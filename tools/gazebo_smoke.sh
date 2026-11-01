#!/usr/bin/env bash
# Runs the sample worlds' Gazebo bundles through a real Gazebo Harmonic (with
# ROS 2 Jazzy and ros_gz for the launch files), in Docker. Needs the bundles
# written first:
#   pnpm smoke:fixtures
#   tools/gazebo_smoke.sh [fixtures/out/gazebo]
# The image is PlastikCAD's (../Quick_CAD/tools/ros, built by its ros_smoke.sh):
# it is built here when missing, from that folder, so the two apps share one.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=$(cd "${1:-fixtures/out/gazebo}" && pwd)
image=plastikcad-ros:jazzy
if ! docker image inspect "$image" >/dev/null 2>&1; then
  context="${PLASTIKCAD_DIR:-$here/../../Quick_CAD}/tools/ros"
  echo "Building $image from $context..."
  docker build -t "$image" "$context"
fi
exec docker run --rm -e ROS_DOMAIN_ID=42 -v "$out:/out:ro" -v "$here:/tools:ro" "$image" \
  bash -c "source /opt/ros/jazzy/setup.bash && python3 /tools/gazebo_smoke.py /out"
