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
