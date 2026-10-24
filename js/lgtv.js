'use strict';

// LG webOS TV client (SSAP protocol) that runs entirely in the browser.
//
// The TV's WebSocket server rejects connections from normal web origins and only
// accepts "Origin: null". So every socket is opened inside a hidden data: iframe
// (which has an opaque, null origin) and relayed to this page with postMessage.

// Unsigned manifest, as used by Home Assistant (aiowebostv 0.9.2+). LG firmware from 2026 rejects the
// old signed "LG test" manifest with "403 Pairing rejected: blacklisted certificate detected" and shows
// no prompt; with this one the TV asks the user to allow the connection.
const LG_MANIFEST = {
  manifestVersion: 1,
  appVersion: '1.1',
  permissions: [
    'APP_TO_APP', 'CLOSE', 'CONTROL_AUDIO', 'CONTROL_DISPLAY', 'CONTROL_INPUT_JOYSTICK',
    'CONTROL_INPUT_MEDIA_PLAYBACK', 'CONTROL_INPUT_MEDIA_RECORDING', 'CONTROL_INPUT_TEXT',
    'CONTROL_INPUT_TV', 'CONTROL_MOUSE_AND_KEYBOARD', 'CONTROL_POWER', 'CONTROL_TV_SCREEN',
    'LAUNCH', 'LAUNCH_WEBAPP', 'READ_APP_STATUS', 'READ_COUNTRY_INFO', 'READ_CURRENT_CHANNEL',
    'READ_INPUT_DEVICE_LIST', 'READ_INSTALLED_APPS', 'READ_LGE_SDX', 'READ_LGE_TV_INPUT_EVENTS',
    'READ_NETWORK_STATE', 'READ_NOTIFICATIONS', 'READ_POWER_STATE', 'READ_RUNNING_APPS',
    'READ_SETTINGS', 'READ_TV_CHANNEL_LIST', 'READ_TV_CURRENT_TIME', 'READ_UPDATE_INFO', 'SEARCH',
    'TEST_OPEN', 'TEST_PROTECTED', 'TEST_SECURE', 'UPDATE_FROM_REMOTE_APP',
    'WRITE_NOTIFICATION_ALERT', 'WRITE_NOTIFICATION_TOAST', 'WRITE_SETTINGS',
  ],
};

// Runs inside the iframe. Must not reference anything outside its own body.
function nullOriginRelay(url) {
  var ws;
  function post(m) { parent.postMessage(JSON.stringify(m), '*'); }
  try {
    ws = new WebSocket(url);
  } catch (e) {
    post({ t: 'error' });
    post({ t: 'close', code: 0 });
    return;
  }
  ws.onopen = function () { post({ t: 'open' }); };
  ws.onmessage = function (e) { post({ t: 'msg', d: e.data }); };
  ws.onerror = function () { post({ t: 'error' }); };
  ws.onclose = function (e) { post({ t: 'close', code: e.code }); };
  addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var m;
    try { m = JSON.parse(e.data); } catch (err) { return; }
    if (m.t === 'send' && ws.readyState === 1) ws.send(m.d);
    else if (m.t === 'close') ws.close();
  });
}

// WebSocket-like wrapper around the relay iframe.
class NullOriginSocket {
  constructor(url) {
    this.url = url;
    this.isOpen = false;
    this.closed = false;
    this.onopen = this.onmessage = this.onerror = this.onclose = null;

    const html = '<!doctype html><meta charset="utf-8"><script>(' +
      nullOriginRelay.toString() + ')(' + JSON.stringify(url) + ');<\/script>';
    this.frame = document.createElement('iframe');
    this.frame.hidden = true;
    this.frame.setAttribute('aria-hidden', 'true');
    // Chrome 142+ asks for "local network" permission; iframes need it delegated.
    this.frame.setAttribute('allow', 'local-network-access *; local-network *');
    this.frame.src = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);

    this._onMessage = (e) => {
      if (e.source !== this.frame.contentWindow || typeof e.data !== 'string') return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'open') { this.isOpen = true; this.onopen && this.onopen(); }
      else if (m.t === 'msg') { this.onmessage && this.onmessage(m.d); }
      else if (m.t === 'error') { this.onerror && this.onerror(); }
      else if (m.t === 'close') { this._finish(m.code); }
    };
    window.addEventListener('message', this._onMessage);
    document.body.appendChild(this.frame);
  }

  send(data) {
    if (!this.isOpen || this.closed) return false;
    this.frame.contentWindow.postMessage(JSON.stringify({ t: 'send', d: data }), '*');
    return true;
  }

  close() {
    if (this.closed) return;
    try { this.frame.contentWindow.postMessage(JSON.stringify({ t: 'close' }), '*'); } catch { /* frame gone */ }
    setTimeout(() => this._finish(1000), 300);
  }

  _finish(code) {
    if (this.closed) return;
    this.closed = true;
    this.isOpen = false;
    window.removeEventListener('message', this._onMessage);
    this.frame.remove();
    this.onclose && this.onclose(code);
  }
}

function waitOpen(sock, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { sock.close(); reject(new Error('timeout')); }, timeoutMs);
    sock.onopen = () => { clearTimeout(timer); resolve(sock); };
    sock.onclose = () => { clearTimeout(timer); reject(new Error('closed')); };
  });
}

// SSAP equivalents for keys, used if the TV refuses the button socket.
const MEDIA_FALLBACK = {
  PLAY: 'ssap://media.controls/play',
  PAUSE: 'ssap://media.controls/pause',
  STOP: 'ssap://media.controls/stop',
  REWIND: 'ssap://media.controls/rewind',
  FASTFORWARD: 'ssap://media.controls/fastForward',
  VOLUMEUP: 'ssap://audio/volumeUp',
  VOLUMEDOWN: 'ssap://audio/volumeDown',
  CHANNELUP: 'ssap://tv/channelUp',
  CHANNELDOWN: 'ssap://tv/channelDown',
};

class LGTV extends EventTarget {
  constructor() {
    super();
    this.ip = null;
    this.state = 'idle'; // idle | connecting | pairing | connected | disconnected | error
    this.ws = null;
    this.pointer = null;
    this.pointerPromise = null;
    this.pending = new Map();
    this.subs = new Map();
    this.seq = 0;
    this.info = {};
    this.helloWaiter = null;
  }

  static keyName(ip) { return 'lg-client-key:' + ip; }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  _setState(state, info) {
    this.state = state;
    this._emit('state', { state, info });
  }

  _id() { return 'r' + (++this.seq) + '_' + Date.now().toString(36); }

  // key: client key saved from an earlier pairing with this TV (undefined = look up by IP).
  // Resolves to { key, uuid, modelName }.
  async connect(ip, key) {
    this.disconnect(true);
    this.ip = ip;
    this.info = {};
    this._setState('connecting');

    const ws = new NullOriginSocket(`wss://${ip}:3001`);
    this.ws = ws;
    try {
      await waitOpen(ws, 7000);
    } catch (e) {
      if (this.ws === ws) { this.ws = null; this._setState('error', 'unreachable'); }
      throw new Error('unreachable');
    }
    if (this.ws !== ws) throw new Error('superseded');

    ws.onmessage = (raw) => this._onMessage(raw);
    ws.onclose = () => this._onSocketClosed(ws);

    if (key === undefined) {
      try { key = localStorage.getItem(LGTV.keyName(ip)); } catch { key = null; }
    }

    // Before pairing: the TV's unique id, and the model (newer webOS answers this only before registration).
    try {
      const hello = await this._hello();
      if (hello && hello.deviceUUID) this.info.uuid = hello.deviceUUID;
    } catch { /* older TVs */ }
    try {
      const sys = await this._raw('request', 'ssap://system/getSystemInfo', {}, 3000);
      if (sys.modelName) this.info.modelName = sys.modelName;
    } catch { /* needs registration on older TVs */ }

    let newKey;
    try {
      newKey = await this._register(key);
    } catch (e) {
      if (this.ws === ws) { this.disconnect(true); this._setState('error', e.message); }
      throw e;
    }

    if (!this.info.modelName) {
      try {
        const sys = await this._raw('request', 'ssap://system/getSystemInfo', {}, 3000);
        if (sys.modelName) this.info.modelName = sys.modelName;
      } catch { /* not available */ }
    }

    this._setState('connected');
    this.openPointer().catch(() => {});
    this._subscribeVolume();
    return { key: newKey || key, uuid: this.info.uuid || null, modelName: this.info.modelName || null };
  }

  _hello() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.helloWaiter = null; reject(new Error('timeout')); }, 3000);
      this.helloWaiter = (payload) => { clearTimeout(timer); this.helloWaiter = null; resolve(payload); };
      this.ws.send(JSON.stringify({ id: 'hello', type: 'hello', payload: {} }));
    });
  }

  // Request on the open socket, also before registration.
  _raw(type, uri, payload, timeoutMs) {
    if (!this.ws) return Promise.reject(new Error('not-connected'));
    return new Promise((resolve, reject) => {
      const id = this._id();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout')); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ type, id, uri, payload: payload || {} }));
    });
  }

  _register(key) {
    return new Promise((resolve, reject) => {
      const id = this._id();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('pair-timeout'));
      }, 60000);
      this.pending.set(id, {
        register: true,
        resolve: (m) => { clearTimeout(timer); resolve(m.payload && m.payload['client-key']); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      const payload = { forcePairing: false, pairingType: 'PROMPT', manifest: LG_MANIFEST };
      if (key) payload['client-key'] = key;
      this.ws.send(JSON.stringify({ type: 'register', id, payload }));
    });
  }

  _onMessage(raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.type === 'hello') {
      if (this.helloWaiter) this.helloWaiter(m.payload || {});
      return;
    }

    const sub = this.subs.get(m.id);
    if (sub) {
      if (m.type === 'response' && m.payload) sub(m.payload);
      return;
    }

    const p = this.pending.get(m.id);
    if (!p) return;

    if (p.register) {
      if (m.type === 'registered') { this.pending.delete(m.id); p.resolve(m); }
      else if (m.type === 'error') {
        this.pending.delete(m.id);
        const text = String(m.error || (m.payload && m.payload.errorText) || '');
        // "403 User denied access" = the user chose "Deny" on the TV; anything else is a TV-side refusal.
        const err = new Error(/denied access|user denied|user reject|cancel/i.test(text) ? 'denied' : 'pair-error');
        err.detail = text;
        p.reject(err);
      }
      else if (m.payload && m.payload.pairingType === 'PROMPT') {
        this._setState('pairing');
        this._emit('prompt');
      }
      return;
    }

    this.pending.delete(m.id);
    if (m.type === 'error' || (m.payload && m.payload.returnValue === false)) {
      p.reject(new Error(m.error || (m.payload && m.payload.errorText) || 'error'));
    } else {
      p.resolve(m.payload || {});
    }
  }

  _onSocketClosed(ws) {
    if (this.ws !== ws) return;
    this.ws = null;
    this._closePointer();
    this._rejectAll('closed');
    this.subs.clear();
    this._setState('disconnected');
  }

  _rejectAll(reason) {
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
  }

  disconnect(silent = false) {
    const ws = this.ws;
    this.ws = null;
    this._closePointer();
    this._rejectAll('closed');
    this.subs.clear();
    if (ws) ws.close();
    if (!silent) this._setState('disconnected');
  }

  get connected() { return this.state === 'connected' && !!this.ws; }

  request(uri, payload = {}, timeoutMs = 6000) {
    if (!this.connected) return Promise.reject(new Error('not-connected'));
    return this._raw('request', uri, payload, timeoutMs);
  }

  subscribe(uri, payload, onData) {
    if (!this.connected) return;
    const id = this._id();
    this.subs.set(id, onData);
    this.ws.send(JSON.stringify({ type: 'subscribe', id, uri, payload: payload || {} }));
  }

  _subscribeVolume() {
    this.subscribe('ssap://audio/getVolume', {}, (p) => {
      const s = p.volumeStatus || p;
      if (typeof s.volume !== 'number') return;
      const muted = s.muteStatus !== undefined ? s.muteStatus : (s.muted !== undefined ? s.muted : !!p.mute);
      this.volume = { volume: s.volume, muted: !!muted };
      this._emit('volume', this.volume);
    });
  }

  // ---- Pointer / button socket (arrows, OK, numbers, colour keys, mouse) ----

  openPointer() {
    if (this.pointer && this.pointer.isOpen) return Promise.resolve(this.pointer);
    if (this.pointerPromise) return this.pointerPromise;
    this.pointerPromise = (async () => {
      let r;
      try {
        r = await this.request('ssap://com.webos.service.networkinput/getPointerInputSocket');
      } catch (e) {
        if (e.message !== 'not-connected' && e.message !== 'closed') this._emit('pointer-refused', e.message);
        throw e;
      }
      let path = r.socketPath;
      if (!path) throw new Error('no-socket-path');
      // Over TLS the TV may still return a plain ws://…:3000 path; the page can only use wss.
      if (path.startsWith('ws://')) path = 'wss://' + path.slice(5).replace(':3000/', ':3001/');
      const sock = await waitOpen(new NullOriginSocket(path), 6000);
      sock.onclose = () => { if (this.pointer === sock) this.pointer = null; };
      this.pointer = sock;
      return sock;
    })().finally(() => { this.pointerPromise = null; });
    return this.pointerPromise;
  }

  _closePointer() {
    const p = this.pointer;
    this.pointer = null;
    if (p) p.close();
  }

  async _sendPointer(text) {
    if (!this.connected) throw new Error('not-connected');
    const sock = await this.openPointer();
    if (!sock.send(text)) throw new Error('pointer-closed');
  }

  async button(name) {
    try {
      await this._sendPointer(`type:button\nname:${name}\n\n`);
    } catch (e) {
      const uri = MEDIA_FALLBACK[name];
      if (!uri || e.message === 'not-connected') throw e;
      await this.request(uri);
    }
  }

  move(dx, dy) {
    if (this.pointer && this.pointer.isOpen) this.pointer.send(`type:move\ndx:${dx}\ndy:${dy}\ndown:0\n\n`);
    else this.openPointer().catch(() => {});
  }

  scroll(dy) {
    if (this.pointer && this.pointer.isOpen) this.pointer.send(`type:scroll\ndx:0\ndy:${dy}\n\n`);
  }

  click() { return this._sendPointer('type:click\n\n'); }

  // ---- High-level commands ----

  async _requestOrButton(uri, payload, buttonName) {
    try { await this.request(uri, payload); }
    catch (e) {
      if (e.message === 'not-connected' || !buttonName) throw e;
      await this.button(buttonName);
    }
  }

  volumeUp() { return this._requestOrButton('ssap://audio/volumeUp', {}, 'VOLUMEUP'); }
  volumeDown() { return this._requestOrButton('ssap://audio/volumeDown', {}, 'VOLUMEDOWN'); }
  channelUp() { return this._requestOrButton('ssap://tv/channelUp', {}, 'CHANNELUP'); }
  channelDown() { return this._requestOrButton('ssap://tv/channelDown', {}, 'CHANNELDOWN'); }
  powerOff() { return this._requestOrButton('ssap://system/turnOff', {}, 'POWER'); }

  toggleMute() {
    if (this.volume) return this._requestOrButton('ssap://audio/setMute', { mute: !this.volume.muted }, 'MUTE');
    return this.button('MUTE');
  }

  launch(appId) { return this.request('ssap://system.launcher/launch', { id: appId }); }

  async listApps() {
    const r = await this.request('ssap://com.webos.applicationManager/listLaunchPoints');
    return (r.launchPoints || []).map((a) => ({ id: a.id, title: a.title || a.id }));
  }

  async listInputs() {
    const r = await this.request('ssap://tv/getExternalInputList');
    return (r.devices || []).map((d) => ({ id: d.id, label: d.label || d.id, connected: !!d.connected }));
  }

  switchInput(inputId) { return this.request('ssap://tv/switchInput', { inputId }); }
}

window.LGTV = LGTV;
window.NullOriginSocket = NullOriginSocket;
