# PlastikWorld

The companion app of PlastikCAD, bundled with it (`../Quick_CAD`, its official name is PlastikCAD): PlastikCAD makes objects and robots, this app places them in a world and writes the scene for Gazebo (SDF), MuJoCo (MJCF) and Isaac Sim (USDA). Read `README.md` first, then `docs/plastikworld-handoff.md` for the decisions behind it.

## Rules of the house

- Same stack as PlastikCAD: Tauri 2, Vite 8, React 19, three.js, vitest, pnpm. When a piece exists in PlastikCAD (the viewer's camera and touch handling, `platform.ts`, the XML reader, the Rust file commands), lift it rather than redo it, and say so in a comment.
- Dev server port 1440 (HMR 1441, preview 1442). Never 1430/1431: that is PlastikCAD's, and both run at once.
- Units: meters, kilograms, radians, Z up, everywhere in the world and the writers. PlastikCAD's exports arrive in meters already; GLB is Y up and is turned on load (`io/meshes.ts`).
- The world file stays engine-neutral and small; the writers in `src/io/` do the translation. Terrain is one source (a grid of heights), three writers.
- Brand: Shei Designs rules in `~/Documents/AOShei_Web_Sites/apps/sheidesigns.com/design-reference/` (`DESIGN.md`, `PRODUCTS.md`). This product's colour is Terrain green `#19DC5A` (shade `#0E3E1C`); Tape `#FF6B1A` is the house signal (primary action, unsaved dot) and never tints a surface. Space Grotesk for the product name only. `pnpm brand` redraws the icon and banner.
- Terrain is made in this app (sculpted, from a heightmap image, or from elevation data), never imported as a mesh; objects go on top of it. Grid sizes snap to 2^n + 1 samples a side, 65 to 1025 (2049 with a warning), the one size all three engines take without resampling.
- Features are what all three engines can read. What one engine does alone (Gazebo water, say) exports with a note in the other two, never silently.
- Comments explain why, in plain sentences, as PlastikCAD's do.

## Checks

`pnpm typecheck && pnpm test && pnpm build`, and `cargo test --manifest-path src-tauri/Cargo.toml` after a change on the Rust side.

After a change to a writer, run its export in the real engine: `pnpm smoke:fixtures` writes the sample worlds under `fixtures/out/` (robots from `../Quick_CAD/fixtures/out`), then `pnpm smoke:gazebo` (Docker, PlastikCAD's `plastikcad-ros:jazzy` image), `pnpm smoke:mujoco` (`MUJOCO_PYTHON` or `python3` with mujoco) and `pnpm smoke:isaac` (`ISAACSIM_PYTHON`, default `~/isaacsim-env/bin/python`; pxr checks, then a headless play, which needs `OMNI_KIT_ACCEPT_EULA=YES` in the environment: accepting NVIDIA's EULA is Andrew's call, never set it in a script for them). Each one drops crates where the file says the ground is and reads back where they rest, which is how the engines' heightmap conventions were found and fixed; `tools/*_smoke.py` say what they check.
