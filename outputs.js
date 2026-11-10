// Вывод повтора на экран. Заготовка под будущий вывод на монитор/ТВ.
// В базовой версии полностью работает только LocalOutputAdapter (показ в самом приложении).

/** Включить, когда внешний вывод будет реализован: кнопка «На внешний экран» станет активной. */
export const EXTERNAL_OUTPUT_ENABLED = false;

/**
 * Интерфейс вывода.
 *   id: 'local' | 'remote-playback' | 'presentation' | 'viewer-link'
 *   isAvailable(): можно ли использовать этот выход прямо сейчас
 *   connect(): выбрать/подключить внешний экран
 *   play(clip, options): показать клип (options.blob — видео)
 *   control(cmd, value): команды плеера (toggle, step, seekBy, seek, rate, loop, mute)
 *   disconnect(): отключиться
 */
export class OutputAdapter {
  constructor(id) { this.id = id; }
  isAvailable() { return false; }
  async connect() { throw new Error('Не реализовано'); }
  async play(_clip, _options) { throw new Error('Не реализовано'); }
  control(_cmd, _value) {}
  async disconnect() {}
}

// ---------------------------------------------------------------------------
// local — показ в самом приложении (РАБОТАЕТ)
// ---------------------------------------------------------------------------
export class LocalOutputAdapter extends OutputAdapter {
  /** @param {import('./player.js').Player} player */
  constructor(player) { super('local'); this.player = player; }
  isAvailable() { return true; }
  async connect() {}
  async play(clip, options = {}) { await this.player.open(clip, options.blob); }
  control(cmd, value) { this.player.control(cmd, value); }
  async disconnect() { this.player.close(); }
}

// ---------------------------------------------------------------------------
// remote-playback — AirPlay / Chromecast через Remote Playback API (ЗАГЛУШКА)
// ---------------------------------------------------------------------------
export class RemotePlaybackOutputAdapter extends OutputAdapter {
  constructor(videoEl) { super('remote-playback'); this.video = videoEl; }
  isAvailable() {
    // feature-detect: API есть в Safari (AirPlay) и в Chrome на Android (Cast)
    return EXTERNAL_OUTPUT_ENABLED && !!(this.video && this.video.remote && typeof this.video.remote.prompt === 'function');
  }
  async connect() {
    // КАК ДЕЛАТЬ: await this.video.remote.prompt() — покажет системный список экранов.
    // Подписаться на this.video.remote.onconnect / ondisconnect / onconnecting.
    // ПРОВЕРИТЬ ОТДЕЛЬНО: воспроизведение локального blob: URL на удалённом экране —
    // часть устройств принимает только http(s)-ссылки на файл. Возможно, потребуется
    // отдавать видео по адресу из Service Worker или через временный локальный сервер.
    throw new Error('Не реализовано в базовой версии');
  }
  async play() { throw new Error('Не реализовано в базовой версии'); }
}

// ---------------------------------------------------------------------------
// presentation — Presentation API (только Chromium) (ЗАГЛУШКА)
// ---------------------------------------------------------------------------
export class PresentationOutputAdapter extends OutputAdapter {
  constructor() { super('presentation'); }
  isAvailable() { return EXTERNAL_OUTPUT_ENABLED && 'PresentationRequest' in window; }
  async connect() {
    // КАК ДЕЛАТЬ: const req = new PresentationRequest(['display.html']);
    //   const conn = await req.start();  // выбор экрана
    //   Страница display.html на втором экране получает сообщения через
    //   navigator.presentation.receiver; видео передавать по conn.send() кусками
    //   либо через общий источник (IndexedDB недоступен между устройствами).
    throw new Error('Не реализовано в базовой версии');
  }
  async play() { throw new Error('Не реализовано в базовой версии'); }
}

// ---------------------------------------------------------------------------
// viewer-link — страница-зритель /display по ссылке (ЗАГЛУШКА, только описание)
// ---------------------------------------------------------------------------
export class ViewerLinkOutputAdapter extends OutputAdapter {
  constructor() { super('viewer-link'); }
  isAvailable() { return false; }
  async connect() {
    // КАК ДЕЛАТЬ: открыть на мониторе/ТВ страницу /display. Телефон и страница
    // соединяются по WebRTC (обмен SDP через QR-код или короткий код, без сервера)
    // либо через небольшой локальный сервер в сети зала. Телефон отправляет клип
    // (WebRTC DataChannel или HTTP-запрос), страница показывает его и принимает
    // команды control(): пауза, шаг, скорость.
    throw new Error('Не реализовано в базовой версии');
  }
  async play() { throw new Error('Не реализовано в базовой версии'); }
}

/** Реестр выходов. active — выход, через который работает экран повтора. */
export function createOutputs(player, videoEl) {
  const local = new LocalOutputAdapter(player);
  const external = [
    new RemotePlaybackOutputAdapter(videoEl),
    new PresentationOutputAdapter(),
    new ViewerLinkOutputAdapter(),
  ];
  return {
    local,
    external,
    active: local,
    /** Есть ли хотя бы один доступный внешний выход (в базовой версии всегда false). */
    externalAvailable: () => EXTERNAL_OUTPUT_ENABLED && external.some((o) => o.isAvailable()),
  };
}
