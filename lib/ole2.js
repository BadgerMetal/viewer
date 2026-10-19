// OLE2 / MS compound file reader (the container behind MetaCAM .3d / .pdg / config.dat).
// OLE2.read(ArrayBuffer) -> { streams: Map<path, Uint8Array> }   paths look like "Root/3DData/BendVal"
// OLE2.inflate(Uint8Array) -> Promise<Uint8Array>   zlib (78 9C ...) via the browser's DecompressionStream
// OLE2.payload(Uint8Array) -> Promise<Uint8Array>   MetaCAM stream: skip its 8/16-byte header, inflate if zlib
(function (root) {
  const FREE = 0xFFFFFFFF, END = 0xFFFFFFFE;

  function read(buf) {
    const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const sig = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    for (let i = 0; i < 8; i++) if (u8[i] !== sig[i]) throw new Error('Not an OLE2 compound file');
    const ssz = 1 << dv.getUint16(0x1E, true), mssz = 1 << dv.getUint16(0x20, true);
    const nFat = dv.getUint32(0x2C, true), dir0 = dv.getUint32(0x30, true), cutoff = dv.getUint32(0x38, true);
    const mfat0 = dv.getUint32(0x3C, true), difat0 = dv.getUint32(0x44, true);
    const secOff = (s) => (s + 1) * ssz;
    // DIFAT -> list of FAT sectors
    const fatSecs = [];
    for (let i = 0; i < 109 && fatSecs.length < nFat; i++) { const s = dv.getUint32(0x4C + i * 4, true); if (s !== FREE) fatSecs.push(s); }
    for (let d = difat0, guard = 0; d !== END && d !== FREE && fatSecs.length < nFat && guard < 1e5; guard++) {
      const o = secOff(d), per = ssz / 4 - 1;
      for (let i = 0; i < per && fatSecs.length < nFat; i++) { const s = dv.getUint32(o + i * 4, true); if (s !== FREE) fatSecs.push(s); }
      d = dv.getUint32(o + per * 4, true);
    }
    const fat = new Uint32Array(fatSecs.length * ssz / 4);
    fatSecs.forEach((s, k) => { for (let i = 0; i < ssz / 4; i++) fat[k * ssz / 4 + i] = dv.getUint32(secOff(s) + i * 4, true); });
    const chain = (start, tbl) => { const out = []; for (let s = start, g = 0; s !== END && s !== FREE && s < tbl.length && g < tbl.length; g++) { out.push(s); s = tbl[s]; } return out; };
    const readChain = (start, size) => {
      const secs = chain(start, fat), out = new Uint8Array(size === undefined ? secs.length * ssz : size);
      let p = 0;
      for (const s of secs) { const o = secOff(s), n = Math.min(ssz, out.length - p); if (n <= 0) break; out.set(u8.subarray(o, o + n), p); p += n; }
      return out;
    };
    // directory
    const dirBytes = readChain(dir0);
    const ddv = new DataView(dirBytes.buffer);
    const ents = [];
    for (let o = 0; o + 128 <= dirBytes.length; o += 128) {
      const nl = ddv.getUint16(o + 0x40, true); let name = '';
      for (let i = 0; i < Math.max(0, nl / 2 - 1); i++) name += String.fromCharCode(ddv.getUint16(o + i * 2, true));
      ents.push({ name, type: dirBytes[o + 0x42], left: ddv.getUint32(o + 0x44, true), right: ddv.getUint32(o + 0x48, true),
                  child: ddv.getUint32(o + 0x4C, true), start: ddv.getUint32(o + 0x74, true), size: ddv.getUint32(o + 0x78, true) });
    }
    const rootE = ents[0];
    const ministream = rootE ? readChain(rootE.start, rootE.size) : new Uint8Array(0);
    const mfatBytes = mfat0 !== END ? readChain(mfat0) : new Uint8Array(0);
    const mfat = new Uint32Array(mfatBytes.buffer, 0, mfatBytes.length >> 2);
    const readMini = (start, size) => {
      const out = new Uint8Array(size); let p = 0;
      for (const s of chain(start, mfat)) { const o = s * mssz, n = Math.min(mssz, size - p); if (n <= 0) break; out.set(ministream.subarray(o, o + n), p); p += n; }
      return out;
    };
    const streams = new Map();
    const walk = (id, prefix, depth) => { // red-black tree of siblings; child = subtree of a storage
      if (id === FREE || id >= ents.length || depth > 64) return;
      const e = ents[id];
      walk(e.left, prefix, depth + 1);
      const path = prefix + '/' + e.name;
      if (e.type === 2) streams.set(path, e.size < cutoff ? readMini(e.start, e.size) : readChain(e.start, e.size));
      else if (e.type === 1) walk(e.child, path, depth + 1);
      walk(e.right, prefix, depth + 1);
    };
    if (rootE) walk(rootE.child, 'Root', 0);
    return { streams };
  }

  async function inflate(bytes) {
    const ds = new DecompressionStream('deflate'); // zlib-wrapped deflate
    const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return new Uint8Array(await out.arrayBuffer());
  }
  // MetaCAM streams: [checksum][count][A6 90 7F 3B][1] then zlib (16-byte header; metacam.db uses 8)
  async function payload(bytes) {
    for (const off of [16, 8, 0]) if (bytes.length > off + 2 && bytes[off] === 0x78 && (bytes[off + 1] === 0x9C || bytes[off + 1] === 0xDA || bytes[off + 1] === 0x01)) return inflate(bytes.subarray(off));
    return bytes;
  }

  const api = { read, inflate, payload };
  if (typeof module !== 'undefined') module.exports = api; else root.OLE2 = api;
})(typeof window !== 'undefined' ? window : globalThis);
