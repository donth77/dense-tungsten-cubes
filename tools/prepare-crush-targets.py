"""Prepare the crush-target assets (18 §5.3, C1.5).

assets-lib/wine-glass/wine_glass.glb  -> public/wine-glass.glb  (verbatim: real
    scale (19.5 cm), origin already at the base; only the Sketchfab wrapper nodes
    are collapsed so the loader gets one named mesh.)
assets-lib/pedestal/pedestal.glb      -> public/pedestal.glb    (scaled 0.173 so the
    plinth footprint stays inside the spawn-slot ring, base shifted to y = 0.)
"""
import json
import shutil
import struct

def read_glb(path):
    data = open(path, 'rb').read()
    assert data[:4] == b'glTF'
    ln = struct.unpack('<I', data[12:16])[0]
    js = json.loads(data[20:20 + ln])
    rest = data[20 + ln:]
    assert rest[4:8] == b'BIN\x00'
    return js, rest[8:]

def write_glb(path, js, binbuf):
    j = json.dumps(js, separators=(',', ':')).encode()
    j += b' ' * (-len(j) % 4)
    b = binbuf + b'\x00' * (-len(binbuf) % 4)
    total = 12 + 8 + len(j) + 8 + len(b)
    with open(path, 'wb') as f:
        f.write(b'glTF' + struct.pack('<II', 2, total))
        f.write(struct.pack('<I', len(j)) + b'JSON' + j)
        f.write(struct.pack('<I', len(b)) + b'BIN\x00' + b)

# Wine glass: verbatim copy — already game-ready.
shutil.copyfile('assets-lib/wine-glass/wine_glass.glb', 'public/wine-glass.glb')
print('wine-glass.glb copied verbatim (19.5 cm, base-origined)')

# Pedestal: the source composes to an 11.4 m monument (a node carries scale 8.67
# under axis-flip wrappers). NEVER touch the wrapper transforms — wrap with a fresh
# root scaled so the plinth stands 0.228 m with its base already at y = 0.
js, binbuf = read_glb('assets-lib/pedestal/pedestal.glb')
WORLD_H = 11.4276
S = 0.228 / WORLD_H
scene = js['scenes'][js.get('scene', 0)]
old_roots = scene['nodes']
js['nodes'].append({'name': 'pedestal_root', 'children': old_roots, 'scale': [S, S, S]})
scene['nodes'] = [len(js['nodes']) - 1]
write_glb('public/pedestal.glb', js, binbuf)
print('pedestal.glb wrapped: scale %.5f -> H 0.228, half-width %.3f' % (S, 4.7004 * S))


# Watermelon: the model ships Watermelon_Full + authored Half_Left/Half_Right break
# pieces. The FULL melon alone composes to 0.23 x 0.23 x 0.30 m with its belly at
# y = 0 (the union bbox lied - the halves are laid out BESIDE the full and inflated
# it; measure the part you ship). Wrap 1.4x for a proper 32 x 32 x 42 cm watermelon.
js, binbuf = read_glb('assets-lib/watermelon/watermelon_fruit_3d_model.glb')
S = 1.4
scene = js['scenes'][js.get('scene', 0)]
old_roots = scene['nodes']
js['nodes'].append({'name': 'melon_root', 'children': old_roots, 'scale': [S, S, S]})
scene['nodes'] = [len(js['nodes']) - 1]
write_glb('public/watermelon.glb', js, binbuf)
print('watermelon.glb wrapped: scale %.2f -> full melon ~0.32 x 0.32 x 0.42 m, belly at y=0' % S)


# Soda can (18 §6 C2): ONE GLB whose two meshes (label + metal) carry the crush as
# glTF MORPH TARGETS — [dent, flat] position deltas — so the crush ANIMATES (three
# drives morphTargetInfluences natively; no runtime library needed). The fold field
# is Yoshimura-style diamond buckling (the pattern thin-walled cylinders actually
# collapse into — doc 07 cites the FEM study): sharp triangle-wave creases with
# per-row hashed phases, and the stiff rims survive at both ends. Normals stay the
# intact set (crushed metal is chaotic enough to carry it). Scale for a true 355 ml
# can: H 122 mm, Ø 64 mm.
import math

js, binbuf = read_glb('assets-lib/soda/soda_can.glb')
binbuf = bytearray(binbuf)
H = 2.643

def read_vec3(acc_i):
    acc = js['accessors'][acc_i]
    bv = js['bufferViews'][acc['bufferView']]
    off = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
    return list(struct.unpack_from('<%df' % (acc['count'] * 3), binbuf, off))

def append_vec3(vals):
    while len(binbuf) % 4:
        binbuf.append(0)
    off = len(binbuf)
    binbuf.extend(struct.pack('<%df' % len(vals), *vals))
    js['bufferViews'].append({'buffer': 0, 'byteOffset': off, 'byteLength': len(vals) * 4})
    xs, ys, zs = vals[0::3], vals[1::3], vals[2::3]
    js['accessors'].append({
        'bufferView': len(js['bufferViews']) - 1, 'componentType': 5126,
        'count': len(vals) // 3, 'type': 'VEC3',
        'min': [min(xs), min(ys), min(zs)], 'max': [max(xs), max(ys), max(zs)],
    })
    return len(js['accessors']) - 1

def hash01(nf):
    x = math.sin(nf * 127.1) * 43758.5453
    return x - math.floor(x)

def tri(x):
    """0..1..0 sharp triangle, period 1 — creases, not sinusoids."""
    x = x - math.floor(x)
    return 1.0 - abs(2.0 * x - 1.0)

def deform(vals, mode):
    out = []
    for i in range(0, len(vals), 3):
        x, y, z = vals[i], vals[i + 1], vals[i + 2]
        u = math.atan2(y, x) / (2 * math.pi)
        if mode == 'dent':
            # Shoulder telescope: the top third folds to 55% with a 5-lobe crease.
            if z > 1.72:
                fz = (z - 1.72) / (H - 1.72)
                z = 1.72 + (z - 1.72) * 0.55
                k = 1 - 0.13 * tri(u * 5 + 0.13) * fz
                x *= k
                y *= k
        else:  # flat
            zf = min(1.0, max(0.0, z / H))
            band = min(1.0, zf * 6) * min(1.0, (1 - zf) * 6)  # rims stay rims
            row = zf * 4.0
            w = tri(u * 8 + hash01(math.floor(row)) + row * 0.5) * tri(row + 0.25)
            z *= 0.24
            k = 1 + band * 0.17 * (w - 0.45)
            x *= k
            y *= k
        out += [x, y, z]
    return out

for mesh_i, acc_i in ((0, 0), (1, 4)):
    orig = read_vec3(acc_i)
    targets = []
    for mode in ('dent', 'flat'):
        bent = deform(orig, mode)
        targets.append({'POSITION': append_vec3([b - o for b, o in zip(bent, orig)])})
    js['meshes'][mesh_i]['primitives'][0]['targets'] = targets
    js['meshes'][mesh_i]['weights'] = [0.0, 0.0]

S = 0.122 / H
scene = js['scenes'][js.get('scene', 0)]
old_roots = scene['nodes']
js['nodes'].append({'name': 'can_root', 'children': old_roots, 'scale': [S, S, S]})
scene['nodes'] = [len(js['nodes']) - 1]
write_glb('public/soda-can.glb', js, bytes(binbuf))
print('soda-can.glb: morph targets [dent, flat] baked, scale %.5f -> H 0.122 m, Ø %.3f m'
      % (S, 2 * 0.6902 * S))
