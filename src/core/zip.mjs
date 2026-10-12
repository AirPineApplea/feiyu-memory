/**
 * 零依赖的极小 ZIP 读写 —— `.dshpack` 就是一个 zip。
 *
 * 为什么不装依赖：
 *   DSH 插件应该能被人一眼读完、离线审计。为了打个包引入几百 KB 的依赖不值得。
 *
 * 能力边界（刻意的）：
 *   写：只写 store（不压缩）。档案本体是文本，压缩收益小，而 store 的格式简单到不会出错。
 *   读：store + deflate 都读（因为别人/别的工具打的包可能是 deflate）。
 *   不支持 Zip64。档案是私人日记，几十 MB 已经是十年量级；超限时明确报错而不是静默截断。
 *
 * 所有 CRC 都实际计算 —— 一个损坏的档案必须能被发现，而不是解出一半乱码。
 */
import { inflateRawSync, deflateRawSync } from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const MAX_UINT32 = 0xffffffff;

/** CRC-32（IEEE）查表 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/**
 * @param {Uint8Array} bytes
 * @returns {number} 无符号 32 位 CRC
 */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 把 Date 编码成 DOS 时间/日期（本地时区，ZIP 传统） */
function dosDateTime(date) {
  const y = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

/**
 * 打一个 zip 包。
 *
 * @param {Array<{name: string, data: string | Uint8Array}>} entries 路径用正斜杠
 * @param {{date?: Date, compress?: boolean}} [options]
 * @returns {Uint8Array}
 */
export function zipSync(entries, options = {}) {
  const date = options.date ?? new Date();
  const compress = options.compress === true;
  const { time, date: dosDate } = dosDateTime(date);

  /** @type {Uint8Array[]} */
  const chunks = [];
  /** @type {Array<{nameBytes: Uint8Array, method: number, crc: number, csize: number, usize: number, offset: number, time: number, date: number}>} */
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const raw = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    const crc = crc32(raw);

    let method = METHOD_STORE;
    let payload = raw;
    if (compress && raw.length > 256) {
      const deflated = new Uint8Array(deflateRawSync(raw, { level: 6 }));
      if (deflated.length < raw.length) {
        method = METHOD_DEFLATE;
        payload = deflated;
      }
    }

    if (raw.length > MAX_UINT32 || payload.length > MAX_UINT32) {
      throw new Error(`zipSync: 条目过大，不支持 Zip64：${entry.name}`);
    }

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, FLAG_UTF8, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra len
    local.set(nameBytes, 30);

    chunks.push(local, payload);
    central.push({
      nameBytes,
      method,
      crc,
      csize: payload.length,
      usize: raw.length,
      offset,
      time,
      date: dosDate,
    });
    offset += local.length + payload.length;
  }

  const cdStart = offset;
  for (const e of central) {
    const rec = new Uint8Array(46 + e.nameBytes.length);
    const rv = new DataView(rec.buffer);
    rv.setUint32(0, SIG_CENTRAL, true);
    rv.setUint16(4, 20, true); // version made by
    rv.setUint16(6, 20, true); // version needed
    rv.setUint16(8, FLAG_UTF8, true);
    rv.setUint16(10, e.method, true);
    rv.setUint16(12, e.time, true);
    rv.setUint16(14, e.date, true);
    rv.setUint32(16, e.crc, true);
    rv.setUint32(20, e.csize, true);
    rv.setUint32(24, e.usize, true);
    rv.setUint16(28, e.nameBytes.length, true);
    rv.setUint16(30, 0, true); // extra
    rv.setUint16(32, 0, true); // comment
    rv.setUint16(34, 0, true); // disk start
    rv.setUint16(36, 0, true); // internal attrs
    rv.setUint32(38, 0, true); // external attrs
    rv.setUint32(42, e.offset, true);
    rec.set(e.nameBytes, 46);
    chunks.push(rec);
    offset += rec.length;
  }

  const cdSize = offset - cdStart;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  ev.setUint16(20, 0, true);
  chunks.push(eocd);

  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/**
 * 解一个 zip 包。返回值按需解压，条目解压失败会抛错（不静默返回坏数据）。
 *
 * @param {Uint8Array} bytes
 * @returns {Array<{name: string, size: number, bytes: () => Uint8Array, text: () => string}>}
 */
export function unzipSync(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // 从尾部往前找 EOCD（注释最长 65535）
  let eocd = -1;
  const scanFrom = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= scanFrom; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('unzipSync: 找不到 EOCD，不是有效的 zip');

  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset === MAX_UINT32 || cdSize === MAX_UINT32 || count === 0xffff) {
    throw new Error('unzipSync: 疑似 Zip64，不支持');
  }
  if (cdOffset + cdSize > bytes.length) throw new Error('unzipSync: 中央目录越界，档案已损坏');

  const out = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== SIG_CENTRAL) throw new Error('unzipSync: 中央目录条目签名错误');
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const csize = view.getUint32(p + 20, true);
    const usize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    const readBytes = () => {
      if (view.getUint32(localOffset, true) !== SIG_LOCAL) {
        throw new Error(`unzipSync: 本地头签名错误：${name}`);
      }
      const lNameLen = view.getUint16(localOffset + 26, true);
      const lExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      if (dataStart + csize > bytes.length) throw new Error(`unzipSync: 数据越界：${name}`);
      const raw = bytes.subarray(dataStart, dataStart + csize);

      let data;
      if (method === METHOD_STORE) data = raw;
      else if (method === METHOD_DEFLATE) data = new Uint8Array(inflateRawSync(raw));
      else throw new Error(`unzipSync: 不支持的压缩方法 ${method}：${name}`);

      if (data.length !== usize) throw new Error(`unzipSync: 长度不符：${name}`);
      if (crc32(data) !== crc) throw new Error(`unzipSync: CRC 校验失败，档案已损坏：${name}`);
      return data;
    };

    out.push({ name, size: usize, bytes: readBytes, text: () => decoder.decode(readBytes()) });
  }
  return out;
}
