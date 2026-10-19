// Sheet faces for STEP / IGES / BREP bodies, so the Hide tool takes the same thing a MetaCAM .3d face is: a surface,
// the surface one thickness behind it, and the thin edge faces between them (sides, hole walls, bend ends).
// Sheet3D.merge(geometry, bb, faceOf) -> Int32Array (a group per triangle), or null when the body isn't sheet metal.
//   faceOf: the CAD face of each triangle (OpenCascade gives every face its own vertices).
// How: from each face's biggest triangles, cast a ray into the material. The distance most of the surface area sees
// is the sheet thickness; faces that see it pair with the face they hit (flats, and the inside/outside of bends).
// Every other face (an edge) joins the sheet face it shares the longest border with.
(function (root) {
  // ---- a uniform grid over the triangles, walked cell by cell along a ray (Amanatides & Woo) ----
  function buildGrid(P, I, nT, bb) {
    const ext = [0, 1, 2].map((k) => Math.max(bb[k + 3] - bb[k], 1e-9)), pad = 1e-6 * Math.max(...ext);
    const min = [bb[0] - pad, bb[1] - pad, bb[2] - pad];
    const res = Math.max(1, Math.min(96, Math.round(Math.cbrt(nT) * 1.2)));
    const n = [0, 1, 2].map((k) => Math.max(1, Math.round(res * ext[k] / Math.max(...ext))));
    const cs = [0, 1, 2].map((k) => (ext[k] + 2 * pad) / n[k]);
    const cell = (k, v) => Math.max(0, Math.min(n[k] - 1, Math.floor((v - min[k]) / cs[k])));
    const range = (t) => {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let j = 0; j < 3; j++) { const v = I[t * 3 + j] * 3; for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[v + k]); hi[k] = Math.max(hi[k], P[v + k]); } }
      return [cell(0, lo[0]), cell(0, hi[0]), cell(1, lo[1]), cell(1, hi[1]), cell(2, lo[2]), cell(2, hi[2])];
    };
    const N = n[0] * n[1] * n[2], count = new Int32Array(N + 1);
    const each = (t, fn) => { const [x0, x1, y0, y1, z0, z1] = range(t); for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) fn((z * n[1] + y) * n[0] + x); };
    for (let t = 0; t < nT; t++) each(t, (c) => count[c + 1]++);
    for (let c = 0; c < N; c++) count[c + 1] += count[c];
    const at = count.slice(), tris = new Int32Array(count[N]);
    for (let t = 0; t < nT; t++) each(t, (c) => { tris[at[c]++] = t; });
    return { min, n, cs, start: count, tris, mark: new Int32Array(nT), stamp: 0 };
  }
  // nearest triangle along o + s d (0 < s < smax) that isn't on face `skip`
  function cast(G, P, I, fid, o, d, smax, skip) {
    const { min, n, cs } = G, stamp = ++G.stamp;
    const c = [0, 1, 2].map((k) => Math.max(0, Math.min(n[k] - 1, Math.floor((o[k] - min[k]) / cs[k]))));
    const step = [], tMax = [], tDelta = [];
    for (let k = 0; k < 3; k++) {
      step[k] = d[k] > 0 ? 1 : d[k] < 0 ? -1 : 0;
      const edge = min[k] + (c[k] + (step[k] > 0 ? 1 : 0)) * cs[k];
      tMax[k] = step[k] ? (edge - o[k]) / d[k] : Infinity;
      tDelta[k] = step[k] ? cs[k] / Math.abs(d[k]) : Infinity;
    }
    let best = smax, bt = -1;
    const eps = 1e-9 * smax;
    for (;;) {
      const ci = (c[2] * n[1] + c[1]) * n[0] + c[0];
      for (let j = G.start[ci]; j < G.start[ci + 1]; j++) {
        const t = G.tris[j];
        if (G.mark[t] === stamp) continue; G.mark[t] = stamp;
        if (fid[t] === skip) continue;
        // Moller-Trumbore
        const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, cc = I[t * 3 + 2] * 3;
        const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
        const e2x = P[cc] - P[a], e2y = P[cc + 1] - P[a + 1], e2z = P[cc + 2] - P[a + 2];
        const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
        const det = e1x * px + e1y * py + e1z * pz; if (Math.abs(det) < 1e-18) continue;
        const inv = 1 / det, sx = o[0] - P[a], sy = o[1] - P[a + 1], sz = o[2] - P[a + 2];
        const u = (sx * px + sy * py + sz * pz) * inv; if (u < -1e-9 || u > 1 + 1e-9) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv; if (v < -1e-9 || u + v > 1 + 1e-9) continue;
        const s = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (s > eps && s < best) { best = s; bt = t; }
      }
      const k = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
      if (best <= tMax[k] || tMax[k] > smax) break;      // nothing nearer is left in later cells
      c[k] += step[k]; if (c[k] < 0 || c[k] >= n[k]) break;
      tMax[k] += tDelta[k];
    }
    return bt < 0 ? null : { t: bt, s: best };
  }

  function merge(g, bb, faceOf) {
    const P = g.attributes.position.array, N = g.attributes.normal ? g.attributes.normal.array : null, I = g.index.array, nT = I.length / 3;
    const diag = Math.hypot(bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]) || 1;
    const fid = new Int32Array(nT), ids = new Map(); let nF = 0;
    for (let t = 0; t < nT; t++) { let k = ids.get(faceOf[t]); if (k === undefined) ids.set(faceOf[t], k = nF++); fid[t] = k; }
    if (nF < 3) return null;
    // per triangle: unit normal (geometric), area, centroid, and the shading normal (OpenCascade's, which points out)
    const tn = new Float64Array(nT * 3), ta = new Float64Array(nT), tc = new Float64Array(nT * 3), fArea = new Float64Array(nF), best = [];
    for (let t = 0; t < nT; t++) {
      const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz);
      ta[t] = l / 2; if (l > 0) { nx /= l; ny /= l; nz /= l; }
      tn[t * 3] = nx; tn[t * 3 + 1] = ny; tn[t * 3 + 2] = nz;
      for (let k = 0; k < 3; k++) tc[t * 3 + k] = (P[a + k] + P[b + k] + P[c + k]) / 3;
      const f = fid[t]; fArea[f] += ta[t];
      const B = best[f] || (best[f] = []);
      if (B.length < 2) B.push(t); else { const w = ta[B[0]] < ta[B[1]] ? 0 : 1; if (ta[t] > ta[B[w]]) B[w] = t; }
    }
    const outN = (t) => {
      if (!N) return [tn[t * 3], tn[t * 3 + 1], tn[t * 3 + 2]];
      let x = 0, y = 0, z = 0;
      for (let j = 0; j < 3; j++) { const v = I[t * 3 + j] * 3; x += N[v]; y += N[v + 1]; z += N[v + 2]; }
      const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l];
    };
    const G = buildGrid(P, I, nT, bb), smax = 0.35 * diag, total = fArea.reduce((s, a) => s + a, 0);
    // into the material is against the outward normal; if a body's normals are flipped, try the other way
    function attempt(sign) {
      const fD = new Float64Array(nF).fill(NaN), fP = new Int32Array(nF).fill(-1);
      for (let f = 0; f < nF; f++) {
        const ds = [], ps = [];
        for (const t of best[f] || []) {
          const n = outN(t), d = [-sign * n[0], -sign * n[1], -sign * n[2]], o = [tc[t * 3], tc[t * 3 + 1], tc[t * 3 + 2]];
          const h = cast(G, P, I, fid, o, d, smax, f);
          // the far side of a sheet faces the other way
          if (h && Math.abs(n[0] * tn[h.t * 3] + n[1] * tn[h.t * 3 + 1] + n[2] * tn[h.t * 3 + 2]) > 0.9) { ds.push(h.s); ps.push(fid[h.t]); }
        }
        if (ds.length) { fD[f] = Math.min(...ds); fP[f] = ps[ds.indexOf(fD[f])]; }
      }
      // thickness: the distance that most surface area sees
      const bin = diag * 2e-4, bins = new Map();
      for (let f = 0; f < nF; f++) if (fD[f] === fD[f]) { const k = Math.round(fD[f] / bin), e = bins.get(k) || bins.set(k, { a: 0, d: 0 }).get(k); e.a += fArea[f]; e.d += fD[f] * fArea[f]; }
      let top = null; for (const e of bins.values()) if (!top || e.a > top.a) top = e;
      if (!top) return null;
      const th = top.d / top.a, tol = Math.max(th * 0.08, diag * 3e-4);   // bends: the facets sag off the true radius
      const sheet = new Uint8Array(nF); let area = 0;
      for (let f = 0; f < nF; f++) if (Math.abs(fD[f] - th) < tol) { sheet[f] = 1; area += fArea[f]; }
      return area >= 0.6 * total ? { sheet, fP, th } : null;
    }
    const S = attempt(1) || attempt(-1);
    if (!S) return null;
    const par = new Int32Array(nF).map((_, i) => i);
    const find = (x) => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
    const join = (a, b) => { a = find(a); b = find(b); if (a !== b) par[b] = a; };
    for (let f = 0; f < nF; f++) if (S.sheet[f] && S.fP[f] >= 0) join(f, S.fP[f]);
    // borders: a triangle edge used once inside a face is on its border; faces meet where their borders match
    const q = Math.max(diag * 1e-7, 1e-12);
    const key = (v) => Math.round(P[v * 3] / q) + ',' + Math.round(P[v * 3 + 1] / q) + ',' + Math.round(P[v * 3 + 2] / q);
    const vk = new Array(P.length / 3); for (let v = 0; v < vk.length; v++) vk[v] = key(v);
    const inFace = new Map();           // face|edge -> uses
    for (let t = 0; t < nT; t++) for (let j = 0; j < 3; j++) {
      const a = vk[I[t * 3 + j]], b = vk[I[t * 3 + (j + 1) % 3]], e = fid[t] + '|' + (a < b ? a + '|' + b : b + '|' + a);
      inFace.set(e, (inFace.get(e) || 0) + 1);
    }
    const border = new Map();           // edge -> [{ f, len }]
    for (const [e, uses] of inFace) {
      if (uses !== 1) continue;
      const i = e.indexOf('|'), f = +e.slice(0, i), edge = e.slice(i + 1);
      let l = border.get(edge); if (!l) border.set(edge, l = []); l.push(f);
    }
    const lenOf = (edge) => { const p = edge.split('|').map((s) => s.split(',').map((x) => +x * q)); return Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1], p[0][2] - p[1][2]); };
    // edge face -> sheet group -> { len: border shared with it, keys: the border's vertices }
    const shared = new Map();
    for (const [edge, fs] of border) {
      if (fs.length < 2) continue;
      const L = lenOf(edge), [a, b] = edge.split('|');
      for (const f of fs) if (!S.sheet[f]) for (const h of fs) if (h !== f && S.sheet[h]) {
        let m = shared.get(f); if (!m) shared.set(f, m = new Map());
        const r = find(h); let e = m.get(r); if (!e) m.set(r, e = { len: 0, keys: new Set() });
        e.len += L; e.keys.add(a); e.keys.add(b);
      }
    }
    const out = new Int32Array(nT); for (let t = 0; t < nT; t++) out[t] = -1;
    const trisOf = new Map(); for (let t = 0; t < nT; t++) { const f = fid[t]; let l = trisOf.get(f); if (!l) trisOf.set(f, l = []); l.push(t); }
    for (const [f, m] of shared) {
      const groups = [...m].filter(([, e]) => e.len >= 0.5 * S.th);
      if (groups.length <= 1) { let bh = -1, bl = 0; for (const [h, e] of m) if (e.len > bl) { bl = e.len; bh = h; } if (bh >= 0) join(bh, f); continue; }
      // one CAD face along several sheet faces (a bent part's whole side profile): split it, each triangle going with
      // the sheet face most of its corners lie on; triangles with no say take a neighbour's
      const tris = trisOf.get(f), byKey = new Map();
      for (const t of tris) {
        let best = -1, bc = 0;
        for (const [r, e] of groups) { let c = 0; for (let j = 0; j < 3; j++) if (e.keys.has(vk[I[t * 3 + j]])) c++; if (c > bc) { bc = c; best = r; } }
        out[t] = best;
        for (let j = 0; j < 3; j++) { const k = vk[I[t * 3 + j]]; let l = byKey.get(k); if (!l) byKey.set(k, l = []); l.push(t); }
      }
      for (let pass = 0, left = true; left && pass < 50; pass++) {
        left = false;
        for (const t of tris) if (out[t] < 0) {
          for (let j = 0; j < 3 && out[t] < 0; j++) for (const u of byKey.get(vk[I[t * 3 + j]])) if (out[u] >= 0) { out[t] = out[u]; break; }
          if (out[t] < 0) left = true;
        }
      }
      for (const t of tris) if (out[t] < 0) out[t] = groups[0][0];
    }
    for (let t = 0; t < nT; t++) out[t] = out[t] >= 0 ? find(out[t]) : find(fid[t]);
    return out;
  }

  root.Sheet3D = { merge };
})(typeof window !== 'undefined' ? window : globalThis);
