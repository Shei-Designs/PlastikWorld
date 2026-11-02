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
warnings. Then each robot's wheel motors (every actuator the attach brought
in under its name) are told a rate for a few seconds: the robot must cover
the distance along its heading, stay upright and on the ground, and climb
when it starts on a slope. Exit code 1 on any failure, 2 when mujoco is
missing.
"""
import glob
import json
import math
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
    # The floor, or a surface zone laid over it (a static geom of the world body, a hair above the ground).
    if dist < 0 or m.geom_bodyid[geomid[0]] != 0:
        return None
    return 50.0 - dist


def judge_slide(name, item, travel):
    """A crate set on a surface zone of a slope: on ice it must have slid, on rubber it must have stayed put."""
    if item['slide'] == 'must':
        if travel < 0.15:
            fail(name, f'{item["id"]} did not slide on the {item["surface"]}: it moved {travel:.3f} m')
        else:
            ok(f'{item["id"]} slid {travel:.2f} m on the {item["surface"]}')
    elif travel > 0.05:
        fail(name, f'{item["id"]} slid {travel:.3f} m on the {item["surface"]}, where it should have held')
    else:
        ok(f'{item["id"]} holds on the {item["surface"]} ({travel * 1000:.0f} mm)')


def resting(z, ground, edge):
    """Whether a crate's origin (the middle of its base) sits on the ground, allowing for a slope and a tumble."""
    return ground - 0.05 - 0.25 * edge <= z <= ground + edge + 0.05


def ground_of(terrain, x, y):
    """The ground height the world file gives at (x, y): bilinear between samples, mirroring io/heightmap.ts heightAt; 0 on a plane or outside."""
    if terrain['kind'] != 'heightmap':
        return 0.0
    rows, cols, size, hs = terrain['rows'], terrain['cols'], terrain['size'], terrain['heights']
    u = (x / size[0] + 0.5) * (cols - 1)
    v = (y / size[1] + 0.5) * (rows - 1)
    if u < 0 or v < 0 or u > cols - 1 or v > rows - 1:
        return 0.0
    c0, r0 = min(math.floor(u), cols - 2), min(math.floor(v), rows - 2)
    fu, fv = u - c0, v - r0
    h = lambda r, c: hs[r * cols + c]  # noqa: E731
    top = h(r0, c0) * (1 - fu) + h(r0, c0 + 1) * fu
    bottom = h(r0 + 1, c0) * (1 - fu) + h(r0 + 1, c0 + 1) * fu
    # The file's heights are meters (format 2); nothing to scale.
    return top * (1 - fv) + bottom * fv


def judge_drive(name, robot, terrain, before, after, roll, pitch):
    """What a drive must have done: covered the distance along the heading, kept the robot upright and on the ground, and climbed on the hills."""
    d = robot['drive']
    dx, dy = after[0] - before[0], after[1] - before[1]
    moved = math.hypot(dx, dy)
    if moved < d['mustMove']:
        fail(name, f'robot {robot["id"]} moved only {moved:.2f} m in {d["seconds"]} s when driven forward')
    else:
        off = abs(math.degrees((math.atan2(dy, dx) - d['heading'] + math.pi) % (2 * math.pi) - math.pi))
        if off > 45:
            fail(name, f'robot {robot["id"]} drove {moved:.2f} m but {off:.0f}° off its heading')
        else:
            ok(f'robot {robot["id"]} drove {moved:.2f} m along its heading ({off:.0f}° off)')
    if abs(roll) > 0.5 or abs(pitch) > 0.5:
        fail(name, f'robot {robot["id"]} tipped over: roll {roll:.2f}, pitch {pitch:.2f} rad')
    g0, g1 = ground_of(terrain, before[0], before[1]), ground_of(terrain, after[0], after[1])
    if after[2] < g1 - 0.05:
        fail(name, f'robot {robot["id"]} is at z = {after[2]:.3f} m, under the ground at {g1:.3f} m')
    elif after[2] > g1 + 0.5:
        fail(name, f'robot {robot["id"]} is at z = {after[2]:.3f} m, over the ground at {g1:.3f} m')
    elif d.get('uphill'):
        if g1 - g0 < 0.05:
            fail(name, f'robot {robot["id"]} did not climb: the ground went from {g0:.3f} m to {g1:.3f} m')
        else:
            ok(f'robot {robot["id"]} climbed {g1 - g0:.2f} m and stays on the ground (z = {after[2]:.3f} m, ground {g1:.3f} m)')
    else:
        ok(f'robot {robot["id"]} stays on the ground (z = {after[2]:.3f} m, ground {g1:.3f} m)')


def roll_pitch(quat):
    """Roll and pitch of a body from its wxyz quaternion."""
    R = np.zeros(9)
    mujoco.mju_quat2Mat(R, quat)
    R = R.reshape(3, 3)
    return math.atan2(R[2, 1], R[2, 2]), math.asin(-max(-1.0, min(1.0, R[2, 0])))


def drive(name, robot, body, m, d, terrain):
    """Runs every actuator attached under the robot's name at the drive's wheel rate and judges where the robot got to."""
    spec = robot['drive']
    acts = [i for i in range(m.nu) if mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_ACTUATOR, i).startswith(f'{robot["id"]}_')]
    if not acts:
        return fail(name, f'robot {robot["id"]} brought no actuators in to drive')
    before = d.xpos[body].copy()
    for i in acts:
        d.ctrl[i] = spec['wheelRate']
    for _ in range(int(spec['seconds'] / m.opt.timestep)):
        mujoco.mj_step(m, d)
    for i in acts:
        d.ctrl[i] = 0
    for _ in range(int(0.5 / m.opt.timestep)):
        mujoco.mj_step(m, d)
    roll, pitch = roll_pitch(d.xquat[body])
    judge_drive(name, robot, terrain, before, d.xpos[body].copy(), roll, pitch)


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
        if o.get('slide'):
            judge_slide(name, o, float(np.hypot(d.xpos[b][0] - o['xyz'][0], d.xpos[b][1] - o['xyz'][1])))
            continue
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
    for r, b in robots:
        if r.get('drive'):
            drive(name, r, b, m, d, spec['terrain'])


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
