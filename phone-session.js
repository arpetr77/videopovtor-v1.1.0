// Сторона телефона: предварительная отправка клипа, команды показа, диагностика.
// Никаких зависимостей от рекордера: только getRecorderState() (чтение состояния).
// Правило: передача идёт ТОЛЬКО когда рекордер в состоянии IDLE.
import { Transport } from './transport.js';
import { CHUNK, V, sleep } from './protocol.js';

const BIG = 256 * 1024; // читаем клип с диска срезами по 256 КБ, не целиком

export function createPhoneSession({ getRecorderState = () => 'IDLE', onEvent = () => {}, iceServers = [], transport = null } = {}) {
  const tr = transport || new Transport(iceServers);
  const s = { connected: false, clips: {}, tid: 0, abort: false };
  const w = {}; // ожидатели ответов
  const emit = (type, data) => { try { onEvent({ type, ...data }); } catch {} };
  const canSend = () => s.connected && getRecorderState() === 'IDLE';

  tr.addEventListener('open', () => { s.connected = true; tr.sendControl({ t: 'hello', v: V }); emit('status', { text: 'Подключено', connected: true }); });
  tr.addEventListener('lost', () => { s.connected = false; emit('status', { text: 'Соединение потеряно', lost: true }); });
  tr.addEventListener('rtt', e => emit('rtt', { rtt: e.detail }));
  tr.addEventListener('msg', e => {
    const m = e.detail;
    if (m.t === 'hello' && m.v !== V) emit('status', { text: 'Несовместимая версия протокола', error: true });
    else if (m.t === 'prepared') w.prepared?.(m);
    else if (m.t === 'ready') { s.clips[m.clipId] = 'ready'; emit('ready', { clipId: m.clipId }); }
    else if (m.t === 'state') emit('state', { state: m });
    else if (m.t === 'testDone') w.test?.(m);
  });

  // Ждём, пока можно слать; при записи ставим передачу на паузу
  let paused = false;
  async function gate(clipId) {
    while (!canSend()) {
      if (!s.connected) throw new Error('Соединение потеряно');
      if (s.abort) return false;
      if (!paused) { paused = true; emit('paused', { clipId, paused: true }); }
      await sleep(100);
    }
    if (paused) { paused = false; emit('paused', { clipId, paused: false }); }
    return !s.abort;
  }

  // Предварительная отправка клипа (НЕ запускает показ)
  async function sendClip(clipId, blob, meta = {}) {
    const tid = ++s.tid; s.abort = false; s.clips[clipId] = 'sending';
    const answer = new Promise(r => { w.prepared = r; });
    tr.sendControl({ t: 'prepare', clipId, tid, size: blob.size, meta });
    const p = await Promise.race([answer, sleep(5000).then(() => null)]);
    if (!p) throw new Error('Экран не ответил');
    if (p.ready) { s.clips[clipId] = 'ready'; return emit('ready', { clipId }); }
    let off = p.have || 0, lastEmit = 0; // докачка с места, которое уже есть на экране
    while (off < blob.size) {
      if (!(await gate(clipId))) return;
      const big = new Uint8Array(await blob.slice(off, off + BIG).arrayBuffer());
      for (let i = 0; i < big.length; i += CHUNK) {
        if (!(await gate(clipId))) return;
        const part = big.subarray(i, i + CHUNK);
        const buf = new Uint8Array(4 + part.length);
        new DataView(buf.buffer).setUint32(0, tid); buf.set(part, 4);
        await tr.sendBinary(buf);
        if (performance.now() - lastEmit > 200) { lastEmit = performance.now(); emit('progress', { clipId, bytes: off + i + part.length, size: blob.size }); }
      }
      off += big.length;
    }
    emit('progress', { clipId, bytes: blob.size, size: blob.size });
  }

  // Проверка связи: тестовые данные, скорость, RTT, тип соединения
  async function runDiagnostics(mb = 10) {
    if (!canSend()) throw new Error('Проверка возможна только когда запись не идёт');
    const size = mb << 20, chunk = new Uint8Array(4 + CHUNK);
    const done = new Promise(r => { w.test = r; });
    tr.sendControl({ t: 'testStart', size });
    const t0 = performance.now();
    for (let o = 0; o < size; o += CHUNK) await tr.sendBinary(chunk);
    const r = await Promise.race([done, sleep(30000).then(() => null)]);
    const sec = (performance.now() - t0) / 1000;
    return { ok: !!r, seconds: +sec.toFixed(2), mbitPerSec: +(size * 8 / 1e6 / sec).toFixed(1), ...(await tr.stats()) };
  }

  return {
    transport: tr, status: s,
    acceptOffer: code => tr.acceptOffer(code),          // вернёт код-ответ для ноутбука
    sendClip, runDiagnostics,
    cancel: () => { s.abort = true; tr.sendControl({ t: 'cancel' }); },
    cmd: (name, args = {}) => tr.sendControl({ t: name, ...args }), // show, play, pause, seek, rate, loop, step, mute, hide
    close: () => tr.close()
  };
}
