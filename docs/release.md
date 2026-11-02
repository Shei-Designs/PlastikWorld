# Releasing PlastikWorld

What a release is made of, on the desktop and on Android, and what the Play
listing needs. Nothing here is automated past the build itself: the key, the
version and the listing are decisions, and they are yours.

## 1. The version

One number in three places, kept the same:

- `package.json` → `version`
- `src-tauri/Cargo.toml` → `version`
- `src-tauri/tauri.conf.json` → `version`

Tauri turns it into Android's `versionName` and `versionCode` (the gradle
file reads `tauri.android.versionCode` and `versionName` from the properties
Tauri writes). Each Play upload needs a higher `versionCode`, so every
release raises the version, a patch at least.

## 2. Desktop

```sh
pnpm typecheck && pnpm test && pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build          # installers under src-tauri/target/release/bundle
```

Linux gives a `.deb`, an `.rpm` and an AppImage; Windows an `.msi` and an
NSIS setup; macOS a `.dmg` (signed ad hoc, `signingIdentity: "-"`, until an
Apple identity is set). The file association for `.plastikworld` is in the
Tauri config and rides along.

## 3. Android

### The key

The release is signed with an upload key of its own, made once and kept out
of the repository (PlastikCAD's is `~/.android/plastikcad-upload.jks`; this
app has the same arrangement under its own name):

```sh
keytool -genkeypair -v -keystore ~/.android/plastikworld-upload.jks \
  -alias plastikworld -keyalg RSA -keysize 4096 -validity 10000
```

`src-tauri/gen/android/app/build.gradle.kts` reads
`~/.android/plastikworld-keystore.properties`:

```properties
storeFile=/home/you/.android/plastikworld-upload.jks
storePassword=…
keyAlias=plastikworld
keyPassword=…
```

Without that file the release build is left unsigned, as Android Studio
would leave it. Keep the keystore and its passwords backed up somewhere that
is not this machine: Play Console lets you reset an upload key, but it takes
days.

### The build

```sh
export ANDROID_HOME=~/Android/Sdk
export NDK_HOME=$ANDROID_HOME/ndk/<version>
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk
pnpm tauri android build --aab                      # the bundle Play takes: gen/android/app/build/outputs/bundle/universalRelease/
pnpm tauri android build --apk --target aarch64     # an APK to hand to a tablet directly
```

Check the APK on the tablet before the upload: open a world, import a robot
package (as a zip), export to `Download/PlastikWorld` and share it, sculpt
with a finger, drive with the stick, rotate the tablet. The things a phone
or tablet does differently are the pickers, the keyboard and the layout under
1100 px, so those are what to try.

### The Play listing

Play Console → the app → Store presence → Main store listing. The texts
below are a starting point in the house voice; the graphics come from
`pnpm brand` (`docs/brand/`).

| Field | Content |
| --- | --- |
| App name | PlastikWorld |
| Short description (80) | Build worlds for robot simulation: Gazebo, MuJoCo and Isaac Sim, from one file. |
| App icon (512 × 512) | `docs/brand/play-icon-512.png` (the tile and the mark; Play rounds it) |
| Feature graphic (1024 × 500) | `docs/brand/feature-graphic.png` (the lockup on Carbon) |
| Screenshots | At least two per form factor you list (tablet 7" and 10"; phone if listed). Take them in the app on the device: a world with terrain and parts, the inspector open; the parts library; a drive in progress; the export panel. No frames, no text over them. |
| Category | Tools (or Productivity) |
| Tags | robotics, simulation, 3D |
| Contact email | the Shei Designs address |
| Privacy policy | <https://sheidesigns.com/privacy> (the app sends nothing anywhere; elevation tiles are fetched from a public bucket when asked for) |

Full description (4000 characters at most):

> PlastikWorld builds the world a robot is simulated in. Place the objects and
> robots PlastikCAD exports on terrain you shape in the app, and write the
> scene for Gazebo (SDF), MuJoCo (MJCF) and Isaac Sim (USD) from the one
> file.
>
> Terrain is made here: sculpt it with a brush, generate rolling hills,
> ridges or craters, bring in a heightmap image, or fetch real elevation for
> a place. Paint surfaces on it (ice, asphalt, rubber, your own) and every
> engine gets the friction. A parts library gives you walls, rooms, ramps,
> stairs, fences, roads, parking, barriers, cones, lamps, trees, rocks,
> bridges, crates, pallets, tables and shelving, each made from a few
> numbers. Drive a robot through the world with the on-screen stick or a
> gamepad before it goes to a simulator, and it tells you what it hit.
>
> Set the sky, fog and wind. Export a self-contained folder for the engine
> you use, robot packages copied in, with a script that runs it; or the whole
> scene as one GLB for Blender. Worlds save themselves as you work and are
> one file each, so they travel.
>
> Units are meters, kilograms and radians throughout. Nothing leaves your
> device. Free software under the GPL-3.0; a Shei Designs project, made with
> PlastikCAD.

Content rating: the questionnaire's answers are all "no" (no user content,
no sharing, no ads, no purchases). Data safety: no data collected or shared;
network use is the optional elevation fetch from a public bucket.

### Testing tracks

Upload the first bundle to **Internal testing**, install it from the opt-in
link on the tablet, and run the same checks as above from the store build
(the signing differs from the APK you side-loaded). Then promote to
Production or an open track.

## 4. After the release

- Tag the commit (`v0.x.y`) and write what changed under the GitHub release,
  with the desktop installers attached.
- Update the product row in the Shei Designs register
  (`design-reference/PRODUCTS.md`) if the version or the store links changed.
