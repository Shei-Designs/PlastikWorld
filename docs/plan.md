# Plan: building out the PlastikWorld roadmap

Written 2026-11-01 from the roadmap agreed the same day (README, handoff
§7). The order follows the roadmap with one change: a foundations phase
comes first, because the world file, the worlds folder and the Android
shell shape every phase after them, and retrofitting them is the expensive
way round. Each phase ends in something that can be run and checked before
the next starts: unit tests in vitest, the three engine smoke tests over
the fixture worlds, a look in the browser build, and from phase 1 on, the
app on the Android tablet.

Sizes are rough: S is a session, M a few sessions, L a week or more of
sessions.

## Android, kept in sight from the start

PlastikWorld ships on Android like PlastikCAD, so every phase carries an
"on the tablet" acceptance line. What Android changes, learned from
PlastikCAD:

- **No paths.** The picker hands over one document at a time as a content
  URI; nothing can be re-read by path later. So a world cannot keep its
  assets by reference: on import, a GLB or a robot package is copied into
  the worlds folder and the world refers to the copy. Desktop keeps the
  original path too, for re-import after a PlastikCAD re-export.
- **Worlds live in the app's own storage**, exports go to the app's folder
  in Downloads and the share sheet (a zip of the bundle), as PlastikCAD
  does through its `device` plugin, which is lifted whole
  (`src-tauri/plugins/device`, Kotlin: pick documents, create documents,
  share, keyboard state).
- **No engines on the device.** Export and share; the smoke tests stay on
  the desktop. The demo drive is the on-device check that the world fits.
- **Memory and GPU.** A 1025 grid is a million-vertex ground mesh and is
  fine on the RTX; the tablet gets 513 by default, 1025 allowed with the
  same warning desktop gives at 2049. Heavy terrain work (resampling,
  DEM decoding, GLB export of the whole scene) goes to a worker, lifted
  from PlastikCAD's `src/worker/` pattern, so the UI thread never stalls.
- **Touch.** The viewer's camera and touch handling are PlastikCAD's
  already: one finger drags or orbits, two fingers pan and zoom. Tools that
  paint (sculpting, surfaces) take the one-finger gesture while active;
  two fingers still move the camera. On-screen controls for the demo drive.
- **Layout.** The window minimum is 1200 px today and the sidebar is
  always open. Under about 1100 px the sidebar and the inspector become
  drawers, and `pointer: coarse` already enlarges targets. Keyboard
  shortcuts stay optional: everything reachable by tap, as PlastikCAD's
  `inputMode.ts` arranges (hardware keyboard or not, keypad height).
- **Network only where it is the feature**: fetching elevation tiles.
  Everything else works offline, on a plane.
- **Build.** `pnpm tauri android init` regenerates `src-tauri/gen/android`
  (never committed: PlastikCAD's is 600 MB of build output); CI builds the
  APK beside the desktop bundles; signing and the Play listing are the last
  phase, copied from PlastikCAD's release notes.

The toolchain is on this machine already (Android SDK, NDK 26, the four
Rust Android targets), so phase 1 can start the Android build directly.

## Phase 1. Foundations (M)

The file model and the shell everything else sits on. **Done 2026-11-01**,
with one change of plan: Andrew asked for PlastikCAD's project model, so a
world is one self-contained file with its assets and heights embedded, rather
than copies in a folder beside it, and there is no Save (autosave, Ctrl+S
writes now, "Open world file…" imports a copy, "Save a copy…" exports). The
heights are Float32 meters inside the JSON, not a sidecar PNG. Still open from
this phase: PlastikCAD's entry sheet for number boxes when there is no
keyboard (`inputMode.ts`), and the Drive sync itself (its engine is written
to the same world store interface, so it lifts in a phase of its own).

1. **World file v2.**
   - Assets by copy: `~/Documents/PlastikCAD Worlds/Assets/<name>/` holds
     imported GLBs and robot package folders; `Source` gains the copy's
     relative path and keeps `path` for desktop re-import. v1 worlds
     migrate on open by copying what they reference.
   - Terrain grid snaps to 2^n + 1 (65, 129, 257, 513, 1025; 2049 with a
     warning) and `heightmap.ts` loses `gazeboSize` resampling on the
     Gazebo side. The terrain inspector shows area, spacing and the sample
     count, and the user edits any two.
   - Heights past 129 square move to a 16-bit PNG beside the world file
     (`<world>.heights.png`), inline JSON below that. `png.ts` writes it
     already; a reader comes in phase 4 and is needed here for opening, so
     the 16-bit PNG decoder (zlib through `DecompressionStream`, which the
     Android WebView has) lands in this phase.
   - `heights` becomes a `Float32Array` in memory, meters, not 0..1 of a
     height; the file keeps 16-bit normalised with min and max in the
     JSON. Writers stop multiplying.
2. **Android shell.** `pnpm tauri android init`, the `device` plugin
   lifted, `isAndroid()` branches in `platform.ts` (pick, save, export to
   the app folder, share), `inputMode.ts` lifted, drawers under 1100 px,
   launcher icons from `docs/brand/icon.json`, an APK job in CI.
3. **Exports on Android**: the bundle written to the app's Downloads
   folder and offered on the share sheet as a zip.

Checks: unit tests for snapping, migration, the PNG round trip and the
Float32 heights; the three smoke tests green with the new file; the APK
installs on the tablet, opens a world made on the desktop (copied over),
imports a GLB from the Files app, exports and shares a zip.

## Phase 2. Drive the robots from the smoke tests (M)

Roadmap item 1. Independent of the app code, so it can run in parallel
with phase 1. **Done 2026-11-01**: all three engines drive the rovers on
the flat yard and up the hills; the Gazebo launch file now starts the ROS
bridge for each package.

- Gazebo: for a ROS package robot, publish `cmd_vel` through the bridge
  the package's launch file sets up; for an SDF model, `gz topic -p`. For
  a MuJoCo model, set `data.ctrl` on its actuators. Isaac: PlastikCAD's
  `smoke:usd` drives its stages over ROS 2; lift that path.
- Assert in all three: on Smoke Flat the rover advances at least 1 m in
  3 s along its heading; on Smoke Hills it climbs, stays upright and does
  not fall through. The fixture worlds gain a `drive` block per robot
  (topic or actuator names, expected speed) read by the smoke scripts.
- Whatever this finds in the writers (spawn pose, launch file, bridge
  config) is fixed in this phase.

Checks: the smoke tests themselves, run on all three.

## Phase 3. Terrain sculpting (M)

**Done 2026-11-01**: `src/terrain/brush.ts` (five brushes, four seeded
field kinds), the viewer's sculpt mode with a ray-marched ground pick and
in-place vertex updates, one undo step per stroke, the hills fixture
sculpted with a mound and a terrace and run through the three engines.

- Brush tools in the viewer: raise, lower, smooth, flatten to the height
  under the brush, set to a given height; size and strength; a falloff.
  Brush math in `src/terrain/brush.ts` on the Float32 grid, pure and
  tested.
- The ground mesh updates in place per stroke (position attribute of the
  touched rows only, normals recomputed for that window), no rebuild.
- Undo per stroke through the existing gesture (`beginGesture`,
  `endGesture`), one history entry a stroke.
- Noise fields (rolling, ridged, craters) as a "generate" step with a
  seed, applied to the whole grid or under the brush.
- Touch: one finger paints while a brush is chosen; two fingers orbit.

Checks: unit tests for every brush on a small grid (volume conserved by
smooth, flatten converges, bounds respected); a sculpted fixture world
added to `fixtures.test.ts` and run through the three smoke tests; the
brush on the tablet with a finger and with a stylus.

## Phase 4. Heightmap image import (S)

**Done 2026-11-02**: a PNG reader of its own (`io/png.ts`, every colour
type and depth, not interlaced), other images through the browser, the
import dialog with the grid, the area and the black and white heights, and
a round-trip test against the image the Gazebo writer emits.

- Open an 8 or 16-bit greyscale PNG (the decoder from phase 1), ask for
  the area and the height range, resample to the snapped grid.
- Colour PNGs are read as luminance; non-square images stretch to the
  grid with a note.

Checks: round trip of the writer's own PNG; a 16-bit fixture; the Gazebo
heightmap a user already has imported and exported back within a sample.

## Phase 5. Elevation import (L)

Two steps so the first works offline and on Android.

1. **A GeoTIFF the user has** (USGS 3DEP, SRTM, Copernicus DEM tiles are
   all GeoTIFFs): `geotiff.js` reads it from bytes in a worker; the user
   picks a box on a preview of the tile; the box is projected to a local
   tangent plane in meters at its centre (good to well under a percent
   over a few kilometres) and resampled to the grid. No-data cells filled
   from neighbours.
2. **Pick a place**: a map picker and tiles fetched from an open source
   (Copernicus DEM on AWS Open Data as cloud-optimised GeoTIFFs, range
   requests through `geotiff.js`; USGS 3DEP through The National Map).
   Network only here, with a plain message when offline.

Checks: a synthetic GeoTIFF fixture with a known ramp; a real tile of a
known place against published spot heights; both on the tablet from the
Files app.

## Phase 6. Surfaces (M)

- The world gains `materials` (name, friction, restitution, colour,
  texture) and the terrain gains `zones` (a rectangle in terrain
  coordinates and a material); the terrain itself keeps a base material.
- Writers: Isaac binds a material per face subset. Gazebo and MuJoCo have
  one friction per collision, so each zone becomes its own ground
  collision. Two ways to cut it, settled by the smoke tests in this phase:
  tile the grid along zone edges (clean, but the remainder is not a
  rectangle, which MuJoCo heightfields must be), or lay each zone as a
  heightfield patch a millimetre proud of the base (simple, every engine
  takes it, the step is below contact tolerance). Start with the patch.
- The viewer paints zones as a splat over the ground; a zone tool draws
  and resizes rectangles; free-form zones are left for later.

Checks: unit tests on the writers; a smoke fixture with an icy zone and a
rubber zone on the same slope, probes sliding a different distance on
each in all three engines.

## Phase 7. Parts library (L)

- A library index (`library/index.json`: id, name, category, tags, a
  thumbnail, the GLB, collision hint, physics defaults) shipped with the
  app; small GLBs, a size budget of about 20 MB so the APK stays
  reasonable, more packs downloadable later.
- Fixed pieces modelled in PlastikCAD and exported as packages: doors,
  tables, shelves, pallets, boxes, cones, curbs, lamp posts, barriers,
  trees, rocks, bridge spans, parking line decals.
- Parametric pieces generated in the app, in `src/parts/`: wall run (length,
  height, thickness, openings), floor and ceiling slabs, ramp, stairs,
  fence run, road segment. They produce `MeshData` and export like any
  mesh; collision is the mesh for runs and a box for slabs.
- A library panel: categories, search, thumbnails, tap to place or drag
  into the viewport; placed parts remember their library id so a pack
  update can re-link them.
- Buildings: a "room" helper that lays four wall runs and a slab from a
  rectangle; doors cut openings. Parking lot: a flatten-zone action plus
  asphalt surface, curbs and line decals.

Checks: every library item loads, has a collision, lands at z = 0 in the
smoke tests; unit tests for the parametric generators (dimensions,
watertight, openings subtract); a building fixture world with a robot
driving through a doorway in phase 2's drive test; the panel on the tablet.

## Phase 8. Demo drive (M)

- Kinematic only. The user picks a placed robot, a drive model
  (differential, Ackermann, holonomic; later read from the package's
  `controllers.yaml` when PlastikCAD wrote one) and goes: WASD and arrows,
  a gamepad through the Gamepad API, an on-screen stick and pedals on
  touch.
- The robot follows the ground by `heightAt` plus a ray against static
  props, tilts to the slope, stops at a bounding-box hit with a prop or a
  wall and says what it hit; a follow camera; a trail.
- Not saved in the world beyond the chosen drive model per robot.

Checks: unit tests for the three kinematic models and the collision stop;
driving through the phase 7 building on the tablet with the on-screen
stick and on the desktop with a gamepad.

## Phase 9. Sky, lighting, fog and wind (S)

- World fields `sky` (preset, sun elevation and azimuth driving the sun
  light), `fog` (colour, start, end) and `wind` (a vector).
- Writers: Gazebo's `<scene>` sky and fog and the wind effects system;
  MuJoCo's `wind` option, no fog; Isaac's dome light and render fog, a
  note that it has no wind.
- The viewer draws the sky and fog.

Checks: writer unit tests; a smoke fixture with a light box in a 10 m/s
wind that moves in Gazebo and MuJoCo and stays put in Isaac with the note.

## Phase 10. Release surface (M)

- Launch the simulator from the app on desktop (`gz sim`, the MuJoCo
  viewer, Isaac through its Python) with the exported bundle.
- Worlds browser thumbnails (a render of the viewer on save).
- A GLB of the whole scene for Blender.
- Android release: signing, Play listing, the feature graphic from the
  brand script, as PlastikCAD's release notes describe.

## Parked

Rain and snow (no engine), water (Gazebo only, buoyancy and hydrodynamics
plugins), free-form surface zones, downloadable part packs.
