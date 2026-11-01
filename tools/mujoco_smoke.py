#!/usr/bin/env python3
"""Simulates the sample worlds' MuJoCo bundles and says whether the world the
engine builds is the one the file describes.

    pnpm smoke:fixtures
    python3 tools/mujoco_smoke.py fixtures/out/mujoco

Needs the `mujoco` package (pip install mujoco, or a venv; MUJOCO_PYTHON picks
the interpreter for pnpm smoke:mujoco). For every bundle: the MJCF must
compile; rays cast down at a few spots must hit the ground at the heights the
file gives (a heightmap flipped or stretched by the engine shows here); after
four seconds a fixed prop must not have moved, a free prop must rest on the
ground, the attached robot must stand on it, and MuJoCo must raise no
warnings. Exit code 1 on any failure, 2 when mujoco is missing.
"""
import glob
import json
import os
import sys

try:
    import mujoco
except ImportError:
    print('mujoco is not installed: pip install mujoco (a venv is fine) and run this with that Python.')
    sys.exit(2)
import numpy as np

failures = []


def fail(name, what):
    failures.append(f'{name}: {what}')
    print(f'  FAIL {what}', flush=True)


def ok(what):
    print(f'  ok   {what}', flush=True)


def ground_at(m, d, x, y):
    """Where a ray dropped from above lands on the floor, or None when it hits something else."""
    geomid = np.array([-1], dtype=np.int32)
    # Only the default geom group: the floor, not the probe crate hanging over the spot (its geoms are in groups 2 and 3).
    groups = np.array([1, 0, 0, 0, 0, 0], dtype=np.uint8)
    dist = mujoco.mj_ray(m, d, np.array([x, y, 50.0]), np.array([0.0, 0.0, -1.0]), groups, 1, -1, geomid)
    if dist < 0 or geomid[0] != mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_GEOM, 'floor'):
        return None
    return 50.0 - dist


def resting(z, ground, edge):
    """Whether a crate's origin (the middle of its base) sits on the ground, allowing for a slope and a tumble."""
    return ground - 0.05 - 0.25 * edge <= z <= ground + edge + 0.05


def check(smoke_path):
    spec = json.load(open(smoke_path))
    bundle = smoke_path[: -len('.smoke.json')]
    name = os.path.basename(bundle)
    print(f'\n== {name} ({spec["terrain"]["kind"]})', flush=True)
    try:
        m = mujoco.MjModel.from_xml_path(os.path.join(bundle, spec['file']))
    except Exception as e:  # noqa: BLE001
        return fail(name, f'the MJCF did not compile: {e}')
    ok(f'compiles: {m.nbody - 1} bodies, {m.ngeom} geoms')
    d = mujoco.MjData(m)
    mujoco.mj_forward(m, d)
    worst = 0.0
    for probe in spec['probes']:
        z = ground_at(m, d, *probe['xy'])
        if z is None:
            fail(name, f'no floor under {probe["xy"]}')
            continue
        worst = max(worst, abs(z - probe['ground']))
    if worst > 0.05:
        fail(name, f'the ground is off by up to {worst:.3f} m from the file')
    else:
        ok(f'the ground is where the file puts it (within {worst * 1000:.0f} mm at {len(spec["probes"])} spots)')
    body = lambda n: mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, n)  # noqa: E731
    for o in spec['objects']:
        if o['placed'] and body(o['id']) < 0:
            fail(name, f'no body "{o["id"]}"')
    robots = []
    for r in spec['robots']:
        if not r['placed']:
            continue
        b = body(f'{r["id"]}_{r["rootBody"]}')
        if b < 0:
            fail(name, f'no body "{r["id"]}_{r["rootBody"]}" for the attached robot')
        else:
            robots.append((r, b))
    for _ in range(int(3.0 / m.opt.timestep)):
        mujoco.mj_step(m, d)
    # Rest is judged over the last second of four: a box on a heightfield reports a jittery velocity while it sits still.
    before = d.xpos.copy()
    for _ in range(int(1.0 / m.opt.timestep)):
        mujoco.mj_step(m, d)
    warnings = [mujoco.mjtWarning(i).name for i in range(mujoco.mjtWarning.mjNWARNING) if d.warning[i].number]
    if warnings:
        fail(name, f'MuJoCo warned: {", ".join(warnings)}')
    else:
        ok('no MuJoCo warnings in 4 s')
    for o in spec['objects']:
        b = body(o['id'])
        if b < 0 or not o['placed']:
            continue
        z = float(d.xpos[b][2])
        if not o['free']:
            if np.max(np.abs(d.xpos[b] - np.array(o['xyz']))) > 1e-6:
                fail(name, f'fixed {o["id"]} is at {d.xpos[b]}, placed at {o["xyz"]}')
            else:
                ok(f'{o["id"]} stays where it was placed')
            continue
        if o['collision'] == 'none':
            continue
        moved = float(np.linalg.norm(d.xpos[b] - before[b]))
        if moved > 0.01:
            fail(name, f'{o["id"]} is still moving {moved * 1000:.0f} mm/s after 4 s')
        elif o.get('probe'):
            if abs(z - o['ground']) > 0.08:
                fail(name, f'{o["id"]} landed at z = {z:.3f} m where the file has the ground at {o["ground"]:.3f} m')
            else:
                ok(f'{o["id"]} finds the ground at z = {z:.3f} m (file: {o["ground"]:.3f} m)')
        elif not resting(z, o['ground'], o['edge']):
            fail(name, f'{o["id"]} rests at z = {z:.3f} m where the ground is at {o["ground"]:.3f} m')
        else:
            ok(f'{o["id"]} rests on the ground: z = {z:.3f} m, ground {o["ground"]:.3f} m')
    for r, b in robots:
        z = float(d.xpos[b][2])
        if z < r['ground'] - 0.05:
            fail(name, f'robot {r["id"]} sank to z = {z:.3f} m, below the ground at {r["ground"]:.3f} m')
        elif z > r['ground'] + 1:
            fail(name, f'robot {r["id"]} floats at z = {z:.3f} m over ground at {r["ground"]:.3f} m')
        else:
            ok(f'robot {r["id"]} stands at z = {z:.3f} m, ground {r["ground"]:.3f} m')


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else 'fixtures/out/mujoco'
    smokes = sorted(glob.glob(os.path.join(root, '*.smoke.json')))
    if not smokes:
        print(f'no bundles under {root}: run pnpm smoke:fixtures first')
        sys.exit(1)
    for smoke in smokes:
        check(smoke)
    print()
    if failures:
        print(f'{len(failures)} failure(s):')
        for f in failures:
            print('  ' + f)
        sys.exit(1)
    print(f'all {len(smokes)} world(s) behave in MuJoCo')


if __name__ == '__main__':
    main()
