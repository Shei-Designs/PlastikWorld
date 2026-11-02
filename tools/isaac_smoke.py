#!/usr/bin/env python3
"""Opens the sample worlds' Isaac Sim stages and says whether they hold up.

    pnpm smoke:fixtures
    ~/isaacsim-env/bin/python tools/isaac_smoke.py fixtures/out/isaac [--no-sim]

Two passes. With pxr alone (pip install usd-core gives it): every stage must
open, every file it refers to must resolve, every placed prop and robot must
be a prim under /World (the robot's reference bringing in an articulation),
and the stage must pass USD's compliance checks. With Isaac Sim installed as
well (the isaacsim package; ISAACSIM_PYTHON picks the interpreter for pnpm
smoke:isaac), each stage is then played headless for four seconds, as a user
would play it after File > Open: a fixed prop must not move, a free prop and
a probe must rest on the ground at the height the file gives, and the robot
must stand on it. Then the robot is driven: the stages PlastikCAD's ROS
packages carry have no ROS 2 graph (PlastikCAD's own Isaac export does, and
its smoke:usd drives that over ROS 2), so here every wheel joint of the
articulation is given a velocity target through PhysX, the way a controller
would; it must cover the distance along its heading, stay upright and on the
ground, and climb when it starts on a slope. Exit code 1 on any failure, 2
when pxr is missing.

The two passes run in separate processes on purpose: Kit brings its own build
of USD, and a pxr imported before SimulationApp starts leaves Kit's libraries
unable to load (every omni.usd extension fails with undefined pxrInternal
symbols). So the pxr pass runs as a child of this script with --no-sim, and
the parent only imports pxr once Isaac Sim is up.
"""
import glob
import json
import math
import os
import subprocess
import sys

failures = []


def fail(name, what):
    failures.append(f'{name}: {what}')
    print(f'  FAIL {what}', flush=True)


def ok(what):
    print(f'  ok   {what}', flush=True)


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


def roll_pitch(q):
    """Roll and pitch from a wxyz quaternion."""
    w, x, y, z = q
    roll = math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y))
    pitch = math.asin(max(-1.0, min(1.0, 2 * (w * y - z * x))))
    return roll, pitch


def load(root):
    worlds = []
    for smoke in sorted(glob.glob(os.path.join(root, '*.smoke.json'))):
        spec = json.load(open(smoke))
        bundle = smoke[: -len('.smoke.json')]
        worlds.append((os.path.basename(bundle), spec, os.path.join(bundle, spec['file'])))
    return worlds


def inspect(name, spec, path):
    """What the file promises, read back through USD."""
    from pxr import Usd, UsdGeom, UsdPhysics, UsdUtils

    print(f'\n== {name} ({spec["terrain"]["kind"]}): the stage', flush=True)
    stage = Usd.Stage.Open(path)
    if not stage:
        return fail(name, 'the stage did not open')
    _layers, _assets, unresolved = UsdUtils.ComputeAllDependencies(path)
    if unresolved:
        fail(name, f'unresolved references: {", ".join(unresolved)}')
    else:
        ok('every reference resolves')
    if stage.GetDefaultPrim().GetName() != 'World' or UsdGeom.GetStageUpAxis(stage) != 'Z' or UsdGeom.GetStageMetersPerUnit(stage) != 1:
        fail(name, 'the stage is not Z up in meters with /World as its default prim')
    if not any(p.IsA(UsdPhysics.Scene) for p in stage.Traverse()):
        fail(name, 'no physics scene')
    if not (stage.HasAuthoredTimeCodeRange() and stage.GetStartTimeCode() < stage.GetEndTimeCode()):
        # Isaac Sim 6 loops such a stage over one frame when Play is pressed.
        fail(name, 'no time-code range: Isaac Sim 6 would play a single frame over and over')
    ground = UsdGeom.Mesh(stage.GetPrimAtPath('/World/Ground/mesh'))
    if not ground:
        fail(name, 'no ground mesh')
    else:
        ok(f'ground mesh of {len(ground.GetPointsAttr().Get())} points')
    for o in spec['objects']:
        prim = stage.GetPrimAtPath(f'/World/{o["id"]}')
        if not o['placed']:
            if prim:
                fail(name, f'{o["id"]} was to be left out but is in the stage')
            continue
        if not prim:
            fail(name, f'no prim for {o["id"]}')
            continue
        mesh = UsdGeom.Mesh(prim.GetChild('mesh'))
        if not mesh or not mesh.GetPointsAttr().Get():
            fail(name, f'{o["id"]} has no mesh')
        if o['free'] != prim.HasAPI(UsdPhysics.RigidBodyAPI):
            fail(name, f'{o["id"]} is {"not " if o["free"] else ""}a rigid body')
        if (o['collision'] != 'none') != bool(mesh and mesh.GetPrim().HasAPI(UsdPhysics.CollisionAPI)):
            fail(name, f'{o["id"]} collision is not as placed ({o["collision"]})')
    ok(f'{sum(1 for o in spec["objects"] if o["placed"])} props as placed')
    for r in spec['robots']:
        prim = stage.GetPrimAtPath(f'/World/{r["id"]}')
        if not r['placed']:
            if prim:
                fail(name, f'{r["id"]} was to be left out but is in the stage')
            continue
        if not prim:
            fail(name, f'no prim for robot {r["id"]}')
            continue
        root = next((p for p in Usd.PrimRange(prim) if p.HasAPI(UsdPhysics.ArticulationRootAPI)), None)
        joints = [p for p in Usd.PrimRange(prim) if p.IsA(UsdPhysics.Joint)]
        if root is None:
            fail(name, f'robot {r["id"]}: its reference brings in no articulation')
        else:
            ok(f'robot {r["id"]} comes in with {len(joints)} joints, articulated at {root.GetPath()}')
    try:
        from pxr.UsdUtils.complianceChecker import ComplianceChecker
    except ImportError:
        print('  (this pxr has no compliance checker; skipped)')
        return
    checker = ComplianceChecker(arkit=False, skipARKitRootLayerCheck=True, rootPackageOnly=False, skipVariants=False, verbose=False)
    checker.CheckCompliance(path)
    problems = checker.GetErrors() + checker.GetFailedChecks()
    if problems:
        fail(name, f'usdchecker: {"; ".join(p.strip() for p in problems)[:600]}')
    else:
        ok('usdchecker finds nothing wrong')


def play(worlds):
    """Each stage played in Isaac Sim, headless, as opened from the file."""
    from isaacsim import SimulationApp

    print('\nStarting Isaac Sim...', flush=True)
    app = SimulationApp({'headless': True})
    try:
        # Only now: Kit's own pxr, loaded after Kit (see the module docstring).
        # Isaac Sim 6 keeps World and isaacsim.core.prims in extsDeprecated, so
        # this presses play on the timeline, which is what File > Open, Play
        # does, and reads poses through the current prims API.
        import time

        import isaacsim.core.experimental.utils.stage as stage_utils
        import numpy as np
        import omni.timeline
        from isaacsim.core.experimental.prims import Articulation, XformPrim
        from pxr import Usd, UsdPhysics

        timeline = omni.timeline.get_timeline_interface()

        def run_until(t, limit=180):
            """Advances the timeline a frame per update until its clock reads t seconds."""
            end = time.time() + limit
            while timeline.get_current_time() < t:
                app.update()
                if time.time() > end:
                    return False
            return True

        for name, spec, path in worlds:
            print(f'\n== {name} ({spec["terrain"]["kind"]}): played in Isaac Sim', flush=True)
            terrain = spec['terrain']
            opened, stage = stage_utils.open_stage(os.path.abspath(path))
            if not opened or stage is None:
                fail(name, 'the stage did not open in Isaac Sim')
                continue
            app.update()
            timeline.play()
            if not run_until(3.0):
                fail(name, f'the timeline stalled at {timeline.get_current_time():.2f} s')
                timeline.stop()
                continue
            tracked = {}
            for o in spec['objects']:
                if o['placed']:
                    tracked[o['id']] = (o, XformPrim(f'/World/{o["id"]}'))
            for r in spec['robots']:
                if not r['placed']:
                    continue
                root = next((p for p in Usd.PrimRange(stage.GetPrimAtPath(f'/World/{r["id"]}')) if p.HasAPI(UsdPhysics.ArticulationRootAPI)), None)
                if root is None:
                    continue
                art = Articulation(str(root.GetPath()))
                if not art.is_physics_tensor_entity_valid():
                    fail(name, f'robot {r["id"]}: PhysX made no articulation of {root.GetPath()}')
                else:
                    ok(f'robot {r["id"]} is an articulation of {art.num_dofs} DOFs in PhysX')
                tracked[r['id']] = (r, art)
            pose = lambda view: np.asarray(view.get_world_poses()[0].numpy()[0], dtype=float)  # noqa: E731
            before = {k: pose(v) for k, (_, v) in tracked.items()}
            run_until(4.0)
            for key, (item, view) in tracked.items():
                p = pose(view)
                moved = float(np.max(np.abs(p - before[key])))
                if 'edge' in item:
                    if not item['free']:
                        if np.max(np.abs(p - np.array(item['xyz']))) > 1e-3:
                            fail(name, f'fixed {key} is at {p.round(3)}, placed at {item["xyz"]}')
                        else:
                            ok(f'{key} stays where it was placed')
                        continue
                    if item['collision'] == 'none':
                        continue
                    if item.get('slide'):
                        judge_slide(name, item, float(np.hypot(p[0] - item['xyz'][0], p[1] - item['xyz'][1])))
                        continue
                    if moved > 0.01:
                        fail(name, f'{key} is still moving {moved * 1000:.0f} mm/s after 4 s')
                    elif item.get('probe'):
                        if abs(p[2] - item['ground']) > 0.08:
                            fail(name, f'{key} landed at z = {p[2]:.3f} m where the file has the ground at {item["ground"]:.3f} m')
                        else:
                            ok(f'{key} finds the ground at z = {p[2]:.3f} m (file: {item["ground"]:.3f} m)')
                    elif not resting(p[2], item['ground'], item['edge']):
                        fail(name, f'{key} rests at z = {p[2]:.3f} m where the ground is at {item["ground"]:.3f} m')
                    else:
                        ok(f'{key} rests on the ground: z = {p[2]:.3f} m, ground {item["ground"]:.3f} m')
                else:
                    if p[2] < item['ground'] - 0.05:
                        fail(name, f'robot {key} sank to z = {p[2]:.3f} m, below the ground at {item["ground"]:.3f} m')
                    elif p[2] > item['ground'] + 1:
                        fail(name, f'robot {key} floats at z = {p[2]:.3f} m over ground at {item["ground"]:.3f} m')
                    else:
                        ok(f'robot {key} stands at z = {p[2]:.3f} m, ground {item["ground"]:.3f} m')
            # The drive: every wheel told the rate, as a velocity controller would set it.
            t = 4.0
            for key, (item, view) in tracked.items():
                if 'edge' in item or not item.get('drive'):
                    continue
                spec_drive = item['drive']
                before = pose(view)
                n = view.num_dofs
                # The URDF importer leaves the wheels' drives with almost no damping, so a velocity target
                # barely bites; PlastikCAD's own USD writer sets effort over rated speed. Set that here.
                view.set_dof_gains(stiffnesses=[[0.0] * n], dampings=[[0.08 / 20.94] * n])
                view.set_dof_velocity_targets([[spec_drive['wheelRate']] * n])
                t += spec_drive['seconds']
                run_until(t)
                view.set_dof_velocity_targets([[0.0] * n])
                t += 0.5
                run_until(t)
                positions, orientations = view.get_world_poses()
                after = np.asarray(positions.numpy()[0], dtype=float)
                roll, pitch = roll_pitch(np.asarray(orientations.numpy()[0], dtype=float))
                judge_drive(name, item, terrain, before, after, roll, pitch)
            timeline.stop()
            app.update()
            stage_utils.close_stage()
    except BaseException:
        import traceback
        traceback.print_exc()
        failures.append('the play pass crashed (traceback above)')
    # Kit's fast shutdown ends the process inside close(), so the verdict goes out first.
    code = report(len(worlds))
    sys.stdout.flush()
    sys.stderr.flush()
    app.close()
    sys.exit(code)


def report(count):
    print()
    if failures:
        print(f'{len(failures)} failure(s):')
        for f in failures:
            print('  ' + f)
        return 1
    print(f'all {count} world(s) hold up in Isaac Sim')
    return 0


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    root = args[0] if args else 'fixtures/out/isaac'
    worlds = load(root)
    if not worlds:
        print(f'no bundles under {root}: run pnpm smoke:fixtures first')
        sys.exit(1)
    sim = '--no-sim' not in sys.argv
    try:
        import isaacsim  # noqa: F401
    except ImportError:
        sim = False
    if sim:
        # The pxr pass in a child, so this process meets pxr only after Kit is up.
        child = subprocess.run([sys.executable, '-u', __file__, root, '--no-sim'])
        if child.returncode:
            failures.append(f'the stage checks failed (exit {child.returncode})')
        play(worlds)
    else:
        try:
            import pxr  # noqa: F401
        except ImportError:
            print('pxr is not installed: pip install usd-core (a venv is fine), or run this with Isaac Sim\'s Python.')
            sys.exit(2)
        for name, spec, path in worlds:
            inspect(name, spec, path)
        if '--no-sim' not in sys.argv:
            print('\nisaacsim is not installed: the stages were checked but not played.')
        sys.exit(report(len(worlds)))


if __name__ == '__main__':
    main()
