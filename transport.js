// Транспорт WebRTC: два раздельных DataChannel.
//  control  — короткие JSON-команды, ping/pong (никогда не данные клипа);
//  transfer — бинарные части клипа с контролем заполнения буфера.
// Сети нет: iceServers по умолчанию пустой (только локальная сеть).
import { parse } from './protocol.js';
import { pack, unpack } from './signaling.js';

const gathered = pc => new Promise(res => {
  if (pc.iceGatheringState === 'complete') return res();
  const f = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', f); res(); } };
  pc.addEventListener('icegatheringstatechange', f);
  setTimeout(res, 4000); // не ждём бесконечно
});

export class Transport extends EventTarget {
  constructor(iceServers = []) {
    super();
    this.pc = new RTCPeerConnection({ iceServers });
    this.rtt = null; this.last = 0; this.opened = false; this.dead = false;
    this.pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(this.pc.connectionState)) this._lost(); };
    this.pc.ondatachannel = e => this._attach(e.channel);
  }
  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  _check() {
    if (this.opened || this.control?.readyState !== 'open' || this.transfer?.readyState !== 'open') return;
    this.opened = true; this.last = Date.now();
    // Heartbeat: ping раз в секунду, нет ответа 5 секунд — соединение потеряно
    this._hb = setInterval(() => {
      this.sendControl({ t: 'ping', ts: performance.now() });
      if (Date.now() - this.last > 5000) this._lost();
    }, 1000);
    this._emit('open');
  }
  _attach(ch) {
    ch.binaryType = 'arraybuffer';
    if (ch.label === 'control') { this.control = ch; ch.onmessage = e => this._onControl(e.data); }
    else { this.transfer = ch; ch.onmessage = e => this._emit('binary', e.data); }
    ch.onopen = () => this._check();
    ch.onclose = () => this._lost();
    this._check();
  }
  _onControl(data) {
    const m = parse(data); if (!m) return;
    this.last = Date.now();
    if (m.t === 'ping') return this.sendControl({ t: 'pong', ts: m.ts });
    if (m.t === 'pong') { this.rtt = Math.round(performance.now() - m.ts); return this._emit('rtt', this.rtt); }
    this._emit('msg', m);
  }
  _lost() {
    if (this.dead) return; this.dead = true; clearInterval(this._hb); this._emit('lost');
  }
  sendControl(o) { if (this.control?.readyState === 'open') this.control.send(JSON.stringify(o)); }
  // Отправка бинарной части с контролем backpressure
  async sendBinary(buf) {
    const ch = this.transfer;
    if (!ch || ch.readyState !== 'open') throw new Error('Канал передачи закрыт');
    if (ch.bufferedAmount > 1048576) {
      await Promise.race([
        new Promise(r => { ch.bufferedAmountLowThreshold = 262144; ch.onbufferedamountlow = () => { ch.onbufferedamountlow = null; r(); }; }),
        new Promise(r => this.addEventListener('lost', r, { once: true }))
      ]);
    }
    ch.send(buf);
  }
  // Сторона-инициатор (экран): создаёт каналы и код-приглашение
  async createOffer() {
    this._attach(this.pc.createDataChannel('control'));
    this._attach(this.pc.createDataChannel('transfer'));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await gathered(this.pc);
    return pack(this.pc.localDescription);
  }
  async acceptAnswer(code) { await this.pc.setRemoteDescription(await unpack(code)); }
  // Сторона-ответчик (телефон): принимает приглашение, возвращает код-ответ
  async acceptOffer(code) {
    await this.pc.setRemoteDescription(await unpack(code));
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await gathered(this.pc);
    return pack(this.pc.localDescription);
  }
  async stats() {
    const rep = await this.pc.getStats(); let pair;
    rep.forEach(r => { if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || !pair)) pair = r; });
    return { local: rep.get(pair?.localCandidateId)?.candidateType, remote: rep.get(pair?.remoteCandidateId)?.candidateType, rttMs: this.rtt };
  }
  close() { this._lost(); try { this.pc.close(); } catch {} }
}
