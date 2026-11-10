// Настройки приложения: хранение в localStorage, подписки на изменения,
// автоматическая привязка к форме на экране «Настройки» (элементы с data-setting).

const STORAGE_KEY = 'videopovtor.settings.v1';

export const DEFAULTS = {
  quality: 1080,            // 720 | 1080
  fps: 30,                  // 30 | 60
  cameraId: '',             // '' = задняя камера
  recordAudio: true,
  postRoll: 1,              // секунд, 0–3
  minDuration: 1,           // секунд
  controlMode: 'buttons',   // buttons | external | voice
  startDuringReplay: 'close', // close | ask
  venueLabel: 'Площадка 1',
  maxClips: 100,
  keyToggle: 'Space',
  keyReplay: 'KeyR',
  extEnabled: false,        // внешний экран (ноутбук) — по умолчанию выключен
  extAutoSend: true,        // заранее отправлять каждый новый клип на экран
  extShowLocal: false,      // показывать видео и на телефоне (без гарантии синхронности)
  extStun: '',              // необязательный STUN-сервер; пусто = только локальная сеть
};

let current = { ...DEFAULTS };
const subs = new Set();

export function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    current = { ...DEFAULTS, ...raw };
  } catch (_) {
    current = { ...DEFAULTS };
  }
  return current;
}

export const getSettings = () => current;

/** Изменить настройки. Подписчики получают список изменённых ключей. */
export function setSettings(patch) {
  const changed = Object.keys(patch).filter((k) => current[k] !== patch[k]);
  if (!changed.length) return;
  current = { ...current, ...patch };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch (_) {}
  for (const fn of subs) fn(changed, current);
}

export function onSettingsChange(fn) { subs.add(fn); return () => subs.delete(fn); }

/** Человекочитаемое название клавиши. */
export function prettyKey(id) {
  if (!id) return '— не задана —';
  const map = { Space: 'Пробел', Enter: 'Enter', AudioVolumeUp: 'Громкость +', AudioVolumeDown: 'Громкость −',
    VolumeUp: 'Громкость +', VolumeDown: 'Громкость −', MediaPlayPause: 'Play/Pause' };
  return map[id] || id;
}

function readValue(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.dataset.type === 'number') {
    const n = parseFloat(String(el.value).replace(',', '.'));
    return Number.isFinite(n) ? n : DEFAULTS[el.dataset.setting];
  }
  return el.value;
}

function writeValue(el, v) {
  if (el.type === 'checkbox') el.checked = !!v; else el.value = String(v);
}

/** Привязать форму: показать текущие значения и сохранять изменения. */
export function bindSettingsForm(root) {
  const refresh = () => {
    root.querySelectorAll('[data-setting]').forEach((el) => writeValue(el, current[el.dataset.setting]));
    root.querySelectorAll('[data-key-for]').forEach((el) => { el.textContent = prettyKey(current[el.dataset.keyFor]); });
  };
  refresh();

  root.addEventListener('change', (e) => {
    const el = e.target.closest('[data-setting]');
    if (!el) return;
    setSettings({ [el.dataset.setting]: readValue(el) });
  });

  // Назначение клавиши: следующая нажатая клавиша запоминается
  root.querySelectorAll('[data-capture]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.capture;
      const old = btn.textContent;
      btn.textContent = 'Нажмите клавишу…';
      const finish = (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        window.removeEventListener('keydown', finish, true);
        btn.textContent = old;
        if (e.key !== 'Escape') setSettings({ [key]: e.code || e.key });
        refresh();
      };
      window.addEventListener('keydown', finish, true);
    });
  });

  return refresh;
}
