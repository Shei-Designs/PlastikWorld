# Handoff: PlastikWorld, the world app beside PlastikCAD

Written 2026-11-01 for whoever starts the companion app, since named PlastikWorld. It says what the
app is for, what PlastikCAD hands it, what it must hand the simulators, and
what was decided already. Nothing here is built; it is a brief, not a spec.

## 1. Why a separate app

PlastikCAD builds components and assemblies of components: parts to print,
robots to simulate, objects to animate. It is deliberately not a physics
engine and not an environment editor. Its test drive is a sanity check
before the robot goes to a real simulator, its exports always stand the
robot on a flat floor, and when a simulator demands a world file (Gazebo
does) PlastikCAD writes a flat plane and nothing else.

Building a world is a different job with different tools: placing many
objects, terrain, lights, spawn points, physics properties of the ground,
and writing the result for each engine's own scene format. Andrew's decision
(2026-11-01) is to keep that out of PlastikCAD and make a focused companion
app for it. The split: PlastikCAD makes the things (a staircase, a table, a
robot), PlastikWorld places them and describes the scene.

Audience: the same as PlastikCAD's. People doing rapid prototyping on open
source tools (ROS 2, Gazebo, MuJoCo, Isaac Sim, Blender) who want one
pipeline instead of five apps.

## 2. What PlastikCAD hands over

Everything is millimeters and Z up inside PlastikCAD; exports convert.

- **Static objects** (props, furniture, a staircase): GLB (meters, Y up, as
  glTF wants, colors and textures embedded), OBJ with its `.mtl` (mm), STL
  (mm), 3MF (mm, colors). GLB is the right one to import: units are known,
  colors come along, every object stays separate.
- **Robots**: a ROS 2 package zip (URDF, xacro, OBJ visual meshes, STL
  collision meshes, launch files, `config/bridge.yaml`,
  `config/controllers.yaml`, an RViz layout, `worlds/<name>.sdf` which is
  the flat stand-in world); a Gazebo model folder (`model.sdf`, meshes,
  the same stand-in world); a MuJoCo model (one MJCF with meshes beside it,
  optional Python starters). All in meters, Z up, every link frame parallel
  to the design axes. A driven robot's root is `base_footprint`, facing +X
  as ROS expects.
- **The design file** `.plastikcad` (JSON, `format: "plastikcad"`,
  `version` 2): the scene as shapes, parts and operations rather than
  triangles, plus the robot description under `robot`. PlastikWorld
  should not need to read it; GLB and the robot packages are the interface.
  If it ever does, `src/model/file.ts` in the PlastikCAD repo is the reader.

PlastikCAD's own repo: `github.com/Shei-Designs/PlastikCAD`. The export
writers live in `src/io/` (`gltf.ts`, `urdf.ts`, `sdf.ts`, `gazebo.ts`,
`mjcf.ts`, `rosPackage.ts`) and `src/robot/export.ts`; read them before
deciding how PlastikWorld imports a robot.

## 3. What PlastikWorld must hand the simulators

One scene, written for each engine in its own terms:

- **Gazebo (Harmonic or later, `gz sim`)**: an SDF world: `<world>` with
  physics, the sensor and contact systems, lights, a ground (plane or
  `<heightmap>` from an image), static `<model>`s for props (mesh or box
  collisions, surface friction), and `<include>` of the robot model by
  `model://` URI with a `<pose>`. PlastikCAD's `src/io/gazebo.ts`
  `worldXml()` is the minimal working world to start from.
- **MuJoCo**: an MJCF with the props as static geoms (mesh, box, or an
  `hfield` for terrain) and the robot brought in with `<include>` or by
  attaching its model; `src/io/mjcf.ts` in PlastikCAD shows a working
  floor, hfield, slope and the steps/ramp blocks (`worldBlocks`).
- **Isaac Sim**: a USD stage. The robot comes in through Isaac's URDF
  importer (the ROS package), so PlastikWorld's job is the stage
  around it: ground, props as USD meshes with collision, lights, and a
  reference to the imported robot. Writing USD from TypeScript is not
  solved; options are a Python side using `pxr` (Isaac's own Python), or
  writing USDA text by hand (it is a text format). PlastikCAD's
  `tools/isaac_smoke.py` is a working example of driving Isaac headless
  and importing a package with the right base type, drive gains and camera
  clip.
- **Blender** (for animation): a GLB of the whole scene, props and robot
  posed; or nothing, since Blender reads GLB from PlastikCAD already.

Known engine gaps to design around: Gazebo wants a heightmap image on disk
for terrain, MuJoCo wants the heights inline, Isaac wants USD. Terrain is
the first place the formats diverge, so decide early whether terrain is a
heightmap (one source, three writers) or built from placed blocks.

## 4. Decisions already taken

- Companion, not a mode: a separate app, its own repo and product colour
  under the Shei Designs rules (the design system is at
  `~/Documents/AOShei_Web_Sites/apps/sheidesigns.com/design-reference/`,
  `PRODUCTS.md` for the per-product icon and colour rules; PlastikCAD is
  Filament teal `#17CDD3`, the new app needs a colour of its own from the
  register there).
- PlastikCAD stays flat: no terrain, no world authoring, no engine-specific
  scene settings will be added to it. Objects like stairs are modeled in
  PlastikCAD and placed in PlastikWorld.
- One robot per PlastikCAD project (one base link). A world with several
  robots takes several packages.
- Same stack is the easy choice, not a requirement: Tauri 2, Vite, React 19,
  three.js for the viewport, vitest. PlastikCAD's viewer (`src/viewer/`)
  draws markers, axis arrows and align dots; its camera controls and touch
  handling are worth lifting rather than redoing.
- Andrew runs the apps on Linux and on an Android tablet; a desktop-first
  PlastikWorld is fine, but do not design anything that cannot work in a
  webview.

## 5. Open questions for the first session

1. Which engine first? Gazebo is where the ROS package already runs and has
   a verified smoke test in PlastikCAD (`tools/ros_smoke.py`, Docker). MuJoCo
   is the simplest format. Isaac is the hardest to write.
2. What is a "world" in the app's own file: a list of placed assets with
   poses and physics tags, a terrain, lights, spawn points. Keep it
   engine-neutral and small; the writers do the translation.
3. Import by reference or by copy? By reference (the GLB or package path)
   keeps the world light and lets PlastikCAD re-export; by copy makes the
   world self-contained for sharing.
4. How the user gets a PlastikCAD object into the world: file open, drag
   from a folder, or a shared parts bin (PlastikCAD keeps custom parts in a
   `Parts/` folder beside its projects and syncs them to Google Drive).
5. Whether the app also launches the simulator (`gz sim world.sdf`,
   `python -m mujoco.viewer`) or stops at writing the files.

## 6. How PlastikCAD's smoke tests can help

`pnpm smoke:robots`, `pnpm smoke:ros` and `pnpm smoke:isaac` in the
PlastikCAD repo export four reference robots (rover, car, quadruped, arm)
and run them in MuJoCo, in ROS 2 Jazzy and Gazebo (Docker), and in Isaac
Sim. The exported packages land in `fixtures/out/`. They are ready-made
robots for PlastikWorld to place and test with, and the smoke scripts
show how each simulator is launched headless and checked.

## 7. Decided in the second session (2026-11-01, evening)

Added after the bootstrap, once the first exports had run in all three
engines. The README's Roadmap carries the order; this is the reasoning.

- **Name: PlastikWorld.** Plastik is the family mark and stays on every
  product in it, whatever the house convention for one-word names
  elsewhere; PlastikBox and PlastikENV were the other candidates. The app
  is bundled with PlastikCAD. Colour: Terrain green `#19DC5A`, confirmed.
- **Terrain is made here.** Sculpting, heightmap images and real elevation
  (GeoTIFF/DEM) are the three sources. No terrain mesh import, from
  PlastikCAD or Blender: PlastikCAD is for objects, and the workflow is a
  terrain first, then objects on it (a valley plus a bridge object, not a
  bridge carved into the ground).
- **Grid size, lowest common denominator.** Gazebo needs 2^n + 1 samples a
  side and reads a heightmap image; Isaac gets a triangle mesh, which is
  the real ceiling (a 4097 grid is 33 million triangles). So the grid snaps
  to 65 … 1025, 2049 with a warning, all three engines get identical
  samples, and the user trades area against spacing in the app.
- **Surfaces matter.** Isaac can bind materials per triangle; Gazebo and
  MuJoCo have one friction per collision, so zones become separate ground
  collisions in those two. Rectangular zones first (MuJoCo heightfields are
  rectangles), free-form later.
- **Features:** a generic parts library (indoor and outdoor; fixed pieces as
  bundled PlastikCAD packages, runs and slabs parametric in-app), a
  kinematic demo drive for checking fit before export, buildings and
  parking lots assembled from parts on the terrain.
- **The line.** Features are what all three engines read. Wind is the one
  weather element with physics in two of them (Gazebo, MuJoCo); fog, sky
  and time of day are rendering for cameras and lidar; rain and snow exist
  in no engine; water is Gazebo only. Anything one engine does alone is an
  opt-in that exports with a note elsewhere.
