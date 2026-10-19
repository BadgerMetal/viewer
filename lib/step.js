// STEP / IGES / BREP -> triangle meshes via OpenCascade (lib/occt.js, loaded first).
// STEP3D.read(arrayBuffer, fileName) -> Promise<model3d>
//   model3d = { meshes: [{ name, pos: Float32Array, nrm: Float32Array|null, idx: Uint32Array, bb: [x0,y0,z0,x1,y1,z1] }],
//               bb, units: 'in', toInch: 1 }
(function (root) {
  let occtP = null;
  function occt() {
    if (!occtP) {
      const b64 = root.OCCT_WASM_B64;
      if (!b64) throw new Error('lib/occt.js did not load');
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      occtP = root.occtimportjs({ wasmBinary: bin });
    }
    return occtP;
  }
  const bboxOf = (p, bb) => {
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
      if (p[i + k] < bb[k]) bb[k] = p[i + k]; if (p[i + k] > bb[k + 3]) bb[k + 3] = p[i + k];
    }
    return bb;
  };
  async function read(buf, name) {
    const o = await occt();
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1].toLowerCase();
    // coarse enough for a low-end PC, fine enough to look right; output converted to inches
    const params = { linearUnit: 'inch', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.002, angularDeflection: 0.5 };
    const data = new Uint8Array(buf);
    const r = ext === 'igs' || ext === 'iges' ? o.ReadIgesFile(data, params)
            : ext === 'brep' ? o.ReadBrepFile(data, params) : o.ReadStepFile(data, params);
    if (!r || !r.success) throw new Error('OpenCascade could not read this file');
    // name each mesh by its assembly path
    const names = [];
    (function walk(n, prefix) {
      const nm = n.name ? (prefix ? prefix + ' / ' : '') + n.name : prefix;
      for (const i of n.meshes || []) names[i] = nm;
      for (const c of n.children || []) walk(c, nm);
    })(r.root || {}, '');
    const meshes = [], bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    r.meshes.forEach((m, i) => {
      const pos = new Float32Array(m.attributes.position.array);
      if (!pos.length) return;
      const nrm = m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null;
      const idx = new Uint32Array(m.index.array);
      const mb = bboxOf(pos, [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
      for (let k = 0; k < 3; k++) { bb[k] = Math.min(bb[k], mb[k]); bb[k + 3] = Math.max(bb[k + 3], mb[k + 3]); }
      meshes.push({ name: m.name || names[i] || 'Body ' + (i + 1), pos, nrm, idx, bb: mb,
                    color: m.color ? m.color.slice(0, 3) : null });
    });
    if (!meshes.length) throw new Error('No solid geometry in this file');
    return { meshes, bb, units: 'in', toInch: 1 };
  }
  root.STEP3D = { read };
})(window);
