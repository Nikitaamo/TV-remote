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
  dialPort: 36866, // LG DIAL server (YouTube/Netflix casting)
  upnpPort: 1754, // LG UPnP device description
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

// Returns { prefixes, routers, httpOk }. A router that serves its web page is a sure sign of
// the subnet; a quick refusal on https is a weaker one. Plain http works only when Chrome
// allows local network access, so it is counted only when it really answers.
async function findSubnets(onProgress) {
  const gateways = [];
  for (const p of Discovery.prefixes) gateways.push({ prefix: p, ip: p + '.1' }, { prefix: p, ip: p + '.254' });
  const results = await pool(gateways, 40, async (g) => {
    const [h, s] = await Promise.all([probe(`http://${g.ip}/`, 1500), probe(`https://${g.ip}/`, 1500)]);
    return { ...g, httpOk: h.ok, strong: h.ok || s.ok, fast: !s.timedOut, ms: s.ms };
  }, onProgress);

  const strong = results.filter((r) => r.strong);
  let picked = [...new Set(strong.map((r) => r.prefix))];
  if (!picked.length) picked = [...new Set(results.filter((r) => r.fast).sort((a, b) => a.ms - b.ms).map((r) => r.prefix))];
  picked = picked.slice(0, 2);
  const routers = results.filter((r) => picked.includes(r.prefix) && (r.strong || r.fast)).map((r) => r.ip);
  return { prefixes: picked, routers, httpOk: results.some((r) => r.httpOk) };
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

// LG's UPnP description holds the name shown in casting lists, e.g. "[LG] webOS TV OLED55C1".
// Readable only if the TV allows cross-origin reads; otherwise null.
async function readFriendlyName(ip) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    const r = await fetch(`http://${ip}:${Discovery.upnpPort}/`, { cache: 'no-store', credentials: 'omit', signal: ctrl.signal });
    const m = /<friendlyName>([^<]{1,80})<\/friendlyName>/i.exec(await r.text());
    return m ? m[1].replace(/&amp;/g, '&').trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Rough device type from well-known HTTP ports (only with local network access).
async function deviceKind(ip, routers, httpAllowed) {
  if (routers.includes(ip)) return 'router';
  if (!httpAllowed) return 'device';
  const [samsung, google] = await Promise.all([
    probe(`http://${ip}:8001/api/v2/`, 1500),
    probe(`http://${ip}:8008/ssdp/device-desc.xml`, 1500),
  ]);
  if (samsung.ok) return 'samsung';
  if (google.ok) return 'google';
  return 'device';
}

// onProgress({ phase: 'subnet' | 'hosts' | 'check', done, total, prefix })
// Result: { subnets, candidates: [{ ip, score, certAccepted, name }], others: [{ ip, kind }], diag }
// score 3 = LG TV for sure, 1-2 = guessed by timing.
async function scanForTVs(onProgress = () => {}) {
  const perm = await requestLocalNetwork(`http://${Discovery.prefixes[0]}.1/`);
  if (perm === 'denied') return { error: 'denied', diag: { perm } };

  const net = await findSubnets((done, total) => onProgress({ phase: 'subnet', done, total }));
  const httpAllowed = perm === 'granted' || net.httpOk;
  const diag = { perm, httpAllowed, subnets: net.prefixes, alive: 0, lg: 0 };
  if (!net.prefixes.length) return { error: 'no-subnet', diag };

  let found = [];
  const alive = [];
  for (const prefix of net.prefixes) {
    const ips = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);
    const res = await pool(ips, 48, async (ip) => {
      const [dial, upnp, tls] = await Promise.all([
        httpAllowed ? probe(`http://${ip}:${Discovery.dialPort}/apps/YouTube`, 2500) : Promise.resolve(NO_PROBE),
        httpAllowed ? probe(`http://${ip}:${Discovery.upnpPort}/`, 2500) : Promise.resolve(NO_PROBE),
        probe(`https://${ip}:${Discovery.tvPort}/`, 2500),
      ]);
      return { ip, dial, upnp, tls };
    }, (done, total) => onProgress({ phase: 'hosts', done, total, prefix }));
    for (const { ip, dial, upnp, tls } of res) {
      if (dial.ok || upnp.ok || tls.ok) found.push({ ip, score: 3, certAccepted: tls.ok, name: null });
      else if (!tls.timedOut || !dial.timedOut || !upnp.timedOut) alive.push({ ip, ms: tls.ms });
    }
    if (found.length || alive.length) break;
  }
  diag.alive = alive.length + found.length;
  diag.lg = found.length;

  if (found.length) {
    onProgress({ phase: 'check', done: 0, total: found.length });
    await Promise.all(found.map(async (c) => { c.name = await readFriendlyName(c.ip); }));
  } else if (alive.length) {
    // No LG answer: guess by timing. A TLS port answers slower than a closed one, so check the slowest first.
    const toCheck = alive.slice().sort((a, b) => b.ms - a.ms).slice(0, 32).map((a) => a.ip);
    const checked = await pool(toCheck, 4, classify, (done, total) => onProgress({ phase: 'check', done, total }));
    found = checked.filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score || (b.delta || 0) - (a.delta || 0))
      .map((c) => ({ ...c, certAccepted: false, name: null }));
  }

  const foundIps = new Set(found.map((c) => c.ip));
  const otherIps = alive.map((a) => a.ip).filter((ip) => !foundIps.has(ip)).sort((a, b) => ipNum(a) - ipNum(b)).slice(0, 40);
  const others = await pool(otherIps, 16, async (ip) => ({ ip, kind: await deviceKind(ip, net.routers, httpAllowed) }));
  return { subnets: net.prefixes, candidates: found, others, diag };
}

// Quick check whether an LG TV is on at this address (DIAL/UPnP answer).
async function lgAnswersAt(ip) {
  const [dial, upnp] = await Promise.all([
    probe(`http://${ip}:${Discovery.dialPort}/apps/YouTube`, 2500),
    probe(`http://${ip}:${Discovery.upnpPort}/`, 2500),
  ]);
  return dial.ok || upnp.ok;
}

window.Discovery = Discovery;
window.scanForTVs = scanForTVs;
window.requestLocalNetwork = requestLocalNetwork;
window.lgAnswersAt = lgAnswersAt;
