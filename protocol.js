// Протокол обмена «телефон ↔ экран». Версия протокола — V.
export const V = 1;
export const CHUNK = 16 * 1024; // размер части клипа в канале transfer
const TYPES = new Set(['hello','ping','pong','prepare','prepared','ack','ready','show','hide','play','pause','seek','rate','loop','step','mute','state','testStart','testDone','cancel']);
// Разбор и проверка входящего control-сообщения; null, если сообщение некорректно.
export function parse(s) { try { const m = JSON.parse(s); return m && TYPES.has(m.t) ? m : null; } catch { return null; } }
export const sleep = ms => new Promise(r => setTimeout(r, ms));
