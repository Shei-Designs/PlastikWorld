#!/usr/bin/env -S blender -b --python
"""Imports each sample world's GLB into Blender and checks that what the
writer put in is there: every prop as an object of its name, back at its
place in Z up (the importer undoes the Y-up turn the GLB carries), every
surface zone, and the ground. Run with:
    blender -b --python tools/blender_smoke.py -- fixtures/out/blender
"""
import glob
import json
import os
import sys

import bpy

out = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else 'fixtures/out/blender'
failures = []


def fail(name, what):
    failures.append(f'{name}: {what}')
    print(f'  FAIL {what}', flush=True)


def ok(what):
    print(f'  ok   {what}', flush=True)


for path in sorted(glob.glob(os.path.join(out, '*.glb'))):
    name = os.path.splitext(os.path.basename(path))[0]
    print(f'\n== {name}', flush=True)
    with open(os.path.join(out, f'{name}.smoke.json')) as f:
        expected = json.load(f)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    try:
        bpy.ops.import_scene.gltf(filepath=os.path.abspath(path))
    except Exception as err:  # noqa: BLE001
        fail(name, f'the import failed: {err}')
        continue
    objects = {o.name: o for o in bpy.data.objects if o.type == 'MESH'}
    if 'Ground' in objects:
        ok(f'the ground is there with {len(objects["Ground"].data.polygons)} faces')
    else:
        fail(name, 'no Ground object')
    for zone in expected['zones']:
        if zone in objects:
            ok(f'zone {zone} is there')
        else:
            fail(name, f'zone {zone} is missing')
    for prop in expected['props']:
        o = objects.get(prop['name'])
        if not o:
            fail(name, f'prop {prop["name"]} is missing')
            continue
        at = o.matrix_world.translation
        off = max(abs(at[i] - prop['xyz'][i]) for i in range(3))
        if off > 1e-3:
            fail(name, f'prop {prop["name"]} is at {tuple(round(v, 3) for v in at)}, placed at {prop["xyz"]}')
        else:
            ok(f'prop {prop["name"]} at {tuple(round(v, 3) for v in at)}')

print()
if failures:
    print(f'{len(failures)} failure(s):')
    for f in failures:
        print(f'  {f}')
    sys.exit(1)
print('All sample worlds imported into Blender as written.')
