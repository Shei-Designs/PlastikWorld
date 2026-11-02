#!/usr/bin/env python3
"""Runs the sample worlds' Gazebo bundles through Gazebo Harmonic and says
whether the world the engine builds is the one the file describes.

Meant to run inside PlastikCAD's tools/ros Docker image (tools/gazebo_smoke.sh
does that), over the folder pnpm smoke:fixtures writes:

    python3 gazebo_smoke.py <dir of bundles, each with a .smoke.json beside it>

For every bundle: gz sdf -k must accept the world; the world runs headless,
through its launch file when it has one (a ROS package robot is spawned by
ros_gz_sim) or straight in gz sim; every placed prop and robot must appear;
after settling, a fixed prop must not have moved, a free prop must rest on the
ground at the height the file gives it (a heightmap written upside down lands
it a hill away), and a robot must stand on the ground. Then each robot is
driven forward for a few seconds, a ROS package robot with a Twist on
/cmd_vel through the bridge its launch file starts, a Gazebo model with the
same message on the gz topic: it must cover the distance along its heading,
stay upright and on the ground, and climb when it starts on a slope. Exits
non-zero on any failure, and reports the [Err] lines Gazebo printed on the way.

The process handling and the pose reading are lifted from PlastikCAD's
tools/ros_smoke.py, so the two smoke tests behave alike.
"""
import glob
import json
import math
import os
import re
import signal
import subprocess
import sys
import time

failures = []


def fail(name, what):
    failures.append(f'{name}: {what}')
    print(f'  FAIL {what}', flush=True)


def ok(what):
    print(f'  ok   {what}', flush=True)


def run(cmd, timeout=60, env=None):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)


def gz_pose(model, timeout=10):
    """The model's pose in Gazebo: (x, y, z, roll, pitch, yaw), or None."""
    try:
        r = run(['gz', 'model', '-m', model, '-p'], timeout=timeout)
    except subprocess.TimeoutExpired:
        return None
    nums = re.findall(r'\[([-\d.e+ ]+)\]', r.stdout)
    rows = [[float(v) for v in n.split()] for n in nums if len(n.split()) == 3]
    if len(rows) >= 2:
        return tuple(rows[0] + rows[1])
    return None


def wait_for(predicate, timeout, step=0.5):
    end = time.time() + timeout
    while time.time() < end:
        value = predicate()
        if value:
            return value
        time.sleep(step)
    return None


class Launched:
    """A launch file or gz server running in its own process group, with its output in a log."""

    def __init__(self, cmd, log, env=None, cwd=None):
        self.log = open(log, 'w')
        self.proc = subprocess.Popen(cmd, stdout=self.log, stderr=subprocess.STDOUT, env=env, cwd=cwd, preexec_fn=os.setsid)
        self.path = log

    def stop(self):
        try:
            os.killpg(self.proc.pid, signal.SIGINT)
            self.proc.wait(15)
        except (subprocess.TimeoutExpired, ProcessLookupError):
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        self.log.close()
        # Gazebo leaves its server behind when the launch is interrupted.
        subprocess.run(['pkill', '-9', '-f', 'gz sim'], capture_output=True)
        subprocess.run(['pkill', '-9', '-f', 'ruby'], capture_output=True)
        time.sleep(1)

    def errors(self):
        with open(self.path, errors='replace') as f:
            text = f.read()
        lines = [l for l in text.splitlines() if '[Err]' in l or 'ERROR' in l or ('error' in l.lower() and 'no error' not in l.lower())]
        noise = ('XDG_RUNTIME_DIR', 'libEGL warning', 'Unable to find or download file', 'already exists')
        return [l for l in lines if not any(n in l for n in noise)]


def judge_slide(name, item, travel):
    """A crate set on a surface zone of a slope: on ice it must have slid, on rubber it must have stayed put.
    DART takes the higher of the two frictions that meet, so the fixture may say what Gazebo does instead."""
    if item.get('slideGazebo', item['slide']) == 'must':
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


def drive(name, robot, terrain, env):
    """Drives the robot forward as its package means it to be driven, and judges where it got to."""
    d = robot['drive']
    before = gz_pose(robot['id'])
    if not before:
        return fail(name, f'could not read the pose of robot {robot["id"]} before driving')
    if d['via'] == 'ros':
        # Through ros_gz_bridge, as the package's config/bridge.yaml sets it up and the world's launch file starts it.
        run(['ros2', 'topic', 'pub', '-r', '20', '-t', str(int(d['seconds'] * 20)), d['topic'], 'geometry_msgs/msg/Twist', f"{{linear: {{x: {d['speed']}}}}}"], timeout=d['seconds'] + 60, env=env)
        run(['ros2', 'topic', 'pub', '-1', '-w', '1', d['topic'], 'geometry_msgs/msg/Twist', '{}'], timeout=30, env=env)
    else:
        # Straight onto the DiffDrive system's gz topic.
        end = time.time() + d['seconds']
        while time.time() < end:
            run(['gz', 'topic', '-t', d['topic'], '-m', 'gz.msgs.Twist', '-p', f"linear: {{x: {d['speed']}}}"], timeout=10, env=env)
            time.sleep(0.1)
        run(['gz', 'topic', '-t', d['topic'], '-m', 'gz.msgs.Twist', '-p', 'linear: {x: 0}'], timeout=10, env=env)
    time.sleep(1)
    after = gz_pose(robot['id'])
    if not after:
        return fail(name, f'could not read the pose of robot {robot["id"]} after driving')
    judge_drive(name, robot, terrain, before[:3], after[:3], after[3], after[4])


def check(smoke_path, env):
    spec = json.load(open(smoke_path))
    bundle = smoke_path[: -len('.smoke.json')]
    name = os.path.basename(bundle)
    world_file = os.path.join(bundle, spec['file'])
    print(f'\n== {name} ({spec["terrain"]["kind"]})', flush=True)
    # gz sdf resolves model:// through SDF_PATH; the simulator through GZ_SIM_RESOURCE_PATH.
    r = run(['gz', 'sdf', '-k', world_file], env=dict(env, SDF_PATH=os.path.join(bundle, 'models')))
    if r.returncode:
        fail(name, f'gz sdf -k rejected the world: {r.stderr.strip() or r.stdout[-400:]}')
    else:
        ok('gz sdf -k accepts the world')
    env = dict(env, GZ_SIM_RESOURCE_PATH=os.path.join(bundle, 'models'))
    launch = world_file[: -len('.sdf')] + '.launch.py'
    if os.path.exists(launch):
        cmd = ['ros2', 'launch', launch, 'headless:=true']
    else:
        cmd = ['gz', 'sim', '-s', '-r', '--headless-rendering', world_file]
    launched = Launched(cmd, f'/tmp/{name}.gazebo.log', env=env, cwd=bundle)
    try:
        expected = [o for o in spec['objects'] if o['placed']] + [r for r in spec['robots'] if r['placed']]
        for item in expected:
            pose = wait_for(lambda: gz_pose(item['id']), 90 if item is expected[0] else 30)
            if not pose:
                fail(name, f'"{item["id"]}" did not appear in the world')
            else:
                ok(f'{item["id"]} in the world at z = {pose[2]:.3f} m')
        # A tumbled triangle mesh takes a dozen seconds to come to rest in DART.
        time.sleep(12)
        before = {item['id']: gz_pose(item['id']) for item in expected}
        time.sleep(1)
        after = {item['id']: gz_pose(item['id']) for item in expected}
        for item in expected:
            p0, p1 = before[item['id']], after[item['id']]
            if not p0 or not p1:
                continue
            moved = max(abs(a - b) for a, b in zip(p0[:3], p1[:3]))
            if 'edge' in item:
                if not item['free']:
                    if max(abs(a - b) for a, b in zip(p1[:3], item['xyz'])) > 1e-3:
                        fail(name, f'fixed {item["id"]} is at {p1[:3]}, placed at {item["xyz"]}')
                    else:
                        ok(f'{item["id"]} stays where it was placed')
                    continue
                if item['collision'] == 'none':
                    continue
                if item.get('slide'):
                    judge_slide(name, item, math.hypot(p1[0] - item['xyz'][0], p1[1] - item['xyz'][1]))
                    continue
                if moved > 0.01:
                    fail(name, f'{item["id"]} is still moving {moved * 1000:.0f} mm/s after 13 s')
                elif item.get('probe'):
                    if abs(p1[2] - item['ground']) > 0.08:
                        fail(name, f'{item["id"]} landed at z = {p1[2]:.3f} m where the file has the ground at {item["ground"]:.3f} m')
                    else:
                        ok(f'{item["id"]} finds the ground at z = {p1[2]:.3f} m (file: {item["ground"]:.3f} m)')
                elif not resting(p1[2], item['ground'], item['edge']):
                    fail(name, f'{item["id"]} rests at z = {p1[2]:.3f} m where the ground is at {item["ground"]:.3f} m')
                else:
                    ok(f'{item["id"]} rests on the ground: z = {p1[2]:.3f} m, ground {item["ground"]:.3f} m')
            else:
                if p1[2] < item['ground'] - 0.05:
                    fail(name, f'robot {item["id"]} sank to z = {p1[2]:.3f} m, below the ground at {item["ground"]:.3f} m')
                elif p1[2] > item['ground'] + 1:
                    fail(name, f'robot {item["id"]} floats at z = {p1[2]:.3f} m over ground at {item["ground"]:.3f} m')
                else:
                    ok(f'robot {item["id"]} stands at z = {p1[2]:.3f} m, ground {item["ground"]:.3f} m')
        for item in spec['robots']:
            if item['placed'] and item.get('drive'):
                drive(name, item, spec['terrain'], env)
    finally:
        errs = launched.errors()
        launched.stop()
        if errs:
            print(f'  Gazebo reported {len(errs)} error line(s):')
            for l in errs[:12]:
                print('       ' + l.strip()[:220])
            fail(name, f'{len(errs)} error line(s) in the gz log')


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else 'fixtures/out/gazebo'
    smokes = sorted(glob.glob(os.path.join(root, '*.smoke.json')))
    if not smokes:
        print(f'no bundles under {root}: run pnpm smoke:fixtures first')
        sys.exit(1)
    env = dict(os.environ)
    for smoke in smokes:
        check(smoke, env)
    print()
    if failures:
        print(f'{len(failures)} failure(s):')
        for f in failures:
            print('  ' + f)
        sys.exit(1)
    print(f'all {len(smokes)} world(s) behave in Gazebo')


if __name__ == '__main__':
    main()
