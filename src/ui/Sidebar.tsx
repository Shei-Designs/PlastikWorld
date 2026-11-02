// The left panel: the brand row, the file bar with its menu, the world's
// contents as a tree, and the assets it draws from.
import { APP_NAME } from '../app';
import type { Asset, LightKind, World } from '../model/types';
import {
  addLight,
  addSpawn,
  importObjects,
  importRobot,
  isDirty,
  newWorld,
  openWorldFile,
  openWorlds,
  pickTerrain,
  pickWorld,
  removeAsset,
  saveCopy,
  saveNow,
  select,
  setTool,
  showAbout,
  showExport,
  showLibrary,
  startPlacing,
  toggleTheme,
  updateWorld,
  useEditor,
} from '../state/store';
import { CubeIcon, GridIcon, LibraryIcon, FlagIcon, ImportIcon, LightIcon, Logo, MenuIcon, MoonIcon, PlusIcon, RobotIcon, SunIcon, TerrainIcon, TrashIcon, WorldIcon } from './icons';
import { Popover } from './Popover';
import { enterByTouch } from './TouchEntry';

const LIGHT_KINDS: { id: LightKind; label: string }[] = [
  { id: 'sun', label: 'Sun' },
  { id: 'point', label: 'Point light' },
  { id: 'spot', label: 'Spot light' },
];

function FileMenu() {
  return (
    <Popover
      align="right"
      button={(open) => (
        <button type="button" className={`icon-button${open ? ' on' : ''}`} title="File" aria-label="File menu">
          <MenuIcon />
        </button>
      )}
    >
      {(close) => {
        const item = (label: string, keys: string, run: () => void, disabled = false) => (
          <button
            type="button"
            className="menu-item"
            disabled={disabled}
            onClick={() => {
              close();
              run();
            }}
          >
            <span>{label}</span>
            <kbd>{keys}</kbd>
          </button>
        );
        return (
          <div className="menu">
            {item('New world', 'Ctrl+N', () => void newWorld())}
            {item('Open…', 'Ctrl+O', () => void openWorlds())}
            {item('Open world file…', 'Ctrl+Shift+O', () => void openWorldFile())}
            <hr />
            {item('Save now', 'Ctrl+S', () => void saveNow())}
            {item('Save a copy…', 'Ctrl+Shift+S', () => void saveCopy())}
            <hr />
            {item('Import object (GLB)…', 'Ctrl+I', () => void importObjects())}
            {item('Import robot package…', 'Ctrl+Shift+I', () => void importRobot())}
            {item('Export world…', 'Ctrl+E', () => showExport(true))}
            <hr />
            {item(`About ${APP_NAME}`, '', () => showAbout(true))}
          </div>
        );
      }}
    </Popover>
  );
}

function assetIcon(asset: Asset | undefined) {
  return asset?.kind === 'robot' ? <RobotIcon /> : asset?.kind === 'part' ? <LibraryIcon /> : <CubeIcon />;
}

export function Sidebar() {
  const world = useEditor((s) => s.world);
  const pick = useEditor((s) => s.pick);
  const selection = useEditor((s) => s.selection);
  const dirty = useEditor((s) => isDirty() && s.saved !== s.world);
  const theme = useEditor((s) => s.prefs.theme);
  const placing = useEditor((s) => s.placing);
  const tool = useEditor((s) => s.tool);
  const assetsById = new Map(world.assets.map((a) => [a.id, a]));
  const on = (kind: 'world' | 'terrain') => pick?.kind === kind;
  const picked = (id: string) => selection.includes(id);
  return (
    <aside className="sidebar">
      <div className="brand">
        <Logo />
        <span className="wordmark">{APP_NAME}</span>
        <button type="button" className="icon-button" title={theme === 'dark' ? 'Light theme' : 'Dark theme'} aria-label="Switch theme" onClick={toggleTheme}>
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>
      </div>
      <div className="file-bar">
        <span className={`dirty-dot${dirty ? ' on' : ''}`} title={dirty ? 'Changes not yet saved' : 'Saved'} />
        <input
          className="doc-name clip"
          value={world.name}
          aria-label="World name"
          onPointerDown={(e) => enterByTouch(e, { label: 'World name', value: world.name, inputMode: 'text', onCommit: (name) => name.trim() && updateWorld({ name: name.trim() }) })}
          onChange={(e) => updateWorld({ name: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
          }}
        />
        <FileMenu />
      </div>
      <div className="catalog">
        <section>
          <div className="section-head">
            <span className="grow">World</span>
          </div>
          <button type="button" className={`tree-item${on('world') ? ' on' : ''}`} onClick={pickWorld}>
            <WorldIcon />
            <span className="clip">Settings</span>
            <span className="meta">gravity {world.gravity[2].toFixed(2)}</span>
          </button>
          <button type="button" className={`tree-item${on('terrain') ? ' on' : ''}`} onClick={pickTerrain}>
            <TerrainIcon />
            <span className="clip">Terrain</span>
            <span className="meta">{world.terrain.kind === 'plane' ? 'plane' : 'heightmap'}</span>
          </button>
        </section>
        <section>
          <div className="section-head">
            <span className="grow">Lights</span>
            <Popover
              align="right"
              button={() => (
                <button type="button" className="icon-button" title="Add a light" aria-label="Add a light">
                  <PlusIcon />
                </button>
              )}
            >
              {(close) => (
                <div className="menu">
                  {LIGHT_KINDS.map((k) => (
                    <button
                      key={k.id}
                      type="button"
                      className="menu-item"
                      onClick={() => {
                        close();
                        addLight(k.id);
                      }}
                    >
                      {k.label}
                    </button>
                  ))}
                </div>
              )}
            </Popover>
          </div>
          {world.lights.map((l) => (
            <button key={l.id} type="button" className={`tree-item${picked(l.id) ? ' on' : ''}`} onClick={(e) => select(l.id, e.shiftKey || e.ctrlKey)}>
              <LightIcon />
              <span className="clip">{l.name}</span>
              <span className="meta">{l.kind}</span>
            </button>
          ))}
          {world.lights.length === 0 && <p className="tree-empty">No lights: the engines will light the world their own way.</p>}
        </section>
        <section>
          <div className="section-head">
            <span className="grow">Spawn points</span>
            <button type="button" className="icon-button" title="Add a spawn point" aria-label="Add a spawn point" onClick={() => addSpawn()}>
              <PlusIcon />
            </button>
          </div>
          {world.spawns.map((s) => (
            <button key={s.id} type="button" className={`tree-item${picked(s.id) ? ' on' : ''}`} onClick={(e) => select(s.id, e.shiftKey || e.ctrlKey)}>
              <FlagIcon />
              <span className="clip">{s.name}</span>
            </button>
          ))}
        </section>
        <section>
          <div className="section-head">
            <span className="grow">Surfaces</span>
            <button type="button" className={`icon-button${tool?.kind === 'zone' ? ' on' : ''}`} title="Draw a surface zone on the ground" aria-label="Draw a surface zone" onClick={() => setTool(tool?.kind === 'zone' ? null : { kind: 'zone' })}>
              <PlusIcon />
            </button>
          </div>
          {world.zones.map((z) => (
            <button key={z.id} type="button" className={`tree-item${picked(z.id) ? ' on' : ''}`} onClick={(e) => select(z.id, e.shiftKey || e.ctrlKey)}>
              <GridIcon />
              <span className="clip">{z.name}</span>
              <span className="meta">{world.materials.find((m) => m.id === z.material)?.name ?? '?'}</span>
            </button>
          ))}
          {world.zones.length === 0 && <p className="tree-empty">The ground has one surface. Draw a zone to give part of it another.</p>}
        </section>
        <section>
          <div className="section-head">
            <span className="grow">Objects and robots</span>
          </div>
          {world.objects.map((o) => (
            <button key={o.id} type="button" className={`tree-item${picked(o.id) ? ' on' : ''}`} onClick={(e) => select(o.id, e.shiftKey || e.ctrlKey)}>
              {assetIcon(assetsById.get(o.asset))}
              <span className="clip">{o.name}</span>
              <span className="meta">{o.physics.static ? 'static' : `${o.physics.mass} kg`}</span>
            </button>
          ))}
          {world.objects.length === 0 && <p className="tree-empty">Nothing placed yet. Import a GLB from PlastikCAD, or a robot package.</p>}
        </section>
        <AssetList world={world} placing={placing?.kind === 'asset' ? placing.asset : null} />
        <div className="import-row">
          <button type="button" className="chip wide" onClick={() => void importObjects()} title="Import a GLB exported from PlastikCAD (Ctrl+I)">
            <ImportIcon /> Object
          </button>
          <button type="button" className="chip wide" onClick={() => void importRobot()} title="Import a ROS 2 package, Gazebo model or MuJoCo model folder (Ctrl+Shift+I)">
            <RobotIcon /> Robot
          </button>
          <button type="button" className="chip wide" onClick={() => showLibrary(true)} title="Add a wall, a ramp, a cone… from the parts library (Ctrl+L)">
            <LibraryIcon /> Parts
          </button>
        </div>
      </div>
    </aside>
  );
}

function AssetList({ world, placing }: { world: World; placing: string | null }) {
  if (world.assets.length === 0) return null;
  return (
    <section>
      <div className="section-head">
        <span className="grow">Assets</span>
      </div>
      {world.assets.map((a) => (
        <div key={a.id} className="asset-row">
          {assetIcon(a)}
          <span className="name clip" title={a.source.path ?? a.source.name}>
            {a.name}
          </span>
          <button type="button" className={`icon-button${placing === a.id ? ' on' : ''}`} title="Place another: click on the ground where it goes" aria-label={`Place ${a.name}`} onClick={() => startPlacing({ kind: 'asset', asset: a.id })}>
            <PlusIcon />
          </button>
          <button type="button" className="icon-button" title="Remove the asset and everything placed from it" aria-label={`Remove ${a.name}`} onClick={() => removeAsset(a.id)}>
            <TrashIcon />
          </button>
        </div>
      ))}
    </section>
  );
}
