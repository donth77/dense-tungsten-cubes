"""
Prepares assets-lib/balance-scale/weighing_scale.glb for runtime (15 §11.2).

The source is a Sketchfab scan-style export: 436 nodes, every one named `g` or
`defaultMaterial`, 46,584 triangles and 8.2 MB of 2048-square textures. It cannot be used
as-is for three reasons, and this script fixes all three.

1. IT IS ONE RIGID OBJECT. The Weigh Station simulates the beam and both pans as separate
   dynamic bodies, so the mesh has to be split into stand / beam / left pan / right pan.
   The node names carry nothing, so the split is SPATIAL — which works because a balance
   has unmistakable spatial structure: the X histogram of node centres is cleanly bimodal
   (107 nodes left, 107 right, 3 in the middle).

2. THE CHAINS ARE 94 % OF THE GEOMETRY. 212 individual link meshes, 44,340 of the 46,584
   triangles. They are also unusable: static link meshes cannot deform with simulated
   pans (15 §6.1), and the lab draws six live rope runs instead. Dropping them is both the
   correctness fix and the entire size problem.

3. EVERY PART IS POSED BY ITS OWN NODE CHAIN. Each kept mesh gets its world transform
   baked in, then re-origined onto the physics body it will be bound to — the stand and
   beam onto the pivot, each pan onto its own centre — so the lab can attach a mesh to a
   body without a correction transform anywhere.

Run: python3 tools/prepare-balance.py
"""
import json, struct, io, math, os
from PIL import Image

SRC = 'assets-lib/balance-scale/weighing_scale.glb'
DST = 'public/balance.glb'
TEXTURE_PX = 512
JPEG_QUALITY = 88

# --- read ------------------------------------------------------------------------
raw = open(SRC, 'rb').read()
off, js, binoff, binlen = 12, None, 0, 0
while off < len(raw):
    clen, ctype = struct.unpack_from('<II', raw, off); off += 8
    if ctype == 0x4E4F534A: js = json.loads(raw[off:off + clen])
    elif ctype == 0x004E4942: binoff, binlen = off, clen
    off += clen
BIN = raw[binoff:binoff + binlen]

def view(i):
    bv = js['bufferViews'][i]
    o = bv.get('byteOffset', 0)
    return BIN[o:o + bv['byteLength']], bv.get('byteStride')

COMP = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}
NUM = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}

def read_accessor(i):
    a = js['accessors'][i]
    fmt, size = COMP[a['componentType']]
    n = NUM[a['type']]
    data, stride = view(a['bufferView'])
    base = a.get('byteOffset', 0)
    step = stride or size * n
    out = []
    for k in range(a['count']):
        o = base + k * step
        out.append(struct.unpack_from('<' + fmt * n, data, o))
    return out

# --- transforms ------------------------------------------------------------------
def mat_of(n):
    if 'matrix' in n:
        m = n['matrix']; return [m[0:4], m[4:8], m[8:12], m[12:16]]
    t = n.get('translation', [0, 0, 0]); r = n.get('rotation', [0, 0, 0, 1]); s = n.get('scale', [1, 1, 1])
    x, y, z, w = r
    xx, yy, zz = x*x, y*y, z*z; xy, xz, yz = x*y, x*z, y*z; wx, wy, wz = w*x, w*y, w*z
    R = [[1-2*(yy+zz), 2*(xy+wz), 2*(xz-wy)], [2*(xy-wz), 1-2*(xx+zz), 2*(yz+wx)], [2*(xz+wy), 2*(yz-wx), 1-2*(xx+yy)]]
    return [[R[i][j]*s[i] for j in range(3)] + [0] for i in range(3)] + [[t[0], t[1], t[2], 1]]

def mul(a, b):
    return [[sum(a[k][r]*b[c][k] for k in range(4)) for r in range(4)] for c in range(4)]

def xf_point(m, p):
    return [sum(m[k][r]*(p[k] if k < 3 else 1) for k in range(4)) for r in range(3)]

def xf_dir(m, p):
    v = [sum(m[k][r]*p[k] for k in range(3)) for r in range(3)]
    L = math.sqrt(sum(c*c for c in v)) or 1.0
    return [c / L for c in v]

I4 = [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]
meshes = []
def walk(i, par):
    n = js['nodes'][i]; m = mul(par, mat_of(n))
    if 'mesh' in n:
        for pr in js['meshes'][n['mesh']]['primitives']:
            a = js['accessors'][pr['attributes']['POSITION']]
            lo, hi = [1e9]*3, [-1e9]*3
            for c in range(8):
                p = [a['min'][k] if c >> k & 1 else a['max'][k] for k in range(3)]
                w = xf_point(m, p)
                for k in range(3): lo[k] = min(lo[k], w[k]); hi[k] = max(hi[k], w[k])
            meshes.append({'prim': pr, 'm': m, 'lo': lo, 'hi': hi,
                           'c': [(lo[k]+hi[k])/2 for k in range(3)],
                           'sz': [hi[k]-lo[k] for k in range(3)]})
    for c in n.get('children', []): walk(c, m)
for s in js['scenes'][js.get('scene', 0)]['nodes']: walk(s, I4)

# --- classify --------------------------------------------------------------------
def classify(p):
    x, sx, sy = p['c'][0], p['sz'][0], p['sz'][1]
    if abs(x) < 0.35:
        if sy > 1.0: return 'stand'
        return 'beam'                      # the arm and the pivot pin both ride the beam
    if sx > 0.25: return 'leftPan' if x < 0 else 'rightPan'
    return None                            # a chain link

groups = {}
dropped = 0
for p in meshes:
    g = classify(p)
    if g is None: dropped += 1; continue
    groups.setdefault(g, []).append(p)

PIVOT_Y = max(p['c'][1] for p in groups['beam'])
STAND_BOTTOM = min(p['lo'][1] for p in groups['stand'])
BEAM_HALF_X = max(p['sz'][0] for p in groups['beam']) / 2
PAN_C = groups['leftPan'][0]['c']
PAN_HALF_X = groups['leftPan'][0]['sz'][0] / 2

# Each part is scaled to ITS OWN physics target, not all of them by one factor.
#
# 15 §6.1 asks for a uniform rescale, and that was measured: the asset's own ratios give a
# 0.254 m arm against a 0.273 m drop, and a balance built to them threw a 1 kg cube off the
# pan instead of pinning at its stop. The physics numbers in `config.weigh.balance` carry a
# calibration sweep behind them, so the asset is fitted to them rather than the other way
# round. The per-part scales differ by about 15 %, which nobody can see, and it means the
# drawn instrument is exactly the size of the simulated one.
TARGET = {
    'armM': 0.37,          # keep in step with config.weigh.balance
    'panRadiusM': 0.115,
    'pivotHeightM': 0.42,
}
SCALE = {
    'beam': TARGET['armM'] / BEAM_HALF_X,
    'leftPan': TARGET['panRadiusM'] / PAN_HALF_X,
    'rightPan': TARGET['panRadiusM'] / PAN_HALF_X,
    'stand': TARGET['pivotHeightM'] / (PIVOT_Y - STAND_BOTTOM),
}

ORIGIN = {
    'stand': [0.0, PIVOT_Y, 0.0],
    'beam': [0.0, PIVOT_Y, 0.0],
    'leftPan': [PAN_C[0], PAN_C[1], PAN_C[2]],
    'rightPan': [-PAN_C[0], PAN_C[1], PAN_C[2]],
}

# --- rebuild ---------------------------------------------------------------------
out_bin = bytearray()
out = {'asset': {'version': '2.0', 'generator': 'dense prepare-balance'},
       'scene': 0, 'scenes': [{'nodes': []}], 'nodes': [], 'meshes': [],
       'accessors': [], 'bufferViews': [], 'materials': [], 'textures': [], 'images': [],
       'samplers': js.get('samplers', [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}])}

def push_view(data, target=None):
    while len(out_bin) % 4: out_bin.append(0)
    o = len(out_bin); out_bin.extend(data)
    bv = {'buffer': 0, 'byteOffset': o, 'byteLength': len(data)}
    if target: bv['target'] = target
    out['bufferViews'].append(bv); return len(out['bufferViews']) - 1

def push_accessor(values, ctype, atype, target):
    fmt, size = COMP[ctype]; n = NUM[atype]
    buf = bytearray()
    for v in values: buf.extend(struct.pack('<' + fmt * n, *v))
    bv = push_view(bytes(buf), target)
    acc = {'bufferView': bv, 'componentType': ctype, 'count': len(values), 'type': atype}
    if atype == 'VEC3':
        acc['min'] = [min(v[k] for v in values) for k in range(3)]
        acc['max'] = [max(v[k] for v in values) for k in range(3)]
    out['accessors'].append(acc); return len(out['accessors']) - 1

# Only the materials the surviving parts actually use.
used_mats = sorted({p['prim'].get('material') for g in groups.values() for p in g} - {None})
mat_remap, img_remap = {}, {}

def keep_image(src_i):
    if src_i in img_remap: return img_remap[src_i]
    im_js = js['images'][src_i]
    data, _ = view(im_js['bufferView'])
    im = Image.open(io.BytesIO(data)).convert('RGB')
    im = im.resize((TEXTURE_PX, TEXTURE_PX), Image.LANCZOS)
    buf = io.BytesIO(); im.save(buf, 'JPEG', quality=JPEG_QUALITY, optimize=True)
    bv = push_view(buf.getvalue())
    out['images'].append({'bufferView': bv, 'mimeType': 'image/jpeg'})
    out['textures'].append({'sampler': 0, 'source': len(out['images']) - 1})
    img_remap[src_i] = len(out['textures']) - 1
    return img_remap[src_i]

for mi in used_mats:
    src = js['materials'][mi]
    pbr_src = src.get('pbrMetallicRoughness', {})
    pbr = {}
    for key in ('baseColorTexture', 'metallicRoughnessTexture'):
        if key in pbr_src:
            pbr[key] = {'index': keep_image(js['textures'][pbr_src[key]['index']]['source'])}
    m = {'name': src.get('name', f'mat{mi}'), 'pbrMetallicRoughness': pbr, 'doubleSided': src.get('doubleSided', False)}
    if 'normalTexture' in src:
        m['normalTexture'] = {'index': keep_image(js['textures'][src['normalTexture']['index']]['source'])}
    out['materials'].append(m)
    mat_remap[mi] = len(out['materials']) - 1

kept_tris = 0
for name, parts in groups.items():
    origin = ORIGIN[name]
    mirror = -1.0 if name == 'rightPan' else 1.0
    prims = []
    for p in parts:
        m = p['m']
        pos = [xf_point(m, v) for v in read_accessor(p['prim']['attributes']['POSITION'])]
        sc = SCALE[name]
        pos = [[(v[0] - origin[0]) * sc * mirror, (v[1] - origin[1]) * sc, (v[2] - origin[2]) * sc]
               for v in pos]
        attrs = {'POSITION': push_accessor(pos, 5126, 'VEC3', 34962)}
        if 'NORMAL' in p['prim']['attributes']:
            nor = [xf_dir(m, v) for v in read_accessor(p['prim']['attributes']['NORMAL'])]
            if mirror < 0: nor = [[-v[0], v[1], v[2]] for v in nor]
            attrs['NORMAL'] = push_accessor(nor, 5126, 'VEC3', 34962)
        if 'TEXCOORD_0' in p['prim']['attributes']:
            uv = read_accessor(p['prim']['attributes']['TEXCOORD_0'])
            attrs['TEXCOORD_0'] = push_accessor(uv, 5126, 'VEC2', 34962)
        prim = {'attributes': attrs}
        if 'indices' in p['prim']:
            idx = [v[0] for v in read_accessor(p['prim']['indices'])]
            # Mirroring flips winding; swap two of every triangle's corners back.
            if mirror < 0:
                idx = [idx[i + j] for i in range(0, len(idx), 3) for j in (0, 2, 1)]
            prim['indices'] = push_accessor([(v,) for v in idx], 5125, 'SCALAR', 34963)
            kept_tris += len(idx) // 3
        if p['prim'].get('material') in mat_remap:
            prim['material'] = mat_remap[p['prim']['material']]
        prims.append(prim)
    out['meshes'].append({'name': name, 'primitives': prims})
    out['nodes'].append({'name': name, 'mesh': len(out['meshes']) - 1})
    out['scenes'][0]['nodes'].append(len(out['nodes']) - 1)

out['buffers'] = [{'byteLength': len(out_bin)}]

json_bytes = json.dumps(out, separators=(',', ':')).encode()
while len(json_bytes) % 4: json_bytes += b' '
while len(out_bin) % 4: out_bin.append(0)
glb = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(json_bytes) + 8 + len(out_bin))
glb += struct.pack('<II', len(json_bytes), 0x4E4F534A) + json_bytes
glb += struct.pack('<II', len(out_bin), 0x004E4942) + bytes(out_bin)
os.makedirs('public', exist_ok=True)
open(DST, 'wb').write(glb)

print(f"parts: {', '.join(f'{k}({len(v)})' for k, v in groups.items())}")
print(f"dropped {dropped} chain-link meshes")
print(f"triangles {kept_tris:,} (was 46,584)   textures {len(out['images'])} at {TEXTURE_PX}px")
print(f"{os.path.getsize(SRC)/1e6:.2f} MB -> {os.path.getsize(DST)/1e6:.3f} MB")
print()
print("per-part scale: " + ", ".join(f"{k} {v:.4f}" for k, v in SCALE.items()))
