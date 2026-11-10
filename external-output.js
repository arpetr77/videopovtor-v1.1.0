// Интеграция внешнего экрана: адаптер вывода (OutputAdapter) + менеджер соединения.
// Этот модуль подгружается динамически, только когда в настройках включён «Внешний экран».
// Рекордер не затрагивается: из него читается только состояние (getRecorderState).
import { OutputAdapter } from './outputs.js';
import { createPhoneSession } from './phone-session.js';

// Режимы показа: 'local' — только на телефоне, 'remote' — на внешнем экране (телефон — пульт),
// 'both' — и там и там (best effort, синхронность не гарантируется).
class ExternalOutputAdapter extends OutputAdapter {
  constructor(mgr, local) {
    super('viewer-link');
    this.m = mgr; this.local = local;
    this.mode = 'local'; this.clip = null; this.blob = null; this.lastSt = null; this.pending = null;
  }
  isAvailable() { return this.m.connected; }
  async connect() { this.m.openDialog(); }
  _setMode(mode) { this.mode = mode; this.m.onMode(mode); }

  async play(clip, { blob } = {}) {
    const m = this.m;
    this.clip = clip; this.blob = blob; this.lastSt = null; this.pending = null;
    if (!m.connected) { this._setMode('local'); return this.local.play(clip, { blob }); }
    if (m.clipState[clip.id] !== 'ready') {
      // Клип ещё не на экране: не блокируем судью, показываем на телефоне и досылаем
      m.send(clip, blob);
      this.pending = clip.id;
      m.toast('Клип ещё передаётся на экран — пока показываю на телефоне', 'info', 3500);
      this._setMode('local');
      return this.local.play(clip, { blob });
    }
    return this._showRemote(0, false);
  }

  async _showRemote(fromTime, paused) {
    const s = this.m.session;
    s.cmd('show', { clipId: this.clip.id });
    if (fromTime > 0) s.cmd('seek', { time: fromTime });
    if (paused) s.cmd('pause');
    if (this.m.getSettings().extShowLocal) {
      this._setMode('both');
      if (!this.local.player.clip) await this.local.play(this.clip, { blob: this.blob });
    } else {
      this._setMode('remote');
      await this.local.disconnect(); // телефон — пульт, своё видео не играет
    }
  }

  /** Клип дошёл до экрана, пока повтор показывался на телефоне: переносим показ на экран. */
  async onReady(clipId) {
    if (this.pending !== clipId || this.clip?.id !== clipId || this.mode !== 'local') return;
    this.pending = null;
    const v = this.local.player.video;
    await this._showRemote(v.currentTime || 0, v.paused);
  }

  control(cmd, value) {
    if (this.mode === 'local') return this.local.control(cmd, value);
    const s = this.m.session;
    const st = this.mode === 'both' ? this.local.player.state() : (this.lastSt || { time: 0, paused: true, loop: false, muted: true });
    if (this.mode === 'both') this.local.control(cmd, value);
    const end = (this.clip && this.clip.durationMs ? this.clip.durationMs / 1000 : 0) || 1e9;
    const seek = (t) => this._sendSeek(Math.min(end, Math.max(0, t))); // всегда абсолютное время, с ограничением частоты
    switch (cmd) {
      case 'toggle':
        if (st.paused) { if (st.ended || st.time >= end - 0.05) seek(0); s.cmd('play'); } else s.cmd('pause');
        break;
      case 'play': case 'pause': s.cmd(cmd); break;
      case 'step': s.cmd('step', { dir: value > 0 ? 1 : -1 }); break;
      case 'seekBy': seek(st.time + value); break;
      case 'seek': seek(value); break;
      case 'rate': s.cmd('rate', { value }); break;
      case 'loop': s.cmd('loop', { value: value === undefined ? !st.loop : !!value }); break;
      case 'mute': s.cmd('mute', { value: value === undefined ? !st.muted : !!value }); break;
    }
  }

  _sendSeek(t) {
    const now = performance.now(); this._seekT = t;
    if (now - (this._lastSeek || 0) >= 80) { this._lastSeek = now; this.m.session.cmd('seek', { time: t }); }
    else if (!this._seekTimer) this._seekTimer = setTimeout(() => {
      this._seekTimer = null; this._lastSeek = performance.now();
      if (this.m.connected && this.mode !== 'local') this.m.session.cmd('seek', { time: this._seekT });
    }, 80 - (now - this._lastSeek));
  }

  async disconnect() {
    clearTimeout(this._seekTimer); this._seekTimer = null;
    if (this.mode !== 'local' && this.m.connected) this.m.session.cmd('hide'); // на экране «Ожидание повтора»
    this.clip = null; this.blob = null; this.pending = null;
    this._setMode('local');
    await this.local.disconnect();
  }

  /** Состояние с экрана (источник истины по времени в режиме 'remote'). */
  onDisplayState(st) {
    if (this.mode !== 'remote' || !this.clip || st.clipId !== this.clip.id) return;
    this.lastSt = st;
    this.m.onState({ time: st.time, duration: (this.clip.durationMs || 0) / 1000, paused: st.paused, rate: st.rate, loop: st.loop, muted: st.muted });
  }

  /** Связь потеряна во время показа: продолжаем на телефоне с того же места. */
  async onLost() {
    this.pending = null;
    if (!this.clip || this.mode === 'local') return;
    const t = this.lastSt ? this.lastSt.time : 0, was = this.mode;
    this._setMode('local');
    this.m.toast('Связь с экраном потеряна — повтор на телефоне', 'warn', 4000);
    if (was === 'remote') { await this.local.play(this.clip, { blob: this.blob }); this.local.control('seek', t); }
  }
}

export function createExternal({ local, getRecorderState, getSettings, getLatest, onChange = () => {}, onState = () => {}, onMode = () => {}, toast = () => {}, sessionFactory = createPhoneSession }) {
  const m = {
    connected: false, useExt: true, session: null, clipState: {}, q: Promise.resolve(),
    chip: { clipId: null, pct: 0, paused: false }, rtt: null,
    openDialog: () => {}, toast, getSettings, onMode, onState, send: null, adapter: null,
  };
  m.adapter = new ExternalOutputAdapter(m, local);

  function newSession() {
    if (m.session) m.session.close();
    m.clipState = {}; m.connected = false; m.q = Promise.resolve();
    const stun = String(getSettings().extStun || '').trim();
    const ses = sessionFactory({ getRecorderState, iceServers: stun ? [{ urls: stun }] : [], onEvent: (e) => handle(ses, e) });
    m.session = ses;
    return ses;
  }

  function handle(ses, e) {
    if (ses !== m.session) return;
    switch (e.type) {
      case 'status':
        if (e.connected) { m.connected = true; onChange(); autoSendLatest(); }
        else if (e.lost) { m.connected = false; m.adapter.onLost(); onChange(); }
        else if (e.error) toast(e.text, 'warn', 4000);
        break;
      case 'rtt': m.rtt = e.rtt; break;
      case 'progress': m.chip = { clipId: e.clipId, pct: Math.round((e.bytes / e.size) * 100), paused: false }; onChange(); break;
      case 'paused': m.chip.paused = e.paused; onChange(); break;
      case 'ready': m.clipState[e.clipId] = 'ready'; m.chip = { clipId: e.clipId, pct: 100, paused: false }; onChange(); m.adapter.onReady(e.clipId); break;
      case 'state': m.adapter.onDisplayState(e.state); break;
    }
  }

  // Клипы уходят строго по одному (очередь); сама отправка встаёт на паузу, пока идёт запись
  m.send = (clip, blob) => {
    if (!m.connected || !blob) return;
    const st = m.clipState[clip.id];
    if (st === 'sending' || st === 'ready') return;
    m.clipState[clip.id] = 'sending';
    m.chip = { clipId: clip.id, pct: 0, paused: false };
    onChange();
    const ses = m.session;
    m.q = m.q.then(async () => {
      try {
        await ses.sendClip(clip.id, blob, { mimeType: clip.mimeType, fps: clip.fps, durationMs: clip.durationMs, endedAt: clip.endedAt, label: clip.label });
      } catch (err) {
        if (ses === m.session) { delete m.clipState[clip.id]; if (m.connected) toast('Не удалось отправить клип на экран: ' + err.message, 'warn', 4000); }
      }
    });
  };

  async function autoSendLatest() {
    if (!getSettings().extAutoSend || getRecorderState() !== 'IDLE') return; // во время записи диск не трогаем
    try { const l = await getLatest(); if (l) m.send(l.clip, l.blob); } catch (_) {}
  }

  return {
    adapter: m.adapter,
    get connected() { return m.connected; },
    get useExt() { return m.useExt; },
    setUseExt(v) { m.useExt = !!v; onChange(); },
    shouldUse() { return m.connected && m.useExt; },
    onSaved(clip, blob) { if (m.connected && getSettings().extAutoSend) m.send(clip, blob); }, // предзагрузка в фоне, без показа
    begin: newSession,                                     // новая попытка подключения
    diagnostics: () => { if (!m.session || !m.connected) throw new Error('Нет соединения'); return m.session.runDiagnostics(10); },
    rtt: () => m.rtt,
    setDialogOpener(fn) { m.openDialog = fn; },
    open() { m.openDialog(); },
    disconnect() { if (m.session) m.session.close(); m.session = null; m.connected = false; m.clipState = {}; onChange(); },
    destroy() { if (m.adapter.mode !== 'local' && m.connected) m.session.cmd('hide'); this.disconnect(); },
    chipText() {
      if (!m.connected) return '🖥 не подключён';
      const st = m.clipState[m.chip.clipId];
      if (m.chip.paused) return '🖥 ⏸ запись';
      if (st === 'ready') return '🖥 ✓';
      if (st === 'sending') return `🖥 ${m.chip.pct}%`;
      return '🖥 подключён';
    },
  };
}
