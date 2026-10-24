'use strict';

const $ = (sel) => document.querySelector(sel);
const tv = new LGTV();

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage blocked */ } },
};

let tvIp = store.get('lg-ip');
let wantConnected = false;
let connecting = null;
let retryTimer = null;
let retryCount = 0;
let apps = null;
const RETRY_DELAYS = [1500, 3000, 6000, 10000, 15000];

// Well-known apps. `id` is the webOS app id; `re` matches the title when the id differs.
const SHORTCUTS = [
  { id: 'youtube.leanback.v4', title: 'YouTube', re: /^youtube$/i, bg: '#ff0033', fg: '#fff' },
  { id: 'netflix', title: 'Netflix', re: /^netflix$/i, bg: '#000', fg: '#e50914', border: '#e50914' },
  { id: 'amazon', title: 'Prime Video', re: /prime video/i, bg: '#00a8e1', fg: '#fff' },
  { id: 'com.disney.disneyplus-prod', title: 'Disney+', re: /^disney\s*\+?$/i, bg: '#0b1d4d', fg: '#fff' },
  { id: 'spotify-beehive', title: 'Spotify', re: /^spotify/i, bg: '#1db954', fg: '#06120b' },
  { id: 'com.webos.app.livetv', title: 'TV kanalai', re: /^live\s?tv$/i, bg: '#3a3f4f', fg: '#fff' },
  { id: null, title: 'Go3', re: /^go3/i, bg: '#ffd400', fg: '#000' },
  { id: null, title: 'Telia Play', re: /telia/i, bg: '#990ae3', fg: '#fff' },
  { id: null, title: 'LRT', re: /^lrt/i, bg: '#c8102e', fg: '#fff' },
  { id: 'com.webos.app.browser', title: 'Naršyklė', re: /^(web\s?)?browser$|naršyklė/i, bg: '#2a2f3c', fg: '#fff' },
];

// ---------- UI helpers ----------

let toastTimer = null;
function toast(text, ms = 2200) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function buzz() { if (navigator.vibrate) navigator.vibrate(10); }

function setupMsg(text, kind = '') {
  const el = $('#setupMsg');
  el.textContent = text;
  el.className = 'setup-msg' + (kind ? ' ' + kind : '');
}

const STATUS_TEXT = {
  idle: () => 'Neprisijungta',
  connecting: () => 'Jungiamasi…',
  pairing: () => 'Patvirtinkite TV ekrane',
  connected: () => 'Prisijungta · ' + tvIp,
  disconnected: () => 'Atsijungta',
  error: () => 'Nepavyko prisijungti',
};

function renderStatus(state) {
  $('#statusBtn').dataset.state = state;
  $('#statusText').textContent = (STATUS_TEXT[state] || STATUS_TEXT.idle)();
  if (state !== 'connected') $('#volBadge').hidden = true;
}

const LNA_HELP = 'Chrome neleidžia šiai svetainei pasiekti vietinio tinklo įrenginių. Leiskite: bakstelėkite piktogramą kairėje adreso juostos pusėje → Leidimai (Svetainės nustatymai) → „Vietinis tinklas“ → Leisti. Tada bandykite dar kartą.';

function errorText(code) {
  if (code === 'lna-denied') return LNA_HELP;
  if (code === 'denied') return 'Televizorius atmetė prisijungimą. Spauskite „Prisijungti“ dar kartą ir TV ekrane pasirinkite „Leisti“.';
  if (code === 'pair-timeout') return 'Nesulaukta patvirtinimo televizoriuje. Spauskite „Prisijungti“ dar kartą.';
  return `Nepavyko pasiekti TV adresu ${tvIp}. Patikrinkite:\n` +
    '• TV įjungtas ir prijungtas prie to paties Wi-Fi kaip telefonas;\n' +
    '• IP adresas teisingas;\n' +
    '• 1 žingsnis (sertifikatas) atliktas šioje naršyklėje (kartais jį reikia pakartoti);\n' +
    '• jei naršyklė prašė leidimo pasiekti vietinio tinklo įrenginius, jį leiskite.';
}

// ---------- Connection ----------

function connect() {
  if (!tvIp) { openSetup(); return Promise.resolve(false); }
  if (connecting) return connecting;
  clearTimeout(retryTimer);
  wantConnected = true;
  renderStatus('connecting');
  connecting = (async () => {
    // Ask for Chrome's "local network" permission from the page itself, so the dialog is shown.
    const perm = await requestLocalNetwork(`https://${tvIp}:3001/`);
    if (perm === 'denied') throw new Error('lna-denied');
    await tv.connect(tvIp);
  })()
    .then(() => {
      retryCount = 0;
      onConnected();
      return true;
    })
    .catch((err) => {
      if (err.message === 'superseded') return false;
      const code = err.message;
      if (code === 'lna-denied') { renderStatus('error'); openSetup(); }
      if ($('#setup').open) setupMsg(errorText(code), 'err');
      if (code === 'unreachable') scheduleRetry();
      return false;
    })
    .finally(() => { connecting = null; });
  return connecting;
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  if (!wantConnected || document.hidden || retryCount >= RETRY_DELAYS.length) return;
  retryTimer = setTimeout(() => { if (!tv.connected) connect(); }, RETRY_DELAYS[retryCount++]);
}

function onConnected() {
  if ($('#setup').open) {
    setupMsg('Prisijungta! Pultas paruoštas.', 'ok');
    setTimeout(() => { if ($('#setup').open) $('#setup').close(); }, 900);
  }
  loadAppsAndInputs();
}

tv.addEventListener('state', (e) => {
  const { state } = e.detail;
  renderStatus(state);
  if (state === 'pairing') {
    const text = 'Televizoriaus ekrane patvirtinkite prisijungimą (pulteliu pasirinkite „Leisti“).';
    if ($('#setup').open) setupMsg(text); else toast(text, 6000);
  } else if (state === 'connecting' && $('#setup').open) {
    setupMsg('Jungiamasi prie ' + tvIp + '…');
  } else if (state === 'disconnected') {
    scheduleRetry();
  }
});

tv.addEventListener('volume', (e) => {
  const { volume, muted } = e.detail;
  const badge = $('#volBadge');
  badge.textContent = muted ? 'Nutildyta' : 'Garsas ' + volume;
  badge.hidden = false;
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(retryTimer); return; }
  if (wantConnected && !tv.connected && tv.state !== 'connecting' && tv.state !== 'pairing') {
    retryCount = 0;
    connect();
  }
});

function needConnection() {
  if (!tvIp) { openSetup(); return; }
  toast(tv.state === 'pairing' ? 'Patvirtinkite prisijungimą TV ekrane.' : 'TV neprisijungęs. Jungiamasi…');
  if (tv.state !== 'connecting' && tv.state !== 'pairing') { retryCount = 0; connect(); }
}

// ---------- Commands ----------

const CMDS = {
  volumeUp: () => tv.volumeUp(),
  volumeDown: () => tv.volumeDown(),
  channelUp: () => tv.channelUp(),
  channelDown: () => tv.channelDown(),
  mute: () => tv.toggleMute(),
  powerOff: () => tv.powerOff(),
};

function actionFor(el) {
  if (el.dataset.key) return () => tv.button(el.dataset.key);
  if (el.dataset.cmd && CMDS[el.dataset.cmd]) return CMDS[el.dataset.cmd];
  if (el.dataset.app) return () => tv.launch(el.dataset.app);
  if (el.dataset.input) return () => tv.switchInput(el.dataset.input);
  return null;
}

const inFlight = new WeakSet();

async function run(el) {
  const action = actionFor(el);
  if (!action) return;
  if (!tv.connected) { needConnection(); return; }
  if (inFlight.has(el)) return;
  inFlight.add(el);
  buzz();
  try {
    await action();
  } catch (err) {
    if (err.message === 'not-connected' || err.message === 'closed') needConnection();
    else if (el.dataset.app) toast('Nepavyko paleisti programėlės.');
    else if (el.dataset.input) toast('Nepavyko perjungti įvesties.');
    else if (err.message === 'timeout') toast('TV neatsako.');
    else toast('Komanda nepavyko.');
  } finally {
    inFlight.delete(el);
  }
}

// Ordinary buttons act on click (so scrolling does not trigger them).
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-key],[data-cmd],[data-app],[data-input]');
  if (!el) return;
  // Hold-to-repeat buttons are handled by pointer events; keyboard clicks have detail 0.
  if (el.hasAttribute('data-repeat') && e.detail !== 0) return;
  run(el);
});

// Hold-to-repeat buttons (volume, channels, arrows).
let repeatEl = null;
let repeatDelay = null;
let repeatTick = null;

function stopRepeat() {
  clearTimeout(repeatDelay);
  clearInterval(repeatTick);
  if (repeatEl) repeatEl.classList.remove('pressed');
  repeatEl = null;
}

document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('[data-repeat]');
  if (!el || e.button > 0) return;
  stopRepeat();
  repeatEl = el;
  el.classList.add('pressed');
  run(el);
  repeatDelay = setTimeout(() => {
    repeatTick = setInterval(() => { if (repeatEl) run(repeatEl); }, 140);
  }, 420);
});
['pointerup', 'pointercancel'].forEach((t) => document.addEventListener(t, stopRepeat));
document.addEventListener('pointerout', (e) => { if (repeatEl && e.target.closest('[data-repeat]') === repeatEl && !repeatEl.contains(e.relatedTarget)) stopRepeat(); });
window.addEventListener('blur', stopRepeat);
document.addEventListener('contextmenu', (e) => { if (e.target.closest('.btn,.touchpad,.scroll-strip')) e.preventDefault(); });

// ---------- Tabs ----------

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === btn.dataset.tab));
    if (btn.dataset.tab === 'tab-touch' && tv.connected) tv.openPointer().catch(() => {});
  });
});

// ---------- Apps, shortcuts, inputs ----------

function resolveShortcuts() {
  if (!apps) return SHORTCUTS.filter((s) => s.id).slice(0, 6);
  const used = new Set();
  const out = [];
  for (const s of SHORTCUTS) {
    const app = apps.find((a) => a.id === s.id) || apps.find((a) => s.re.test(a.title));
    if (app && !used.has(app.id)) {
      used.add(app.id);
      out.push({ ...s, id: app.id });
    }
  }
  return out.slice(0, 6);
}

function renderShortcuts() {
  const box = $('#shortcuts');
  box.innerHTML = '';
  for (const s of resolveShortcuts()) {
    const b = document.createElement('button');
    b.className = 'btn shortcut';
    b.dataset.app = s.id;
    b.textContent = s.title;
    b.style.background = s.bg;
    b.style.color = s.fg;
    if (s.border) b.style.boxShadow = 'inset 0 0 0 1px ' + s.border;
    box.appendChild(b);
  }
}

function renderApps() {
  const box = $('#appsList');
  box.innerHTML = '';
  if (!apps || !apps.length) {
    box.innerHTML = '<p class="muted">Programėlių sąrašo gauti nepavyko.</p>';
    return;
  }
  for (const a of apps) {
    const b = document.createElement('button');
    b.className = 'btn app-item';
    b.dataset.app = a.id;
    const span = document.createElement('span');
    span.textContent = a.title;
    b.appendChild(span);
    box.appendChild(b);
  }
}

function renderInputs(list) {
  const box = $('#inputsList');
  box.innerHTML = '';
  if (!list || !list.length) {
    box.innerHTML = '<p class="muted">Įvesčių sąrašo gauti nepavyko. Naudokite įvesčių mygtuką pulte.</p>';
    return;
  }
  for (const d of list) {
    const b = document.createElement('button');
    b.className = 'chip' + (d.connected ? '' : ' off');
    b.dataset.input = d.id;
    b.textContent = d.label;
    box.appendChild(b);
  }
}

async function loadAppsAndInputs() {
  try {
    const list = await tv.listApps();
    apps = list.sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }));
    store.set('lg-apps', JSON.stringify(apps));
  } catch { /* keep cached list */ }
  renderShortcuts();
  renderApps();
  try { renderInputs(await tv.listInputs()); } catch { renderInputs(null); }
}

// ---------- Touchpad ----------

(function touchpad() {
  const pad = $('#touchpad');
  const strip = $('#scrollStrip');
  const SPEED = 1.6;
  let id = null, last = null, start = null, travel = 0, ax = 0, ay = 0, frame = 0;

  function flush() {
    frame = 0;
    const dx = Math.trunc(ax), dy = Math.trunc(ay);
    if (dx || dy) { tv.move(dx, dy); ax -= dx; ay -= dy; }
  }

  pad.addEventListener('pointerdown', (e) => {
    if (id !== null) return;
    if (!tv.connected) { needConnection(); return; }
    id = e.pointerId;
    pad.setPointerCapture(id);
    last = { x: e.clientX, y: e.clientY };
    start = performance.now();
    travel = 0;
    pad.classList.add('active');
    tv.openPointer().catch(() => {});
  });
  pad.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    const dx = e.clientX - last.x, dy = e.clientY - last.y;
    last = { x: e.clientX, y: e.clientY };
    travel += Math.abs(dx) + Math.abs(dy);
    ax += dx * SPEED; ay += dy * SPEED;
    if (!frame) frame = requestAnimationFrame(flush);
  });
  function end(e, tap) {
    if (e.pointerId !== id) return;
    id = null;
    pad.classList.remove('active');
    if (tap && travel < 10 && performance.now() - start < 300) {
      buzz();
      tv.click().catch(() => {});
    }
  }
  pad.addEventListener('pointerup', (e) => end(e, true));
  pad.addEventListener('pointercancel', (e) => end(e, false));

  // Scroll strip: drag up/down to scroll the page on the TV.
  let sid = null, sy = 0, sacc = 0, sframe = 0;
  function flushScroll() {
    sframe = 0;
    const v = Math.trunc(sacc);
    if (v) { tv.scroll(v); sacc -= v; }
  }
  strip.addEventListener('pointerdown', (e) => {
    if (sid !== null) return;
    if (!tv.connected) { needConnection(); return; }
    sid = e.pointerId;
    strip.setPointerCapture(sid);
    sy = e.clientY;
    strip.classList.add('active');
  });
  strip.addEventListener('pointermove', (e) => {
    if (e.pointerId !== sid) return;
    sacc += (sy - e.clientY); // finger up = scroll down, like on a phone
    sy = e.clientY;
    if (!sframe) sframe = requestAnimationFrame(flushScroll);
  });
  const sEnd = (e) => { if (e.pointerId === sid) { sid = null; strip.classList.remove('active'); } };
  strip.addEventListener('pointerup', sEnd);
  strip.addEventListener('pointercancel', sEnd);
})();

// ---------- Setup dialog ----------

function readIp() {
  const v = $('#ipInput').value.trim();
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (ipv4 && ipv4.slice(1).every((n) => Number(n) <= 255)) return v;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.local$/i.test(v)) return v;
  setupMsg('Įveskite teisingą IP adresą, pvz. 192.168.1.50.', 'err');
  $('#ipInput').focus();
  return null;
}

function applyIp(ip) {
  if (ip === tvIp) return;
  tv.disconnect(true);
  renderStatus('idle');
  tvIp = ip;
  store.set('lg-ip', ip);
  apps = null;
  store.del('lg-apps');
  renderShortcuts();
}

function openSetup() {
  $('#ipInput').value = tvIp || '';
  setupMsg(tv.connected ? 'Prisijungta prie ' + tvIp + '.' : '', tv.connected ? 'ok' : '');
  if (!$('#setup').open) $('#setup').showModal();
}

$('#settingsBtn').addEventListener('click', openSetup);
$('#statusBtn').addEventListener('click', () => {
  if (tv.connected || !tvIp) openSetup();
  else { retryCount = 0; connect(); }
});

function openCertTab(ip) {
  // Coming back to this page reconnects automatically (see visibilitychange).
  wantConnected = true;
  retryCount = 0;
  window.open(`https://${ip}:3001/`, '_blank', 'noopener');
}

$('#certBtn').addEventListener('click', () => {
  const ip = readIp();
  if (!ip) return;
  applyIp(ip);
  setupMsg('Patvirtinę sertifikatą grįžkite čia: prisijungsiu automatiškai.');
  openCertTab(ip);
});

// ---------- Automatic search ----------

let scanning = false;

function scanMsg(text, kind = '') {
  const el = $('#scanMsg');
  el.textContent = text;
  el.className = 'scan-msg' + (kind ? ' ' + kind : '');
}

function chooseCandidate(ip, certAccepted) {
  $('#ipInput').value = ip;
  applyIp(ip);
  if (certAccepted) {
    retryCount = 0;
    connect();
    return;
  }
  setupMsg('Atsidariusiame skirtuke spauskite „Išplėstiniai“ → „Tęsti į …“ ir grįžkite čia: prisijungsiu automatiškai.\n' +
    'Jei skirtuke matote „Svetainė nepasiekiama“, tai ne televizorius: grįžkite ir pasirinkite kitą adresą.');
  openCertTab(ip);
}

function scanButton(ip, label, opts = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn scan-item' + (opts.best ? ' best' : '');
  const name = document.createElement('b');
  name.textContent = ip;
  const note = document.createElement('small');
  note.textContent = label;
  b.append(name, note);
  b.addEventListener('click', () => chooseCandidate(ip, !!opts.certAccepted));
  return b;
}

function renderScan(res) {
  const box = $('#scanResults');
  box.innerHTML = '';
  if (res.error === 'denied') return scanMsg(LNA_HELP, 'err');
  if (res.error === 'no-subnet') return scanMsg('Nepavyko nustatyti jūsų Wi-Fi tinklo. Įveskite TV IP adresą ranka.', 'err');

  const { candidates, others, subnets } = res;
  if (candidates.length) {
    const sure = candidates.filter((c) => c.score === 3).length;
    const tap = candidates[0].certAccepted ? 'Bakstelėkite jį, kad prisijungtumėte.' : 'Bakstelėkite jį: atsidarys sertifikato patvirtinimas.';
    scanMsg(sure === 1 && candidates.length === 1 ? 'Rastas LG televizorius. ' + tap
      : sure ? `Rasta LG televizorių: ${sure}. ` + tap
      : `Tiksliai atpažinti TV nepavyko, bet rasti galimi: ${candidates.length}. Bakstelėkite pirmą: atsidarys sertifikato patvirtinimas.`);
    candidates.forEach((c, i) => {
      const label = c.certAccepted ? 'LG TV · sertifikatas jau patvirtintas' : c.score === 3 ? 'LG televizorius' : 'Galimas TV';
      box.appendChild(scanButton(c.ip, label, { best: i === 0, certAccepted: c.certAccepted }));
    });
  } else {
    scanMsg(`Televizorius tinkle ${subnets.map((p) => p + '.x').join(', ')} nerastas. Patikrinkite, ar TV įjungtas ir prijungtas prie to paties Wi-Fi.` +
      (others.length ? ' Galite išbandyti kitus rastus įrenginius.' : ''), 'err');
  }
  if (others.length) {
    const more = document.createElement('details');
    more.className = 'scan-more';
    if (!candidates.length) more.open = true;
    const sum = document.createElement('summary');
    sum.textContent = `Kiti tinklo įrenginiai (${others.length})`;
    const list = document.createElement('div');
    list.className = 'scan-results';
    others.forEach((ip) => list.appendChild(scanButton(ip, 'Įrenginys')));
    more.append(sum, list);
    box.appendChild(more);
  }
}

$('#scanBtn').addEventListener('click', async () => {
  if (scanning) return;
  scanning = true;
  const btn = $('#scanBtn');
  btn.disabled = true;
  btn.textContent = 'Ieškoma…';
  $('#scanBox').hidden = false;
  $('#scanResults').innerHTML = '';
  scanMsg('Laukiama leidimo pasiekti vietinio tinklo įrenginius…');
  try {
    const res = await scanForTVs((p) => {
      const pct = Math.round((100 * p.done) / p.total);
      if (p.phase === 'subnet') scanMsg(`Ieškomas jūsų Wi-Fi tinklas… ${pct}%`);
      else if (p.phase === 'hosts') scanMsg(`Tikrinami adresai ${p.prefix}.1–254… ${pct}%`);
      else scanMsg(`Tikrinami rasti įrenginiai… ${p.done}/${p.total}`);
    });
    renderScan(res);
  } catch {
    scanMsg('Paieška nepavyko. Įveskite TV IP adresą ranka.', 'err');
  } finally {
    scanning = false;
    btn.disabled = false;
    btn.textContent = 'Ieškoti dar kartą';
  }
});

$('#connectBtn').addEventListener('click', () => {
  const ip = readIp();
  if (!ip) return;
  applyIp(ip);
  retryCount = 0;
  if (tv.connected) { setupMsg('Prisijungta prie ' + ip + '.', 'ok'); return; }
  connect();
});

$('#forgetBtn').addEventListener('click', () => {
  wantConnected = false;
  clearTimeout(retryTimer);
  tv.disconnect(true);
  if (tvIp) store.del(LGTV.keyName(tvIp));
  store.del('lg-ip');
  store.del('lg-apps');
  tvIp = null;
  apps = null;
  $('#ipInput').value = '';
  renderStatus('idle');
  renderShortcuts();
  setupMsg('Televizorius pamirštas.');
});

$('#ipInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#connectBtn').click(); }
});

// ---------- Start ----------

try { apps = JSON.parse(store.get('lg-apps') || 'null'); } catch { apps = null; }
renderShortcuts();
renderStatus('idle');
if (tvIp) connect(); else openSetup();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
