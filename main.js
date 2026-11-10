// Запуск приложения и связывание модулей.

import { CMD, publish, subscribe, KeyboardAdapter, MediaSessionAdapter, VoiceAdapter } from './commands.js';
import { loadSettings, getSettings, onSettingsChange, bindSettingsForm } from './settings.js';
import { Camera, keepAwake } from './camera.js';
import { Recorder, RS } from './recorder.js';
import { Player } from './player.js';
import { createOutputs } from './outputs.js';
import * as store from './store.js';
import * as ui from './ui.js';
import { $, $$ } from './ui.js';

const APP_VERSION = '1.1.1';

// ---------------------------------------------------------------------------
// Проверка окружения
// ---------------------------------------------------------------------------
function checkSupport() {
  if (!window.isSecureContext) {
    return 'Приложение открыто не по HTTPS, поэтому браузер не даст доступ к камере. Откройте сайт по адресу, который начинается с https://';
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return 'Этот браузер не даёт доступ к камере. Используйте Safari на iOS 16.4+ или Chrome на Android.';
  }
  if (!window.MediaRecorder) {
    return 'Этот браузер не умеет записывать видео. Используйте Safari на iOS 16.4+ или Chrome на Android.';
  }
  if (!window.indexedDB) {
    return 'В этом браузере недоступно хранилище для видео (возможно, включён приватный режим). Откройте сайт в обычной вкладке.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Состояние
// ---------------------------------------------------------------------------
const camera = new Camera();
let recorder;
let player;
let outputs;
let clipsCache = [];            // список клипов (новые сверху)
const blobCache = new Map();    // id -> Blob (только самый свежий клип, чтобы повтор открывался мгновенно)
let pendingCameraRestart = false;
let hiddenDuringRecording = false;
let cleanMode = false;
let ext = null;                // модуль внешнего экрана (загружается только если включён в настройках)
let extDialog = null;
let replayClip = null;         // клип, открытый на экране повтора

const keyboard = new KeyboardAdapter(() => ({ toggle: getSettings().keyToggle, replay: getSettings().keyReplay }));
const mediaSession = new MediaSessionAdapter();
const voice = new VoiceAdapter();

const latestClip = () => clipsCache.find((c) => c.status !== 'recording') || null;
const hasClip = () => !!latestClip();

function refreshRecUi() {
  ui.setRecState(recorder.state, { hasClip: hasClip() });
}

async function reloadClips() {
  clipsCache = (await store.listClips()).filter((c) => c.status !== 'recording');
  ui.setReplayThumb(latestClip() ? latestClip().thumb : null);
  refreshRecUi();
  if (ui.currentScreen() === 'clips') renderClipsScreen();
}

// ---------------------------------------------------------------------------
// Камера
// ---------------------------------------------------------------------------
function effectiveAudio() {
  const s = getSettings();
  return s.recordAudio && s.controlMode !== 'voice'; // голос и запись звука конфликтуют за микрофон
}

async function startCamera() {
  const s = getSettings();
  try {
    const info = await camera.start({ quality: s.quality, fps: s.fps, deviceId: s.cameraId, audio: effectiveAudio() });
    ui.setCamInfo(info, camera.audioOk);
    ui.hideAlert();
    ui.fillCameraSelect(await camera.listCameras(), s.cameraId);
    return true;
  } catch (e) {
    ui.setCamInfo(null);
    ui.showAlert(e.message, { action: 'Повторить' });
    return false;
  }
}

async function restartCamera() {
  if (recorder.busy) { pendingCameraRestart = true; ui.toast('Настройки камеры применятся после остановки записи'); return; }
  pendingCameraRestart = false;
  await startCamera();
}

camera.addEventListener('ended', () => {
  recorder.cameraLost();
  ui.showAlert('Камера отключилась.', { action: 'Переподключить камеру' });
});
camera.addEventListener('mute', () => {
  if (recorder.busy) ui.showAlert('Камера приостановлена системой — запись может быть неполной.', { action: 'Переподключить камеру', soft: true });
});
camera.addEventListener('unmute', () => { if (camera.ready) ui.hideAlert(); });
camera.addEventListener('audio-unavailable', () => ui.toast('Микрофон недоступен — запись без звука', 'warn', 4000));

$('#alert-btn').addEventListener('click', async () => {
  if (recorder.busy) recorder.cameraLost();
  await startCamera();
});

// ---------------------------------------------------------------------------
// Команды
// ---------------------------------------------------------------------------
function doStart() {
  const screen = ui.currentScreen();
  if (screen === 'replay') {
    if (getSettings().startDuringReplay === 'ask' && !window.confirm('Идёт повтор. Закрыть повтор и начать запись?')) return;
    closeReplay();
  } else if (screen !== 'record') {
    ui.showScreen('record');
  }
  recorder.start();
}

subscribe(CMD.START, doStart);
subscribe(CMD.STOP, () => recorder.stop());
subscribe(CMD.TOGGLE, () => (recorder.state === RS.IDLE ? doStart() : recorder.stop()));
subscribe(CMD.REPLAY, () => {
  if (recorder.busy) { ui.toast('Во время записи повтор недоступен'); return; }
  const clip = latestClip();
  if (!clip) { ui.toast('Пока нет клипов для повтора'); return; }
  openReplay(clip);
});

// Источник «экранные кнопки»
$('#btn-fight').addEventListener('click', () => publish(CMD.TOGGLE, 'screen'));
$('#btn-replay').addEventListener('click', () => publish(CMD.REPLAY, 'screen'));
$('#btn-clips').addEventListener('click', () => { renderClipsScreen(); ui.showScreen('clips'); });
$('#btn-settings').addEventListener('click', () => { ui.showScreen('settings'); updateStorageInfo(); });
$$('[data-back]').forEach((b) => b.addEventListener('click', () => ui.showScreen('record')));

// ---------------------------------------------------------------------------
// Рекордер → UI
// ---------------------------------------------------------------------------
function wireRecorder() {
  let prevState = RS.IDLE;
  recorder.addEventListener('state', (e) => {
    const st = e.detail.state;
    refreshRecUi();
    if (st === RS.RECORDING) {
      navigator.vibrate && navigator.vibrate(60);          // старт записи
      hiddenDuringRecording = false;
    } else if (prevState === RS.RECORDING) {
      navigator.vibrate && navigator.vibrate([50, 70, 50]); // стоп
    }
    prevState = st;
    if (st === RS.IDLE && pendingCameraRestart) restartCamera();
    if (st === RS.IDLE) updateStorageInfo();
  });
  recorder.addEventListener('tick', (e) => ui.setTimer(e.detail.ms));
  recorder.addEventListener('notice', (e) => ui.toast(e.detail.text, e.detail.level, e.detail.level === 'error' ? 4500 : 2600));
  recorder.addEventListener('saved', async (e) => {
    const { clip, blob } = e.detail;
    blobCache.clear();
    blobCache.set(clip.id, blob);
    if (ext) ext.onSaved(clip, blob); // предзагрузка на внешний экран в фоне (передача ждёт IDLE)
    await reloadClips();
  });
  recorder.addEventListener('discarded', reloadClips);
  recorder.addEventListener('cleaned', () => reloadClips());
}

// ---------------------------------------------------------------------------
// Повтор
// ---------------------------------------------------------------------------
async function openReplay(clip) {
  replayClip = clip;
  ui.showScreen('replay');
  setClean(false);
  ui.setReplayTitle(`${ui.fmtDate(clip.endedAt || clip.startedAt)} · ${clip.label || ''}`);
  const timerStart = performance.now();
  let blob = blobCache.get(clip.id);
  if (!blob) {
    blob = await store.getBlob(clip.id);
    if (!blob) { ui.toast('Видео клипа не найдено', 'error'); ui.showScreen('record'); return; }
    blobCache.clear();
    blobCache.set(clip.id, blob);
  }
  if (ui.currentScreen() !== 'replay') return; // успели закрыть
  outputs.active = ext && ext.shouldUse() ? ext.adapter : outputs.local;
  await outputs.active.play(clip, { blob });
  console.debug('Повтор открыт за', Math.round(performance.now() - timerStart), 'мс');
}

function closeReplay() {
  replayClip = null;
  setClean(false);
  outputs.active.disconnect();
  ui.showScreen('record'); // камера не перезапускается
}

function setClean(on) {
  cleanMode = on;
  $('#screen-replay').classList.toggle('clean', on);
  if (on) {
    ui.toast('Двойное касание — выйти из чистого экрана', 'info', 2500);
    const el = document.documentElement;
    if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  } else if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
}

function wireReplay() {
  $('#rp-close').addEventListener('click', closeReplay);
  $('#rp-clean').addEventListener('click', () => setClean(true));
  // Переключатель «Показ: внешний экран / телефон» (виден только при подключённом экране)
  $('#rp-ext').addEventListener('click', async () => {
    if (!ext || !ext.connected) return;
    ext.setUseExt(!ext.useExt);
    if (replayClip) { await outputs.active.disconnect(); await openReplay(replayClip); }
  });

  $$('[data-rp]').forEach((b) => b.addEventListener('click', () => {
    const cmd = b.dataset.rp;
    const v = b.dataset.v === undefined ? undefined : Number(b.dataset.v);
    outputs.active.control(cmd, v);
  }));

  const seek = $('#rp-seek');
  seek.addEventListener('input', () => outputs.active.control('seek', Number(seek.value) / 1000));
  const drag = (on) => () => { ui.seekState.dragging = on; };
  seek.addEventListener('pointerdown', drag(true));
  window.addEventListener('pointerup', drag(false));
  window.addEventListener('pointercancel', drag(false));

  // «Чистый экран»: касание — пауза/пуск, двойное касание — выход
  let lastTap = 0;
  $('#player-wrap').addEventListener('click', () => {
    if (!cleanMode) return;
    outputs.active.control('toggle');
    const now = Date.now();
    if (now - lastTap < 350) { setClean(false); lastTap = 0; } else lastTap = now;
  });
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && cleanMode) setClean(false);
  });
}

// ---------------------------------------------------------------------------
// Клипы
// ---------------------------------------------------------------------------
function renderClipsScreen() {
  ui.renderClips(clipsCache, {
    play: (c) => openReplay(c),
    share: shareClip,
    pin: async (c) => { await store.updateClip(c.id, { pinned: !c.pinned }); await reloadClips(); },
    del: async (c) => {
      if (!window.confirm('Удалить этот клип?')) return;
      await store.deleteClip(c.id);
      blobCache.delete(c.id);
      await reloadClips();
    },
  });
}

async function shareClip(clip) {
  const blob = await store.getBlob(clip.id);
  if (!blob) { ui.toast('Видео клипа не найдено', 'error'); return; }
  const name = clip.fileName || 'clip.' + (clip.mimeType === 'video/mp4' ? 'mp4' : 'webm');
  const file = new File([blob], name, { type: clip.mimeType });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e.name === 'AbortError') return; /* иначе — обычное скачивание */ }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 15000);
}

// ---------------------------------------------------------------------------
// Источники команд по настройкам
// ---------------------------------------------------------------------------
function configureSources() {
  const mode = getSettings().controlMode;
  if (mode === 'external') { keyboard.enable(); mediaSession.enable(); }
  else { keyboard.disable(); mediaSession.disable(); }

  if (mode === 'voice') {
    if (voice.enable()) ui.setVoice({ enabled: true, text: 'слушаю…' });
    else { ui.setVoice({ enabled: false }); }
  } else {
    voice.disable();
    ui.setVoice({ enabled: false });
  }
}

voice.addEventListener('heard', (e) => { ui.setVoice({ enabled: true, text: '«' + e.detail.text + '»' }); if (e.detail.final) ui.addVoiceLog(e.detail.text); });
voice.addEventListener('listening', (e) => { if (getSettings().controlMode === 'voice') ui.setVoice({ enabled: true, text: e.detail.on ? 'слушаю…' : 'перезапуск…' }); });
voice.addEventListener('error', (e) => { ui.toast(e.detail.message, 'warn', 4000); });

// ---------------------------------------------------------------------------
// Батарея, место, wake lock
// ---------------------------------------------------------------------------
async function initBattery() {
  if (!navigator.getBattery) return;
  try {
    const b = await navigator.getBattery();
    const upd = () => ui.setBattery(b.level, b.charging);
    b.addEventListener('levelchange', upd);
    b.addEventListener('chargingchange', upd);
    upd();
  } catch (_) {}
}

let lowWarned = false;
async function updateStorageInfo() {
  if (!navigator.storage || !navigator.storage.estimate) return;
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (!quota) return;
    const free = quota - usage;
    const low = free < 300e6;
    ui.setStorage(free, low);
    if (low && !lowWarned) { lowWarned = true; ui.toast('Мало свободного места — удалите старые клипы', 'warn', 5000); }
    if (!low) lowWarned = false;
  } catch (_) {}
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') {
    if (recorder && recorder.busy) hiddenDuringRecording = true;
    return;
  }
  if (!recorder) return;
  keepAwake(); // блокировка снимается при сворачивании — запрашиваем снова
  if (!camera.ready && !recorder.busy) await startCamera();
  if (hiddenDuringRecording) {
    hiddenDuringRecording = false;
    ui.showAlert('Приложение теряло фокус во время записи — проверьте, что клип записан полностью.', { soft: true });
    setTimeout(() => { if (camera.ready) ui.hideAlert(); }, 8000);
  }
});
window.addEventListener('blur', () => { if (recorder && recorder.state === RS.RECORDING) hiddenDuringRecording = true; });

// ---------------------------------------------------------------------------
// Service Worker
// ---------------------------------------------------------------------------
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          ui.toast('Вышла новая версия. Закройте и откройте приложение, когда запись не идёт.', 'info', 6000);
        }
      });
    });
  }).catch((e) => console.warn('Service Worker не зарегистрирован', e));
}

// ---------------------------------------------------------------------------
// Внешний экран (необязательный модуль: код в js/external/, грузится только при включении)
// ---------------------------------------------------------------------------
async function latestWithBlob() {
  const c = latestClip();
  if (!c) return null;
  const b = blobCache.get(c.id) || await store.getBlob(c.id);
  return b ? { clip: c, blob: b } : null;
}

function updateExtUi() {
  const chip = $('#ext-chip');
  chip.hidden = !ext;
  if (ext) { chip.textContent = ext.chipText(); chip.classList.toggle('low', !ext.connected); }
  const b = $('#rp-ext');
  b.hidden = !(ext && ext.connected);
  if (!b.hidden) b.textContent = ext.useExt ? 'Показ: внешний экран' : 'Показ: телефон';
  $('#ext-status').textContent = ext ? (ext.connected ? 'подключено' : 'не подключено') : 'выключено';
  $('#ext-opts').hidden = !getSettings().extEnabled;
  if (extDialog) extDialog.refresh();
}

async function syncExternal() {
  const want = !!getSettings().extEnabled;
  if (want && !ext) {
    try {
      const mod = await import('./external-output.js');
      const dlg = await import('./dialog.js');
      ext = mod.createExternal({
        local: outputs.local,
        getRecorderState: () => recorder.state,          // только чтение
        getSettings,
        getLatest: latestWithBlob,
        onChange: updateExtUi,
        onState: ui.updateReplay,                        // состояние с внешнего экрана → таймлайн на телефоне
        onMode: (mode) => { $('#rp-remote-note').hidden = mode !== 'remote'; },
        toast: ui.toast,
      });
      extDialog = dlg.createDialog({ root: $('#ext-dialog'), ext, isBusy: () => recorder.busy, toast: ui.toast });
      ext.setDialogOpener(extDialog.open);
    } catch (e) {
      console.warn('Модуль внешнего экрана не загружен', e);
      ui.toast('Не удалось загрузить модуль внешнего экрана', 'warn', 4000);
      ext = null; extDialog = null;
    }
  } else if (!want && ext) {
    ext.destroy();
    ext = null; extDialog = null;
    outputs.active = outputs.local;
    $('#rp-remote-note').hidden = true;
    $('#ext-dialog').hidden = true;
  }
  updateExtUi();
}

// ---------------------------------------------------------------------------
// Старт
// ---------------------------------------------------------------------------
async function init() {
  const problem = checkSupport();
  if (problem) { ui.showFatal(problem); return; }

  loadSettings();
  $('#app-version') && ($('#app-version').textContent = `Версия ${APP_VERSION}`);
  bindSettingsForm($('#screen-settings'));

  camera.attach($('#preview'));
  recorder = new Recorder(camera, getSettings);
  player = new Player($('#player'), ui.updateReplay);
  outputs = createOutputs(player, $('#player'));
  wireRecorder();
  wireReplay();
  $('#btn-ext-open').addEventListener('click', () => ext && ext.open());
  $('#ext-chip').addEventListener('click', () => ext && ext.open());
  await syncExternal();

  registerSW();
  try { navigator.storage && navigator.storage.persist && (await navigator.storage.persist()); } catch (_) {}

  // Восстановление клипов, прерванных закрытием вкладки
  try {
    const n = await store.recoverInterrupted();
    if (n) ui.toast(`Восстановлено прерванных клипов: ${n}`, 'warn', 5000);
  } catch (e) { console.warn('Восстановление не удалось', e); }
  await store.cleanup(Number(getSettings().maxClips) || 100).catch(() => {});
  await reloadClips();

  onSettingsChange((changed) => {
    const cameraKeys = ['quality', 'fps', 'cameraId', 'recordAudio', 'controlMode'];
    if (changed.some((k) => cameraKeys.includes(k))) restartCamera();
    if (changed.includes('controlMode')) configureSources();
    if (changed.includes('extEnabled')) syncExternal();
    if (changed.includes('maxClips')) store.cleanup(Number(getSettings().maxClips) || 100).then(reloadClips).catch(() => {});
  });

  keepAwake();
  initBattery();
  updateStorageInfo();
  setInterval(() => { if (!recorder.busy) updateStorageInfo(); }, 30000);

  await startCamera();
  configureSources();
}

init();
