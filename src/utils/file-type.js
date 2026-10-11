/**
 * 基于文件头（magic number）的真实类型识别。
 *
 * 为什么不用 client 提供的 Content-Type 或扩展名？
 * 攻击者可以把 webshell 改名成 .jpg 并声明 image/jpeg，
 * 只有嗅探真实字节才能挡住这类绕过。扩展名仅用于生成可访问的 URL，
 * 不作为安全判断依据。
 */

/** @type {Array<{ext:string[], mime:string, offset:number, bytes:number[], mask?:number[]}>} */
const SIGNATURES = [
  { ext: ['png'], mime: 'image/png', offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: ['jpg', 'jpeg'], mime: 'image/jpeg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { ext: ['gif'], mime: 'image/gif', offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] },
  { ext: ['bmp'], mime: 'image/bmp', offset: 0, bytes: [0x42, 0x4d] },
  { ext: ['ico'], mime: 'image/x-icon', offset: 0, bytes: [0x00, 0x00, 0x01, 0x00] },
  { ext: ['cur'], mime: 'image/x-icon', offset: 0, bytes: [0x00, 0x00, 0x02, 0x00] },
  // RIFF....WEBP
  { ext: ['webp'], mime: 'image/webp', offset: 8, bytes: [0x57, 0x45, 0x42, 0x50], prefix: [0x52, 0x49, 0x46, 0x46] },
  // ....ftypavif / ftypavis
  { ext: ['avif'], mime: 'image/avif', offset: 8, bytes: [0x66, 0x74, 0x79, 0x70], prefix: null, asciiAfter: 'avif' },
  { ext: ['heic'], mime: 'image/heic', offset: 8, bytes: [0x66, 0x74, 0x79, 0x70], prefix: null, asciiAfter: 'hei' },
  // JPEG XL: 0xFF 0x0A 或容器签名 00 00 00 0C 4A 58 4C 20
  { ext: ['jxl'], mime: 'image/jxl', offset: 0, bytes: [0xff, 0x0a] },
];

function matchesAt(buf, sig) {
  const head = buf.subarray(sig.offset, sig.offset + sig.bytes.length);
  if (head.length !== sig.bytes.length) return false;
  for (let i = 0; i < sig.bytes.length; i += 1) {
    if (head[i] !== sig.bytes[i]) return false;
  }
  if (sig.prefix) {
    const p = buf.subarray(0, sig.prefix.length);
    for (let i = 0; i < sig.prefix.length; i += 1) {
      if (p[i] !== sig.prefix[i]) return false;
    }
  }
  if (sig.asciiAfter) {
    const brand = buf
      .subarray(sig.offset + sig.bytes.length, sig.offset + sig.bytes.length + sig.asciiAfter.length)
      .toString('ascii');
    if (!brand.toLowerCase().startsWith(sig.asciiAfter)) return false;
  }
  return true;
}

/**
 * SVG 没有二进制文件头，必须解析文本内容。
 * 这里做的是「是否像 SVG」的判断，脚本风险由 allowSvg 配置项控制。
 */
function looksLikeSvg(buf) {
  const head = buf.subarray(0, Math.min(buf.length, 4096)).toString('utf8').trimStart();
  if (!head.startsWith('<')) return false;
  const lower = head.toLowerCase();
  return lower.includes('<svg');
}

/**
 * 检测 SVG 中是否包含可执行脚本等危险内容。
 * @returns {{dangerous:boolean, reasons:string[]}}
 */
export function inspectSvg(buf) {
  const text = buf.toString('utf8');
  const reasons = [];

  if (/<script[\s>]/i.test(text)) reasons.push('包含 <script> 标签');
  if (/\son\w+\s*=\s*["']/i.test(text)) reasons.push('包含内联事件处理器（onload/onclick 等）');
  if (/javascript\s*:/i.test(text)) reasons.push('包含 javascript: 伪协议');
  if (/<foreignObject[\s>]/i.test(text)) reasons.push('包含 <foreignObject>');
  if (/<!ENTITY/i.test(text)) reasons.push('包含 DOCTYPE ENTITY（XXE 风险）');

  return { dangerous: reasons.length > 0, reasons };
}

/**
 * 识别图片真实类型。
 * @param {Buffer} buf 文件内容
 * @returns {{mime:string, ext:string, kind:'raster'|'svg'|'unknown'}}
 */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return { mime: 'application/octet-stream', ext: 'bin', kind: 'unknown' };
  }

  for (const sig of SIGNATURES) {
    if (matchesAt(buf, sig)) {
      return { mime: sig.mime, ext: sig.ext[0], kind: 'raster' };
    }
  }

  if (looksLikeSvg(buf)) {
    return { mime: 'image/svg+xml', ext: 'svg', kind: 'svg' };
  }

  return { mime: 'application/octet-stream', ext: 'bin', kind: 'unknown' };
}

/**
 * 从文件名取扩展名（仅用于 URL 命名与提示，不作为安全依据）。
 */
export function extOf(filename = '') {
  const m = String(filename).toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return m ? m[1] : '';
}

/**
 * 清理用户提供的文件名，防止路径穿越。
 */
export function sanitizeFilename(name = '') {
  return String(name)
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[^\w.\-一-龥]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120) || 'image';
}

export default sniffImage;