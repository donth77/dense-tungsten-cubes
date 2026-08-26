/**
 * Offline Voronoi fracture of the crush targets (18 §6 C2, second cut).
 *
 * three-pinata (the library doc 03 named) fractures the REAL meshes into
 * irregular fragments: outer faces keep the source UVs/material, cut faces land
 * in a second slot. Fragments PARTITION the body — no bonus matter — and nothing
 * is a platonic solid (user review, 2026-08-25). Runs under vite-node because the
 * library ships extensionless ESM imports.
 *
 *   pnpm exec vite-node tools/fracture-targets.mjs
 *     ->  public/melon-frags.glb  (12 pieces of the watermelon)
 *     ->  public/glass-frags.glb  (10 pieces of the wine glass)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { fracture, FractureOptions } from 'three-pinata';

// ---------- read the source GLB ----------
function fractureGlb(srcPath, meshNameRe, fragmentCount, outPath) {
  const raw = readFileSync(srcPath);
  const jsonLen = raw.readUInt32LE(12);
  const gltf = JSON.parse(raw.subarray(20, 20 + jsonLen).toString());
  const bin = raw.subarray(20 + jsonLen + 8);

  function accessorArray(idx) {
    const acc = gltf.accessors[idx];
    const bv = gltf.bufferViews[acc.bufferView];
    const byteOffset = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const compCount = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type];
    const Ctor = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array }[
      acc.componentType
    ];
    return new Ctor(bin.buffer, bin.byteOffset + byteOffset, acc.count * compCount);
  }

  // ---------- find Watermelon_Full and compose its world matrix ----------
  const parent = {};
  gltf.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => (parent[c] = i)));
  const fullIdx = gltf.nodes.findIndex((n) => meshNameRe.test(n.name ?? '') && 'mesh' in n);
  if (fullIdx < 0) throw new Error(meshNameRe + ' mesh node not found in ' + srcPath);
  const chain = [fullIdx];
  while (chain[chain.length - 1] in parent) chain.push(parent[chain[chain.length - 1]]);
  chain.reverse();
  const world = new THREE.Matrix4();
  for (const i of chain) {
    const n = gltf.nodes[i];
    const m = new THREE.Matrix4();
    if (n.matrix) m.fromArray(n.matrix);
    else {
      const t = n.translation ?? [0, 0, 0];
      const r = n.rotation ?? [0, 0, 0, 1];
      const s = n.scale ?? [1, 1, 1];
      m.compose(new THREE.Vector3(...t), new THREE.Quaternion(...r), new THREE.Vector3(...s));
    }
    world.multiply(m);
  }

  const prim = gltf.meshes[gltf.nodes[fullIdx].mesh].primitives[0];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.BufferAttribute(accessorArray(prim.attributes.POSITION).slice(), 3),
  );
  geo.setAttribute(
    'normal',
    new THREE.BufferAttribute(accessorArray(prim.attributes.NORMAL).slice(), 3),
  );
  geo.setAttribute(
    'uv',
    new THREE.BufferAttribute(accessorArray(prim.attributes.TEXCOORD_0).slice(), 2),
  );
  geo.setIndex(new THREE.BufferAttribute(accessorArray(prim.indices).slice(), 1));
  geo.applyMatrix4(world); // bake real scale + grounding: fragments live in world space
  console.log('source mesh:', geo.attributes.position.count, 'verts,', geo.index.count / 3, 'tris');
  geo.computeBoundingBox();
  console.log(
    'world bbox:',
    geo.boundingBox.min.toArray().map((v) => +v.toFixed(3)),
    geo.boundingBox.max.toArray().map((v) => +v.toFixed(3)),
  );

  // ---------- fracture ----------
  const opts = new FractureOptions();
  opts.fragmentCount = fragmentCount;
  opts.fractureMode = 'Non-Convex';
  opts.textureScale = new THREE.Vector2(1, 1);
  const fragments = fracture(new THREE.Mesh(geo), opts);
  console.log('fragments:', fragments.length);

  // ---------- emit a compact GLB: one node per fragment, two primitives each ----------
  const buffers = [];
  let byteLength = 0;
  function pushBuffer(typed) {
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) {
      buffers.push(Buffer.alloc(pad));
      byteLength += pad;
    }
    const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const view = { buffer: 0, byteOffset: byteLength, byteLength: buf.byteLength };
    buffers.push(buf);
    byteLength += buf.byteLength;
    return view;
  }
  const out = {
    asset: { version: '2.0', generator: 'fracture-targets.mjs (three-pinata)' },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
    materials: [
      { name: 'melon_outer', pbrMetallicRoughness: { baseColorFactor: [0.35, 0.6, 0.3, 1] } },
      { name: 'melon_inner', pbrMetallicRoughness: { baseColorFactor: [0.78, 0.24, 0.2, 1] } },
    ],
    accessors: [],
    bufferViews: [],
    buffers: [],
  };
  function addAccessor(typed, type, componentType, extra = {}) {
    const view = pushBuffer(typed);
    out.bufferViews.push(view);
    const compCount = { SCALAR: 1, VEC2: 2, VEC3: 3 }[type];
    out.accessors.push({
      bufferView: out.bufferViews.length - 1,
      componentType,
      count: typed.length / compCount,
      type,
      ...extra,
    });
    return out.accessors.length - 1;
  }

  let kept = 0;
  for (const frag of fragments) {
    const g = frag.toGeometry();
    const pos = g.attributes.position.array;
    if (pos.length < 36) continue; // degenerate sliver
    // Re-origin at the centroid; the node translation carries the placement.
    let cx = 0,
      cy = 0,
      cz = 0;
    for (let i = 0; i < pos.length; i += 3) {
      cx += pos[i];
      cy += pos[i + 1];
      cz += pos[i + 2];
    }
    const n = pos.length / 3;
    cx /= n;
    cy /= n;
    cz /= n;
    const posC = new Float32Array(pos.length);
    let mn = [Infinity, Infinity, Infinity],
      mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) {
      posC[i] = pos[i] - cx;
      posC[i + 1] = pos[i + 1] - cy;
      posC[i + 2] = pos[i + 2] - cz;
      for (let k = 0; k < 3; k++) {
        mn[k] = Math.min(mn[k], posC[i + k]);
        mx[k] = Math.max(mx[k], posC[i + k]);
      }
    }
    const posIdx = addAccessor(posC, 'VEC3', 5126, { min: mn, max: mx });
    const nrmIdx = addAccessor(new Float32Array(g.attributes.normal.array), 'VEC3', 5126);
    const uvIdx = addAccessor(new Float32Array(g.attributes.uv.array), 'VEC2', 5126);
    const index =
      g.index.array instanceof Uint32Array ? g.index.array : Uint32Array.from(g.index.array);
    const prims = [];
    for (const grp of g.groups) {
      if (grp.count === 0) continue;
      const slice = index.slice(grp.start, grp.start + grp.count);
      const idxIdx = addAccessor(slice, 'SCALAR', 5125);
      prims.push({
        attributes: { POSITION: posIdx, NORMAL: nrmIdx, TEXCOORD_0: uvIdx },
        indices: idxIdx,
        material: grp.materialIndex === 0 ? 0 : 1,
      });
    }
    if (prims.length === 0) continue;
    out.meshes.push({ name: `frag_${kept}`, primitives: prims });
    out.nodes.push({
      name: `frag_${kept}`,
      mesh: out.meshes.length - 1,
      translation: [cx, cy, cz],
    });
    out.scenes[0].nodes.push(out.nodes.length - 1);
    kept += 1;
  }
  out.buffers.push({ byteLength });
  const binOut = Buffer.concat(buffers, byteLength);
  let jsonBuf = Buffer.from(JSON.stringify(out));
  if (jsonBuf.length % 4)
    jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(4 - (jsonBuf.length % 4), 0x20)]);
  const binPadded =
    binOut.length % 4 ? Buffer.concat([binOut, Buffer.alloc(4 - (binOut.length % 4))]) : binOut;
  const total = 12 + 8 + jsonBuf.length + 8 + binPadded.length;
  const header = Buffer.alloc(12 + 8);
  header.write('glTF', 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  header.writeUInt32LE(jsonBuf.length, 12);
  header.write('JSON', 16);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binPadded.length, 0);
  binHeader.write('BIN\0', 4);
  writeFileSync(outPath, Buffer.concat([header, jsonBuf, binHeader, binPadded]));
  console.log(`${outPath}: ${kept} fragments, ${(total / 1024).toFixed(0)} KB`);
}

fractureGlb('public/watermelon.glb', /Watermelon_Full/, 12, 'public/melon-frags.glb');
fractureGlb('public/wine-glass.glb', /Object_4|Object_0/, 10, 'public/glass-frags.glb');
/*
 * NOT the egg. Voronoi-fracturing an egg as a SOLID gives chunky wedges, and an egg
 * is a 0.35 mm brittle SHELL around a liquid — it caves in and its curved plates
 * stay put in the puddle (user review, 2026-08-25). The shell is authored as thin
 * curved caps in targets.ts instead.
 */
