// 3D navigation, view cube and axis marker, ported from K-FACTOR (app/static/nav.js) to three.js r147 globals.
// Nav3D.Nav(camera, dom, hitDistance, onChange)   Nav3D.ViewCube(canvas, camera, onPick)   Nav3D.AxisTriad(canvas, camera)
//  - left-drag orbits freely (no stops, any direction) about the PART CENTRE
//  - right- or middle-drag pans; the wheel zooms toward whatever is under the cursor
//  - no inertia: the view stops the moment the mouse does
// OrbitControls can't do this -- it always looks at its target, so zoom-at-cursor drags the
// orbit centre off the part. Here the camera keeps its own orientation and the pivot is separate.
(function (root) {
  const THREE = root.THREE;
  const Z = new THREE.Vector3(0, 0, 1);
  const ISO = new THREE.Vector3(1, -1.4, 0.9).normalize();
  const DPR = () => Math.min(root.devicePixelRatio || 1, 1.5); // same cap as the main view (shop PC)

  // Camera orientation looking along -dir (dir points from the part toward the camera). Z stays
  // screen-up (looking straight down/up, +Y) unless an `up` is given.
  function lookQuat(dir, up = null) {
    const d = dir.clone().normalize();
    up = up ? up.clone().normalize() : Math.abs(d.z) > 0.9999 ? new THREE.Vector3(0, 1, 0) : Z;
    const m = new THREE.Matrix4().lookAt(d, new THREE.Vector3(), up);
    return new THREE.Quaternion().setFromRotationMatrix(m);
  }

  class Nav {
    // hitDistance(ndc, raycaster) -> distance along the ray to the model under the cursor, or null.
    // onChange() -> the view moved; redraw.
    constructor(camera, dom, hitDistance, onChange) {
      this.camera = camera; this.dom = dom; this.hitDistance = hitDistance; this.onChange = onChange || (() => {});
      this.pivot = new THREE.Vector3(); this.radius = 100;
      this.opts = { invert: false, step: 0.2 };
      this.drag = null; this.anim = null;
      this.ray = new THREE.Raycaster();
      dom.style.touchAction = 'none';
      dom.addEventListener('pointerdown', (ev) => this.down(ev));
      dom.addEventListener('pointermove', (ev) => this.move(ev));
      dom.addEventListener('pointerup', (ev) => this.up(ev));
      dom.addEventListener('pointercancel', (ev) => this.up(ev));
      dom.addEventListener('wheel', (ev) => this.wheel(ev), { passive: false });
      dom.addEventListener('contextmenu', (ev) => ev.preventDefault());
    }

    setPivot(sphere) { if (sphere) { this.pivot.copy(sphere.center); this.radius = sphere.radius || 100; } }

    forward() { return new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion); }
    aspect() { return (this.dom.clientWidth || 1) / (this.dom.clientHeight || 1); }
    // Half the view height in world units at `depth` in front of the camera.
    halfH(depth) { return depth * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2); }

    stopAnim() { const a = this.anim; this.anim = null; a?.done?.(); }
    get animating() { return !!this.anim; }

    // touch: one finger orbits, two pinch (dolly toward the point between them) and pan together
    down(ev) {
      if (ev.pointerType === 'touch') {
        this.touches = this.touches || new Map();
        if (this.touches.size >= 2) return;
        this.touches.set(ev.pointerId, [ev.clientX, ev.clientY]);
        this.dom.setPointerCapture(ev.pointerId);
        if (this.touches.size === 2) { this.stopAnim(); this.drag = null; this.pinch = this.twoTouch(); return; }
      }
      const mode = ev.button === 0 ? 'orbit' : ev.button === 1 || ev.button === 2 ? 'pan' : null;
      if (!mode) return;
      if (ev.button === 1) ev.preventDefault();       // no autoscroll on middle-drag
      this.stopAnim();
      this.drag = { mode, x: ev.clientX, y: ev.clientY, id: ev.pointerId };
      this.dom.setPointerCapture(ev.pointerId);
    }
    twoTouch() {
      const [a, b] = [...this.touches.values()];
      return { d: Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 };
    }
    up(ev) {
      if (this.touches && this.touches.delete(ev.pointerId)) {
        if (this.touches.size < 2) this.pinch = null;
        if (this.touches.size) { this.drag = null; return; }   // one finger left after a pinch: no orbit jump
      }
      if (this.drag && this.drag.id === ev.pointerId) { this.drag = null; this.dom.releasePointerCapture?.(ev.pointerId); }
    }
    move(ev) {
      if (this.pinch && this.touches.has(ev.pointerId)) {
        this.touches.set(ev.pointerId, [ev.clientX, ev.clientY]);
        const n = this.twoTouch(), p = this.pinch; this.pinch = n;
        this.pan(n.x - p.x, n.y - p.y);
        this.dollyAt(n.x, n.y, 1 - p.d / n.d);       // spread 2x = halfway in
        this.onChange();
        return;
      }
      const d = this.drag;
      if (!d || d.id !== ev.pointerId) return;
      const dx = ev.clientX - d.x, dy = ev.clientY - d.y;
      d.x = ev.clientX; d.y = ev.clientY;
      const h = this.dom.clientHeight || 1;
      if (d.mode === 'orbit') this.orbit(-2 * Math.PI * dx / h, -2 * Math.PI * dy / h);
      else this.pan(dx, dy);
      this.onChange();
    }

    // Rigidly rotate the camera about the pivot, about the SCREEN's own axes: left-right drags
    // turn about the view's up, up-down drags about its right. No stops in any direction --
    // you can roll the part right over the top.
    orbit(yaw, pitch) {
      const cam = this.camera;
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
      const q = new THREE.Quaternion().setFromAxisAngle(up, yaw)
        .multiply(new THREE.Quaternion().setFromAxisAngle(right, pitch));
      cam.position.sub(this.pivot).applyQuaternion(q).add(this.pivot);
      cam.quaternion.premultiply(q).normalize();
    }

    // The world point at the pivot's depth stays under the cursor.
    pan(dx, dy) {
      const cam = this.camera, h = this.dom.clientHeight || 1;
      const depth = Math.max(this.pivot.clone().sub(cam.position).dot(this.forward()), this.radius * 0.05);
      const wpp = 2 * this.halfH(depth) / h;
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
      cam.position.addScaledVector(right, -dx * wpp).addScaledVector(up, dy * wpp);
    }

    // Dolly along the ray through the cursor, by a fraction of the distance to what's under it --
    // fast when far away, fine up close, never through the surface.
    wheel(ev) {
      ev.preventDefault();
      if (!ev.deltaY) return;
      this.stopAnim();
      const lines = ev.deltaMode === 1 ? Math.abs(ev.deltaY) / 3 : ev.deltaMode === 2 ? 3 : Math.abs(ev.deltaY) / 100;
      const k = 1 - Math.pow(1 - this.opts.step, Math.min(lines, 5));
      const zoomIn = (ev.deltaY < 0) !== !!this.opts.invert;
      this.dollyAt(ev.clientX, ev.clientY, zoomIn ? k : -k / (1 - k));
      this.onChange();
    }
    // move the camera f of the way to what's under (clientX, clientY); f < 0 backs off
    dollyAt(x, y, f) {
      const cam = this.camera, r = this.dom.getBoundingClientRect();
      const ndc = new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
      this.ray.setFromCamera(ndc, cam);
      const dir = this.ray.ray.direction;
      let dist = this.hitDistance(ndc, this.ray);
      if (!(dist > 0)) {                                // nothing under the cursor: the pivot's depth
        const depth = this.pivot.clone().sub(cam.position).dot(this.forward());
        dist = Math.max(depth, this.radius * 0.05) / Math.max(dir.dot(this.forward()), 0.2);
      }
      cam.position.addScaledVector(dir, Math.max(-4, Math.min(0.9, f)) * dist);
    }

    // Frame the part looking along `dir` (default: the current direction). animate = ms.
    fit(sphere, dir = null, animate = 0, done = null) {
      if (!sphere) return;
      this.setPivot(sphere);
      const cam = this.camera, rad = THREE.MathUtils.degToRad;
      const q = dir ? lookQuat(dir) : cam.quaternion.clone();
      const a = this.aspect(), vh = rad(cam.fov) / 2, hh = Math.atan(Math.tan(vh) * a);
      const h = 1.15 * sphere.radius / Math.sin(Math.min(vh, hh)) * Math.tan(vh);   // framed half-height at the centre
      this.goTo({ q, c: sphere.center.clone(), h }, animate, done);
    }
    home(sphere, animate = 0) { this.fit(sphere, ISO, animate); }

    // Move to a view {q, c (look-at point), h (half-height there)}. Animated, it swings about a
    // look-at point moving from where we look now, with the framing blending along.
    goTo(v, animate = 0, done = null) {
      const cam = this.camera, f0 = this.forward();
      const d0 = Math.max(v.c.clone().sub(cam.position).dot(f0), this.radius * 0.05);
      this.anim = { t0: performance.now(), ms: Math.max(animate, 1), q0: cam.quaternion.clone(), q1: v.q,
                    c0: cam.position.clone().addScaledVector(f0, d0), c1: v.c, h0: this.halfH(d0), h1: v.h, done };
      if (!animate) { this.anim.t0 -= 1e6; this.update(); }
      this.onChange();
    }

    // Per frame: run a view animation, keep near/far hugging the part so close-ups don't clip.
    update() {
      const cam = this.camera, a = this.anim;
      if (a) {
        const t = Math.min(1, (performance.now() - a.t0) / a.ms), s = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;   // ease in-out (cubic)
        cam.quaternion.slerpQuaternions(a.q0, a.q1, s);
        const c = a.c0.clone().lerp(a.c1, s);
        const h = a.h0 * Math.pow(a.h1 / a.h0, s);              // framed size, geometric blend
        cam.position.copy(c).addScaledVector(this.forward(), -h / Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
        if (t >= 1) { this.anim = null; a.done?.(); }
      }
      const dist = cam.position.distanceTo(this.pivot), r = this.radius;
      const near = Math.max(r / 2000, (dist - r * 1.2) * 0.9);
      if (Math.abs(near - cam.near) > near * 0.01 || Math.abs(cam.far - (dist + r * 3)) > r) {
        cam.near = near; cam.far = dist + r * 3; cam.updateProjectionMatrix();
      }
    }
  }

  function overlayRenderer(canvas) {
    const R = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    R.setPixelRatio(DPR());
    return R;
  }
  // Point an overlay's camera the way the main camera looks, then draw.
  function renderOverlay(o) {
    const w = o.canvas.clientWidth, h = o.canvas.clientHeight;
    if (!w || !h) return;
    if (o.canvas.width !== Math.round(w * DPR())) o.renderer.setSize(w, h, false);
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(o.main.quaternion);
    o.camera.position.copy(f).multiplyScalar(-6);
    o.camera.quaternion.copy(o.main.quaternion);
    o.renderer.render(o.scene, o.camera);
  }

  // The view cube: a small labelled cube at the top right of the 3D view that turns with the
  // camera. Click a face, an edge or a corner for that view (26 directions).
  // [text, texture turn so it reads upright from outside with Z up]
  const LABELS = [['RIGHT', Math.PI / 2], ['LEFT', -Math.PI / 2], ['BACK', Math.PI], ['FRONT', 0], ['TOP', 0], ['BOTTOM', 0]];

  class ViewCube {
    constructor(canvas, mainCamera, onPick, onHover) {
      this.main = mainCamera; this.onPick = onPick; this.canvas = canvas; this.onHover = onHover || (() => {});
      this.renderer = overlayRenderer(canvas);
      this.scene = new THREE.Scene();
      this.camera = new THREE.OrthographicCamera(-1.75, 1.75, 1.75, -1.75, 0.1, 20);
      this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8278, 1.15));
      // BoxGeometry material order: +x, -x, +y, -y, +z, -z (= LABELS order)
      const mats = LABELS.map(([t, turn]) => new THREE.MeshLambertMaterial({ map: this.label(t, turn) }));
      this.cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mats);
      this.scene.add(this.cube);
      this.scene.add(new THREE.LineSegments(new THREE.EdgesGeometry(this.cube.geometry),
        new THREE.LineBasicMaterial({ color: 0x16100b })));
      this.hl = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial({ color: 0xd25800, transparent: true, opacity: 0.6, depthWrite: false }));
      this.hl.visible = false; this.scene.add(this.hl);
      this.ray = new THREE.Raycaster(); this.zone = null;
      canvas.addEventListener('pointermove', (ev) => this.hover(ev));
      canvas.addEventListener('pointerleave', () => { this.zone = null; this.hl.visible = false; canvas.style.cursor = ''; this.onHover(); });
      canvas.addEventListener('click', (ev) => { const z = this.zoneAt(ev); if (z) this.onPick(z); });
    }

    label(text, turn) {
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const g = c.getContext('2d');
      g.fillStyle = '#d9d6d1'; g.fillRect(0, 0, 128, 128);
      g.fillStyle = '#100900'; g.font = `bold ${text.length > 5 ? 22 : 26}px system-ui, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 64, 66);
      const t = new THREE.CanvasTexture(c);
      t.center.set(0.5, 0.5); t.rotation = turn;
      return t;
    }

    // Which of the 26 zones is under the pointer: each axis is -1/0/+1 by how near the hit is
    // to that face (the outer 30% of a face belongs to its edge or corner).
    zoneAt(ev) {
      const r = this.canvas.getBoundingClientRect();
      this.ray.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), this.camera);
      const hit = this.ray.intersectObject(this.cube, false)[0];
      if (!hit) return null;
      const v = hit.point.toArray().map((x) => (x > 0.6 ? 1 : x < -0.6 ? -1 : 0));
      return new THREE.Vector3(...v);
    }

    hover(ev) {
      const z = this.zoneAt(ev);
      const same = z && this.zone && z.equals(this.zone);
      this.zone = z; this.canvas.style.cursor = z ? 'pointer' : '';
      if (same) return;
      if (!z) { this.hl.visible = false; this.onHover(); return; }
      // a box over just that zone, a hair outside the cube so it shows on the surface
      const size = [z.x, z.y, z.z].map((c) => (c ? 0.42 : 1.22));
      const pos = [z.x, z.y, z.z].map((c) => c * 0.8);
      this.hl.scale.set(...size); this.hl.position.set(...pos); this.hl.visible = true;
      this.onHover();
    }

    render() { renderOverlay(this); }
  }

  // The axis marker: X/Y/Z arrows at the bottom left of the 3D view, turning with the camera.
  // Colours follow the CAD convention (X red, Y green, Z blue).
  const AXES = [['X', [1, 0, 0], '#e5484d'], ['Y', [0, 1, 0], '#3fb950'], ['Z', [0, 0, 1], '#4c8dff']];

  class AxisTriad {
    constructor(canvas, mainCamera) {
      this.main = mainCamera; this.canvas = canvas;
      this.renderer = overlayRenderer(canvas);
      this.scene = new THREE.Scene();
      this.camera = new THREE.OrthographicCamera(-1.55, 1.55, 1.55, -1.55, 0.1, 20);
      for (const [name, dir, color] of AXES) {
        const d = new THREE.Vector3(...dir);
        // solid shaft + cone (WebGL lines are always 1 px, too thin to read)
        const mat = new THREE.MeshBasicMaterial({ color });
        const up = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.78, 12), mat);
        shaft.quaternion.copy(up); shaft.position.copy(d).multiplyScalar(0.39);
        const head = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.28, 16), mat);
        head.quaternion.copy(up); head.position.copy(d).multiplyScalar(0.86);
        this.scene.add(shaft, head);
        const c = document.createElement('canvas'); c.width = c.height = 64;
        const g = c.getContext('2d');
        g.fillStyle = color; g.font = 'bold 44px system-ui, sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(name, 32, 34);
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
        s.scale.set(0.5, 0.5, 1); s.position.copy(d).multiplyScalar(1.25);
        this.scene.add(s);
      }
    }

    render() { renderOverlay(this); }
  }

  root.Nav3D = { Nav, ViewCube, AxisTriad, lookQuat, ISO };
})(window);
