// Работа с DOM: экраны, индикаторы, список клипов. Логики записи здесь нет.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const p2 = (n) => String(n).padStart(2, '0');

/** 83000 → «1:23» */
export function fmtTimer(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${p2(s % 60)}`;
}
/** секунды → «1:23.45» */
export function fmtPlayer(sec) {
  const s = Math.max(0, sec || 0);
  const m = Math.floor(s / 60);
  return `${m}:${p2(Math.floor(s % 60))}.${p2(Math.floor((s % 1) * 100))}`;
}
export function fmtDate(ts) {
  const d = new Date(ts);
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
export function fmtBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' ГБ';
  return Math.round(b / 1e6) + ' МБ';
}

// ---- уведомления ----------------------------------------------------------------
let toastTimer = 0;
export function toast(text, level = 'info', ms = 2600) {
  const el = $('#toast');
  el.textContent = text;
  el.dataset.level = level;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---- экраны ----------------------------------------------------------------------
// Экран «Запись» всегда на месте под остальными, поэтому камера не перезапускается.
const OVERLAYS = ['replay', 'clips', 'settings'];
let current = 'record';
export const currentScreen = () => current;

export function showScreen(name) {
  for (const n of OVERLAYS) $('#screen-' + n).hidden = n !== name;
  current = name;
  document.body.dataset.screen = name;
}

export function showFatal(text) {
  $('#unsupported-text').textContent = text;
  $('#unsupported').hidden = false;
}

// ---- экран записи ------------------------------------------------------------------
export function setRecState(state, { hasClip }) {
  const chip = $('#state-chip');
  const btn = $('#btn-fight');
  const timer = $('#timer');
  document.body.classList.toggle('is-recording', state === 'RECORDING' || state === 'POST_ROLL');

  chip.className = 'chip state';
  switch (state) {
    case 'RECORDING':
      chip.textContent = '● ИДЁТ ЗАПИСЬ'; chip.classList.add('rec');
      btn.textContent = 'СТОП'; btn.className = 'fight stop'; btn.disabled = false;
      timer.hidden = false;
      break;
    case 'POST_ROLL':
      chip.textContent = '● ДОПИСЫВАЮ'; chip.classList.add('rec');
      btn.textContent = 'СТОП'; btn.className = 'fight stop'; btn.disabled = true;
      timer.hidden = false;
      break;
    case 'FINALIZING':
      chip.textContent = 'СОХРАНЯЮ…'; chip.classList.add('busy');
      btn.textContent = 'БОЙ'; btn.className = 'fight go'; btn.disabled = true;
      timer.hidden = true;
      break;
    default:
      chip.textContent = 'ГОТОВ'; chip.classList.add('ready');
      btn.textContent = 'БОЙ'; btn.className = 'fight go'; btn.disabled = false;
      timer.hidden = true;
  }
  $('#btn-replay').disabled = !(state === 'IDLE' && hasClip);
}

export function setTimer(ms) { $('#timer').textContent = fmtTimer(ms); }

export function setReplayThumb(dataUrl) {
  const img = $('#replay-thumb');
  if (dataUrl) { img.src = dataUrl; img.hidden = false; } else { img.hidden = true; }
}

export function setCamInfo(info, audioOn) {
  const chip = $('#cam-chip');
  const actual = $('#cam-actual');
  if (!info) { chip.hidden = true; actual.textContent = 'Фактически: камера не запущена'; return; }
  const text = `${info.width}×${info.height} @${info.frameRate || '?'}${audioOn ? ' 🔊' : ''}`;
  chip.textContent = text; chip.hidden = false;
  actual.textContent = `Фактически: ${info.width}×${info.height}, ${info.frameRate || '?'} к/с${audioOn ? ', со звуком' : ', без звука'}`;
}

export function setBattery(level, charging) {
  const chip = $('#battery-chip');
  chip.hidden = false;
  chip.textContent = `🔋 ${Math.round(level * 100)}%${charging ? ' ⚡' : ''}`;
  chip.classList.toggle('low', level < 0.2 && !charging);
}

export function setStorage(free, low) {
  const chip = $('#storage-chip');
  chip.hidden = false;
  chip.textContent = `💾 ${fmtBytes(free)}`;
  chip.classList.toggle('low', !!low);
  $('#storage-info').textContent = `Свободно на устройстве: ${fmtBytes(free)}`;
}

export function setVoice({ enabled, text }) {
  $('#voice-chip').hidden = !enabled;
  if (text) $('#voice-heard').textContent = text;
  $('#voice-log').hidden = !enabled;
}

export function addVoiceLog(text) {
  const ol = $('#voice-log-list');
  const li = document.createElement('li');
  li.textContent = text;
  ol.prepend(li);
  while (ol.children.length > 8) ol.lastChild.remove();
}

export function showAlert(text, { action = null, soft = false } = {}) {
  const el = $('#alert');
  $('#alert-text').textContent = text;
  const btn = $('#alert-btn');
  btn.hidden = !action;
  if (action) btn.textContent = action;
  el.classList.toggle('soft', soft);
  el.hidden = false;
}
export function hideAlert() { $('#alert').hidden = true; }

export function fillCameraSelect(cameras, selected) {
  const sel = $('#camera-select');
  sel.innerHTML = '';
  const def = document.createElement('option');
  def.value = ''; def.textContent = 'Задняя (по умолчанию)';
  sel.append(def);
  for (const c of cameras) {
    const o = document.createElement('option');
    o.value = c.deviceId; o.textContent = c.label;
    sel.append(o);
  }
  sel.value = selected || '';
}

// ---- экран повтора ---------------------------------------------------------------------
export function setReplayTitle(text) { $('#rp-title').textContent = text; }

export const seekState = { dragging: false }; // true, пока палец/мышь держит ползунок

export function updateReplay(st) {
  const seek = $('#rp-seek');
  const dur = Math.max(st.duration, 0.01);
  if (!seekState.dragging) {
    seek.max = String(Math.round(dur * 1000));
    seek.value = String(Math.round(Math.min(st.time, dur) * 1000));
  }
  $('#rp-time').textContent = fmtPlayer(st.time);
  $('#rp-dur').textContent = fmtPlayer(dur);
  $('#rp-toggle').textContent = st.paused ? '▶' : '❚❚';
  $$('[data-rp="rate"]').forEach((b) => b.classList.toggle('active', Number(b.dataset.v) === st.rate));
  $('#rp-loop').classList.toggle('active', st.loop);
  $('#rp-mute').textContent = st.muted ? 'Звук выкл.' : 'Звук вкл.';
  $('#rp-mute').classList.toggle('active', !st.muted);
}

// ---- список клипов -----------------------------------------------------------------------
/** handlers: { play(clip), share(clip), pin(clip), del(clip) } */
export function renderClips(clips, handlers) {
  const ul = $('#clips-list');
  ul.innerHTML = '';
  $('#clips-empty').hidden = clips.length > 0;
  $('#clips-count').textContent = clips.length ? `(${clips.length})` : '';
  for (const c of clips) {
    const li = document.createElement('li');
    li.className = 'clip' + (c.pinned ? ' pinned' : '');

    const img = document.createElement('img');
    img.className = 'thumb'; img.alt = '';
    if (c.thumb) img.src = c.thumb;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const when = document.createElement('b');
    when.textContent = fmtDate(c.endedAt || c.startedAt);
    const dur = document.createElement('span');
    dur.className = 'mono'; dur.textContent = fmtTimer(c.durationMs || 0);
    const label = document.createElement('span');
    label.className = 'dim'; label.textContent = c.label || '';
    meta.append(when, dur, label);
    if (c.pinned) { const p = document.createElement('span'); p.textContent = '★'; meta.append(p); }
    if (c.status === 'interrupted') { const b = document.createElement('span'); b.className = 'badge'; b.textContent = 'прерван'; meta.append(b); }

    const acts = document.createElement('div');
    acts.className = 'acts';
    const mk = (text, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.addEventListener('click', () => fn(c)); return b; };
    acts.append(
      mk('▶ Смотреть', handlers.play),
      mk('Поделиться', handlers.share),
      mk(c.pinned ? '★ Откреплить' : '☆ Закрепить', handlers.pin),
      mk('Удалить', handlers.del),
    );

    const left = document.createElement('div');
    left.append(img);
    li.append(left, meta, acts);
    ul.append(li);
  }
}
