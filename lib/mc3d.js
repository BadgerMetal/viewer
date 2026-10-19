// MetaCAM native .3d sheet-metal model reader (browser + Node). Depends only on OLE2 (lib/ole2.js).
// Port of K-FACTOR's sheetmetal/read3d.py (format: k-factor docs/ref/metacam_3d_format.md).
//
// MC3D.read(ArrayBuffer|Uint8Array) -> Promise<{
//   faces:   [{ id, layer, outer:[[x,y,z]..], holes:[[[x,y,z]..]..], marks:[[[x,y,z]..]..],
//               normal:[x,y,z], t, side:[x,y,z], bend:false }]
//            Every face is FLAT. outer/holes are MetaCAM's plane (one surface of the sheet);
//            the solid is that polygon swept by t along side (unit vector into the material).
//            Polygons run to the bend lines (virtual sharp of the plane surfaces), arcs tessellated.
//   bends:   [{ a, b (indices into faces), r, die, angle (deg, 0 = flat), joint (r=0 seam),
//               line:[[x,y,z],[x,y,z]] (shared edge on the planes), fill:[6 pts] (triangular
//               prism S, S+t*sideA, S+t*sideB at both ends of line: closes the corner notch) }]
//   units:   'mm' (MetaCAM stores world mm),  bbox: {min, max, size} of the slab solid,
//   thumbnail: Blob('image/bmp') | null,  notes: [str], skipped: [str],
//   version, savedBy, layers:[{name, thickness, radius}], md (the raw parse, for tests) }>
// MC3D.parse(modelBytes, version) -> md;  MC3D.check(md) -> [str] (empty = clean, like read3d.check)
// MC3D.notes(md) -> [str];  MC3D.pairBends(md) -> [{xa, xb, ea, eb, relation}]
(function (root) {
  const FONT_BLOCK = 0xEC, LAYER_FIXED = 60, BIG = 1e90, CLOSE_TOL = 1e-3, MEET_TOL = 1e-2;
  const REAL_UNKNOWN = 'Jqrlp', VERSIONS = [73, 77, 79], X_PARTNER = 269, X_SIDES = 47;
  const FINITE_MAX = 1e7, PLANE_TOL = 0.01;
  const ARC_SAG = 0.002;   // mm; max chord sagitta when tessellating arcs (0.00008 in)
  const UNKNOWN_WHAT = { J: 'patch surfaces (pipe/cone/transition)', q: 'q records', r: 'r records',
                         l: 'l records', p: 'p records', 'D-before-loop': 'edges stored before their loop' };

  class Read3dError extends Error {}

  // ------------------------------------------------------------- vector helpers
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => Math.sqrt(dot(a, a));
  const unit = (a) => { const l = norm(a); return [a[0] / l, a[1] / l, a[2] / l]; };
  const close = (a, b, tol = CLOSE_TOL) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])) <= tol;
  const ok = (v, big) => v.every(c => Number.isFinite(c) && (Math.abs(c) < FINITE_MAX || (big && Math.abs(c) > BIG)));

  // ------------------------------------------------------------- byte access
  function bytesOf(m) {
    const dv = new DataView(m.buffer, m.byteOffset, m.byteLength), n = m.length;
    return {
      n,
      i32: (o) => (o >= 0 && o + 4 <= n ? dv.getInt32(o, true) : null),
      i16: (o) => (o >= 0 && o + 2 <= n ? dv.getInt16(o, true) : null),
      f64: (o) => dv.getFloat64(o, true),
      vec: (o) => [dv.getFloat64(o, true), dv.getFloat64(o + 8, true), dv.getFloat64(o + 16, true)],
    };
  }
  function find(m, pat, from) {  // bytes.find
    const b0 = pat[0], L = pat.length;
    for (let j = m.indexOf(b0, from); j >= 0 && j + L <= m.length; j = m.indexOf(b0, j + 1)) {
      let k = 1; while (k < L && m[j + k] === pat[k]) k++;
      if (k === L) return j;
    }
    return -1;
  }
  const packI = (k) => [k & 255, (k >>> 8) & 255, (k >>> 16) & 255, (k >>> 24) & 255];
  const isTag = (m, o) => o + 4 <= m.length && m[o + 1] === 0 && m[o + 2] === 0 && m[o + 3] === 0 &&
    ((m[o] >= 65 && m[o] <= 90) || (m[o] >= 97 && m[o] <= 122));
  const ARRAY = [28, 0, 0, 0, 8, 0, 0, 0];

  // ------------------------------------------------------------- record heads
  function faceHead(m, B, k, o, nlayers) {
    const b = o + 8;
    if (b + 22 > B.n) return null;
    const z = B.i32(b), layer = B.i32(b + 8), n = B.i32(b + 18);
    if (z !== 0 || !(n > 0 && n < 100000)) return null;
    if (!(layer >= 0 && layer < Math.max(nlayers, 1))) return null;
    return { id: k, offset: o, layer, nloops: n, loops: [], side: null, t: null, tail: false };
  }
  function loopHead(m, B, k, o) {
    if (o + 12 > B.n) return null;
    const n = B.i32(o + 8);
    return n > 0 && n < 1000000 ? { id: k, offset: o, nedges: n, face: null, edges: [] } : null;
  }
  function edgeHead(m, B, k, o, loops) {
    const b = o + 8;
    if (b + 4 + 112 + 20 > B.n) return null;
    const own = B.i32(b);
    if (!loops.has(own)) return null;
    const pts = [];
    for (let j = 0; j < 4; j++) pts.push(B.vec(b + 4 + 28 * j));
    const [p0, p1, p2, p3] = pts;
    if (!(ok(p0) && ok(p1) && ok(p2, true) && ok(p3, true))) return null;
    if (ok(p3) && Math.abs(norm(p3) - 1) > 1e-3) return null;
    const kind = B.i32(b + 116), n = B.i32(b + 124);
    let i = b + 128;
    let display = [];
    if (i + 16 > B.n) return null;
    const stride = B.i32(i), e8 = B.i32(i + 4), cnt = B.i32(i + 8);
    if (stride === 28 && e8 === 8) {
      if (!(cnt > 0 && cnt < 100000) || (n && cnt !== n) || i + 16 + 28 * cnt + 8 > B.n) return null;
      i += 16;
      for (let j = 0; j < cnt; j++) display.push(B.vec(i + 28 * j));
      i += 28 * cnt;
    } else if (n) return null;
    if (i + 8 > B.n) return null;
    const nbends = B.i32(i + 4);
    i += 8;
    const arc = kind === 3;
    if (!(nbends >= 0 && nbends <= 8) || (arc && !ok(p2))) return null;
    const e = { id: k, offset: o, loop: own, kind, p0, p1, p2: arc ? p2 : null, p3, bend: null, nbends, display };
    if (nbends) {
      if (i + 4 > B.n) return null;
      e.bend = B.i32(i);
      if (!(e.bend > 0 && e.bend <= k + 1)) return null;
    }
    return [e, i];
  }
  function bendHead(m, B, k, o, seen) {
    const b = o + 8;
    if (b + 33 > B.n) return null;
    const kind = m[b], r = B.f64(b + 1), d2 = B.f64(b + 9), die = B.f64(b + 17), flags = B.i32(b + 25);
    if (!(kind > 0 && kind < 32) || !(flags >= 0 && flags < (1 << 20))) return null;
    if (![r, d2, die].every(v => Number.isFinite(v) && Math.abs(v) < 1e5) || r < 0) return null;
    const x = { id: k, offset: o, kind, radius: r, d2, die, face: null, edge: null, partner: null, sides: null };
    const face = B.i32(b + 29);
    if (seen.has(face)) {
      x.face = face;
      x.edge = B.i32(b + 33);
      if (x.edge !== null && seen.has(x.edge) && b + X_PARTNER + 4 <= B.n) {
        x.partner = B.i32(b + X_PARTNER);
        x.sides = B.i16(b + X_SIDES);
      }
    }
    return x;
  }

  // ------------------------------------------------------------- reader
  function parse(m, version = 0, savedBy = '') {
    if (version && !VERSIONS.includes(version)) throw new Read3dError(`unsupported model version ${version}` + (version === 70 ? ' (old MetaCAM demo layout)' : ''));
    if (m.length < FONT_BLOCK + 8) throw new Read3dError('Model stream too short');
    const B = bytesOf(m);
    const nl = B.i32(FONT_BLOCK);
    if (!(nl >= 0 && nl < 1000)) throw new Read3dError(`implausible layer count ${nl}`);
    let i = FONT_BLOCK + 4;
    const layers = [];
    for (let q = 0; q < nl; q++) {
      if (i + 5 > m.length || m[i] !== 5) throw new Read3dError(`layer block at ${i} does not start with 05`);
      const n = B.i32(i + 1);
      if (!(n >= 0) || i + 6 + n + 16 > m.length) throw new Read3dError(`layer block at ${i} is truncated`);
      let name = ''; for (let c = 0; c < n; c++) name += String.fromCharCode(m[i + 5 + c]);
      layers.push({ name, thickness: B.f64(i + 6 + n), radius: B.f64(i + 14 + n) });
      i += 5 + n + LAYER_FIXED;
    }
    const nroot = B.i32(i);
    if (nroot === null) throw new Read3dError('Model stream truncated after the layers');
    i += 4;
    const md = { version, savedBy, layers, nroot, faces: new Map(), loops: new Map(), edges: new Map(),
                 bends: new Map(), unknown: new Map(), lastId: 0, recordsStart: i, size: m.length };
    const seen = new Set();
    let pos = i, k = 1;
    for (;;) {
      const pat = packI(k);
      let j = find(m, pat, pos), got = null;
      while (j >= 0 && got === null) {
        if (isTag(m, j + 4)) got = record(m, B, k, j, md, seen);
        if (got === null) j = find(m, pat, j + 1);
      }
      if (got === null) break;
      seen.add(k); md.lastId = k; pos = got; k++;
    }
    orderLoops(m, B, md);
    materialSides(m, B, md);
    return md;
  }

  function record(m, B, k, j, md, seen) {
    const t = String.fromCharCode(m[j + 4]);
    if (t === 'F') {
      const f = faceHead(m, B, k, j, md.layers.length);
      if (f) { md.faces.set(k, f); return j + 30; }
    } else if (t === 'L') {
      const lp = loopHead(m, B, k, j);
      if (lp) { md.loops.set(k, lp); return j + 12; }
    } else if (t === 'D') {
      const own = B.i32(j + 8);
      if (own === k + 1 && m[j + 12] === 76 && m[j + 13] === 0 && m[j + 14] === 0 && m[j + 15] === 0) {
        md.unknown.set(k, { id: k, offset: j, tag: 'D-before-loop' });
        return j + 8;
      }
      const got = edgeHead(m, B, k, j, md.loops);
      if (got) { md.edges.set(k, got[0]); return got[1]; }
    } else if (t === 'x') {
      const x = bendHead(m, B, k, j, seen);
      if (x) { md.bends.set(k, x); return j + 37; }
    } else if (REAL_UNKNOWN.includes(t) || j === md.recordsStart) {
      md.unknown.set(k, { id: k, offset: j, tag: t });
      return j + 8;
    }
    return null;
  }

  function orderLoops(m, B, md) {
    for (const lp of md.loops.values()) {
      const prev = md.faces.get(lp.id - 1);
      if (prev && prev.offset + 30 === lp.offset) lp.face = prev.id;
      else if (lp.offset >= 15) {
        const f = B.i32(lp.offset - 15);
        if (md.faces.has(f)) lp.face = f;
      }
    }
    for (const lp of [...md.loops.values()].sort((a, b) => a.id - b.id))
      if (md.faces.has(lp.face)) md.faces.get(lp.face).loops.push(lp.id);
    const byLoop = new Map();
    for (const e of md.edges.values()) { if (!byLoop.has(e.loop)) byLoop.set(e.loop, []); byLoop.get(e.loop).push(e); }
    for (const [lid, es] of byLoop) md.loops.get(lid).edges = chainEdges(es).map(e => e.id);
  }

  function array(m, B, o) {
    if (o + 16 > B.n) return null;
    const n = B.i32(o + 8);
    if (B.i32(o) !== 28 || B.i32(o + 4) !== 8 || !(n >= 0 && n < 100000) || o + 16 + 28 * n > B.n) return null;
    const pts = []; for (let q = 0; q < n; q++) pts.push(B.vec(o + 16 + 28 * q));
    return [pts, o + 16 + 28 * n];
  }
  function materialSides(m, B, md) {
    for (const f of md.faces.values()) {
      if (!f.loops.length) continue;
      const lp = md.loops.get(f.loops[0]);
      let j = find(m, ARRAY, lp.offset);
      while (j >= 0) {
        const got = tailOffset(m, B, j, f.id);
        if (got !== null) {
          f.tail = true;
          if (got.length) { f.t = norm(got); f.side = f.t > 1e-9 ? unit(got) : null; }
          break;
        }
        j = find(m, ARRAY, j + 1);
      }
    }
  }
  function tailOffset(m, B, j, face) {  // offset vector, [] if the arrays are empty, null if no tail here
    const a = array(m, B, j), b = a && array(m, B, a[1]);
    if (!b || b[0].length !== a[0].length) return null;
    if (!a[0].length) {
      const c = array(m, B, b[1]);
      const good = c && !c[0].length && c[1] + 4 <= B.n;
      return good && B.i32(c[1]) === face ? [] : null;
    }
    const d = sub(b[0][0], a[0][0]);
    for (let q = 0; q < a[0].length; q++) if (!close(sub(b[0][q], a[0][q]), d, 1e-6)) return null;
    const c = array(m, B, b[1]);
    if (!c || c[0].length !== a[0].length || c[1] + 4 > B.n) return null;
    return B.i32(c[1]) === face ? d : null;
  }

  const isArc = (e) => e.p2 !== null;
  function chainEdges(es) {
    const dots = es.filter(e => !isArc(e) && close(e.p0, e.p1));
    const rest = es.filter(e => !dots.includes(e)).sort((a, b) => a.id - b.id);
    if (!rest.length) return es.slice().sort((a, b) => a.id - b.id);
    const out = [rest.shift()];
    while (rest.length) {
      const at = rest.findIndex(e => close(e.p0, out[out.length - 1].p1));
      if (at < 0) break;
      out.push(rest.splice(at, 1)[0]);
    }
    for (const d of dots.slice().sort((a, b) => a.id - b.id)) {
      const at = out.findIndex(e => close(e.p1, d.p0));
      if (at >= 0) out.splice(at + 1, 0, d);
    }
    return out;
  }

  // ------------------------------------------------------------- checks (read3d.check)
  function facePlane(md, f) {
    if (!f.loops.length) return null;
    const pts = md.loops.get(f.loops[0]).edges.map(i => md.edges.get(i).p0);
    if (!pts.length) return null;
    const n = [0, 0, 0];
    for (let q = 0; q < pts.length; q++) {
      const a = pts[q], b = pts[(q + 1) % pts.length];
      n[0] += (a[1] - b[1]) * (a[2] + b[2]);
      n[1] += (a[2] - b[2]) * (a[0] + b[0]);
      n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const ln = norm(n);
    if (ln < 1e-9) return null;
    const c = [0, 1, 2].map(k => pts.reduce((s, p) => s + p[k], 0) / pts.length);
    return [c, scl(n, 1 / ln)];
  }
  function offPlane(md, f) {
    const pl = facePlane(md, f);
    if (!pl) return null;
    const [c, n] = pl;
    for (const lid of f.loops) for (const eid of md.loops.get(lid).edges) {
      const e = md.edges.get(eid);
      if (Math.max(Math.abs(dot(n, sub(e.p0, c))), Math.abs(dot(n, sub(e.p1, c)))) > PLANE_TOL) return lid;
    }
    return null;
  }
  function isClosed(md, lp) {
    const es = lp.edges.map(i => md.edges.get(i));
    return es.length > 0 && es.length === lp.nedges && close(es[es.length - 1].p1, es[0].p0);
  }
  function isOuter(md, lp) {
    const f = lp.face !== null ? md.faces.get(lp.face) : undefined;
    return !f || (f.loops.length > 0 && f.loops[0] === lp.id);
  }
  function relation(a, b) {
    if (close(a.p0, b.p0, MEET_TOL) && close(a.p1, b.p1, MEET_TOL)) return 'same';
    if (close(a.p0, b.p1, MEET_TOL) && close(a.p1, b.p0, MEET_TOL)) return 'reversed';
    if (isArc(a) || isArc(b)) return 'apart';
    if (norm(sub(a.p1, a.p0)) < norm(sub(b.p1, b.p0))) [a, b] = [b, a];
    const d = sub(a.p1, a.p0), ln = norm(d);
    if (ln < MEET_TOL) return 'apart';
    const u = scl(d, 1 / ln);
    const off = [b.p0, b.p1].map(q => norm(cross(u, sub(q, a.p0))));
    if (Math.max(...off) > MEET_TOL) return 'apart';
    const s = [b.p0, b.p1].map(q => dot(u, sub(q, a.p0))).sort((x, y) => x - y);
    return Math.min(ln, s[1]) - Math.max(0, s[0]) > MEET_TOL ? 'overlap' : 'apart';
  }
  function pairBendsMsgs(md) {
    const msgs = [], xpairs = [], named = new Set();
    for (const x of [...md.bends.values()].sort((a, b) => a.id - b.id)) {
      if (x.partner === null || xpairs.some(([p, q]) => p === x.partner && q === x.id)) continue;
      if (!md.bends.has(x.partner) || named.has(x.partner) || named.has(x.id)) {
        msgs.push(`x${x.id}: partner ref x${x.partner} is not a free bend record`); continue;
      }
      named.add(x.id); named.add(x.partner); xpairs.push([x.id, x.partner]);
    }
    for (const x of md.bends.values()) if (!named.has(x.id)) msgs.push(`x${x.id}: no partner`);
    const edgeOf = new Map(), addE = (x, e) => { if (!edgeOf.has(x)) edgeOf.set(x, new Set()); edgeOf.get(x).add(e); };
    for (const e of md.edges.values()) if (e.bend !== null) addE(e.bend, e.id);
    for (const x of md.bends.values()) if (md.edges.has(x.edge)) addE(x.id, x.edge);
    const spare = new Map();
    for (const e of md.edges.values()) if (e.nbends) spare.set(e.id, e.nbends);
    for (const es of edgeOf.values()) for (const eid of es) spare.set(eid, (spare.get(eid) || 0) - 1);
    for (const [xa, xb] of xpairs) for (const [me, other] of [[xa, xb], [xb, xa]]) {
      const known = edgeOf.get(other) || new Set();
      if ((edgeOf.get(me) && edgeOf.get(me).size) || known.size !== 1) continue;
      const oe = md.edges.get([...known][0]);
      const face = md.bends.get(me).face;
      const cands = [...spare].filter(([eid, n]) => n > 0 && eid !== oe.id &&
        (face === null || md.loops.get(md.edges.get(eid).loop).face === face) &&
        relation(md.edges.get(eid), oe) !== 'apart').map(([eid]) => eid);
      if (cands.length === 1) { edgeOf.set(me, new Set([cands[0]])); spare.set(cands[0], spare.get(cands[0]) - 1); }
    }
    const pairs = [];
    for (const [xa, xb] of xpairs) {
      const ea = [...(edgeOf.get(xa) || [])].sort((p, q) => p - q), eb = [...(edgeOf.get(xb) || [])].sort((p, q) => p - q);
      if (ea.length !== 1 || eb.length !== 1) {
        msgs.push(`x${xa}/x${xb}: ${ea.length}/${eb.length} edges carry them`);
        pairs.push({ xa, xb, ea: ea.length ? ea[0] : null, eb: eb.length ? eb[0] : null, relation: 'apart' });
        continue;
      }
      const rel = relation(md.edges.get(ea[0]), md.edges.get(eb[0]));
      pairs.push({ xa, xb, ea: ea[0], eb: eb[0], relation: rel });
      if (rel === 'apart') msgs.push(`x${xa}/x${xb}: edges D${ea[0]}/D${eb[0]} do not meet`);
    }
    return [pairs, msgs];
  }
  function sideFlags(md, pairs) {
    const out = [];
    for (const p of pairs) {
      if (p.ea === null || p.eb === null) continue;
      for (const xid of [p.xa, p.xb]) {
        const x = md.bends.get(xid);
        if (x.sides === null || (x.edge !== p.ea && x.edge !== p.eb)) continue;
        const own = md.edges.get(x.edge), oth = md.edges.get(x.edge === p.ea ? p.eb : p.ea);
        const fo = md.faces.get(md.loops.get(own.loop).face), ft = md.faces.get(md.loops.get(oth.loop).face);
        if (!fo || !ft || !fo.side || !ft.side || !(ok(own.p3) && ok(oth.p3))) continue;
        const a = dot(fo.side, oth.p3), b = dot(ft.side, own.p3);
        if (Math.abs(a) < 1e-6 || Math.abs(b) < 1e-6) continue;
        if (x.sides !== ((a < 0 ? 2 : 0) | (b < 0 ? 1 : 0))) out.push(`x${x.id}: side flags ${x.sides} disagree with F${fo.id}/F${ft.id}`);
      }
    }
    return out;
  }
  function check(md) {
    const out = [];
    if (md.unknown.size) out.push('unsupported records: ' + [...new Set([...md.unknown.values()].map(u => u.tag))].sort().join(' '));
    const ids = new Set([...md.faces.keys(), ...md.loops.keys(), ...md.edges.keys(), ...md.bends.keys(), ...md.unknown.keys()]);
    let gaps = ids.size !== md.lastId;
    for (let q = 1; !gaps && q <= md.lastId; q++) if (!ids.has(q)) gaps = true;
    if (gaps) out.push('id gaps');
    if (!md.faces.size && !md.unknown.size) out.push(md.nroot === 0 ? 'empty model' : 'no faces');
    else if (!md.unknown.size && md.faces.size !== md.nroot) out.push(`${md.faces.size} faces found, header says ${md.nroot}`);
    for (const f of md.faces.values()) {
      if (f.loops.length !== f.nloops) out.push(`F${f.id}: ${f.loops.length} loops found, F says ${f.nloops}`);
      if (f.loops.length && f.loops[0] !== f.id + 1) out.push(`F${f.id}: first loop is not L${f.id + 1}`);
    }
    for (const lp of md.loops.values()) {
      if (lp.face === null) out.push(`L${lp.id}: owner face not found`);
      let n = 0; for (const e of md.edges.values()) if (e.loop === lp.id) n++;
      if (n !== lp.nedges) out.push(`L${lp.id}: ${n} edges, L says ${lp.nedges}`);
      else if (lp.edges.length !== n) out.push(`L${lp.id}: edges do not chain`);
      else if (!isClosed(md, lp) && isOuter(md, lp)) out.push(`L${lp.id}: outer loop does not close`);
    }
    for (const f of md.faces.values()) {
      const bad = offPlane(md, f);
      if (bad !== null) out.push(`F${f.id}: loop L${bad} is not in the face's plane`);
      if (!f.tail) out.push(`F${f.id}: loop tail not found`);
    }
    for (const e of md.edges.values()) if (e.bend !== null && !md.bends.has(e.bend)) out.push(`D${e.id}: bend ref x${e.bend} missing`);
    const [pairs, msgs] = pairBendsMsgs(md);
    return out.concat(msgs, sideFlags(md, pairs));
  }
  function notes(md) {
    const out = [];
    for (const f of md.faces.values()) {
      if (!f.tail) continue;
      if (f.t === null) out.push(`F${f.id}: no offset polygon stored, material side unknown`);
      else if (!f.side) out.push(`F${f.id}: zero thickness (a reference face, not sheet)`);
      else if (Math.abs(f.t - md.layers[f.layer].thickness) > 1e-4)
        out.push(`F${f.id}: offset by ${f.t.toFixed(4)}, its layer says ${md.layers[f.layer].thickness.toFixed(4)}`);
    }
    return out;
  }

  // ------------------------------------------------------------- geometry for the viewer
  function arcCircle(e) {  // [centre, radius, unit normal]; P0 -> P2 -> P1 is CCW about the normal
    const a = e.p0, b = e.p2, c = e.p1;
    if (close(a, c)) {
      const n = unit(cross(e.p3, sub(b, a)));
      return [scl(add(a, b), 0.5), norm(sub(b, a)) / 2, n];
    }
    const ab = sub(b, a), ac = sub(c, a), n = cross(ab, ac), nn = dot(n, n);
    if (nn < 1e-18) return null;
    const t1 = cross(n, ab), t2 = cross(ac, n), k1 = dot(ac, ac) / (2 * nn), k2 = dot(ab, ab) / (2 * nn);
    const off = add(scl(t1, k1), scl(t2, k2));
    return [add(a, off), norm(off), unit(n)];
  }
  // Points of an edge from p0 up to (not including) p1.
  function edgePoints(e) {
    if (!isArc(e)) return [e.p0];
    const cc = arcCircle(e);
    if (!cc || !(cc[1] > 1e-9) || !cc[2].every(Number.isFinite)) return [e.p0, e.p2];
    const [c, r, n] = cc, u = unit(sub(e.p0, c)), v = cross(n, u);
    const ang = (p) => { const d = sub(p, c); let t = Math.atan2(dot(d, v), dot(d, u)); return t < 0 ? t + 2 * Math.PI : t; };
    let sweep = close(e.p0, e.p1) ? 2 * Math.PI : ang(e.p1);
    if (!(sweep > 1e-12)) sweep = 2 * Math.PI;
    const step = r > ARC_SAG ? 2 * Math.acos(Math.max(-1, 1 - ARC_SAG / r)) : Math.PI / 2;
    const segs = Math.min(720, Math.max(2, Math.ceil(sweep / step)));
    const out = [e.p0];
    for (let s = 1; s < segs; s++) {
      const t = sweep * s / segs, ct = Math.cos(t) * r, st = Math.sin(t) * r;
      out.push([c[0] + u[0] * ct + v[0] * st, c[1] + u[1] * ct + v[1] * st, c[2] + u[2] * ct + v[2] * st]);
    }
    return out;
  }
  function loopPolyline(md, lp) {
    const out = [];
    for (const id of lp.edges) { const e = md.edges.get(id); if (!isArc(e) && close(e.p0, e.p1)) continue; out.push(...edgePoints(e)); }
    return out;
  }

  function bmpBlob(bytes) {
    if (!bytes || bytes.length < 40) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let full = null;
    if (bytes[0] === 0x42 && bytes[1] === 0x4D) full = bytes;
    else if ([40, 52, 56, 108, 124].includes(dv.getUint32(0, true))) {  // bare DIB: prepend BITMAPFILEHEADER
      const hs = dv.getUint32(0, true), bpp = dv.getUint16(14, true), clr = dv.getUint32(32, true);
      const pal = bpp <= 8 ? (clr || (1 << bpp)) * 4 : (dv.getUint32(16, true) === 3 && hs === 40 ? 12 : 0);
      full = new Uint8Array(14 + bytes.length);
      const h = new DataView(full.buffer);
      full[0] = 0x42; full[1] = 0x4D; h.setUint32(2, full.length, true); h.setUint32(10, 14 + hs + pal, true);
      full.set(bytes, 14);
    } else if (bytes[0] === 0x89 && bytes[1] === 0x50) return typeof Blob !== 'undefined' ? new Blob([bytes], { type: 'image/png' }) : null;
    if (!full) return null;
    return typeof Blob !== 'undefined' ? new Blob([full], { type: 'image/bmp' }) : null;
  }

  async function read(buf) {
    const OLE = root.OLE2 || (typeof require !== 'undefined' ? require('./ole2.js') : null);
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const { streams } = OLE.read(u8);
    const notesOut = [], skipped = [];
    let thumbnail = null;
    try { const th = streams.get('Root/Thumbnail'); if (th) thumbnail = bmpBlob(await OLE.payload(th)); } catch (e) { notesOut.push('thumbnail unreadable: ' + e.message); }
    const raw = streams.get('Root/Model');
    const saved = streams.get('Root/SavedBy');
    let savedBy = '', version = 0;
    if (saved && saved.length > 4) { for (let q = 4; q < saved.length && saved[q]; q++) savedBy += String.fromCharCode(saved[q]); }
    const empty = (why) => {
      if (!thumbnail) throw new Read3dError(why);
      skipped.push(why);
      return { faces: [], bends: [], units: 'mm', bbox: null, thumbnail, notes: notesOut, skipped, version, savedBy, layers: [], md: null };
    };
    if (!raw) return empty('no Model stream in this .3d file');
    if (!(raw[8] === 0xA6 && raw[9] === 0x90 && raw[10] === 0x7F && raw[11] === 0x3B)) return empty('Model stream has no A6907F3B magic');
    version = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getInt32(4, true);
    let md;
    try { md = parse(await OLE.inflate(raw.subarray(16)), version, savedBy); }
    catch (e) { return empty(`MetaCAM model not readable: ${e.message}`); }
    const res = build(md);
    res.thumbnail = thumbnail;
    res.notes = notesOut.concat(res.notes);
    if (!res.faces.length) {
      const why = res.skipped.length ? res.skipped.join('; ') : (md.nroot === 0 ? 'empty model (no faces)' : 'no faces could be read');
      if (!thumbnail) throw new Read3dError(why);
      if (!res.skipped.includes(why)) res.skipped.push(why);
    }
    return res;
  }

  function build(md) {
    const notesOut = notes(md), skipped = [];
    const counts = {};
    for (const u of md.unknown.values()) counts[u.tag] = (counts[u.tag] || 0) + 1;
    for (const [tag, n] of Object.entries(counts)) skipped.push(`${n} x ${tag}: ${UNKNOWN_WHAT[tag] || 'unknown records'} not read (geometry missing)`);
    const faces = [], index = new Map();
    for (const f of md.faces.values()) {
      if (!f.loops.length) { skipped.push(`F${f.id}: no loops found`); continue; }
      const outerL = md.loops.get(f.loops[0]);
      if (outerL.edges.length !== outerL.nedges || !isClosed(md, outerL)) { skipped.push(`F${f.id}: outer loop incomplete`); continue; }
      const pl = facePlane(md, f);
      if (!pl) { skipped.push(`F${f.id}: degenerate outer loop`); continue; }
      const holes = [], marks = [];
      for (const lid of f.loops.slice(1)) {
        const lp = md.loops.get(lid);
        if (lp.edges.length !== lp.nedges) { skipped.push(`F${f.id}: inner loop L${lid} incomplete`); continue; }
        (isClosed(md, lp) ? holes : marks).push(loopPolyline(md, lp));
      }
      let side = f.side, t = f.t;
      const lt = md.layers[f.layer] ? md.layers[f.layer].thickness : 0;
      if (t === null) { side = pl[1]; t = lt; notesOut.push(`F${f.id}: material side guessed (+normal), t from layer`); }
      else if (!side) { side = pl[1]; t = 0; }
      index.set(f.id, faces.length);
      faces.push({ id: f.id, layer: f.layer, outer: loopPolyline(md, outerL), holes, marks, normal: pl[1], t, side, bend: false });
    }
    // bends: pairs of `x` records joining two flat faces along coincident/overlapping edges
    const bends = [];
    for (const p of pairBendsMsgs(md)[0]) {
      if (p.ea === null || p.eb === null || p.relation === 'apart') continue;
      const A = md.edges.get(p.ea), Bq = md.edges.get(p.eb);
      const fa = md.loops.get(A.loop).face, fb = md.loops.get(Bq.loop).face;
      if (!index.has(fa) || !index.has(fb)) continue;
      const a = faces[index.get(fa)], b = faces[index.get(fb)], x = md.bends.get(p.xa);
      const line = norm(sub(A.p1, A.p0)) <= norm(sub(Bq.p1, Bq.p0)) ? [A.p0, A.p1] : [Bq.p0, Bq.p1];
      const c = Math.min(1, Math.abs(dot(a.normal, b.normal)));
      const angle = Math.acos(c) * 180 / Math.PI;
      const fill = [];
      for (const s of line) fill.push(s, add(s, scl(a.side, a.t)), add(s, scl(b.side, b.t)));
      bends.push({ a: index.get(fa), b: index.get(fb), r: x.radius, die: x.die, angle, joint: x.radius === 0 && x.die === 0, sides: x.sides, line, fill });
    }
    if (bends.length) notesOut.push('bends are joints between flat faces (no cylinder faces stored); faces run to the bend line');
    // bbox of the slab solid
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const f of faces) for (const p of f.outer) for (const q of [p, add(p, scl(f.side, f.t))])
      for (let k = 0; k < 3; k++) { if (q[k] < mn[k]) mn[k] = q[k]; if (q[k] > mx[k]) mx[k] = q[k]; }
    const bbox = faces.length ? { min: mn, max: mx, size: sub(mx, mn) } : null;
    return { faces, bends, units: 'mm', bbox, thumbnail: null, notes: notesOut, skipped, version: md.version, savedBy: md.savedBy,
             layers: md.layers, md };
  }

  const api = { read, parse, check, notes, pairBends: (md) => pairBendsMsgs(md)[0], build, arcCircle, Read3dError };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MC3D = api;
})(typeof window !== 'undefined' ? window : globalThis);
