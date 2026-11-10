// Плеер повтора: замедление, покадровый шаг, перемотка, цикл.
// Длительность для ползунка берём из сохранённых метаданных клипа (durationMs),
// потому что у видео из MediaRecorder video.duration часто равен Infinity или NaN.

const REAL_DURATION_TIMEOUT_MS = 1500;

export class Player {
  /** @param {HTMLVideoElement} video @param {(state:object)=>void} onUpdate */
  constructor(video, onUpdate) {
    this.video = video;
    this.onUpdate = onUpdate || (() => {});
    this.url = null;
    this.clip = null;
    this.duration = 0;   // секунды (из метаданных)
    this.fps = 30;
    this.rate = 1;
    this.raf = 0;
    video.addEventListener('ended', () => this._push());
    video.addEventListener('pause', () => this._push());
    video.addEventListener('play', () => this._push());
  }

  /** Открыть клип и сразу начать воспроизведение. */
  async open(clip, blob) {
    this.close();
    this.clip = clip;
    this.fps = clip.fps > 0 ? clip.fps : 30;
    this.duration = (clip.durationMs || 0) / 1000;

    const v = this.video;
    this.url = URL.createObjectURL(blob);
    v.preload = 'auto';
    v.muted = true;
    v.loop = false;
    v.src = this.url;

    await new Promise((res) => {
      if (v.readyState >= 1) return res();
      const done = () => { v.removeEventListener('loadedmetadata', done); v.removeEventListener('error', done); res(); };
      v.addEventListener('loadedmetadata', done);
      v.addEventListener('error', done);
      setTimeout(done, 4000);
    });

    await this._fixDuration();
    v.playbackRate = this.rate;
    v.currentTime = 0;
    try { await v.play(); } catch (_) { /* автозапуск мог быть заблокирован — пользователь нажмёт ▶ */ }
    this._loop();
    this._push();
  }

  /**
   * Обход проблемы MediaRecorder: duration = Infinity.
   * Временно перематываем в «бесконечность» — браузер вычисляет реальную длительность.
   */
  _fixDuration() {
    const v = this.video;
    if (Number.isFinite(v.duration) && v.duration > 0) return Promise.resolve();
    return new Promise((res) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        v.removeEventListener('timeupdate', onTime);
        v.removeEventListener('durationchange', onTime);
        try { v.currentTime = 0; } catch (_) {}
        res();
      };
      const onTime = () => { if (Number.isFinite(v.duration)) finish(); };
      v.addEventListener('timeupdate', onTime);
      v.addEventListener('durationchange', onTime);
      try { v.currentTime = 1e101; } catch (_) { finish(); }
      setTimeout(finish, REAL_DURATION_TIMEOUT_MS);
    });
  }

  close() {
    cancelAnimationFrame(this.raf);
    const v = this.video;
    try { v.pause(); } catch (_) {}
    v.removeAttribute('src');
    v.load();
    if (this.url) { URL.revokeObjectURL(this.url); this.url = null; } // освобождаем память
    this.clip = null;
  }

  // ---- управление ------------------------------------------------------------
  /** @param {'toggle'|'play'|'pause'|'step'|'seekBy'|'seek'|'rate'|'loop'|'mute'} cmd */
  control(cmd, value) {
    const v = this.video;
    if (!this.clip) return;
    const end = this._end();
    switch (cmd) {
      case 'toggle':
        if (v.paused || v.ended) {
          if (v.ended || v.currentTime >= end - 0.05) v.currentTime = 0;
          v.play().catch(() => {});
        } else v.pause();
        break;
      case 'play': v.play().catch(() => {}); break;
      case 'pause': v.pause(); break;
      case 'step': // покадровый шаг: value = ±1 кадр
        v.pause();
        v.currentTime = Math.min(end, Math.max(0, v.currentTime + value / this.fps));
        break;
      case 'seekBy':
        v.currentTime = Math.min(end, Math.max(0, v.currentTime + value));
        break;
      case 'seek':
        v.currentTime = Math.min(end, Math.max(0, value));
        break;
      case 'rate':
        this.rate = value;
        v.playbackRate = value;
        break;
      case 'loop': v.loop = value === undefined ? !v.loop : !!value; break;
      case 'mute': v.muted = value === undefined ? !v.muted : !!value; break;
    }
    this._push();
  }

  /** Конец клипа в секундах: реальная длительность видео, если известна, иначе из метаданных. */
  _end() {
    const d = this.video.duration;
    if (Number.isFinite(d) && d > 0) return d;
    return this.duration;
  }

  state() {
    const v = this.video;
    return {
      time: v.currentTime || 0,
      duration: this.duration || this._end(),
      paused: v.paused,
      rate: this.rate,
      loop: v.loop,
      muted: v.muted,
    };
  }

  _push() { this.onUpdate(this.state()); }

  _loop() {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (!this.clip) return;
      this._push();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
}
