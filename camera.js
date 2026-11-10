// Камера: один раз запрашиваем поток и держим его включённым на экране «Запись».

/** Превращает ошибку getUserMedia в понятное сообщение. */
function explain(e) {
  const map = {
    NotAllowedError: 'Нет доступа к камере. Разрешите камеру для этого сайта в настройках браузера и нажмите «Повторить».',
    SecurityError: 'Нет доступа к камере. Разрешите камеру для этого сайта в настройках браузера.',
    NotFoundError: 'Камера не найдена на этом устройстве.',
    NotReadableError: 'Камера занята другим приложением. Закройте его и нажмите «Повторить».',
    AbortError: 'Камера не запустилась. Нажмите «Повторить».',
    OverconstrainedError: 'Камера не поддерживает выбранное качество. Выберите 720p / 30 к/с в настройках.',
  };
  const err = new Error(map[e.name] || `Ошибка камеры: ${e.name || e.message}`);
  err.code = e.name;
  return err;
}

export class Camera extends EventTarget {
  constructor() {
    super();
    this.stream = null;
    this.videoEl = null;
    this.info = null;       // фактические параметры { width, height, frameRate, label }
    this.audioOk = false;
    this._token = 0;
  }

  attach(videoEl) { this.videoEl = videoEl; }

  /** Поток жив и трек видео работает. */
  get ready() {
    const t = this.stream && this.stream.getVideoTracks()[0];
    return !!t && t.readyState === 'live';
  }

  /** @param {{quality:number,fps:number,deviceId:string,audio:boolean}} o */
  async start({ quality = 1080, fps = 30, deviceId = '', audio = false } = {}) {
    this.stop();
    const token = ++this._token; // защита от гонки: актуален только последний запуск
    const h = quality === 720 ? 720 : 1080;
    const w = h === 720 ? 1280 : 1920;
    // Всё запрашиваем как ideal: если камера не умеет — браузер подберёт ближайшее
    const full = { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: fps } };
    if (deviceId) full.deviceId = { exact: deviceId };
    else full.facingMode = { ideal: 'environment' };

    // Запасные варианты: сначала упрощённые ограничения, в конце — любая камера
    const attempts = [full];
    if (deviceId) attempts.push({ facingMode: { ideal: 'environment' } });
    attempts.push({ facingMode: { ideal: 'environment' } }, true);

    const md = navigator.mediaDevices;
    let stream = null;
    let lastErr = null;
    this.audioOk = false;

    const tryGet = async (video, withAudio) => {
      try { return await md.getUserMedia({ video, audio: withAudio }); }
      catch (e) { lastErr = e; return null; }
    };

    for (const video of attempts) {
      stream = await tryGet(video, audio);
      if (stream) { this.audioOk = !!audio; break; }
      // Отказ в доступе к камере повторять бессмысленно — но микрофон мог быть причиной
      if (lastErr && lastErr.name === 'NotAllowedError' && !audio) break;
    }
    if (!stream && audio) {
      // Возможно, мешает микрофон — пробуем без звука
      for (const video of attempts) {
        stream = await tryGet(video, false);
        if (stream) { this.dispatchEvent(new CustomEvent('audio-unavailable')); break; }
      }
    }
    if (!stream) throw explain(lastErr || new Error('Камера не запустилась'));

    if (token !== this._token) { // за время ожидания запущена другая попытка — этот поток не нужен
      stream.getTracks().forEach((t) => t.stop());
      return this.info;
    }

    this.stream = stream;
    const track = stream.getVideoTracks()[0];
    const s = track.getSettings();
    this.info = { width: s.width, height: s.height, frameRate: Math.round(s.frameRate || 0), label: track.label };

    track.addEventListener('ended', () => { if (this.stream === stream) this.dispatchEvent(new CustomEvent('ended')); });
    track.addEventListener('mute', () => this.dispatchEvent(new CustomEvent('mute')));
    track.addEventListener('unmute', () => this.dispatchEvent(new CustomEvent('unmute')));

    if (this.videoEl) {
      this.videoEl.srcObject = stream;
      this.videoEl.play().catch(() => {});
    }
    this.dispatchEvent(new CustomEvent('started'));
    return this.info;
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    this.stream = null;
    if (this.videoEl) this.videoEl.srcObject = null;
  }

  /** Список камер (подписи доступны только после выдачи разрешения). */
  async listCameras() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter((d) => d.kind === 'videoinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Камера ${i + 1}` }));
    } catch (_) { return []; }
  }

  /** Кадр из живого превью → dataURL (миниатюра клипа). */
  captureFrame(maxW = 320) {
    const v = this.videoEl;
    if (!v || !v.videoWidth) return null;
    try {
      const c = document.createElement('canvas');
      const k = Math.min(1, maxW / v.videoWidth);
      c.width = Math.round(v.videoWidth * k);
      c.height = Math.round(v.videoHeight * k);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.7);
    } catch (_) { return null; }
  }
}

// ---- Screen Wake Lock: экран не гаснет ---------------------------------------
let wakeLock = null;
export async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (_) { /* не поддерживается или отказано — не критично */ }
}
