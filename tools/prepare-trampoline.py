"""
Prepares assets-lib/trampoline/trampoline.glb for the Drop Tower (16 §14.1).

The export is one node with four primitives, distinguishable only by MATERIAL — and by
bounds, which is what actually identifies them: Material.003 is a flat disc at the top
(the MAT, the one part that must follow the CompliantPad body), everything else is
frame: the padded edge ring, the leg tubes, the feet.

  mat    (dynamic — bound to the pad body)   the jumping surface
  frame  (static visual)                     pad ring, legs, feet

Uniform scale is chosen so the asset's mat surface sits exactly at the physics pad's
rest top (config.drop.pads.trampoline.restCentreYM 0.30 + the 10 mm half-thickness =
0.31): the model and the simulation agree about where the fabric is, or the cube
visibly floats. The frame is re-origined at the ground, the mat at its own centre so
binding it to the pad body is an identity.

Run: python3 tools/prepare-trampoline.py
"""
import json, struct, os

SRC = 'assets-lib/trampoline/trampoline.glb'
DST = 'public/trampoline.glb'
# config.drop.pads.trampoline.restCentreYM + mat half-thickness (0.01) = the fabric top.
TARGET_MAT_TOP_M = 0.31
MAT_MATERIAL = 'Material.003'

raw = open(SRC, 'rb').read()
off, js, binoff, binlen = 12, None, 0, 0
while off < len(raw):
    clen, ctype = struct.unpack_from('<II', raw, off); off += 8
    if ctype == 0x4E4F534A: js = json.loads(raw[off:off + clen])
    elif ctype == 0x004E4942: binoff, binlen = off, clen
    off += clen
BIN = raw[binoff:binoff + binlen]

COMP = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}
NUM = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}

def view(i):
    bv = js['bufferViews'][i]
    o = bv.get('byteOffset', 0)
    return BIN[o:o + bv['byteLength']], bv.get('byteStride')

def read_accessor(i):
    a = js['accessors'][i]
    fmt, size = COMP[a['componentType']]
    n = NUM[a['type']]
    data, stride = view(a['bufferView'])
    base, step = a.get('byteOffset', 0), (stride or size * n)
    return [struct.unpack_from('<' + fmt * n, data, base + k * step) for k in range(a['count'])]

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
def xf_point(m, p): return [sum(m[k][r]*(p[k] if k < 3 else 1) for k in range(4)) for r in range(3)]
def xf_dir(m, p):
    import math
    v = [sum(m[k][r]*p[k] for k in range(3)) for r in range(3)]
    L = math.sqrt(sum(c*c for c in v)) or 1.0
    return [c / L for c in v]

I4 = [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]
groups = {'frame': [], 'mat': []}

def walk(i, par):
    n = js['nodes'][i]
    m = mul(par, mat_of(n))
    if 'mesh' in n:
        for pr in js['meshes'][n['mesh']]['primitives']:
            mat_i = pr.get('material')
            mat_name = js['materials'][mat_i].get('name', '') if mat_i is not None else ''
            group = 'mat' if mat_name == MAT_MATERIAL else 'frame'
            a = js['accessors'][pr['attributes']['POSITION']]
            lo, hi = [1e9]*3, [-1e9]*3
            for c in range(8):
                p = [a['min'][k] if c >> k & 1 else a['max'][k] for k in range(3)]
                w = xf_point(m, p)
                for k in range(3): lo[k] = min(lo[k], w[k]); hi[k] = max(hi[k], w[k])
            groups[group].append({'prim': pr, 'm': m, 'lo': lo, 'hi': hi})
    for c in n.get('children', []): walk(c, m)

for s in js['scenes'][js.get('scene', 0)]['nodes']: walk(s, I4)

def bounds(parts):
    lo = [min(p['lo'][k] for p in parts) for k in range(3)]
    hi = [max(p['hi'][k] for p in parts) for k in range(3)]
    return lo, hi

mlo, mhi = bounds(groups['mat'])
flo, fhi = bounds(groups['frame'])
SCALE = TARGET_MAT_TOP_M / mhi[1]

ORIGIN = {
    'frame': [0.0, flo[1], 0.0],
    'mat': [(mlo[0]+mhi[0])/2, (mlo[1]+mhi[1])/2, (mlo[2]+mhi[2])/2],
}

out_bin = bytearray()
out = {'asset': {'version': '2.0', 'generator': 'dense prepare-trampoline'},
       'scene': 0, 'scenes': [{'nodes': []}], 'nodes': [], 'meshes': [],
       'accessors': [], 'bufferViews': [], 'materials': []}

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
    acc = {'bufferView': push_view(bytes(buf), target), 'componentType': ctype,
           'count': len(values), 'type': atype}
    if atype == 'VEC3':
        acc['min'] = [min(v[k] for v in values) for k in range(3)]
        acc['max'] = [max(v[k] for v in values) for k in range(3)]
    out['accessors'].append(acc); return len(out['accessors']) - 1

mat_remap = {}
for mi in sorted({p['prim'].get('material') for g in groups.values() for p in g} - {None}):
    src = js['materials'][mi]
    pbr = src.get('pbrMetallicRoughness', {})
    out['materials'].append({
        'name': src.get('name', f'mat{mi}'),
        'pbrMetallicRoughness': {k: v for k, v in pbr.items() if not isinstance(v, dict)},
        'doubleSided': src.get('doubleSided', False),
    })
    mat_remap[mi] = len(out['materials']) - 1

tris = 0
for name, parts in groups.items():
    origin = ORIGIN[name]
    prims = []
    for p in parts:
        m = p['m']
        pos = [xf_point(m, v) for v in read_accessor(p['prim']['attributes']['POSITION'])]
        pos = [[(v[k] - origin[k]) * SCALE for k in range(3)] for v in pos]
        attrs = {'POSITION': push_accessor(pos, 5126, 'VEC3', 34962)}
        if 'NORMAL' in p['prim']['attributes']:
            attrs['NORMAL'] = push_accessor(
                [xf_dir(m, v) for v in read_accessor(p['prim']['attributes']['NORMAL'])],
                5126, 'VEC3', 34962)
        prim = {'attributes': attrs}
        if 'indices' in p['prim']:
            idx = [v[0] for v in read_accessor(p['prim']['indices'])]
            prim['indices'] = push_accessor([(v,) for v in idx], 5125, 'SCALAR', 34963)
            tris += len(idx) // 3
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

print(f"frame {len(groups['frame'])} prims, mat {len(groups['mat'])} prims, {tris:,} tris")
print(f"{os.path.getsize(SRC)/1e6:.2f} MB -> {os.path.getsize(DST)/1e6:.3f} MB  scale {SCALE:.5f}")
print(f"mat centre y {((mlo[1]+mhi[1])/2)*SCALE:.4f}  (pad body rest 0.30)")
print(f"mat radius   {max(mhi[0]-mlo[0], mhi[2]-mlo[2])/2*SCALE:.4f}")
print(f"outer radius {max(fhi[0]-flo[0], fhi[2]-flo[2])/2*SCALE:.4f}  frame top {fhi[1]*SCALE:.4f}")
