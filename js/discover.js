'use strict';

// Finds an LG webOS TV on the home network from the browser.
//
// Web pages cannot use SSDP/mDNS (UDP), so the TV is found by probing addresses:
// 1) find the phone's subnet: the router answers on x.x.x.1 or x.x.x.254;
// 2) probe every address of that subnet. LG webOS TVs run a DIAL server (used for
//    YouTube/Netflix casting) on http port 36866: any HTTP answer there means an LG TV.
//    Port 3001 is probed too: it answers only if the TV certificate was accepted before.
// 3) Fallback when nothing answered on those: rank the hosts that answered at all by
//    timing (a TLS server on 3001 fails later than a closed port).

const Discovery = {
  prefixes: [
    '192.168.1', '192.168.0', '192.168.8', '192.168.100', '192.168.31', '192.168.88',
    '192.168.68', '192.168.50', '192.168.2', '192.168.3', '192.168.10', '192.168.11',
    '192.168.178', '192.168.254', '192.168.86', '10.0.0', '10.0.1', '10.1.1', '172.16.0',
  ],
  tvPort: 3001,
  refPort: 3002,
  dialPort: 36866,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    await fetch(url, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: ctrl.signal });
    return { ok: true, timedOut: false, ms: performance.now() - t0 };
  } catch {
    return { ok: false, timedOut: ctrl.signal.aborted, ms: performance.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

async function pool(items, limit, fn, onEach) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
      done++;
      if (onEach) onEach(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---- Chrome "local network" permission (Chrome 142+) ----

async function localNetworkStatus() {
  if (!navigator.permissions || !navigator.permissions.query) return null;
  for (const name of ['local-network', 'local-network-access']) {
    try { return await navigator.permissions.query({ name }); } catch { /* unknown name */ }
  }
  return null;
}

// Returns 'granted' | 'denied' | 'unsupported' (browser without the permission) |
// 'unknown' (no answer: the dialog was dismissed, or this request did not need it).
// A request from the top-level page makes Chrome show its permission dialog; we wait for the answer.
async function requestLocalNetwork(triggerUrl, waitMs = 60000) {
  const status = await localNetworkStatus();
  if (!status) return 'unsupported';
  if (status.state !== 'prompt') return status.state;
  let probeDone = false;
  probe(triggerUrl, waitMs).then(() => { probeDone = true; });
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    await sleep(200);
    if (status.state !== 'prompt') return status.state;
    if (probeDone) { await sleep(200); return status.state === 'prompt' ? 'unknown' : status.state; }
  }
  return status.state === 'prompt' ? 'unknown' : status.state;
}

// ---- Scan ----

async function findSubnets(httpAllowed, onProgress) {
  const gateways = [];
  for (const p of Discovery.prefixes) gateways.push({ prefix: p, ip: p + '.1' }, { prefix: p, ip: p + '.254' });
  const results = await pool(gateways, 40, async (g) => {
    const [h, s] = await Promise.all([
      httpAllowed ? probe(`http://${g.ip}/`, 1500) : Promise.resolve({ ok: false, timedOut: true, ms: 1500 }),
      probe(`https://${g.ip}/`, 1500),
    ]);
    return { ...g, strong: h.ok || s.ok, fast: !h.timedOut || !s.timedOut, ms: Math.min(h.ms, s.ms) };
  }, onProgress);

  // A router that serves its web page is a sure sign; a quick refusal is a weaker one.
  const strong = [...new Set(results.filter((r) => r.strong).map((r) => r.prefix))];
  if (strong.length) return strong.slice(0, 2);
  const weak = results.filter((r) => r.fast).sort((a, b) => a.ms - b.ms).map((r) => r.prefix);
  return [...new Set(weak)].slice(0, 2);
}

async function classify(ip) {
  const tv = [], ref = [];
  let tvOk = false, refSilent = 0;
  for (let k = 0; k < 4; k++) {
    const a = await probe(`https://${ip}:${Discovery.tvPort}/?d=${k}`, 2000);
    const b = await probe(`https://${ip}:${Discovery.refPort}/?d=${k}`, 1200);
    if (a.ok) tvOk = true;
    if (!a.timedOut) tv.push(a.ms);
    if (b.timedOut) refSilent++; else ref.push(b.ms);
  }
  const tvMin = tv.length ? Math.min(...tv) : Infinity;
  const refMin = ref.length ? Math.min(...ref) : Infinity;
  const delta = tvMin - refMin;
  let score = 0;
  if (tvOk) score = 3; // certificate already accepted earlier: the TLS server answered
  else if (tv.length && refSilent >= 3) score = 2; // only port 3001 answers
  else if (tv.length && ref.length && delta >= 3 && delta >= refMin * 0.25) score = 1; // TLS handshake is slower than a refusal
  return { ip, score, delta: Number.isFinite(delta) ? Math.round(delta * 10) / 10 : null };
}

const ipNum = (ip) => ip.split('.').reduce((n, x) => n * 256 + Number(x), 0);
const NO_PROBE = { ok: false, timedOut: true, ms: 0 };

// onProgress({ phase: 'subnet' | 'hosts' | 'check', done, total, prefix })
async function scanForTVs(onProgress = () => {}) {
  const perm = await requestLocalNetwork(`http://${Discovery.prefixes[0]}.1/`);
  if (perm === 'denied') return { error: 'denied' };
  const httpAllowed = perm === 'granted'; // plain http to local IPs is allowed only with the permission

  const subnets = await findSubnets(httpAllowed, (done, total) => onProgress({ phase: 'subnet', done, total }));
  if (!subnets.length) return { error: 'no-subnet' };

  let found = [];
  const alive = [];
  for (const prefix of subnets) {
    const ips = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);
    const res = await pool(ips, 48, async (ip) => {
      const [dial, tls] = await Promise.all([
        httpAllowed ? probe(`http://${ip}:${Discovery.dialPort}/apps/YouTube`, 2500) : Promise.resolve(NO_PROBE),
        probe(`https://${ip}:${Discovery.tvPort}/`, 2500),
      ]);
      return { ip, dial, tls };
    }, (done, total) => onProgress({ phase: 'hosts', done, total, prefix }));
    for (const { ip, dial, tls } of res) {
      if (dial.ok || tls.ok) found.push({ ip, score: 3, certAccepted: tls.ok });
      else if (!tls.timedOut || !dial.timedOut) alive.push({ ip, ms: tls.ms });
    }
    if (found.length || alive.length) break;
  }

  if (!found.length && alive.length) {
    // A TLS port answers slower than a closed one, so check the slowest responders first.
    const toCheck = alive.slice().sort((a, b) => b.ms - a.ms).slice(0, 32).map((a) => a.ip);
    const checked = await pool(toCheck, 4, classify, (done, total) => onProgress({ phase: 'check', done, total }));
    found = checked.filter((c) => c.score > 0).sort((a, b) => b.score - a.score || (b.delta || 0) - (a.delta || 0));
  }

  const foundIps = new Set(found.map((c) => c.ip));
  const others = alive.map((a) => a.ip).filter((ip) => !foundIps.has(ip)).sort((a, b) => ipNum(a) - ipNum(b)).slice(0, 40);
  return { subnets, candidates: found, others };
}

window.Discovery = Discovery;
window.scanForTVs = scanForTVs;
window.requestLocalNetwork = requestLocalNetwork;
