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
it a hill away), and a robot must stand on the ground. Exits non-zero on any
failure, and reports the [Err] lines Gazebo printed on the way.

The process handling and the pose reading are lifted from PlastikCAD's
tools/ros_smoke.py, so the two smoke tests behave alike.
"""
import glob
import json
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


def resting(z, ground, edge):
    """Whether a crate's origin (the middle of its base) sits on the ground, allowing for a slope and a tumble."""
    return ground - 0.05 - 0.25 * edge <= z <= ground + edge + 0.05


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
