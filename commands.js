// Шина команд и адаптеры источников команд.
// Принцип: источники (кнопки, клавиши, голос) только публикуют команды в шину
// и ничего не знают о рекордере. Рекордер и UI только подписываются на шину.

export const CMD = {
  START: 'START',     // начать запись («Бой»)
  STOP: 'STOP',       // закончить запись («Стоп»)
  TOGGLE: 'TOGGLE',   // одна кнопка: старт, если записи нет, иначе стоп
  REPLAY: 'REPLAY',   // открыть повтор последнего клипа
};

const listeners = new Map(); // команда -> Set функций

/** Подписаться на команду. Возвращает функцию отписки. */
export function subscribe(cmd, fn) {
  if (!listeners.has(cmd)) listeners.set(cmd, new Set());
  listeners.get(cmd).add(fn);
  return () => listeners.get(cmd).delete(fn);
}

/** Опубликовать команду. source — для отладки ('screen' | 'keyboard' | 'media' | 'voice'). */
export function publish(cmd, source = 'unknown') {
  const set = listeners.get(cmd);
  if (!set) return;
  for (const fn of [...set]) {
    try { fn({ cmd, source, at: Date.now() }); } catch (e) { console.error('Ошибка обработчика команды', cmd, e); }
  }
}

// ---------------------------------------------------------------------------
// Адаптер: клавиатура и медиа-клавиши (Bluetooth-кликер, кнопка гарнитуры)
// ---------------------------------------------------------------------------
const MEDIA_TOGGLE = ['MediaPlayPause', 'MediaStop', 'MediaPause', 'MediaPlay'];
const MEDIA_REPLAY = ['MediaTrackNext', 'MediaTrackPrevious'];

/** Идентификатор клавиши для настроек: code, а если его нет — key. */
export function keyId(e) { return e.code || e.key; }

export class KeyboardAdapter {
  /** getKeys() -> { toggle, replay } — актуальные клавиши из настроек */
  constructor(getKeys) {
    this.getKeys = getKeys;
    this.enabled = false;
    this._down = (e) => this._onKey(e, true);
    this._up = (e) => this._onKey(e, false);
  }
  enable() {
    if (this.enabled) return;
    this.enabled = true;
    window.addEventListener('keydown', this._down);
    window.addEventListener('keyup', this._up);
  }
  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    window.removeEventListener('keydown', this._down);
    window.removeEventListener('keyup', this._up);
  }
  _match(e) {
    const { toggle, replay } = this.getKeys();
    const ids = [e.code, e.key].filter(Boolean);
    const has = (k) => k && ids.includes(k);
    if (has(toggle) || ids.some((i) => MEDIA_TOGGLE.includes(i))) return CMD.TOGGLE;
    if (has(replay) || ids.some((i) => MEDIA_REPLAY.includes(i))) return CMD.REPLAY;
    return null;
  }
  _onKey(e, isDown) {
    const t = e.target;
    if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return; // не мешаем вводу в настройках
    const cmd = this._match(e);
    if (!cmd) return;
    e.preventDefault(); // чтобы пробел не «нажимал» кнопку на экране второй раз
    if (isDown && !e.repeat) publish(cmd, 'keyboard');
  }
}

// ---------------------------------------------------------------------------
// Адаптер: Media Session (кнопки гарнитуры, блокировочный экран)
// Внимание: браузер отдаёт эти события странице только при «активном» медиа —
// на части устройств они не приходят. Подробности — в README.
// ---------------------------------------------------------------------------
export class MediaSessionAdapter {
  enable() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: 'Видеоповтор боя', artist: 'Бой / Стоп' });
      navigator.mediaSession.playbackState = 'playing';
    } catch (_) { /* не критично */ }
    const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch (_) {} };
    set('play', () => publish(CMD.TOGGLE, 'media'));
    set('pause', () => publish(CMD.TOGGLE, 'media'));
    set('stop', () => publish(CMD.TOGGLE, 'media'));
    set('nexttrack', () => publish(CMD.REPLAY, 'media'));
    set('previoustrack', () => publish(CMD.REPLAY, 'media'));
  }
  disable() {
    if (!('mediaSession' in navigator)) return;
    for (const a of ['play', 'pause', 'stop', 'nexttrack', 'previoustrack']) {
      try { navigator.mediaSession.setActionHandler(a, null); } catch (_) {}
    }
    try { navigator.mediaSession.playbackState = 'none'; } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Адаптер: голос (ЭКСПЕРИМЕНТАЛЬНО). Слова «бой» и «стоп».
// ---------------------------------------------------------------------------
const RE_START = /(^|[^а-яё])бо[йи]([^а-яё]|$)/i;
const RE_STOP = /(^|[^а-яё])(стоп|стой|stop)([^а-яё]|$)/i;

export class VoiceAdapter extends EventTarget {
  constructor() {
    super();
    this.enabled = false;
    this.rec = null;
    this.fired = new Set();
    this.log = [];
  }
  static get supported() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }

  enable() {
    if (this.enabled) return true;
    if (!VoiceAdapter.supported) {
      this._emit('error', { message: 'Голосовое управление не поддерживается этим браузером' });
      return false;
    }
    this.enabled = true;
    this._begin();
    return true;
  }
  disable() {
    this.enabled = false;
    this._emit('listening', { on: false });
    try { this.rec && this.rec.abort(); } catch (_) {}
    this.rec = null;
  }

  _begin() {
    if (!this.enabled) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = 'ru-RU';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    this.fired.clear();

    rec.onstart = () => this._emit('listening', { on: true });
    rec.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const text = ev.results[i][0].transcript.trim().toLowerCase();
        if (!text) continue;
        this._emit('heard', { text, final: ev.results[i].isFinal });
        // Реагируем на промежуточный результат, но один раз на каждое слово в каждом результате
        for (const [re, cmd] of [[RE_STOP, CMD.STOP], [RE_START, CMD.START]]) {
          const key = `${i}:${cmd}`;
          if (re.test(text) && !this.fired.has(key)) {
            this.fired.add(key);
            publish(cmd, 'voice');
            break; // «стоп» приоритетнее «боя» в одной фразе
          }
        }
        if (ev.results[i].isFinal) {
          this.fired.delete(`${i}:${CMD.STOP}`);
          this.fired.delete(`${i}:${CMD.START}`);
        }
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.enabled = false;
        this._emit('error', { message: 'Нет доступа к микрофону или службе распознавания речи', fatal: true });
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        this._emit('error', { message: 'Ошибка распознавания: ' + e.error });
      }
    };
    rec.onend = () => {
      this._emit('listening', { on: false });
      // Автоперезапуск: браузер сам завершает сессию через некоторое время
      if (this.enabled) setTimeout(() => this._begin(), 300);
    };
    this.rec = rec;
    try { rec.start(); } catch (_) { setTimeout(() => this._begin(), 800); }
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}
