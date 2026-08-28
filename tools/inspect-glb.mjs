// Where the bytes actually are in each shipped GLB. Read-only.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import fs from 'node:fs';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
for (const f of fs.readdirSync('public').filter((f) => f.endsWith('.glb'))) {
  const doc = await io.read('public/' + f);
  const root = doc.getRoot();
  let tex = 0;
  const kinds = {};
  for (const t of root.listTextures()) {
    const n = t.getImage()?.byteLength ?? 0;
    tex += n;
    kinds[t.getMimeType()] = (kinds[t.getMimeType()] || 0) + n;
  }
  const total = fs.statSync('public/' + f).size;
  const prims = root.listMeshes().flatMap((m) => m.listPrimitives());
  const verts = prims.reduce((a, p) => a + (p.getAttribute('POSITION')?.getCount() || 0), 0);
  const morphs = prims.reduce((a, p) => a + p.listTargets().length, 0);
  const k = (n) => String(Math.round(n / 1024)).padStart(5);
  console.log(
    `${f.padEnd(20)} total ${k(total)}K  tex ${k(tex)}K (${
      Object.entries(kinds)
        .map(([m, v]) => m.split('/')[1] + ':' + Math.round(v / 1024) + 'K')
        .join(' ') || '-'
    })  verts ${String(verts).padStart(6)}  morphs ${morphs}`,
  );
}
