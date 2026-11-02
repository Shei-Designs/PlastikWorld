// The right panel: what is picked, with its numbers.
import { heightAt, range, resample } from '../io/heightmap';
import { BRUSH_KINDS, DEFAULT_BRUSH, DEFAULT_FIELD, FIELD_KINDS } from '../terrain/brush';
import type { FieldSpec } from '../terrain/brush';
import { partById } from '../parts/library';
import { GRID_MAX, GRID_SIZES, MATERIAL_PRESETS, assetOf, isProp } from '../model/types';
import type { Asset, Light, LightKind, Material, Placed, SpawnPoint, Terrain, World, Zone } from '../model/types';
import { addMaterial, deleteSelected, duplicateSelected, fetchElevation, generateTerrain, importElevation, importHeightmap, removeMaterial, setBrush, updatePartParams, updateMaterial, updateZone, setTerrainKind, setTool, showExport, updateLight, updateObject, updateSpawn, updateTerrain, updateWorld, useEditor } from '../state/store';
import { useState } from 'react';
import { CheckField, ColorField, DEGREES, NumberField, SelectField, TextField, Vec3Field } from './Fields';
import { DuplicateIcon, ExportIcon, TrashIcon } from './icons';

const PHYSICS_COLLISION = [
  { id: 'mesh' as const, label: 'The mesh itself' },
  { id: 'box' as const, label: 'Its bounding box' },
  { id: 'none' as const, label: 'None (decoration)' },
];

const LIGHT_KINDS: { id: LightKind; label: string }[] = [
  { id: 'sun', label: 'Sun (directional)' },
  { id: 'point', label: 'Point light' },
  { id: 'spot', label: 'Spot light' },
];

function Head({ title, note, children }: { title: string; note?: string; children?: React.ReactNode }) {
  return (
    <div className="params-head">
      <div className="grow">
        <h1 className="clip">{title}</h1>
        {note && <p>{note}</p>}
      </div>
      {children}
    </div>
  );
}

function PoseFields({ pose, onChange, rotation = true }: { pose: Placed['pose']; onChange: (pose: Placed['pose']) => void; rotation?: boolean }) {
  return (
    <>
      <Vec3Field label="Position" unit="m" value={pose.xyz} step={0.05} onChange={(xyz) => onChange({ ...pose, xyz })} />
      {rotation && <Vec3Field label="Rotation (roll, pitch, yaw)" unit="°" value={pose.rpy} decimals={1} step={5} display={DEGREES} onChange={(rpy) => onChange({ ...pose, rpy })} />}
    </>
  );
}

function Actions() {
  return (
    <div className="inspector-actions">
      <button type="button" className="chip" onClick={duplicateSelected}>
        <DuplicateIcon /> Duplicate
      </button>
      <button type="button" className="chip" onClick={deleteSelected}>
        <TrashIcon /> Delete
      </button>
    </div>
  );
}

/** A library part's numbers; changing one changes every placement of the part. */
function PartFields({ asset }: { asset: Extract<Asset, { kind: 'part' }> }) {
  const def = partById(asset.part);
  if (!def) return <p className="note">This part is not in the library any more.</p>;
  const placements = useEditor((s) => s.world.objects.filter((o) => o.asset === asset.id).length);
  return (
    <>
      <h2>Shape</h2>
      {def.params.map((spec) => (
        <NumberField key={spec.id} label={spec.label} unit={spec.unit || undefined} value={asset.params[spec.id] ?? spec.value} min={spec.min} max={spec.max} step={spec.step} decimals={spec.step >= 1 ? 0 : 2} onChange={(v) => updatePartParams(asset.id, { [spec.id]: v })} />
      ))}
      {placements > 1 && <p className="note">These numbers are the part's: all {placements} placements of it change together. Duplicate the asset for a different one.</p>}
    </>
  );
}

function ObjectPanel({ world, placed }: { world: World; placed: Placed }) {
  const asset = assetOf(world, placed);
  const robot = asset?.kind === 'robot';
  const update = (patch: Partial<Placed>) => updateObject(placed.id, patch);
  const physics = (patch: Partial<Placed['physics']>) => update({ physics: { ...placed.physics, ...patch } });
  return (
    <div className="params">
      <Head title={placed.name} note={robot ? `Robot from a ${asset.format === 'ros' ? 'ROS 2 package' : asset.format === 'gazebo' ? 'Gazebo model' : 'MuJoCo model'}` : asset?.kind === 'part' ? `${partById(asset.part)?.name ?? 'Part'} from the parts library` : 'Object from a GLB'} />
      <TextField label="Name" value={placed.name} onChange={(name) => update({ name })} />
      {asset?.kind === 'part' && <PartFields asset={asset} />}
      <h2>Where it {robot ? 'starts' : 'sits'}</h2>
      <PoseFields pose={placed.pose} onChange={(pose) => update({ pose })} />
      {!robot && <NumberField label="Scale" value={placed.scale} min={0.001} step={0.1} onChange={(scale) => update({ scale })} />}
      {!robot && (
        <>
          <h2>Physics</h2>
          <CheckField label="Static (fixed in the world)" value={placed.physics.static} onChange={(v) => physics({ static: v })} />
          {!placed.physics.static && <NumberField label="Mass" unit="kg" value={placed.physics.mass} min={0} step={0.1} onChange={(mass) => physics({ mass })} />}
          <NumberField label="Friction" value={placed.physics.friction} min={0} step={0.1} decimals={2} onChange={(friction) => physics({ friction })} />
          <SelectField label="Collides with" value={placed.physics.collision} options={PHYSICS_COLLISION} onChange={(collision) => physics({ collision })} />
        </>
      )}
      {asset && (
        <>
          <h2>Source</h2>
          <dl className="info-rows">
            <dt>File</dt>
            <dd>{asset.source.path ?? asset.source.name}</dd>
            {robot && (
              <>
                <dt>Model</dt>
                <dd>{asset.modelName}</dd>
                <dt>Entry</dt>
                <dd>{asset.entry}</dd>
                {asset.rootBody && (
                  <>
                    <dt>Root body</dt>
                    <dd>{asset.rootBody}</dd>
                  </>
                )}
                <dt>Isaac USD</dt>
                <dd>{asset.usd ?? 'none in the package'}</dd>
              </>
            )}
          </dl>
          {robot && asset.format === 'mujoco' && <p className="note">A MuJoCo model is placed in MuJoCo worlds only. For Gazebo or Isaac, export the robot from PlastikCAD as a ROS 2 package.</p>}
          {robot && asset.format === 'gazebo' && <p className="note">A Gazebo model is placed in Gazebo worlds only. For MuJoCo, export the robot from PlastikCAD as a MuJoCo model.</p>}
        </>
      )}
      <Actions />
    </div>
  );
}

function LightPanel({ light }: { light: Light }) {
  const update = (patch: Partial<Light>) => updateLight(light.id, patch);
  return (
    <div className="params">
      <Head title={light.name} note="Light" />
      <TextField label="Name" value={light.name} onChange={(name) => update({ name })} />
      <SelectField label="Kind" value={light.kind} options={LIGHT_KINDS} onChange={(kind) => update({ kind })} />
      <PoseFields pose={light.pose} rotation={false} onChange={(pose) => update({ pose })} />
      {light.kind === 'sun' && <Vec3Field label="Direction" value={light.direction} decimals={2} step={0.1} onChange={(direction) => update({ direction })} />}
      {light.kind === 'spot' && <NumberField label="Cone" unit="°" value={light.cone} decimals={1} step={5} min={0.01} max={Math.PI / 2} display={DEGREES} onChange={(cone) => update({ cone })} />}
      <ColorField label="Colour" value={light.color} onChange={(color) => update({ color })} />
      <NumberField label="Intensity" value={light.intensity} min={0} step={0.1} decimals={2} onChange={(intensity) => update({ intensity })} />
      <CheckField label="Casts shadows" value={light.castShadows} onChange={(castShadows) => update({ castShadows })} />
      <Actions />
    </div>
  );
}

function SpawnPanel({ spawn }: { spawn: SpawnPoint }) {
  const update = (patch: Partial<SpawnPoint>) => updateSpawn(spawn.id, patch);
  return (
    <div className="params">
      <Head title={spawn.name} note="Spawn point: a named pose a robot can be started from" />
      <TextField label="Name" value={spawn.name} onChange={(name) => update({ name })} />
      <PoseFields pose={spawn.pose} onChange={(pose) => update({ pose })} />
      <Actions />
    </div>
  );
}

function TerrainPanel({ terrain }: { terrain: Terrain }) {
  const update = (patch: Partial<Terrain>) => updateTerrain({ ...terrain, ...patch } as Terrain);
  const tool = useEditor((s) => s.tool);
  const brush = tool?.kind === 'sculpt' ? tool.brush : DEFAULT_BRUSH;
  // What the next generated field looks like, and where the next fetched elevation is; not part of the world, so they live here.
  const [field, setField] = useState<FieldSpec>(DEFAULT_FIELD);
  const [place, setPlace] = useState({ lat: 45.9763, lon: 7.6586, radius: 2000 });
  const [lo, hi] = terrain.kind === 'heightmap' ? range(terrain.heights) : [0, 0];
  return (
    <div className="params">
      <Head title="Terrain" note="The ground every engine stands the world on" />
      <SelectField
        label="Kind"
        value={terrain.kind}
        options={[
          { id: 'plane', label: 'Flat plane' },
          { id: 'heightmap', label: 'Heightmap (sculpted or generated)' },
        ]}
        onChange={setTerrainKind}
      />
      <div className="vec3" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <NumberField label="Width (X)" unit="m" value={terrain.size[0]} min={0.1} step={1} onChange={(v) => update({ size: [v, terrain.size[1]] })} />
        <NumberField label="Depth (Y)" unit="m" value={terrain.size[1]} min={0.1} step={1} onChange={(v) => update({ size: [terrain.size[0], v] })} />
      </div>
      <NumberField label="Friction" value={terrain.friction} min={0} step={0.1} decimals={2} onChange={(friction) => update({ friction })} />
      {terrain.kind === 'heightmap' && (
        <>
          <h2>Heights</h2>
          <SelectField
            label="Samples"
            value={String(terrain.rows)}
            options={GRID_SIZES.map((n) => ({ id: String(n), label: `${n} × ${n}${n > GRID_MAX ? ' (slow in Isaac Sim)' : ''}` }))}
            onChange={(v) => {
              const n = Number(v);
              updateTerrain({ ...terrain, rows: n, cols: n, heights: resampleTo(terrain, n) });
            }}
          />
          <dl className="info-rows">
            <dt>Spacing</dt>
            <dd>{spacingText(terrain.size[0] / (terrain.cols - 1), terrain.size[1] / (terrain.rows - 1))}</dd>
            <dt>Lowest, highest</dt>
            <dd>
              {lo.toFixed(2)} m, {hi.toFixed(2)} m
            </dd>
            <dt>At the origin</dt>
            <dd>{heightAt(terrain, 0, 0).toFixed(3)} m</dd>
          </dl>
          <h2>Sculpt</h2>
          <div className="segmented wrap" role="group" aria-label="Brush">
            {BRUSH_KINDS.map((b) => (
              <button key={b.id} type="button" className={tool?.kind === 'sculpt' && tool.brush.kind === b.id ? 'on' : ''} title={b.hint} onClick={() => (tool?.kind === 'sculpt' && tool.brush.kind === b.id ? setTool(null) : setTool({ kind: 'sculpt', brush: { ...brush, kind: b.id } }))}>
                {b.label}
              </button>
            ))}
          </div>
          <div className="vec3" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <NumberField label="Brush size" unit="m" value={brush.radius} min={0.1} max={50} step={0.5} decimals={2} onChange={(radius) => setBrush({ radius })} />
            <NumberField label={brush.kind === 'raise' || brush.kind === 'lower' ? 'Speed' : 'Strength'} unit={brush.kind === 'raise' || brush.kind === 'lower' ? 'm/s' : '/s'} value={brush.strength} min={0.01} step={0.25} decimals={2} onChange={(strength) => setBrush({ strength })} />
          </div>
          {brush.kind === 'set' && <NumberField label="Set to" unit="m" value={brush.target} step={0.1} decimals={2} onChange={(target) => setBrush({ target })} />}
          <p className="note">{tool?.kind === 'sculpt' ? 'Drag on the ground in the viewport. Each stroke is one undo step.' : 'Pick a brush, then drag on the ground. Two fingers or the right button still turn the camera.'}</p>
          <h2>Generate</h2>
          <SelectField label="Field" value={field.kind} options={FIELD_KINDS} onChange={(kind) => setField({ ...field, kind })} />
          <div className="vec3" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <NumberField label="Height" unit="m" value={field.amplitude} min={0} step={0.1} decimals={2} onChange={(amplitude) => setField({ ...field, amplitude })} />
            <NumberField label="Feature size" unit="× side" value={field.feature} min={0.05} max={1} step={0.05} decimals={2} onChange={(feature) => setField({ ...field, feature })} />
          </div>
          <div className="vec3" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <NumberField label="Seed" value={field.seed} step={1} decimals={0} onChange={(seed) => setField({ ...field, seed: Math.round(seed) })} />
            <NumberField label="Level middle" unit="× half" value={field.clear} min={0} max={1} step={0.05} decimals={2} onChange={(clear) => setField({ ...field, clear })} />
          </div>
          <div className="vec3" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <button type="button" className="chip" onClick={() => generateTerrain(field)}>
              Generate
            </button>
            <button
              type="button"
              className="chip"
              onClick={() => {
                const next = { ...field, seed: Math.floor(Math.random() * 1e6) };
                setField(next);
                generateTerrain(next);
              }}
            >
              New seed
            </button>
          </div>
          <h2>Import</h2>
          <div className="vec3" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <button type="button" className="chip" onClick={() => void importHeightmap()}>
              Heightmap image…
            </button>
            <button type="button" className="chip" onClick={() => void importElevation()}>
              Elevation (GeoTIFF)…
            </button>
          </div>
          <p className="note">
            A greyscale PNG (8 or 16-bit; a colour image is read by its brightness), black the lowest point and white the highest; or a GeoTIFF of real elevation (USGS 3DEP, SRTM, Copernicus DEM tiles), a box of which is read in meters.
          </p>
          <h2>A real place</h2>
          <div className="vec3" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <NumberField label="Latitude" unit="°" value={place.lat} min={-90} max={90} step={0.01} decimals={4} onChange={(lat) => setPlace({ ...place, lat })} />
            <NumberField label="Longitude" unit="°" value={place.lon} min={-180} max={180} step={0.01} decimals={4} onChange={(lon) => setPlace({ ...place, lon })} />
          </div>
          <div className="vec3" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <NumberField label="Around it" unit="m" value={place.radius} min={100} max={50000} step={100} decimals={0} onChange={(radius) => setPlace({ ...place, radius })} />
            <button type="button" className="chip" onClick={() => void fetchElevation(place.lat, place.lon, place.radius)}>
              Fetch Copernicus DEM
            </button>
          </div>
          <p className="note">
            Copernicus GLO-30 from AWS Open Data, 30 m a sample the world over, fetched over the network for the tile the place is in. The grid is 2^n + 1 samples a side so that Gazebo, MuJoCo and Isaac Sim all get the very same heights; past {GRID_MAX} the Isaac stage's ground mesh gets heavy.
          </p>
        </>
      )}
    </div>
  );
}

/** "12.5 × 12.5 cm" for a yard, "24.2 × 24.8 m" for a landscape. */
const spacingText = (dx: number, dy: number): string => (Math.max(dx, dy) >= 1 ? `${dx.toFixed(1)} × ${dy.toFixed(1)} m` : `${(dx * 100).toFixed(1)} × ${(dy * 100).toFixed(1)} cm`);

/** The heights on an `n` × `n` grid, bilinear. */
const resampleTo = (terrain: Extract<Terrain, { kind: 'heightmap' }>, n: number): Float32Array => resample(terrain, n);

function ZonePanel({ world, zone }: { world: World; zone: Zone }) {
  const update = (patch: Partial<Zone>) => updateZone(zone.id, patch);
  const [x0, y0, x1, y1] = zone.rect;
  const centre: [number, number] = [(x0 + x1) / 2, (y0 + y1) / 2];
  const size: [number, number] = [x1 - x0, y1 - y0];
  const place = (c: [number, number], s: [number, number]) => update({ rect: [c[0] - s[0] / 2, c[1] - s[1] / 2, c[0] + s[0] / 2, c[1] + s[1] / 2] });
  return (
    <div className="params">
      <Head title={zone.name} note="Surface zone: a patch of the ground with a surface of its own" />
      <TextField label="Name" value={zone.name} onChange={(name) => update({ name })} />
      <SelectField label="Surface" value={zone.material} options={world.materials.map((m) => ({ id: m.id, label: `${m.name} (friction ${m.friction})` }))} onChange={(material) => update({ material })} />
      <div className="vec3" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <NumberField label="Centre X" unit="m" value={centre[0]} step={0.5} decimals={2} onChange={(v) => place([v, centre[1]], size)} />
        <NumberField label="Centre Y" unit="m" value={centre[1]} step={0.5} decimals={2} onChange={(v) => place([centre[0], v], size)} />
      </div>
      <div className="vec3" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <NumberField label="Width (X)" unit="m" value={size[0]} min={0.05} step={0.5} decimals={2} onChange={(v) => place(centre, [v, size[1]])} />
        <NumberField label="Depth (Y)" unit="m" value={size[1]} min={0.05} step={0.5} decimals={2} onChange={(v) => place(centre, [size[0], v])} />
      </div>
      <p className="note">Every engine gets the zone as a collision piece of its own, a hair over the ground, with this surface's friction. The surfaces themselves are edited in the world settings.</p>
      <Actions />
    </div>
  );
}

function MaterialRow({ material }: { material: Material }) {
  const update = (patch: Partial<Material>) => updateMaterial(material.id, patch);
  return (
    <div className="material-row">
      <ColorField label="Colour" value={material.color} onChange={(color) => update({ color })} />
      <TextField label="Name" value={material.name} onChange={(name) => update({ name })} />
      <NumberField label="Friction" value={material.friction} min={0} step={0.1} decimals={2} onChange={(friction) => update({ friction })} />
      <NumberField label="Bounce" value={material.restitution} min={0} max={1} step={0.05} decimals={2} onChange={(restitution) => update({ restitution })} />
      <button type="button" className="icon-button" title="Remove the surface and the zones that have it" aria-label={`Remove ${material.name}`} onClick={() => removeMaterial(material.id)}>
        <TrashIcon />
      </button>
    </div>
  );
}

function WorldPanel({ world }: { world: World }) {
  return (
    <div className="params">
      <Head title={world.name} note="World settings" />
      <TextField label="Name" value={world.name} onChange={(name) => updateWorld({ name })} />
      <Vec3Field label="Gravity" unit="m/s²" value={world.gravity} decimals={2} step={0.1} onChange={(gravity) => updateWorld({ gravity })} />
      <h2>Contents</h2>
      <dl className="info-rows">
        <dt>Objects</dt>
        <dd>{world.objects.filter((o) => isProp(assetOf(world, o))).length}</dd>
        <dt>Robots</dt>
        <dd>{world.objects.filter((o) => assetOf(world, o)?.kind === 'robot').length}</dd>
        <dt>Lights</dt>
        <dd>{world.lights.length}</dd>
        <dt>Spawn points</dt>
        <dd>{world.spawns.length}</dd>
      </dl>
      <h2>Surfaces</h2>
      {world.materials.map((m) => (
        <MaterialRow key={m.id} material={m} />
      ))}
      <SelectField
        label="Add a surface"
        value=""
        options={[{ id: '', label: 'Pick one…' }, ...MATERIAL_PRESETS.map((p) => ({ id: p.name, label: `${p.name} (friction ${p.friction})` }))]}
        onChange={(name) => {
          const preset = MATERIAL_PRESETS.find((p) => p.name === name);
          if (preset) addMaterial(preset);
        }}
      />
      <p className="note">The ground's own friction is set on the terrain; a surface here is what a zone drawn on the ground gets.</p>
      <div className="inspector-actions">
        <button type="button" className="primary" onClick={() => showExport(true)}>
          <ExportIcon /> Export world…
        </button>
      </div>
    </div>
  );
}

export function Inspector() {
  const world = useEditor((s) => s.world);
  const pick = useEditor((s) => s.pick);
  let body: React.ReactNode = <WorldPanel world={world} />;
  if (pick?.kind === 'terrain') body = <TerrainPanel terrain={world.terrain} />;
  else if (pick?.kind === 'object') {
    const placed = world.objects.find((o) => o.id === pick.id);
    if (placed) body = <ObjectPanel world={world} placed={placed} />;
  } else if (pick?.kind === 'light') {
    const light = world.lights.find((l) => l.id === pick.id);
    if (light) body = <LightPanel light={light} />;
  } else if (pick?.kind === 'spawn') {
    const spawn = world.spawns.find((s) => s.id === pick.id);
    if (spawn) body = <SpawnPanel spawn={spawn} />;
  } else if (pick?.kind === 'zone') {
    const zone = world.zones.find((z) => z.id === pick.id);
    if (zone) body = <ZonePanel world={world} zone={zone} />;
  }
  return <aside className="inspector">{body}</aside>;
}
