// Окно подключения внешнего экрана: мастер (обмен текстовыми кодами) и проверка связи.
// Камера телефона здесь НЕ используется: код вставляется текстом.
export function createDialog({ root, ext, isBusy, toast }) {
  const url = new URL('display.html', location.href).href;
  root.innerHTML = `
  <header class="page-head"><h1>Внешний экран</h1><div class="spacer"></div><button type="button" id="xd-close">Закрыть</button></header>
  <div class="settings">
    <div id="xd-pair">
      <p>1. На ноутбуке откройте страницу:</p>
      <p><b class="mono" id="xd-url"></b></p>
      <button type="button" id="xd-copyurl">Копировать адрес</button>
      <p>2. На ноутбуке нажмите «Подключить», скопируйте код и вставьте его сюда:</p>
      <textarea id="xd-offer" rows="4" spellcheck="false" autocomplete="off"></textarea>
      <div class="xd-row"><button type="button" id="xd-paste">Вставить из буфера</button><button type="button" id="xd-go" class="primary">Подключиться</button></div>
      <div id="xd-answer-box" hidden>
        <p>3. Скопируйте код-ответ и вставьте его на ноутбуке, затем нажмите «Применить ответ»:</p>
        <textarea id="xd-answer" rows="4" readonly></textarea>
        <div class="xd-row"><button type="button" id="xd-copy">Копировать</button><button type="button" id="xd-share">Поделиться</button></div>
        <p class="hint">Когда ноутбук примет ответ, здесь появится «Подключено».</p>
      </div>
      <p class="hint warn">Подключайтесь, когда запись не идёт.</p>
      <p class="hint">Если не подключается: оба устройства должны быть в одной сети без «изоляции клиентов» (в гостевых Wi-Fi она часто включена). Можно включить точку доступа на телефоне и подключить к ней ноутбук.</p>
    </div>
    <div id="xd-live" hidden>
      <p>Статус: <b id="xd-status">подключено</b></p>
      <button type="button" id="xd-diag">Проверка связи (10 МБ)</button>
      <pre id="xd-diag-out" class="hint"></pre>
      <button type="button" id="xd-off">Отключить</button>
    </div>
  </div>`;
  const $ = (id) => root.querySelector('#' + id);
  $('xd-url').textContent = url;

  const refresh = () => {
    $('xd-pair').hidden = ext.connected;
    $('xd-live').hidden = !ext.connected;
    $('xd-status').textContent = ext.connected ? 'подключено' : 'не подключено';
    $('xd-diag').disabled = isBusy();
  };
  const open = () => {
    if (isBusy()) { toast('Во время записи подключение недоступно', 'warn'); return; }
    root.hidden = false; refresh();
  };
  $('xd-close').onclick = () => { root.hidden = true; };
  $('xd-copyurl').onclick = () => navigator.clipboard && navigator.clipboard.writeText(url).then(() => toast('Адрес скопирован'));
  $('xd-paste').onclick = async () => {
    try { $('xd-offer').value = await navigator.clipboard.readText(); } catch (_) { toast('Вставьте код в поле вручную', 'warn'); }
  };
  $('xd-go').onclick = async () => {
    const code = $('xd-offer').value.trim();
    if (!code) { toast('Сначала вставьте код с ноутбука', 'warn'); return; }
    try {
      const ses = ext.begin();
      $('xd-answer').value = await ses.acceptOffer(code);
      $('xd-answer-box').hidden = false;
    } catch (e) { toast(e.message || 'Не удалось подключиться', 'warn', 5000); }
  };
  $('xd-copy').onclick = () => navigator.clipboard && navigator.clipboard.writeText($('xd-answer').value).then(() => toast('Код-ответ скопирован'));
  $('xd-share').onclick = () => { if (navigator.share) navigator.share({ text: $('xd-answer').value }).catch(() => {}); else toast('Поделиться недоступно — используйте «Копировать»', 'warn'); };
  $('xd-diag').onclick = async () => {
    const out = $('xd-diag-out');
    try {
      out.textContent = 'идёт проверка…';
      const r = await ext.diagnostics();
      const est = r.mbitPerSec > 0 ? Math.round((30 * 8) / r.mbitPerSec) : null;
      out.textContent = `Скорость: ${r.mbitPerSec} Мбит/с · RTT: ${r.rttMs ?? '—'} мс · соединение: ${r.local || '?'} / ${r.remote || '?'}` +
        (est ? ` · клип ~30 МБ передастся примерно за ${est} с` : '') + (r.ok ? '' : ' · экран не подтвердил приём');
    } catch (e) { out.textContent = e.message; }
  };
  $('xd-off').onclick = () => { ext.disconnect(); $('xd-answer-box').hidden = true; $('xd-offer').value = ''; refresh(); };
  return { open, refresh };
}
