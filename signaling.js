// Ручной сигналинг: описание соединения (SDP) превращается в короткий текстовый код.
// Код копируется/вставляется любым способом (мессенджер, заметки, буфер обмена).
const b64 = u => btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const run = async stream => new Uint8Array(await new Response(stream).arrayBuffer());

export async function pack(desc) {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, t: desc.type, s: desc.sdp }));
  if (typeof CompressionStream === 'function')
    return 'VR1z.' + b64(await run(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))));
  return 'VR1r.' + b64(bytes); // запасной вариант без сжатия
}

export async function unpack(text) {
  const m = /^VR1([zr])\.([\w-]+)$/.exec(String(text).replace(/\s+/g, ''));
  if (!m) throw new Error('Неверный код: он скопирован не полностью или не из этого приложения');
  let bytes = unb64(m[2]);
  if (m[1] === 'z') bytes = await run(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')));
  const o = JSON.parse(new TextDecoder().decode(bytes));
  if (o.v !== 1) throw new Error('Несовместимая версия кода');
  return { type: o.t, sdp: o.s };
}
