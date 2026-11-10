// Рекордер: конечный автомат записи. Не знает, откуда пришла команда.
// IDLE → (start) → RECORDING → (stop) → POST_ROLL (если включён) → FINALIZING → IDLE

import * as store from './store.js';

export const RS = { IDLE: 'IDLE', RECORDING: 'RECORDING', POST_ROLL: 'POST_ROLL', FINALIZING: 'FINALIZING' };

const DEAD_TIME_MS = 700;          // «мёртвое время» между командами (дребезг кнопки)
const TIMESLICE_MS = 1000;         // как часто части пишутся в IndexedDB
const MEMORY_KEEP_LIMIT = 150e6;   // до этого размера держим копию частей в памяти (быстрее собрать клип)
const MIN_FREE_BYTES = 50e6;       // меньше — не начинаем запись

// Порядок форматов: сначала mp4, затем webm
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=h264,opus',
  'video/webm',
];

export function pickMimeType() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

const baseMime = (m) => (m || 'video/webm').split(';')[0];
const extFor = (m) => (baseMime(m) === 'video/mp4' ? 'mp4' : 'webm');

function bitrate(quality, fps) {
  const base = quality === 720 ? 5e6 : 8e6;
  return fps >= 60 ? Math.round(base * 1.6) : base;
}

// ---- имя файла ---------------------------------------------------------------
const TRANSLIT = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };

export function slugify(label) {
  const s = String(label || '').toLowerCase().split('').map((ch) => (ch in TRANSLIT ? TRANSLIT[ch] : ch)).join('');
  return s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'court';
}

const p2 = (n) => String(n).padStart(2, '0');

/** YYYY-MM-DD_HH-MM-SS_<метка>.mp4 — локальное время ОКОНЧАНИЯ боя. */
export function makeFileName(endedAt, label, mime) {
  const d = new Date(endedAt);
  const date = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const time = `${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
  return `${date}_${time}_${slugify(label)}.${extFor(mime)}`;
}

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));

export class Recorder extends EventTarget {
  /** @param {import('./camera.js').Camera} camera @param {() => object} getSettings */
  constructor(camera, getSettings) {
    super();
    this.camera = camera;
    this.getSettings = getSettings;
    this.state = RS.IDLE;
    this.lastCmdAt = -1e9;
    this.rec = null;
    this._tick = null;
    this._postTimer = null;
  }

  get busy() { return this.state !== RS.IDLE; }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  _notice(text, level = 'info') { this._emit('notice', { text, level }); }
  _setState(s) { this.state = s; this._emit('state', { state: s }); }

  /** Подавление дребезга: true — команду нужно проигнорировать. */
  _dead() {
    const now = performance.now();
    if (now - this.lastCmdAt < DEAD_TIME_MS) return true;
    return false;
  }
  _accept() { this.lastCmdAt = performance.now(); }

  // =========================================================================
  // START
  // =========================================================================
  async start() {
    if (this._dead()) return;
    if (this.state !== RS.IDLE) {
      this._notice(this.state === RS.RECORDING ? 'Запись уже идёт' : 'Сохраняю предыдущий клип…');
      return;
    }
    if (!this.camera.ready) { this._notice('Камера не готова. Нажмите «Переподключить камеру».', 'error'); return; }

    // Место на устройстве
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const { quota, usage } = await navigator.storage.estimate();
        if (quota && quota - usage < MIN_FREE_BYTES) {
          this._notice('Не хватает места на устройстве. Удалите старые клипы.', 'error');
          return;
        }
      }
    } catch (_) {}
    if (this.state !== RS.IDLE) return; // за время await могла прийти другая команда

    const s = this.getSettings();
    const info = this.camera.info || {};
    const fps = info.frameRate || s.fps;
    const wanted = pickMimeType();
    const opts = { videoBitsPerSecond: bitrate(s.quality, s.fps) };
    if (wanted) opts.mimeType = wanted;

    // ---- ТОЧКА РАСШИРЕНИЯ: Pre-roll ---------------------------------------
    // Чтобы захватывать кадры ДО команды «Бой», здесь нужно запустить
    // «скользящую» запись (например, короткими сегментами по 1–2 с, которые
    // хранятся в кольцевом буфере), а при START — приклеить к клипу последние
    // сегменты буфера. В базовой версии не реализовано намеренно.
    // -----------------------------------------------------------------------

    let rec;
    try {
      rec = new MediaRecorder(this.camera.stream, opts);
    } catch (e) {
      try { rec = new MediaRecorder(this.camera.stream); }
      catch (e2) { this._notice('Не удалось начать запись: формат не поддерживается', 'error'); return; }
    }

    this._accept();
    this._storeErrShown = false;
    this.id = uuid();
    this.idx = 0;
    this.parts = [];
    this.bytes = 0;
    this.mime = baseMime(rec.mimeType || wanted);
    this.startedAt = Date.now();
    this._t0 = performance.now();
    this.endedAt = null;
    this.thumb = null;
    this.meta = {
      id: this.id, status: 'recording', startedAt: this.startedAt, endedAt: null, durationMs: 0,
      mimeType: this.mime, size: 0, fps, width: info.width, height: info.height,
      label: s.venueLabel, thumb: null, pinned: false, hasAudio: this.camera.audioOk,
    };

    const id = this.id;
    rec.ondataavailable = (e) => this._onData(id, e);
    rec.onerror = () => this._notice('Ошибка записи видео', 'error');
    rec.start(TIMESLICE_MS);
    this.rec = rec;

    // Запись клипа в статусе «recording» (нужна для восстановления). Части пишутся строго после неё.
    this._chain = store.putClip(this.meta).catch((e) => this._storeError(e));

    this._setState(RS.RECORDING);
    this._tick = setInterval(() => this._emit('tick', { ms: performance.now() - this._t0 }), 250);
    this._emit('tick', { ms: 0 });
  }

  _onData(id, e) {
    if (!e.data || !e.data.size || id !== this.id) return;
    const idx = this.idx++;
    this.bytes += e.data.size;
    if (this.parts) {
      this.parts.push(e.data);
      if (this.bytes > MEMORY_KEEP_LIMIT) this.parts = null; // слишком много — собирать будем из IndexedDB
    }
    const rec = { clipId: id, idx, blob: e.data, t: Date.now() };
    this._chain = this._chain.then(() => store.putChunk(rec)).catch((err) => this._storeError(err));
  }

  _storeError(err) {
    if (this._storeErrShown) return;
    this._storeErrShown = true;
    const quota = err && (err.name === 'QuotaExceededError' || /quota/i.test(err.message || ''));
    this._notice(quota ? 'Нет места на устройстве — запись может быть неполной' : 'Ошибка сохранения видео', 'error');
  }

  // =========================================================================
  // STOP
  // =========================================================================
  stop() {
    if (this._dead()) return;
    if (this.state === RS.IDLE) { this._notice('Запись не идёт'); return; }
    if (this.state !== RS.RECORDING) return; // уже останавливаемся
    this._accept();

    this.endedAt = Date.now();                    // время окончания боя — по команде «Стоп»
    this.thumb = this.camera.captureFrame(320);   // миниатюра — кадр в момент остановки

    const postMs = Math.max(0, Math.min(3, Number(this.getSettings().postRoll) || 0)) * 1000;
    if (postMs > 0) {
      this._setState(RS.POST_ROLL);
      this._postTimer = setTimeout(() => this._finalize('ready'), postMs);
    } else {
      this._finalize('ready');
    }
  }

  /** Камера пропала во время записи: сохраняем что есть как «прерванный» клип. */
  cameraLost() {
    if (this.state !== RS.RECORDING && this.state !== RS.POST_ROLL) return;
    clearTimeout(this._postTimer);
    if (!this.endedAt) { this.endedAt = Date.now(); this.thumb = null; }
    this._finalize('interrupted');
  }

  /** Строка со временем записи в мс (для таймера). */
  elapsed() { return this.state === RS.IDLE ? 0 : performance.now() - this._t0; }

  // =========================================================================
  // Завершение
  // =========================================================================
  async _finalize(status) {
    if (this.state === RS.FINALIZING) return;
    this._setState(RS.FINALIZING);
    clearInterval(this._tick);
    clearTimeout(this._postTimer);

    const rec = this.rec;
    const stoppedAt = performance.now();
    try {
      await new Promise((res) => {
        if (!rec || rec.state === 'inactive') return res();
        rec.onstop = () => res();
        try { rec.stop(); } catch (_) { res(); }
      });
      await this._chain; // дождаться записи всех частей в IndexedDB
    } catch (_) {}

    const s = this.getSettings();
    const durationMs = Math.round(stoppedAt - this._t0); // с учётом post-roll
    const minMs = Math.max(0, Number(s.minDuration) || 0) * 1000;
    const id = this.id;

    // Ложное срабатывание: слишком короткий клип не сохраняем
    if (status === 'ready' && durationMs < minMs) {
      try { await store.deleteClip(id); } catch (_) {}
      this._notice('Слишком короткий клип — не сохранён');
      this._emit('discarded', { id });
      this.rec = null;
      this._setState(RS.IDLE);
      return;
    }

    try {
      const blob = this.parts
        ? new Blob(this.parts, { type: this.mime })
        : await store.assembleBlob(id, this.mime);
      const endedAt = this.endedAt || Date.now();
      const clip = {
        ...this.meta,
        status, endedAt, durationMs, size: blob.size, thumb: this.thumb,
        fileName: makeFileName(endedAt, this.meta.label, this.mime),
      };
      await store.saveFinal(clip, blob);
      this._emit('saved', { clip, blob });
      if (status === 'interrupted') this._notice('Камера отключилась — клип сохранён как прерванный', 'warn');
      store.cleanup(Number(s.maxClips) || 100).then((n) => { if (n) this._emit('cleaned', { count: n }); }).catch(() => {});
    } catch (e) {
      // Части остаются в IndexedDB — при следующем запуске клип будет восстановлен
      this._notice('Не удалось сохранить клип: ' + (e && e.message ? e.message : 'ошибка'), 'error');
    }

    this.parts = null;
    this.rec = null;
    this._setState(RS.IDLE);
  }
}
