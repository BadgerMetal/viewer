// 3D view for STEP / IGES / MetaCAM .3d, on three.js r147 (lib/three.min.js + lib/nav3d.js + lib/measure3d.js loaded first).
// View3D.init(container, { onHover(info|null, x, y), unit() -> 'in'|'mm', onVisibility() })
// View3D.show(model3d)   model3d = { meshes: [{ name, pos, nrm, idx, bb }], bb, toInch }
// View3D.fit() (keeps the view direction)  View3D.home(ms) (iso)  View3D.resize()  View3D.clear()  View3D.key(ev)
// View3D.setHidden(meshInfos, hidden)  View3D.highlight(meshInfos|null)  View3D.showAll()
// await View3D.snapshot(k) -> canvas: the view k times over, white background, bodies in greys, dims on top (for printing)
// Navigation, the view cube, Home and the axis marker are K-FACTOR's (lib/nav3d.js); dimensions: a lib/measure3d.js tool.
// Hide tool (H): click a face to hide it - one sheet face (both surfaces and its edges) or one bend; on STEP & co. that's
// worked out by lib/sheet3d.js, and a body that isn't sheet metal hides one CAD face at a time. Ctrl+click = a whole body.
// What's hidden lives on the mesh infos (info.hidden, info.hiddenTris), so it stays with the file.
// View3D.fromFaces(faces, name, toInch, bends) -> model3d   (MetaCAM faces: polygon slabs of thickness t along `side`)
(function (root) {
  const T = () => root.THREE;
  let R, scene, cam, nav, cube, triad, group, opts, el, model = null, hovered = null, mats = null;
  let dim = null, hideMode = false, hideUI = null, hl = null, undo = [], listHot = new Set(), edgesOn = true;

  function init(container, o) {
    const THREE = T(); el = container; opts = o;
    R = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    R.setPixelRatio(Math.min(root.devicePixelRatio || 1, 1.5)); // keep fill-rate sane on the shop PC
    R.setClearColor(0x000000, 0);
    el.appendChild(R.domElement);
    R.domElement.style.display = 'block';
    scene = new THREE.Scene();
    cam = new THREE.PerspectiveCamera(30, 1, 0.01, 1e6);
    cam.up.set(0, 0, 1); // CAD convention: Z up
    scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3027, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 0.75);
    key.position.set(0.4, -0.6, 1);
    cam.add(key); scene.add(cam); // light follows the view so nothing goes black
    group = new THREE.Group(); scene.add(group);
    nav = new Nav3D.Nav(cam, R.domElement, hitDistance, render);
    // view cube + Home at the top right, axis marker at the bottom left
    const bar = document.createElement('div'); bar.className = 'nav3';
    const homeBtn = document.createElement('button'); homeBtn.className = 'home3'; homeBtn.innerHTML = '&#8962;';
    homeBtn.title = 'Home view (iso, fit the part)'; homeBtn.onclick = () => home(VIEW_MS);
    const cubeCv = document.createElement('canvas'); cubeCv.className = 'cube3'; cubeCv.title = 'Click a face, edge or corner for that view';
    bar.append(homeBtn, cubeCv); el.appendChild(bar);
    const axesCv = document.createElement('canvas'); axesCv.className = 'axes3'; el.appendChild(axesCv);
    cube = new Nav3D.ViewCube(cubeCv, cam, (dir) => { if (model) nav.fit(sphere(), dir, VIEW_MS); }, render);
    triad = new Nav3D.AxisTriad(axesCv, cam);
    // tools, top left: the dimension tool's buttons, then Hide / Show all
    const tools = document.createElement('div'); tools.className = 'meas3'; el.appendChild(tools);
    dim = Measure.create({ el, bar: tools, canvas: R.domElement, camera: cam, scene, render, unit: o.unit,
                     raycast: (x, y) => hitAt(x, y), visible, onActive: (on) => { if (on) setHideMode(false); } });
    tools.insertAdjacentHTML('beforeend',
      '<button data-a="hide" title="Hide tool (H): click a face to hide it, Ctrl+click to hide a whole body. Ctrl+Z = undo">Hide</button>' +
      '<button data-a="showall" title="Show everything that was hidden">Show all</button>');
    const prompt = document.createElement('div'); prompt.className = 'mprompt'; el.appendChild(prompt);
    hideUI = { btn: tools.querySelector('[data-a=hide]'), all: tools.querySelector('[data-a=showall]'), prompt };
    hideUI.btn.onclick = () => setHideMode(!hideMode);
    hideUI.all.onclick = showAll;
    // double-sided: MetaCAM faces don't wind consistently, and open STEP shells shouldn't show holes
    const solid = { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
    mats = {
      body: new THREE.MeshLambertMaterial(Object.assign({ color: 0xc6c3be }, solid)),
      hot: new THREE.MeshLambertMaterial(Object.assign({ color: 0xd25800, emissive: 0x3a1500 }, solid)),
      edge: new THREE.LineBasicMaterial({ color: 0x16100b }),
    };
    hl = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0xd25800, transparent: true, opacity: 0.55,
      side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    hl.visible = false; hl.renderOrder = 2; scene.add(hl);
    let pend = null, pendFn = null;
    const later = (fn) => { const first = !pendFn; pendFn = fn; if (first) requestAnimationFrame(() => { const f = pendFn; pendFn = null; f(); }); };
    R.domElement.addEventListener('pointermove', (e) => {
      if (e.buttons) { setHot(null); hlOff(); opts.onHover(null); return; }
      const r = R.domElement.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, ctrl = e.ctrlKey;
      if (hideMode) { opts.onHover(null); later(() => hideHover(x, y, ctrl)); return; }
      if (dim.active) { setHot(null); opts.onHover(null); return; }
      later(() => { if (!dim.active && !hideMode) pick(x, y); });
    });
    let down = null;
    // a tap with a finger (no hover): hide tool = hide what's under it, otherwise show it like a mouse hover would
    const touchTap = (e) => e.pointerType !== 'mouse' && !hideMode && !dim.active;
    R.domElement.addEventListener('pointerdown', (e) => { down = (hideMode || touchTap(e)) && e.button === 0 && e.isPrimary ? [e.clientX, e.clientY] : null; });
    R.domElement.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !down) return;
      const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]); down = null;
      if (moved > (e.pointerType === 'mouse' ? 4 : 10)) return;   // that was an orbit
      const r = R.domElement.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      if (hideMode) hideAt(x, y, e.ctrlKey);
      else if (touchTap(e)) pick(x, y);
    });
    // a finger "leaves" as it lifts: keep what the tap showed
    R.domElement.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { setHot(null); hlOff(); opts.onHover(null); } });
    R.domElement.addEventListener('dblclick', () => { if (!hideMode) fit(); });
    syncHide();
    resize();
  }

  function resize() {
    if (!R) return;
    const w = el.clientWidth || 1, h = el.clientHeight || 1;
    R.setSize(w, h, false); R.domElement.style.width = w + 'px'; R.domElement.style.height = h + 'px';
    cam.aspect = w / h; cam.updateProjectionMatrix(); render();
  }

  function clear() {
    for (const c of [...group.children]) {
      group.remove(c);
      if (c.geometry) c.geometry.dispose();
      if (c.userData.base && c.userData.base !== c.geometry) c.userData.base.dispose();
    }
    model = null; hovered = null; undo = []; listHot = new Set(); hlOff();
    dim.setModel(null);
    syncHide();
    render();
  }

  function show(m) {
    const THREE = T();
    clear(); model = m;
    let tris = 0; for (const mm of m.meshes) tris += mm.idx.length / 3;
    edgesOn = tris < 400000; // feature edges are the CAD look, but skip them on huge assemblies
    for (const mm of m.meshes) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(mm.pos, 3));
      g.setIndex(new THREE.BufferAttribute(mm.idx, 1));
      if (mm.nrm && mm.nrm.length === mm.pos.length) g.setAttribute('normal', new THREE.BufferAttribute(mm.nrm, 3));
      else g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, mats.body);
      mesh.userData.info = mm; mesh.userData.base = g;
      group.add(mesh);
      if (edgesOn) {
        const line = new THREE.LineSegments(new THREE.EdgesGeometry(g, 28), mats.edge);
        mesh.userData.edges = line; group.add(line);
      }
      if (mm.hidden || (mm.hiddenTris && mm.hiddenTris.size)) rebuild(mesh);
    }
    dim.setModel(m, edgeSegs());
    syncHide();
    home();
  }

  // what the dimension tool snaps to: the feature edges of whatever is showing
  function edgeSegs() {
    const segs = [];
    for (const o of meshes()) if (o.userData.edges) segs.push(o.userData.edges.geometry.attributes.position.array);
    const all = new Float32Array(segs.reduce((n, a) => n + a.length, 0));
    let k = 0; for (const a of segs) { all.set(a, k); k += a.length; }
    return all;
  }

  const VIEW_MS = 650; // cube / Home swing: slow enough to follow
  // the model's bounding sphere: the orbit centre and what Fit / Home frame
  function sphere() {
    const THREE = T(), bb = model.bb;
    const c = new THREE.Vector3((bb[0] + bb[3]) / 2, (bb[1] + bb[4]) / 2, (bb[2] + bb[5]) / 2);
    return new THREE.Sphere(c, Math.max(1e-6, 0.5 * Math.hypot(bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2])));
  }
  function fit() { if (model) nav.fit(sphere()); }           // keeps the view direction
  function home(ms = 0) { if (model) nav.home(sphere(), ms); } // iso view from front-right
  // the bodies you can see and click (the raycaster ignores .visible on its own)
  const meshes = () => group.children.filter((o) => o.isMesh && o.visible);
  // wheel zoom: how far along the ray the part is under the cursor
  function hitDistance(ndc, rc) {
    const hit = model && rc.intersectObjects(meshes(), false)[0];
    return hit ? hit.distance : null;
  }
  function hitAt(x, y) {
    if (!model) return null;
    const THREE = T(), rc = new THREE.Raycaster();
    cam.updateMatrixWorld(); // an orbit only reaches the matrices on the next frame
    rc.setFromCamera(new THREE.Vector2(x / el.clientWidth * 2 - 1, -(y / el.clientHeight) * 2 + 1), cam);
    return rc.intersectObjects(meshes(), false)[0] || null;
  }
  // can the camera see point p, or is part of the model in front of it?
  function visible(p) {
    const THREE = T(), P = new THREE.Vector3(p[0], p[1], p[2]), d = P.clone().sub(cam.position), L = d.length();
    const rc = new THREE.Raycaster(cam.position.clone(), d.normalize(), 0, L);
    const hit = rc.intersectObjects(meshes(), false)[0], bb = model.bb;
    const eps = 2e-4 * Math.hypot(bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]);
    return !hit || hit.distance > L - eps;
  }

  function pick(x, y) {
    if (!model) return;
    const hit = hitAt(x, y), info = hit ? hit.object.userData.info : null;
    setHot(hit ? hit.object : null);
    opts.onHover(info, x, y);
  }
  function setHot(obj) {
    if (hovered === obj) return;
    hovered = obj; paint(); render();
  }
  // hovered body, or the bodies of a hovered parts-list row, in orange
  function paint() {
    for (const o of group.children) if (o.isMesh) o.material = o === hovered || listHot.has(o.userData.info) ? mats.hot : mats.body;
  }
  function highlight(infos) { listHot = new Set(infos || []); paint(); render(); }

  // ---------- show / hide ----------
  // Faces, in the base (nothing hidden) triangle numbering. STEP: OpenCascade gives every CAD face its own vertices,
  // so a CAD face is a set of triangles joined by shared vertex indices; Sheet3D then joins those into sheet faces. .3d: fromFaces tags every triangle with its
  // MetaCAM face (the whole slab: inside, outside and edges) or its bend.
  function regions(mesh) {
    if (mesh.userData.regions) return mesh.userData.regions;
    const g = mesh.userData.base, info = mesh.userData.info, I = g.index.array, P = g.attributes.position.array, nT = I.length / 3;
    const par = new Int32Array(nT).map((_, i) => i);
    const find = (x) => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
    const join = (a, b) => { a = find(a); b = find(b); if (a !== b) par[b] = a; };
    if (info.groups) {                                   // .3d: one MetaCAM face slab or one bend
      const first = new Map();
      for (let t = 0; t < nT; t++) { const g = info.groups[t], f = first.get(g); if (f == null) first.set(g, t); else join(f, t); }
    } else {                                             // STEP: shared vertex indices
      const owner = new Int32Array(P.length / 3).fill(-1);
      for (let t = 0; t < nT; t++) for (let k = 0; k < 3; k++) { const v = I[t * 3 + k]; if (owner[v] < 0) owner[v] = t; else join(owner[v], t); }
    }
    const of = new Int32Array(nT), list = new Map();
    for (let t = 0; t < nT; t++) of[t] = find(t);
    // STEP & co.: CAD faces -> sheet faces (a surface, the one a thickness behind it, the edges between), like .3d
    if (!info.groups && root.Sheet3D) { const m = Sheet3D.merge(g, info.bb, of); if (m) of.set(m); }
    for (let t = 0; t < nT; t++) { const r = of[t]; let l = list.get(r); if (!l) list.set(r, l = []); l.push(t); }
    return (mesh.userData.regions = { of, list });
  }
  const baseTri = (hit) => (hit.object.userData.map ? hit.object.userData.map[hit.faceIndex] : hit.faceIndex);
  function regionGeo(mesh, tris) {
    const THREE = T(), g = mesh.userData.base, I = g.index.array, P = g.attributes.position.array, pos = new Float32Array(tris.length * 9);
    tris.forEach((t, i) => { for (let k = 0; k < 3; k++) { const v = I[t * 3 + k]; pos[i * 9 + k * 3] = P[v * 3]; pos[i * 9 + k * 3 + 1] = P[v * 3 + 1]; pos[i * 9 + k * 3 + 2] = P[v * 3 + 2]; } });
    const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return out;
  }
  function hlOff() { if (hl && hl.visible) { hl.visible = false; render(); } }
  let hlKey = null;
  function hideHover(x, y, ctrl) {
    if (!hideMode) return;
    const hit = hitAt(x, y);
    if (!hit) { setHot(null); hlOff(); hlKey = null; return; }
    if (ctrl) { hlOff(); hlKey = null; setHot(hit.object); return; }
    setHot(null);
    const R = regions(hit.object), r = R.of[baseTri(hit)];
    if (hlKey !== hit.object.id + ':' + r) {
      hlKey = hit.object.id + ':' + r;
      hl.geometry.dispose(); hl.geometry = regionGeo(hit.object, R.list.get(r));
    }
    hl.visible = true; render();
  }
  function hideAt(x, y, ctrl) {
    const hit = hitAt(x, y); if (!hit) return;
    const mesh = hit.object, info = mesh.userData.info;
    if (ctrl) { info.hidden = true; undo.push({ info }); }
    else {
      const R = regions(mesh), tris = R.list.get(R.of[baseTri(hit)]);
      info.hiddenTris = info.hiddenTris || new Set();
      for (const t of tris) info.hiddenTris.add(t);
      undo.push({ info, tris });
    }
    hlOff(); hlKey = null; setHot(null);
    rebuild(mesh); changed();
    hideHover(x, y, ctrl);
  }
  // swap the mesh's index for one without the hidden triangles (positions and normals are shared with the base)
  function rebuild(mesh) {
    const THREE = T(), info = mesh.userData.info, base = mesh.userData.base, H = info.hiddenTris;
    mesh.visible = !info.hidden;
    if (mesh.geometry !== base) mesh.geometry.dispose();
    if (!H || !H.size) { mesh.geometry = base; mesh.userData.map = null; }
    else {
      const I = base.index.array, nT = I.length / 3, keep = [];
      for (let t = 0; t < nT; t++) if (!H.has(t)) keep.push(t);
      const idx = new Uint32Array(keep.length * 3);
      keep.forEach((t, i) => { idx[i * 3] = I[t * 3]; idx[i * 3 + 1] = I[t * 3 + 1]; idx[i * 3 + 2] = I[t * 3 + 2]; });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', base.attributes.position);
      if (base.attributes.normal) g.setAttribute('normal', base.attributes.normal);
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      mesh.geometry = g; mesh.userData.map = Uint32Array.from(keep);
    }
    const line = mesh.userData.edges;
    if (line) {
      line.visible = mesh.visible;
      line.geometry.dispose(); line.geometry = new THREE.EdgesGeometry(mesh.geometry, 28);
    }
  }
  function changed() {
    dim.setEdges(edgeSegs());
    syncHide(); render();
    if (opts.onVisibility) opts.onVisibility();
  }
  function setHidden(infos, hidden) {
    for (const o of group.children) if (o.isMesh && infos.includes(o.userData.info)) {
      o.userData.info.hidden = !!hidden; rebuild(o);
      if (hidden) undo.push({ info: o.userData.info });
    }
    changed();
  }
  function showAll() {
    for (const o of group.children) if (o.isMesh) {
      const info = o.userData.info;
      if (info.hidden || (info.hiddenTris && info.hiddenTris.size)) { info.hidden = false; info.hiddenTris = null; rebuild(o); }
    }
    undo = []; changed();
  }
  function undoHide() {
    const u = undo.pop(); if (!u) return false;
    if (u.tris) for (const t of u.tris) u.info.hiddenTris.delete(t); else u.info.hidden = false;
    for (const o of group.children) if (o.isMesh && o.userData.info === u.info) rebuild(o);
    changed(); return true;
  }
  const anyHidden = () => !!model && model.meshes.some((m) => m.hidden || (m.hiddenTris && m.hiddenTris.size));
  function setHideMode(on) {
    hideMode = !!on;
    if (hideMode) dim.setActive(false);
    if (!hideMode) { hlOff(); hlKey = null; setHot(null); }
    syncHide();
  }
  function syncHide() {
    if (!hideUI) return;
    hideUI.btn.classList.toggle('on', hideMode);
    hideUI.all.style.display = anyHidden() ? '' : 'none';
    hideUI.prompt.textContent = hideMode ? 'Click a face to hide it · Ctrl+click = whole body · Ctrl+Z = undo · Esc = done' : '';
    if (hideMode) R.domElement.style.cursor = 'pointer';
    else if (!dim.active) R.domElement.style.cursor = '';
  }
  function key(e) {
    if (dim.key(e)) return true;
    if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.metaKey && !e.altKey) { setHideMode(!hideMode); return true; }
    if (e.key === 'Escape' && hideMode) { setHideMode(false); return true; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) return undoHide();
    return false;
  }

  // printing: render once on white with grey bodies and no highlights, flatten to greys, put the dims on top
  async function snapshot(k) {
    const THREE = T(), w = el.clientWidth, h = el.clientHeight;
    const keep = { pr: R.getPixelRatio(), hot: hovered, list: listHot, hl: hl.visible, body: mats.body.color.getHex() };
    const restoreDims = dim.printPrep();
    hovered = null; listHot = new Set(); paint(); hl.visible = false;
    R.setClearColor(0xffffff, 1); mats.body.color.setHex(0xc4c4c4);
    R.setPixelRatio(k); R.setSize(w, h, false);
    nav.update(); R.render(scene, cam);
    const out = document.createElement('canvas'); out.width = Math.round(w * k); out.height = Math.round(h * k);
    const g = out.getContext('2d'); g.drawImage(R.domElement, 0, 0, out.width, out.height);
    const px = g.getImageData(0, 0, out.width, out.height), d = px.data;
    for (let i = 0; i < d.length; i += 4) { const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; d[i] = d[i + 1] = d[i + 2] = l; }
    g.putImageData(px, 0, 0);
    R.setClearColor(0x000000, 0); mats.body.color.setHex(keep.body);
    R.setPixelRatio(keep.pr); R.setSize(w, h, false);
    hovered = keep.hot; listHot = keep.list; hl.visible = keep.hl; paint();
    try { await dim.snapshot(g, k); } finally { restoreDims(); render(); }
    return out;
  }

  let raf = 0;
  function render() {
    if (raf || !R) return;
    raf = requestAnimationFrame(() => {
      raf = 0; nav.update();
      R.render(scene, cam); cube.render(); triad.render(); dim.draw();
      if (nav.animating) render();
    });
  }

  // ---- rounded bends ----
  // MetaCAM stores a bend as two flat faces that run to a shared line (a virtual sharp) plus the inside
  // radius r. Across the bend line: find the circle of radius r tangent to both flanges' inside surfaces,
  // trim each flange back to its tangent point, and sweep the inside (r) and outside (r + t) arcs between.
  const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const vscl = (a, k) => [a[0] * k, a[1] * k, a[2] * k], vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const vnorm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-12 ? vscl(a, 1 / l) : null; };
  const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  // unit normal of a planar loop, oriented by its winding (counter-clockwise seen from the tip)
  const newell = (o) => {
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < o.length; i++) {
      const a = o[i], b = o[(i + 1) % o.length];
      x += (a[1] - b[1]) * (a[2] + b[2]); y += (a[2] - b[2]) * (a[0] + b[0]); z += (a[0] - b[0]) * (a[1] + b[1]);
    }
    return vnorm([x, y, z]);
  };
  function roundBend(bd, fa, fb) {
    const r = bd.r, t = fa.t || fb.t;
    if (!(r > 0) || bd.joint || !(bd.angle > 0.5 && bd.angle < 179.5) || !t || !bd.line) return null;
    const [L0, L1] = bd.line, e = vnorm(vsub(L1, L0)); if (!e) return null;
    const perp = (v) => vsub(v, vscl(e, vdot(v, e)));
    // direction from the bend line into each flange: the flange is on the inside (left) of its outer loop's
    // edge along the bend line. Exact even for non-convex flanges; falls back to the vertex average.
    const inward = (f) => {
      const o = f.outer, nrm = newell(o), tol = 0.01 + t * 1e-3, on = (p) => Math.hypot(...perp(vsub(p, L0))) < tol;
      if (nrm) for (let i = 0; i < o.length; i++) {
        const a = o[i], b = o[(i + 1) % o.length];
        if (on(a) && on(b)) { const d = vnorm(vsub(b, a)); if (d) { const left = vnorm(perp(vcross(nrm, d))); if (left) return left; } }
      }
      let c = [0, 0, 0]; for (const p of o) c = vadd(c, perp(vsub(p, L0))); return vnorm(c);
    };
    const dA = inward(fa), dB = inward(fb); if (!dA || !dB) return null;
    const pA = vnorm(vsub(dB, vscl(dA, vdot(dB, dA)))), pB = vnorm(vsub(dA, vscl(dB, vdot(dA, dB))));
    if (!pA || !pB) return null;
    // p* points into the bend; a flange's inside surface is whichever of its two surfaces lies further that way
    const hA = Math.max(0, t * Math.sign(vdot(fa.side, pA))), hB = Math.max(0, t * Math.sign(vdot(fb.side, pB)));
    const y = hA + r, k = vdot(dA, pB); if (Math.abs(k) < 1e-9) return null;
    const x = (hB + r - y * vdot(pA, pB)) / k;           // circle centre, in (dA, pA) coordinates from the line
    const uA = x, uB = x * vdot(dA, dB) + y * vdot(pA, dB); // tangent points, measured along each flange
    if (uA < -1e-6 || uB < -1e-6) return null;              // not a geometry we understand: keep the sharp fill
    const f0 = -Math.PI / 2;                                // centre -> A's tangent point is -pA
    let sw = Math.atan2(-vdot(pB, pA), -vdot(pB, dA)) - f0;
    while (sw > Math.PI) sw -= 2 * Math.PI; while (sw < -Math.PI) sw += 2 * Math.PI;
    const n = Math.max(3, Math.ceil(Math.abs(sw) / (Math.PI / 36))); // 5° steps
    const ring = (o, R) => { const out = []; for (let i = 0; i <= n; i++) { const a = f0 + sw * i / n; out.push(vadd(o, vadd(vscl(dA, x + R * Math.cos(a)), vscl(pA, y + R * Math.sin(a))))); } return out; };
    // the bend only exists where BOTH flanges reach the bend line (relief notches cut through it)
    const spans = (f) => {
      const out = [], tol = 0.01 + t * 1e-3, onLine = (p) => Math.hypot(...perp(vsub(p, L0))) < tol;
      const o = f.outer;
      for (let i = 0; i < o.length; i++) {
        const a = o[i], b = o[(i + 1) % o.length];
        if (onLine(a) && onLine(b)) { const sa = vdot(vsub(a, L0), e), sb = vdot(vsub(b, L0), e); out.push([Math.min(sa, sb), Math.max(sa, sb)]); }
      }
      return out;
    };
    const meet = (P, Q) => { const out = []; for (const [a0, a1] of P) for (const [b0, b1] of Q) { const s0 = Math.max(a0, b0), s1 = Math.min(a1, b1); if (s1 - s0 > 1e-6) out.push([s0, s1]); } return out; };
    let runs = meet(spans(fa), spans(fb));
    if (!runs.length) runs = [[0, vdot(vsub(L1, L0), e)]]; // no shared edge found: fall back to the stored line
    // build once the flanges are trimmed: trimA/trimB = where each trimmed flange's cut edge lies along the
    // bend, so a mitred / angled flange end ends its bend there instead of poking out past the miter
    const build = (trimA, trimB) => {
      let use = runs;
      if (trimA.length) use = meet(use, trimA);
      if (trimB.length) use = meet(use, trimB);
      const tris = [], quad = (a, b, c, d) => tris.push(a, b, c, a, c, d);
      for (const [s0, s1] of use) {
        const P0 = vadd(L0, vscl(e, s0)), P1 = vadd(L0, vscl(e, s1));
        const i0 = ring(P0, r), o0 = ring(P0, r + t), i1 = ring(P1, r), o1 = ring(P1, r + t);
        for (let i = 0; i < n; i++) {
          quad(i0[i], i0[i + 1], i1[i + 1], i1[i]); quad(o0[i], o1[i], o1[i + 1], o0[i + 1]);
          quad(i0[i], o0[i], o0[i + 1], i0[i + 1]); quad(i1[i], i1[i + 1], o1[i + 1], o1[i]);
        }
      }
      return tris;
    };
    return { build, e, L0, clips: [[bd.a, L0, dA, uA], [bd.b, L0, dB, uB]] };
  }
  // where a trimmed loop's edges lie on the trim plane, as [s0, s1] intervals along the bend direction e
  function cutSpans(L, o, d, u, e) {
    const out = [], on = (p) => Math.abs(vdot(vsub(p, o), d) - u) < 1e-6;
    for (let i = 0; i < L.length; i++) {
      const a = L[i], b = L[(i + 1) % L.length];
      if (on(a) && on(b)) { const sa = vdot(vsub(a, o), e), sb = vdot(vsub(b, o), e); if (Math.abs(sb - sa) > 1e-9) out.push([Math.min(sa, sb), Math.max(sa, sb)]); }
    }
    return out;
  }
  // keep the part of a loop where (p - o)·d >= u  (Sutherland-Hodgman against one plane)
  function clipLoop(L, o, d, u) {
    const g = (p) => vdot(vsub(p, o), d) - u, out = [];
    for (let i = 0; i < L.length; i++) {
      const a = L[i], b = L[(i + 1) % L.length], ga = g(a), gb = g(b);
      if (ga >= 0) out.push(a);
      if ((ga >= 0) !== (gb >= 0)) out.push(vadd(a, vscl(vsub(b, a), ga / (ga - gb))));
    }
    return out;
  }

  // ---- MetaCAM faces -> one solid-looking mesh ----
  function fromFaces(faces, name, toInch, bends) {
    const THREE = T(), pos = [], grp = [];
    // grp: which MetaCAM face (a whole slab: both surfaces and its edges) or bend each triangle belongs to (show / hide)
    let gid = -1;
    const tri = (a, b, c) => { pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); grp.push(gid); };
    // round the bends first, then cut each flange back to where its bend starts
    const rounded = [], roundedSet = new Set();
    faces = faces.map((f) => Object.assign({}, f));
    for (const b of bends || []) {
      const fa = faces[b.a], fb = faces[b.b]; if (!fa || !fb || !fa.outer || !fb.outer) continue;
      const g = roundBend(b, fa, fb); if (!g) continue;
      rounded.push(g); roundedSet.add(b);
    }
    for (const g of rounded) for (const [fi, o, d, u] of g.clips) {
      const f = faces[fi];
      f.outer = clipLoop(f.outer, o, d, u);
      f.holes = (f.holes || []).map((h) => clipLoop(h, o, d, u)).filter((h) => h.length >= 3);
      (f.cuts = f.cuts || []).push([o, d, u]);
    }
    for (const g of rounded) {
      const [[ia, oa, da, ua], [ib, ob, db, ub]] = g.clips;
      g.tris = g.build(cutSpans(faces[ia].outer, oa, da, ua, g.e), cutSpans(faces[ib].outer, ob, db, ub, g.e));
    }
    // an edge lying on a trim plane joins the bend: it's inside the solid, so it gets no side wall
    const onCut = (f, a, b) => (f.cuts || []).some(([o, d, u]) => Math.abs(vdot(vsub(a, o), d) - u) < 1e-6 && Math.abs(vdot(vsub(b, o), d) - u) < 1e-6);
    for (const f of faces) {
      if (!f.outer || f.outer.length < 3) continue;
      gid++;
      const loops = [f.outer, ...(f.holes || [])];
      // plane basis from the outer loop's Newell normal
      let nx = 0, ny = 0, nz = 0; const o = f.outer;
      for (let i = 0; i < o.length; i++) {
        const a = o[i], b = o[(i + 1) % o.length];
        nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
      }
      const n = new THREE.Vector3(nx, ny, nz); if (n.lengthSq() < 1e-30) continue; n.normalize();
      const u = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      u.sub(n.clone().multiplyScalar(u.dot(n))).normalize();
      const v = new THREE.Vector3().crossVectors(n, u);
      const to2 = (p) => new THREE.Vector2(p[0] * u.x + p[1] * u.y + p[2] * u.z, p[0] * v.x + p[1] * v.y + p[2] * v.z);
      const t = f.t || 0, s = f.side || [n.x, n.y, n.z];
      const off = (p) => [p[0] + s[0] * t, p[1] + s[1] * t, p[2] + s[2] * t];
      const all = loops.flat();
      let ix;
      try { ix = THREE.ShapeUtils.triangulateShape(o.map(to2), (f.holes || []).map((h) => h.map(to2))); } catch (e) { continue; }
      for (const [a, b, c] of ix) { tri(all[a], all[b], all[c]); if (t) tri(off(all[a]), off(all[c]), off(all[b])); }
      if (t) for (const L of loops) for (let i = 0; i < L.length; i++) {
        const a = L[i], b = L[(i + 1) % L.length];
        if (onCut(f, a, b)) continue;
        const a2 = off(a), b2 = off(b);
        tri(a, b, b2); tri(a, b2, a2);
      }
    }
    const flatTris = pos.length / 9; // everything before here is a flat face (the dimension tool's face picks)
    for (const g of rounded) { gid++; for (let i = 0; i < g.tris.length; i += 3) tri(g.tris[i], g.tris[i + 1], g.tris[i + 2]); }
    // bends we couldn't round (r = 0, odd geometry): close the outside corner with the reader's prism
    // (fill = [p0, p0+t·sideA, p0+t·sideB, p1, p1+t·sideA, p1+t·sideB])
    for (const b of bends || []) {
      const q = b.fill; if (!q || q.length !== 6 || b.joint || roundedSet.has(b)) continue;
      gid++;
      tri(q[0], q[1], q[2]); tri(q[3], q[5], q[4]);
      for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) { tri(q[i], q[j], q[j + 3]); tri(q[i], q[j + 3], q[i + 3]); }
    }
    const P = new Float32Array(pos);
    const idx = new Uint32Array(P.length / 3); for (let i = 0; i < idx.length; i++) idx[i] = i;
    // flat normals per triangle; faces may wind either way, so light both sides
    const nrm = new Float32Array(P.length);
    for (let i = 0; i < P.length; i += 9) {
      const ax = P[i + 3] - P[i], ay = P[i + 4] - P[i + 1], az = P[i + 5] - P[i + 2];
      const bx = P[i + 6] - P[i], by = P[i + 7] - P[i + 1], bz = P[i + 8] - P[i + 2];
      let cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx; const l = Math.hypot(cx, cy, cz) || 1;
      cx /= l; cy /= l; cz /= l;
      for (let k = 0; k < 3; k++) { nrm[i + k * 3] = cx; nrm[i + k * 3 + 1] = cy; nrm[i + k * 3 + 2] = cz; }
    }
    const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { bb[k] = Math.min(bb[k], P[i + k]); bb[k + 3] = Math.max(bb[k + 3], P[i + k]); }
    if (!P.length) throw new Error('No faces could be drawn');
    return { meshes: [{ name, pos: P, nrm, idx, bb, doubleSided: true, flatTris, groups: Int32Array.from(grp) }], bb, toInch: toInch || 1 };
  }

  // A few MetaCAM faces store a bad offset polygon ("offset by 3048, its layer says 1.2192"), which would draw
  // a slab 120" thick. The layer's thickness is the real sheet; trust it whenever the two disagree.
  function fixThickness(faces, layers) {
    for (const f of faces) {
      const L = layers && layers[f.layer], lt = L && L.thickness;
      if (lt > 0 && f.t > 0 && Math.abs(f.t - lt) > 0.02 * lt) {
        f.t = lt;
        // the side came from the same bad offset; snap it onto the face normal (keeping its sign if it has one)
        const n = newell(f.outer);
        if (n) { const s = f.side ? vdot(f.side, n) : 1; f.side = s < 0 ? vscl(n, -1) : n; }
      }
    }
    return faces;
  }

  root.View3D = { init, show, fit, home, resize, key, setHidden, highlight, showAll, snapshot, clear, _dim: () => dim, fromFaces, fixThickness, render, _roundBend: roundBend }; // _roundBend: tests only
})(window);
