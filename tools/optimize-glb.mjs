/**
 * Shrink the shipped GLBs without changing a single pixel or vertex.
 *
 * Every candidate encoding is PROVED lossless before it is accepted: the texture is
 * decoded back to raw RGBA and compared byte for byte against the original, and any
 * candidate that differs — or that comes out bigger — is discarded and the original
 * kept. Nothing here quantizes, resizes, or re-encodes a JPEG (re-encoding a lossy
 * codec cannot be lossless), so it is safe to re-run over already-optimised files.
 *
 *   node tools/optimize-glb.mjs           report only, writes nothing
 *   node tools/optimize-glb.mjs --write   rewrite public/*.glb in place
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions';
import { dedup, prune } from '@gltf-transform/functions';
import sharp from 'sharp';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const WRITE = process.argv.includes('--write');
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

/** Raw RGBA of a buffer, the only comparison that means "identical to the eye and the GPU". */
const raw = (buf) => sharp(buf).ensureAlpha().raw().toBuffer();

let totalBefore = 0;
let totalAfter = 0;

for (const file of fs
  .readdirSync('public')
  .filter((f) => f.endsWith('.glb'))
  .sort()) {
  const path = 'public/' + file;
  const before = fs.statSync(path).size;
  const doc = await io.read(path);
  const notes = [];

  // Structural only: merge identical accessors/meshes/textures, drop unreferenced nodes.
  await doc.transform(dedup(), prune());

  let usedWebP = false;
  for (const tex of doc.getRoot().listTextures()) {
    const src = Buffer.from(tex.getImage());
    if (tex.getMimeType() !== 'image/png') continue; // JPEG: any re-encode loses data
    const ref = await raw(src);

    const candidates = [];
    try {
      // oxipng rewrites the PNG datastream — filters and zlib only — and never decodes
      // to pixels, so it cannot shift a colour. No --strip: dropping an ICC profile
      // would change how the texture renders, which is exactly what we are avoiding.
      candidates.push([
        'image/png',
        execFileSync('oxipng', ['-o', 'max', '--quiet', '--stdout', '-'], {
          input: src,
          maxBuffer: 1 << 28,
        }),
      ]);
    } catch {
      /* oxipng absent or refused the file */
    }
    try {
      // sharp DOES decode to pixels, and colour-manages on the way through; kept only
      // because the verification below catches it when that changes anything.
      candidates.push([
        'image/png',
        await sharp(src).png({ compressionLevel: 9, effort: 10 }).toBuffer(),
      ]);
    } catch {
      /* leave it alone */
    }
    try {
      candidates.push([
        'image/webp',
        await sharp(src).webp({ lossless: true, effort: 6 }).toBuffer(),
      ]);
    } catch {
      /* leave it alone */
    }

    let best = null;
    for (const [mime, buf] of candidates) {
      if (buf.length >= src.length) continue;
      if (!(await raw(buf)).equals(ref)) continue; // not provably lossless — refuse it
      if (!best || buf.length < best[1].length) best = [mime, buf];
    }
    if (!best) continue;
    tex.setImage(best[1]).setMimeType(best[0]);
    if (best[0] === 'image/webp') usedWebP = true;
    notes.push(
      `${Math.round(src.length / 1024)}K->${Math.round(best[1].length / 1024)}K ${best[0].split('/')[1]}`,
    );
  }
  if (usedWebP) doc.createExtension(EXTTextureWebP).setRequired(true);

  const out = await io.writeBinary(doc);
  const after = out.byteLength;
  totalBefore += before;
  // Never let an "optimisation" grow a file.
  const keep = after < before;
  totalAfter += keep ? after : before;
  if (keep && WRITE) fs.writeFileSync(path, out);
  const pct = Math.round((1 - after / before) * 100);
  console.log(
    `${file.padEnd(20)} ${String(Math.round(before / 1024)).padStart(5)}K -> ${String(Math.round(after / 1024)).padStart(5)}K  ${keep ? String(pct).padStart(3) + '%' : ' -- '}  ${notes.join(', ')}`,
  );
}
console.log(
  `\ntotal ${Math.round(totalBefore / 1024)}K -> ${Math.round(totalAfter / 1024)}K  (${Math.round((1 - totalAfter / totalBefore) * 100)}% smaller)`,
);
console.log(WRITE ? 'written' : 'dry run — pass --write to apply');
