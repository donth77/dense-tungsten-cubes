"""
Tank props (19 §3).

assets-lib/rubber-duck/rubber_duck.glb -> public/rubber-duck.glb

The source composes to a ~7.2 unit duck sitting off-origin in z. This wraps it in one
node that re-origins it (centred in x/z, base at y = 0) and scales it to a real bath
duck at 8.5 cm long — measured from the COMPOSED WORLD BBOX, not from accessor bounds,
which lie whenever a node chain carries transforms (the lesson the melon taught).
"""

import json
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


def node_matrix(n):
    if 'matrix' in n:
        m = n['matrix']
        return [m[0:4], m[4:8], m[8:12], m[12:16]]
    t = n.get('translation', [0, 0, 0])
    r = n.get('rotation', [0, 0, 0, 1])
    s = n.get('scale', [1, 1, 1])
    x, y, z, w = r
    rot = [
        [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)],
        [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
        [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)],
    ]
    m = [[rot[i][j] * s[i] for j in range(3)] + [0.0] for i in range(3)]
    m.append([t[0], t[1], t[2], 1.0])
    return m


def mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def xform(m, p):
    return [sum(p[k] * m[k][i] for k in range(3)) + m[3][i] for i in range(3)]


js, binbuf = read_glb('assets-lib/rubber-duck/rubber_duck.glb')

lo = [1e9] * 3
hi = [-1e9] * 3


def walk(i, parent):
    n = js['nodes'][i]
    m = mul(node_matrix(n), parent)
    if 'mesh' in n:
        for prim in js['meshes'][n['mesh']]['primitives']:
            acc = js['accessors'][prim['attributes']['POSITION']]
            for a in (acc['min'][0], acc['max'][0]):
                for b in (acc['min'][1], acc['max'][1]):
                    for c in (acc['min'][2], acc['max'][2]):
                        w = xform(m, [a, b, c])
                        for k in range(3):
                            lo[k] = min(lo[k], w[k])
                            hi[k] = max(hi[k], w[k])
    for c in n.get('children', []):
        walk(c, m)


ident = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
scene = js['scenes'][js.get('scene', 0)]
for root in scene['nodes']:
    walk(root, ident)

size = [hi[k] - lo[k] for k in range(3)]
LENGTH_M = 0.085  # a real bath duck
S = LENGTH_M / max(size)

# Re-origin first (centre x/z, base to y=0), then scale: the wrapper applies its own
# translation BEFORE its scale, so the offset is expressed in source units.
offset = [-(lo[0] + hi[0]) / 2, -lo[1], -(lo[2] + hi[2]) / 2]

old_roots = list(scene['nodes'])
js['nodes'].append(
    {'name': 'duck_root', 'children': old_roots, 'scale': [S, S, S], 'translation': [0, 0, 0]}
)
outer = len(js['nodes']) - 1
js['nodes'].append({'name': 'duck_origin', 'children': [outer], 'translation': [0, 0, 0]})
# Put the re-origin INSIDE the scaled node so it is in source units.
js['nodes'][outer]['children'] = [len(js['nodes'])]
js['nodes'].append({'name': 'duck_shift', 'children': old_roots, 'translation': offset})
scene['nodes'] = [outer]

write_glb('public/rubber-duck.glb', js, binbuf)
print(
    'rubber-duck.glb wrapped: scale %.5f -> %.3f x %.3f x %.3f m, base at y=0'
    % (S, size[0] * S, size[1] * S, size[2] * S)
)
