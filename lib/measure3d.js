// Dimension tool for the 3D view (STEP / IGES / BREP / MetaCAM .3d, on three.js r147 globals) and the 2D view.
// Snaps follow K-FACTOR's Edit Plane rules (app/static/snap.js): the same types, the same priority groups,
// 10 px reach, a point held 250 ms becomes an active point for construction lines (the four most recent).
// K-FACTOR gets its fixed points (end/mid/center/quad) exactly from Python; here they come from the mesh's
// feature edges, chained and split into straight runs and arcs (tessellated circles -> centre + quadrants).
//
// Picks: a snapped point, or (no snap within reach, or Shift held) a flat face - in 2D, a straight line.
//   point-point -> distance + its X / Y / Z legs, each with its value on a leader;
//   point-face, parallel faces -> perpendicular distance;  faces not parallel -> angle (an arc about where the planes meet).
//   (2D: the same with lines - parallel lines give the gap, crossing lines the angle at their corner.)
//
// const tool = Measure.create({ el, bar?, canvas, render(), unit() -> 'in'|'mm', onActive(on),
//     3D: camera, scene, raycast(x, y) -> hit|null, visible(p) -> bool
//     2D: planar: true, scr(p) -> [sx, sy, 0], ray(sx, sy) -> { o, d } })
// tool.setModel(model|null, edgeSegs Float32Array [ax,ay,az,bx,by,bz, ...], bb6?)   tool.setEdges(edgeSegs) (after a show/hide)
// tool.setActive(on)   tool.draw() (after each frame)   tool.key(ev) -> handled   tool.active
// Resolution and which snaps are on are shared by every instance (and remembered on the PC).
// Printing: const restore = tool.printPrep() (no snap marker, hover or half-made dim); await tool.snapshot(ctx2d, scale); restore()
(function (root) {
  let THREE = root.THREE;   // the 2D view loads this before three.js: picked up again by create()
  const TYPES = [
    ['on', 'On'], ['end', 'Endpoint'], ['mid', 'Midpoint'], ['int', 'Intersection'],
    ['center', 'Center'], ['quad', 'Quadrant'], ['tan', 'Tangent'], ['perp', 'Perpendicular'],
    ['cons', 'Cons. Line'],
  ];
  const LABEL = {
    end: 'endpoint', mid: 'midpoint', int: 'intersection', center: 'center', quad: 'quadrant',
    tan: 'tangent', perp: 'perpendicular', on: 'on',
  };
  // Several snaps within reach: the lowest group wins, then the nearest within it.
  const GROUP = { end: 0, int: 0, center: 0, mid: 0, quad: 0, perp: 1, tan: 1, consint: 2, align: 3, on: 4 };
  const RES = ['0.0', '0.00', '0.000', '0.0000', '1/8', '1/16', '1/32', '1/64'];
  const AXES = [['X', [1, 0, 0], '#e5484d'], ['Y', [0, 1, 0], '#3fb950'], ['Z', [0, 0, 1], '#4c8dff']];
  const REACH = 10, DWELL = 250, CLICK_PX = 4;
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  // ---- small vector helpers on [x, y, z] ----
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const scl = (a, k) => [a[0] * k, a[1] * k, a[2] * k], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = (a) => Math.hypot(a[0], a[1], a[2]), dist = (a, b) => len(sub(a, b));
  const norm = (a) => { const l = len(a); return l > 1e-15 ? scl(a, 1 / l) : null; };
  const TAU = 2 * Math.PI;
  const sangle = (a, b, n) => Math.atan2(dot(cross(a, b), n), dot(a, b));  // signed angle a -> b about n
  const turn = (a, b, c) => { const u = norm(sub(b, a)), v = norm(sub(c, b)); return u && v ? Math.acos(Math.max(-1, Math.min(1, dot(u, v)))) : 0; };

  // ================= feature edges -> straight runs and arcs =================
  // circle through three points (null if they're in a line)
  function circle3(a, b, c) {
    const ab = sub(b, a), ac = sub(c, a), n = cross(ab, ac), n2 = dot(n, n);
    if (n2 < 1e-30) return null;
    const off = scl(add(scl(cross(n, ab), dot(ac, ac)), scl(cross(ac, n), dot(ab, ab))), 1 / (2 * n2));
    return { c: add(a, off), r: len(off), n: norm(n) };
  }
  // the in-plane directions an arc's quadrants sit on: the world axis lying most in the plane, and n x it
  function quadAxes(n) {
    let best = null;
    for (const [, e] of AXES) { const d = Math.abs(dot(e, n)); if (!best || d < best.d) best = { d, e }; }
    const qa = norm(sub(best.e, scl(n, dot(best.e, n))));
    return [qa, cross(n, qa)];
  }
  function makeArc(C, P, full) {
    let n = C.n, sw = 0;
    for (let i = 0; i + 1 < P.length; i++) sw += sangle(sub(P[i], C.c), sub(P[i + 1], C.c), n);
    if (sw < 0) { n = scl(n, -1); sw = -sw; }                      // run counter-clockwise about n
    const u = norm(sub(P[0], C.c)), v = cross(n, u);
    return { c: C.c, r: C.r, n, u, v, sw: full ? TAU : sw, full, p: P[0], q: P[P.length - 1] };
  }
  const arcAngle = (A, x) => { const d = sub(x, A.c); let a = Math.atan2(dot(d, A.v), dot(d, A.u)); if (a < 0) a += TAU; return a; };
  const onSweep = (A, a, eps = 1e-9) => A.full || (((a % TAU) + TAU) % TAU) <= A.sw + eps;
  const arcAt = (A, a) => add(A.c, add(scl(A.u, A.r * Math.cos(a)), scl(A.v, A.r * Math.sin(a))));

  // Split one chain of edge points into arcs and straight runs. Tessellated arcs are runs of 3+ segments that turn
  // the same way by less than 40 degrees each, all on one circle.
  function decompose(P, closed, tolOf, out) {
    const MAXT = 40 * Math.PI / 180, STRAIGHT = 0.3 * Math.PI / 180;
    const fits = (C, p) => { const d = sub(p, C.c), t = tolOf(C); return Math.abs(dot(d, C.n)) < t && Math.abs(len(d) - C.r) < t; };
    if (closed && P.length >= 5) {
      const n = P.length, C = circle3(P[0], P[Math.floor(n / 3)], P[Math.floor(2 * n / 3)]);
      let small = true;
      for (let i = 0; i < n && small; i++) small = turn(P[(i + n - 1) % n], P[i], P[(i + 1) % n]) < MAXT;
      if (C && small && P.every((p) => fits(C, p))) { out.arcs.push(makeArc(C, P.concat([P[0]]), true)); return; }
      // start at the sharpest corner so the loop's seam doesn't cut an arc in two
      let k = 0, kt = -1;
      for (let i = 0; i < n; i++) { const t = turn(P[(i + n - 1) % n], P[i], P[(i + 1) % n]); if (t > kt) { kt = t; k = i; } }
      P = P.slice(k).concat(P.slice(0, k));
    }
    const Q = closed ? P.concat([P[0]]) : P, m = Q.length - 1;
    const turnAt = (j) => (j <= 0 || j >= m ? Infinity : turn(Q[j - 1], Q[j], Q[j + 1]));
    const side = (j, n) => Math.sign(dot(cross(sub(Q[j], Q[j - 1]), sub(Q[j + 1], Q[j])), n));
    let i = 0;
    while (i < m) {
      let j = i + 1;
      if (i + 3 <= m) {
        const C = circle3(Q[i], Q[i + 1], Q[i + 2]);
        const ok = (t) => t > STRAIGHT && t < MAXT;
        if (C && ok(turnAt(i + 1)) && ok(turnAt(i + 2)) && side(i + 1, C.n) === side(i + 2, C.n) && fits(C, Q[i + 3])) {
          const s = side(i + 1, C.n);
          j = i + 3;
          while (j < m && ok(turnAt(j)) && side(j, C.n) === s && fits(C, Q[j + 1])) j++;
          out.arcs.push(makeArc(C, Q.slice(i, j + 1), false));
          i = j; continue;
        }
      }
      while (j < m && turnAt(j) < STRAIGHT) j++;
      out.lines.push({ p: Q[i], q: Q[j] });
      i = j;
    }
  }

  // feature-edge segments -> chains (split where 1 or 3+ edges meet) -> lines/arcs -> fixed snap points
  function analyze(seg, diag) {
    const q = Math.max(diag * 1e-7, 1e-9), nodes = new Map(), edges = [];
    const node = (x, y, z) => {
      const k = Math.round(x / q) + ',' + Math.round(y / q) + ',' + Math.round(z / q);
      let n = nodes.get(k); if (!n) nodes.set(k, n = { p: [x, y, z], e: [] });
      return n;
    };
    for (let i = 0; i < seg.length; i += 6) {
      const a = node(seg[i], seg[i + 1], seg[i + 2]), b = node(seg[i + 3], seg[i + 4], seg[i + 5]);
      if (a === b) continue;
      const e = { a, b, used: false }; edges.push(e); a.e.push(e); b.e.push(e);
    }
    const out = { lines: [], arcs: [] };
    const tolOf = (C) => Math.max(C.r * 2e-4, diag * 2e-6);   // tessellated circles sit right on the curve; splines (lettering) do not
    const follow = (start, e0) => {
      const pts = [start.p]; let e = e0, at = start, closed = false;
      for (;;) {
        e.used = true;
        const nx = e.a === at ? e.b : e.a;
        if (nx === start) { closed = true; break; }
        pts.push(nx.p);
        if (nx.e.length !== 2) break;
        const ne = nx.e.find((x) => !x.used); if (!ne) break;
        e = ne; at = nx;
      }
      if (pts.length >= 2) decompose(pts, closed && pts.length >= 3, tolOf, out);
    };
    for (const n of nodes.values()) if (n.e.length !== 2) for (const e of n.e) if (!e.used) follow(n, e);
    for (const e of edges) if (!e.used) follow(e.a, e);   // what's left is closed loops
    // fixed snap points, de-duplicated
    const fixed = [], seen = new Set();
    const put = (t, p) => {
      const k = t + Math.round(p[0] / q) + ',' + Math.round(p[1] / q) + ',' + Math.round(p[2] / q);
      if (!seen.has(k)) { seen.add(k); fixed.push({ t, p }); }
    };
    for (const L of out.lines) { put('end', L.p); put('end', L.q); put('mid', scl(add(L.p, L.q), 0.5)); }
    for (const A of out.arcs) {
      put('center', A.c);
      if (!A.full) { put('end', A.p); put('end', A.q); put('mid', arcAt(A, A.sw / 2)); }
      const [qa, qb] = quadAxes(A.n);
      for (const d of [qa, qb, scl(qa, -1), scl(qb, -1)]) {
        const a = arcAngle(A, add(A.c, d));
        if (onSweep(A, a, 1e-6)) put('quad', arcAt(A, a));
      }
    }
    return { fixed, lines: out.lines, arcs: out.arcs, seg };
  }

  // ================= faces: grow a flat region from the triangle under the cursor =================
  const faceCache = new WeakMap();
  function prepFaces(g, info, diag, map) {         // map: this geometry's triangle -> the unhidden one (show/hide)
    const P = g.attributes.position.array, N = g.attributes.normal ? g.attributes.normal.array : null;
    const I = g.index ? g.index.array : null, nT = (I ? I.length : P.length / 3) / 3;
    const vi = (t, k) => (I ? I[t * 3 + k] : t * 3 + k);
    const vp = (v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
    const q = Math.max(diag * 1e-7, 1e-9), key = (p) => Math.round(p[0] / q) + ',' + Math.round(p[1] / q) + ',' + Math.round(p[2] / q);
    const tn = new Float64Array(nT * 3), planar = new Uint8Array(nT), keys = new Array(nT * 3), byKey = new Map();
    const cosN = Math.cos(3 * Math.PI / 180);
    for (let t = 0; t < nT; t++) {
      const a = vp(vi(t, 0)), b = vp(vi(t, 1)), c = vp(vi(t, 2)), n = norm(cross(sub(b, a), sub(c, a)));
      if (!n) continue;
      tn[t * 3] = n[0]; tn[t * 3 + 1] = n[1]; tn[t * 3 + 2] = n[2];
      // flat if the file says so (.3d: the faces before the bends), else if every vertex normal is the face normal
      if (info && info.flatTris != null) planar[t] = (map ? map[t] : t) < info.flatTris ? 1 : 0;
      else if (N) {
        let ok = 1;
        for (let k = 0; k < 3 && ok; k++) { const v = vi(t, k); ok = Math.abs(N[v * 3] * n[0] + N[v * 3 + 1] * n[1] + N[v * 3 + 2] * n[2]) > cosN ? 1 : 0; }
        planar[t] = ok;
      } else planar[t] = 1;
      for (let k = 0; k < 3; k++) {
        const s = key([a, b, c][k]); keys[t * 3 + k] = s;
        let l = byKey.get(s); if (!l) byKey.set(s, l = []); l.push(t);
      }
    }
    return { P, I, vi, vp, nT, tn, planar, keys, byKey, region: new Int32Array(nT).fill(-1), regions: [], tolD: Math.max(diag * 1e-5, 1e-9) };
  }
  function faceOf(hit, diag) {
    if (!hit || hit.faceIndex == null) return null;
    const g = hit.object.geometry;
    let F = faceCache.get(g); if (!F) faceCache.set(g, F = prepFaces(g, hit.object.userData.info, diag, hit.object.userData.map));
    const t0 = hit.faceIndex;
    if (!F.planar[t0]) return null;
    if (F.region[t0] < 0) {
      const id = F.regions.length, n0 = [F.tn[t0 * 3], F.tn[t0 * 3 + 1], F.tn[t0 * 3 + 2]], P0 = F.vp(F.vi(t0, 0));
      const cos = Math.cos(0.5 * Math.PI / 180), tris = [], stack = [t0];
      F.region[t0] = id;
      while (stack.length) {
        const t = stack.pop(); tris.push(t);
        for (let k = 0; k < 3; k++) for (const u of F.byKey.get(F.keys[t * 3 + k]) || []) {
          if (F.region[u] >= 0 || !F.planar[u]) continue;
          const nu = [F.tn[u * 3], F.tn[u * 3 + 1], F.tn[u * 3 + 2]];
          if (Math.abs(dot(nu, n0)) < cos || Math.abs(dot(sub(F.vp(F.vi(u, 0)), P0), n0)) > F.tolD) continue;
          F.region[u] = id; stack.push(u);
        }
      }
      F.regions.push({ n: n0, P: P0, tris, F });
    }
    return F.regions[F.region[t0]];
  }
  function faceGeometry(R) {
    if (R.geo) return R.geo;
    const F = R.F, pos = new Float32Array(R.tris.length * 9);
    R.tris.forEach((t, i) => { for (let k = 0; k < 3; k++) { const p = F.vp(F.vi(t, k)); pos.set(p, i * 9 + k * 3); } });
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return (R.geo = g);
  }

  // ================= closest points =================
  function raySeg(o, d, a, b, clamp = true) {           // point on segment/line a-b nearest the ray o + t d
    const u = sub(b, a), w = sub(a, o), A = dot(u, u), B = dot(u, d), C = dot(d, d), D = dot(u, w), E = dot(d, w);
    const den = A * C - B * B;
    let s = den > 1e-20 ? (B * E - C * D) / den : 0;
    if (clamp) s = Math.max(0, Math.min(1, s));
    return add(a, scl(u, s));
  }
  function lineLine(a1, e1, a2, e2) {                      // closest points of two infinite lines
    const w = sub(a1, a2), b = dot(e1, e2), d = dot(e1, w), e = dot(e2, w), den = 1 - b * b;
    if (den < 1e-12) return null;
    const s = (b * e - d) / den, t = (e - b * d) / den;
    return [add(a1, scl(e1, s)), add(a2, scl(e2, t))];
  }
  function perpendicular(f, L, A) {
    if (L) {
      const d = sub(L.q, L.p), L2 = dot(d, d); if (!L2) return [];
      const t = dot(sub(f, L.p), d) / L2;
      return t < -1e-9 || t > 1 + 1e-9 ? [] : [add(L.p, scl(d, t))];
    }
    const fp = sub(f, scl(A.n, dot(sub(f, A.c), A.n)));
    if (dist(fp, A.c) < 1e-12) return [];
    const a = arcAngle(A, fp);
    return [a, a + Math.PI].filter((x) => onSweep(A, x)).map((x) => arcAt(A, x));
  }
  function tangent(f, A) {
    const fp = sub(f, scl(A.n, dot(sub(f, A.c), A.n))), d = dist(fp, A.c);
    if (d <= A.r + 1e-12) return [];
    const base = arcAngle(A, fp), al = Math.acos(A.r / d);
    return [base + al, base - al].filter((x) => onSweep(A, x)).map((x) => arcAt(A, x));
  }

  // ================= the tool =================
  let snapOn = new Set(store.get('fv.snaps3d', TYPES.map(([k]) => k)));
  let res = store.get('fv.dimres', '0.000'); if (!RES.includes(res)) res = '0.000';

  let made = 0;
  function create(opts) {
    THREE = root.THREE || THREE;
    const uid = 'mt' + (++made) + '-';
    let o = null, cam = null, model = null, geo = null, segs = null, diag = 1, active = false;
    const planar = !!opts.planar, AX = planar ? AXES.slice(0, 2) : AXES;   // 2D: no Z
    let mouse = null, shift = false, cur = null, hoverFace = null, first = null, tracked = [], dwell = 0, perpCache = null;
    let ui = {}, faceMesh = null, firstMesh = null, scene = null, labels = [], down = null, raf = 0;

    function init(opts) {
      o = opts; cam = opts.camera || null; scene = opts.scene || null;
      const bar = opts.bar || document.createElement('div'); bar.classList.add('meas3');
      bar.insertAdjacentHTML('beforeend', `<button data-a="dim" title="Dimension tool (D): click two points, or ${planar ? 'lines' : 'flat faces'}. Shift = ${planar ? 'line' : 'face'} only">Dim</button>` +
        `<select data-a="res" title="Dimension resolution">${RES.map((r) => `<option value="${r}"${r === res ? ' selected' : ''}>${r.includes('/') ? r + '"' : r + '"'}</option>`).join('')}</select>` +
        `<span class="snapwrap"><button data-a="snaps" title="Which snaps are on">Snaps ▾</button>` +
        `<div class="snapmenu" hidden>${TYPES.map(([k, n]) => `<label><input type="checkbox" data-k="${k}"${snapOn.has(k) ? ' checked' : ''}> ${n}</label>`).join('')}</div></span>` +
        `<button data-a="clear" title="Remove every dimension on this file">Clear</button>`);
      const prompt = document.createElement('div'); prompt.className = 'mprompt';
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'meas3svg');
      const lab = document.createElement('div'); lab.className = 'meas3lab';
      o.el.append(svg, lab, prompt); if (!opts.bar) o.el.append(bar);
      ui = { bar, prompt, svg, lab, resSel: bar.querySelector('[data-a=res]'), btn: bar.querySelector('[data-a=dim]'), menu: bar.querySelector('.snapmenu'), clear: bar.querySelector('[data-a=clear]') };
      ui.btn.onclick = () => setActive(!active);
      bar.querySelector('[data-a=res]').onchange = (e) => { res = e.target.value; store.set('fv.dimres', res); o.render(); };
      bar.querySelector('[data-a=snaps]').onclick = (e) => {
        e.stopPropagation(); ui.menu.hidden = !ui.menu.hidden;
        ui.menu.querySelectorAll('input').forEach((i) => (i.checked = snapOn.has(i.dataset.k)));   // the other view may have changed them
      };
      ui.menu.addEventListener('click', (e) => e.stopPropagation());
      document.addEventListener('click', () => { ui.menu.hidden = true; });
      ui.menu.querySelectorAll('input').forEach((i) => (i.onchange = () => {
        if (i.checked) snapOn.add(i.dataset.k); else snapOn.delete(i.dataset.k);
        store.set('fv.snaps3d', [...snapOn]); perpCache = null; refresh();
      }));
      ui.clear.onclick = () => { if (model) model.dims = []; cancel(); o.render(); };
      lab.addEventListener('click', (e) => {
        const d = e.target.closest('[data-i]'); if (!d || !model) return;
        model.dims.splice(+d.dataset.i, 1); o.render();
      });
      const cv = opts.canvas;
      cv.addEventListener('pointermove', (e) => {
        if (!active) return;
        shift = e.shiftKey;
        const r = cv.getBoundingClientRect();
        mouse = e.buttons ? null : [e.clientX - r.left, e.clientY - r.top];
        if (!raf) raf = requestAnimationFrame(() => { raf = 0; refresh(); });
      });
      cv.addEventListener('pointerleave', () => { mouse = null; refresh(); });
      cv.addEventListener('pointerdown', (e) => { if (active && e.button === 0) down = [e.clientX, e.clientY]; });
      cv.addEventListener('pointerup', (e) => {
        if (!active || e.button !== 0 || !down) return;
        const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]); down = null;
        if (moved > (e.pointerType === 'mouse' ? CLICK_PX : 10)) return;   // that was an orbit (a finger wobbles more)
        const r = cv.getBoundingClientRect(); shift = e.shiftKey;
        mouse = [e.clientX - r.left, e.clientY - r.top]; refresh(); pick();
      });
      if (scene) {                                       // 3D: the face under the cursor / the first face, tinted
        const mat = (op) => new THREE.MeshBasicMaterial({ color: 0xd25800, transparent: true, opacity: op, side: THREE.DoubleSide,
          depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        faceMesh = new THREE.Mesh(new THREE.BufferGeometry(), mat(0.28)); faceMesh.visible = false; faceMesh.renderOrder = 2;
        firstMesh = new THREE.Mesh(new THREE.BufferGeometry(), mat(0.5)); firstMesh.visible = false; firstMesh.renderOrder = 2;
        scene.add(faceMesh, firstMesh);
      }
      sync();
    }

    // the visible edges changed (something was hidden or shown): new snap points, keep the dims
    function setEdges(seg) {
      cancel(); tracked = [];
      segs = seg || new Float32Array(0); geo = null;
      refresh();
    }
    function getGeo() { if (!geo && model) geo = analyze(segs || new Float32Array(0), diag); return geo; }

    function setModel(m, seg, bb6) {
      cancel(); tracked = []; model = m; geo = null; segs = seg || null;
      if (!m) { sync(); return; }
      m.dims = m.dims || [];
      const bb = bb6 || m.bb; diag = Math.max(1e-9, Math.hypot(bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]));
      sync(); o.render();
    }

    function setActive(on) {
      if (!!on === active) return;
      active = !!on; cancel();
      if (o.onActive) o.onActive(active);
      if (!active) { mouse = null; cur = null; hoverFace = null; }
      sync(); refresh();
    }
    function cancel() { first = null; perpCache = null; if (firstMesh) firstMesh.visible = false; sync(); }
    function sync() {
      if (!ui.btn) return;
      ui.btn.classList.toggle('on', active);
      o.canvas.style.cursor = active ? 'crosshair' : '';
      if (ui.resSel.value !== res) ui.resSel.value = res;   // the other view may have changed it
      ui.clear.style.display = model && model.dims && model.dims.length ? '' : 'none';
      const F = planar ? 'line' : 'face';
      ui.prompt.textContent = !active ? '' : first ? `Click the second point or ${F} · Esc = cancel`
        : `Click a point or a ${planar ? 'line' : 'flat face'} · Shift = ${F} only · Esc = done`;
    }

    function key(e) {
      if (e.key === 'd' || e.key === 'D') { setActive(!active); return true; }
      if (e.key === 'Escape' && active) { if (first) cancel(); else setActive(false); refresh(); return true; }
      return false;
    }

    // ---- per mouse move: the snap, else the face under the cursor ----
    let V = null;
    function scr(p) {
      if (o.scr) return o.scr(p);
      V = V || new THREE.Vector3();
      V.set(p[0], p[1], p[2]).project(cam);
      return [(V.x + 1) / 2 * o.el.clientWidth, (1 - V.y) / 2 * o.el.clientHeight, V.z];
    }
    function cursorRay() {
      if (o.ray) return o.ray(mouse[0], mouse[1]);
      const w = o.el.clientWidth || 1, h = o.el.clientHeight || 1, rc = new THREE.Raycaster();
      rc.setFromCamera(new THREE.Vector2(mouse[0] / w * 2 - 1, -(mouse[1] / h) * 2 + 1), cam);
      return { o: rc.ray.origin.toArray(), d: rc.ray.direction.toArray() };
    }
    function findSnap() {
      const on = (k) => snapOn.has(k), [cx, cy] = mouse, ray = cursorRay(), cands = [], geo = getGeo();
      const put = (t, p, extra = {}) => {
        const s = scr(p); if (s[2] > 1 || s[2] < -1) return;
        const d = Math.hypot(s[0] - cx, s[1] - cy);
        if (d <= REACH) cands.push({ t, p, d, g: GROUP[extra.g || t], label: extra.label || LABEL[t], lines: extra.lines || [], free: !!extra.free });
      };
      for (const f of geo.fixed) if (on(f.t)) put(f.t, f.p);
      const from = first && first.kind === 'pt' ? first.p : null;
      if (from && (on('perp') || on('tan'))) {
        if (!perpCache) {
          perpCache = [];
          if (on('perp')) { for (const L of geo.lines) for (const p of perpendicular(from, L)) perpCache.push(['perp', p]); for (const A of geo.arcs) for (const p of perpendicular(from, null, A)) perpCache.push(['perp', p]); }
          if (on('tan')) for (const A of geo.arcs) for (const p of tangent(from, A)) perpCache.push(['tan', p]);
        }
        for (const [t, p] of perpCache) put(t, p);
      }
      if (on('cons') && tracked.length) {
        // tracking lines along X, Y and Z through the active points that pass within reach of the cursor
        const near = [];
        for (const a of tracked) for (const [name, e] of AX) {
          const p = raySeg(ray.o, ray.d, a, add(a, e), false), s = scr(p);
          if (s[2] <= 1 && s[2] >= -1 && Math.hypot(s[0] - cx, s[1] - cy) <= REACH) near.push({ src: a, e, axis: name, p });
        }
        for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) {
          if (near[i].src === near[j].src) continue;
          const c = lineLine(near[i].src, near[i].e, near[j].src, near[j].e);
          if (c && dist(c[0], c[1]) < diag * 1e-6) put('int', c[0], { g: 'consint', lines: [near[i], near[j]], free: true });
        }
        for (const l of near) put('cons', l.p, { g: 'align', label: 'along ' + l.axis, lines: [l], free: true });
      }
      if (on('on')) {
        const S = geo.seg;
        for (let i = 0; i < S.length; i += 6) {
          const a = [S[i], S[i + 1], S[i + 2]], b = [S[i + 3], S[i + 4], S[i + 5]];
          const sa = scr(a), sb = scr(b);
          // cheap screen-space reject before the exact ray / segment solve
          if (Math.min(sa[0], sb[0]) > cx + REACH || Math.max(sa[0], sb[0]) < cx - REACH ||
              Math.min(sa[1], sb[1]) > cy + REACH || Math.max(sa[1], sb[1]) < cy - REACH) continue;
          put('on', raySeg(ray.o, ray.d, a, b));
        }
      }
      if (!cands.length) return null;
      cands.sort((a, b) => a.g - b.g || a.d - b.d);
      // the nearest snap you can actually see (edges behind the part don't count)
      let tries = 0;
      for (const c of cands) {
        if (c.free || !o.visible || o.visible(c.p)) return c;
        if (++tries >= 6) break;
      }
      return null;
    }

    function refresh() {
      if (!active || !model || !mouse) {
        cur = null; hoverFace = null; if (faceMesh) faceMesh.visible = false; clearTimeout(dwell); o.render(); return;
      }
      if (cam) cam.updateMatrixWorld();        // an orbit only lands in the matrices on the next frame
      const next = shift ? null : findSnap();
      const same = next && cur && next.t === cur.t && dist(next.p, cur.p) < 1e-12;
      cur = next;
      if (!same) {
        clearTimeout(dwell);
        // a point snap held for a moment becomes an active point (MetaCAM's "four most recent")
        if (cur && !['on', 'cons'].includes(cur.t)) {
          const p = cur.p;
          dwell = setTimeout(() => {
            tracked = tracked.filter((a) => dist(a, p) > 1e-12).concat([p]).slice(-4);
          }, DWELL);
        }
      }
      hoverFace = null;
      if (!cur && planar) hoverFace = lineAt();
      else if (!cur) {
        const hit = o.raycast(mouse[0], mouse[1]);
        const R = faceOf(hit, diag);
        if (R) hoverFace = { R, p: hit.point.toArray() };
      }
      if (faceMesh) {
        if (hoverFace && (!first || first.R !== hoverFace.R)) { faceMesh.geometry = faceGeometry(hoverFace.R); faceMesh.visible = true; }
        else faceMesh.visible = false;
      }
      o.render();
    }

    function lineAt() {
      const [cx, cy] = mouse, ray = cursorRay(); let best = null;
      for (const L of getGeo().lines) {
        const a = scr(L.p), b = scr(L.q), dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, ((cx - a[0]) * dx + (cy - a[1]) * dy) / l2)) : 0;
        const d = Math.hypot(a[0] + dx * t - cx, a[1] + dy * t - cy);
        if (d <= REACH && (!best || d < best.d)) best = { d, L };
      }
      if (!best) return null;
      const L = best.L, u = norm(sub(L.q, L.p)); if (!u) return null;
      L.R = L.R || { n: [-u[1], u[0], 0], P: L.p, L };
      return { R: L.R, p: raySeg(ray.o, ray.d, L.p, L.q) };
    }

    // ---- clicks ----
    function target() {
      if (cur) return { kind: 'pt', p: cur.p };
      if (hoverFace) return { kind: 'face', R: hoverFace.R, p: hoverFace.p };
      return null;
    }
    // point-point: distance + its X / Y / Z legs.  point-face, parallel faces: the perpendicular distance.
    // faces that aren't parallel: the angle between them, drawn as an arc about the line where their planes meet.
    function measure(a, b) {
      if (a.kind === 'pt' && b.kind === 'pt') return { kind: 'pp', a: a.p, b: b.p };
      if (a.kind === 'face' && b.kind === 'face') {
        const c = Math.abs(dot(a.R.n, b.R.n));
        if (c > Math.cos(0.05 * Math.PI / 180)) {           // parallel: the gap, measured from the second pick
          const s = dot(sub(b.p, a.R.P), a.R.n);
          return { kind: 'ff', a: sub(b.p, scl(a.R.n, s)), b: b.p };
        }
        return angleDim(a, b);
      }
      const f = a.kind === 'face' ? a : b, p = a.kind === 'face' ? b.p : a.p;
      const foot = sub(p, scl(f.R.n, dot(sub(p, f.R.P), f.R.n)));
      return a.kind === 'face' ? { kind: 'pf', a: foot, b: p } : { kind: 'pf', a: p, b: foot };
    }
    function angleDim(A, B) {
      const n1 = A.R.n, n2 = B.R.n, c = cross(n1, n2), cc = dot(c, c), e = norm(c);
      const d1 = dot(n1, A.R.P), d2 = dot(n2, B.R.P);
      const O0 = scl(add(scl(cross(n2, c), d1), scl(cross(c, n1), d2)), 1 / cc);   // a point on both planes
      const mid = scl(add(A.p, B.p), 0.5), O = add(O0, scl(e, dot(sub(mid, O0), e)));
      // from the hinge line toward each pick, in its own face
      const away = (p, n) => {
        const u = sub(p, O), v = sub(u, scl(e, dot(u, e))), l = len(v);
        return l > diag * 1e-6 ? [scl(v, 1 / l), l] : [norm(cross(n, e)), 0];
      };
      const [u1, l1] = away(A.p, n1), [u2, l2] = away(B.p, n2);
      const ang = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2)))) * 180 / Math.PI;
      const r = Math.max(0.6 * Math.min(l1 || l2, l2 || l1), diag * 0.05);
      return { kind: 'fa', O, u1, u2, r, ang, a: A.p, b: B.p };
    }
    function pick() {
      const t = target(); if (!t) return;
      if (!first) {
        first = t; perpCache = null;
        if (t.kind === 'face' && firstMesh) { firstMesh.geometry = faceGeometry(t.R); firstMesh.visible = true; }
        sync(); refresh(); return;
      }
      if (t.kind === 'pt' && first.kind === 'pt' && dist(t.p, first.p) < 1e-12) return;   // same point twice
      if (t.kind === 'face' && first.kind === 'face' && t.R === first.R) return;          // same face twice (a double-click)
      model.dims.push(measure(first, t));
      cancel(); refresh();
    }

    // ---- drawing ----
    function fmtLen(v) {
      const inch = Math.abs(v) * model.toInch;
      if (o.unit() === 'mm') {
        const places = res.includes('/') ? 2 : Math.max(1, res.split('.')[1].length - 1);
        return (inch * 25.4).toFixed(places) + ' mm';
      }
      if (res.includes('/')) {
        const den = +res.split('/')[1], n = Math.round(inch * den);
        const w = Math.floor(n / den); let r = n % den, d = den;
        while (r && r % 2 === 0) { r /= 2; d /= 2; }
        return (r ? (w ? `${w} ${r}/${d}` : `${r}/${d}`) : `${w}`) + '"';
      }
      return inch.toFixed(res.split('.')[1].length) + '"';
    }
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

    function draw() {
      if (!ui.svg) return;
      const w = o.el.clientWidth, h = o.el.clientHeight, svg = [];
      ui.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      const S = (p) => scr(p), inView = (s) => s[2] <= 1 && s[2] >= -1;
      const line = (a, b, cls, extra = '') => { const A = S(a), B = S(b); if (inView(A) && inView(B)) svg.push(`<line class="${cls}" x1="${A[0]}" y1="${A[1]}" x2="${B[0]}" y2="${B[1]}" ${extra}/>`); };
      const arrows = (m) => `marker-start="url(#${uid}${m})" marker-end="url(#${uid}${m})"`;   // ids per tool: two tools share the page
      const items = [], tiny = diag * 1e-6;
      const dims = model ? model.dims.slice() : [];
      // live preview of the dimension being placed
      let preview = null;
      if (active && first) { const t = target(); if (t && !(t.kind === 'pt' && first.kind === 'pt' && dist(t.p, first.p) < 1e-12)) preview = measure(first, t); }
      const all = dims.map((d, i) => [d, i]).concat(preview ? [[preview, -1]] : []);
      for (const [d, i] of all) {
        const pv = i < 0 ? ' pv' : '';
        if (d.kind === 'fa') {
          // angle: an arc of radius r about the hinge line, from face 1's side to face 2's, with extension lines
          const th = d.ang * Math.PI / 180, wv = norm(sub(d.u2, scl(d.u1, dot(d.u1, d.u2)))) || d.u2;
          const at = (t, r) => add(d.O, scl(add(scl(d.u1, Math.cos(t)), scl(wv, Math.sin(t))), r));
          line(d.O, add(d.O, scl(d.u1, d.r * 1.15)), 'ext' + pv); line(d.O, add(d.O, scl(d.u2, d.r * 1.15)), 'ext' + pv);
          const n = Math.max(8, Math.ceil(d.ang / 4)), pts = [];
          for (let k = 0; k <= n; k++) { const s = S(at(th * k / n, d.r)); if (inView(s)) pts.push(s[0].toFixed(1) + ',' + s[1].toFixed(1)); }
          if (pts.length > 1) svg.push(`<polyline class="dl${pv}" fill="none" points="${pts.join(' ')}" ${arrows('m3a')}/>`);
          const m = S(at(th / 2, d.r)); if (inView(m)) items.push({ i, x: m[0], y: m[1], html: `<b>${d.ang.toFixed(2)}°</b>` });
          continue;
        }
        line(d.a, d.b, 'dl' + pv, arrows('m3a'));
        const D = sub(d.b, d.a), m = S(scl(add(d.a, d.b), 0.5));
        const legs = d.kind === 'pp' ? AXES.map((ax, k) => [ax, k]).filter(([, k]) => Math.abs(D[k]) > tiny) : [];
        // lined up with one axis: the distance is that axis' dimension; say which
        const tag = legs.length === 1 ? `<i style="color:${legs[0][0][2]}">${legs[0][0][0]}</i> ` : '';
        if (inView(m)) items.push({ i, x: m[0], y: m[1], html: `<b>${tag}${esc(fmtLen(len(D)))}</b>` });
        if (legs.length < 2) continue;
        // X, then Y, then Z from the first point to the second, each its own dimension in the axis colour,
        // its value off to the side on a leader (away from the middle of the staircase, so they don't pile up)
        const corners = [d.a]; let p = d.a;
        for (const [[, e], k] of legs) { p = add(p, scl(e, D[k])); corners.push(p); }
        const sc = corners.map(S); if (!sc.every(inView)) continue;
        const cx = sc.reduce((s, q) => s + q[0], 0) / sc.length, cy = sc.reduce((s, q) => s + q[1], 0) / sc.length;
        legs.forEach(([[name, , col], k], j) => {
          const A = sc[j], B = sc[j + 1];
          svg.push(`<line class="leg${pv}" stroke="${col}" x1="${A[0]}" y1="${A[1]}" x2="${B[0]}" y2="${B[1]}" ${arrows('m3' + name.toLowerCase())}/>`);
          const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2, L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
          let nx = -(B[1] - A[1]) / L, ny = (B[0] - A[0]) / L;
          if (nx * (mx - cx) + ny * (my - cy) < 0) { nx = -nx; ny = -ny; }
          if (Math.abs(mx - cx) + Math.abs(my - cy) < 1) { nx = 0; ny = -1; }
          const lx = mx + nx * 46, ly = my + ny * 34;
          svg.push(`<line class="ldr${pv}" stroke="${col}" x1="${mx}" y1="${my}" x2="${lx}" y2="${ly}"/><circle cx="${mx}" cy="${my}" r="2.5" fill="${col}"/>`);
          items.push({ i, x: lx, y: ly, cls: ' axis', col, html: `<b><i style="color:${col}">${name}</i> ${esc(fmtLen(D[k]))}</b>` });
        });
      }
      if (first && first.kind === 'pt') { const s = S(first.p); if (inView(s)) svg.push(`<circle class="dpt" cx="${s[0]}" cy="${s[1]}" r="4"/>`); }
      if (planar && active) {
        if (first && first.kind === 'face') line(first.R.L.p, first.R.L.q, 'fhl on');
        if (hoverFace && (!first || first.R !== hoverFace.R)) line(hoverFace.R.L.p, hoverFace.R.L.q, 'fhl');
      }
      // snap marker + label, and the construction lines it uses
      if (active && cur) {
        for (const l of cur.lines) {
          const big = diag * 3;
          line(sub(l.src, scl(l.e, big)), add(l.src, scl(l.e, big)), 'cons', `stroke="${AXES.find((a) => a[0] === l.axis)[2]}"`);
          const s = S(l.src); if (inView(s)) svg.push(`<rect class="snap" x="${s[0] - 3}" y="${s[1] - 3}" width="6" height="6"/>`);
        }
        const s = S(cur.p);
        if (inView(s)) {
          const [x, y] = s, r = 6, m = (d) => svg.push(`<path class="snap" d="${d}"/>`);
          if (cur.label === 'intersection') { svg.push(`<circle class="snap" cx="${x}" cy="${y}" r="${r * 0.7}"/>`); m(`M${x - r},${y - r}L${x + r},${y + r}M${x - r},${y + r}L${x + r},${y - r}`); }
          else if (cur.t === 'mid') m(`M${x - r},${y + r}L${x + r},${y + r}L${x},${y - r}Z`);
          else if (cur.t === 'center') { svg.push(`<circle class="snap" cx="${x}" cy="${y}" r="${r}"/>`); m(`M${x - r},${y}L${x + r},${y}M${x},${y - r}L${x},${y + r}`); }
          else if (cur.t === 'quad') m(`M${x - r},${y}L${x},${y - r}L${x + r},${y}L${x},${y + r}Z`);
          else if (cur.t === 'perp') m(`M${x - r},${y - r}L${x - r},${y + r}L${x + r},${y + r}M${x - r},${y}L${x},${y}L${x},${y + r}`);
          else if (cur.t === 'tan') { svg.push(`<circle class="snap" cx="${x}" cy="${y - r * 0.4}" r="${r * 0.6}"/>`); m(`M${x - r},${y + r * 0.2}L${x + r},${y + r * 0.2}`); }
          else if (cur.t === 'on') m(`M${x - r},${y + r}L${x + r},${y - r}`);
          else svg.push(`<rect class="snap" x="${x - r}" y="${y - r}" width="${2 * r}" height="${2 * r}"/>`);
          svg.push(`<text class="snapt" x="${x + 9}" y="${y - 9}">${esc(cur.label)}</text>`);
        }
      }
      // arrowheads: orange for the dimension itself, the axis colours for its X / Y / Z legs
      const mk = (id, fill) => `<marker id="${uid}${id}" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse">` +
        `<path d="M0,1L10,5L0,9Z" ${fill ? `fill="${fill}"` : 'class="arrow"'}/></marker>`;
      ui.svg.innerHTML = '<defs>' + mk('m3a') + AXES.map(([n, , c]) => mk('m3' + n.toLowerCase(), c)).join('') + '</defs>' + svg.join('');
      // labels: one reusable element each, so a click on one isn't lost to a redraw
      while (labels.length < items.length) { const d = document.createElement('div'); d.className = 'dlab'; ui.lab.appendChild(d); labels.push(d); }
      labels.forEach((d, k) => {
        const it = items[k];
        if (!it) { d.style.display = 'none'; return; }
        d.style.display = 'block';
        if (d._html !== it.html) { d.innerHTML = it.html; d._html = it.html; }
        d.className = 'dlab' + (it.cls || '') + (it.i < 0 ? ' pv' : ''); d.style.borderLeftColor = it.col || '';
        d.dataset.i = it.i;
        d.title = it.i < 0 ? '' : 'Click to remove this dimension';
        d.style.left = it.x + 'px'; d.style.top = it.y + 'px';
      });
      sync();
    }

    // ---- printing ----
    function printPrep() {
      const keep = { cur, first, hoverFace, fm: faceMesh && faceMesh.visible, fi: firstMesh && firstMesh.visible };
      cur = null; first = null; hoverFace = null;
      if (faceMesh) faceMesh.visible = false; if (firstMesh) firstMesh.visible = false;
      draw();
      return () => {
        ({ cur, first, hoverFace } = keep);
        if (faceMesh) faceMesh.visible = keep.fm; if (firstMesh) firstMesh.visible = keep.fi;
        draw();
      };
    }
    // the dims as they are on screen, scaled k times onto ctx2d (an SVG drawn as an image gets none of the page's CSS)
    async function snapshot(g, k) {
      if (!model || !model.dims.length) return;
      const w = o.el.clientWidth, h = o.el.clientHeight, svg = ui.svg.cloneNode(true);
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); svg.setAttribute('width', w * k); svg.setAttribute('height', h * k);
      const st = document.createElementNS('http://www.w3.org/2000/svg', 'style');
      st.textContent = '.dl{stroke:#c45200;stroke-width:2}.leg{stroke-width:1.5}.ldr{stroke-width:1}.ext{stroke:#c45200;stroke-width:1;stroke-dasharray:3 3}.arrow{fill:#c45200}.dpt{fill:#c45200}';
      svg.insertBefore(st, svg.firstChild);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg)); });
      g.drawImage(img, 0, 0, w * k, h * k);
      // labels: white boxes, black text, the axis letter in its colour
      const base = o.el.getBoundingClientRect();
      for (const d of labels) {
        if (d.style.display === 'none' || d.classList.contains('pv')) continue;
        const r = d.getBoundingClientRect(), x = (r.left - base.left) * k, y = (r.top - base.top) * k, bw = r.width * k, bh = r.height * k;
        g.fillStyle = '#fff'; g.fillRect(x, y, bw, bh);
        g.strokeStyle = '#333'; g.lineWidth = k * 0.75; g.strokeRect(x, y, bw, bh);
        g.fillStyle = d.style.borderLeftColor || '#c45200'; g.fillRect(x, y, 3 * k, bh);
        const b = d.querySelector('b'); if (!b) continue;
        g.font = `800 ${(d.classList.contains('axis') ? 15 : 18) * k * (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dimk')) || 1)}px "Roboto Condensed", sans-serif`; g.textBaseline = 'middle';
        const runs = [...b.childNodes].map((n) => [n.textContent, n.nodeType === 1 && n.style.color ? n.style.color : '#000']);
        let cx = x + bw / 2 - runs.reduce((s, [t]) => s + g.measureText(t).width, 0) / 2 + 1.5 * k;
        for (const [t, c] of runs) { g.fillStyle = c; g.fillText(t, cx, y + bh / 2 + k); cx += g.measureText(t).width; }
      }
    }

    init(opts);
    return { setModel, setEdges, setActive, draw, key, printPrep, snapshot, get active() { return active; },
      _dbg: () => ({ geo: getGeo(), scr, faceOf: (h) => faceOf(h, diag), raycast: o.raycast, visible: o.visible, model, cur, first }) }; // tests only
  }

  root.Measure = { create, analyze }; // analyze: tests only
})(window);
