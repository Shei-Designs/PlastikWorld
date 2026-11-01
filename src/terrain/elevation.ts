// Real elevation for the terrain: a GeoTIFF the user has (USGS 3DEP, SRTM
// and Copernicus DEM tiles all are), or a Copernicus GLO-30 tile fetched
// from AWS Open Data for a place given by its latitude and longitude. A box
// of the DEM is read, resampled onto the grid and put on a local tangent
// plane in meters: good to well under a percent over a few kilometres, which
// is as far as a world here goes. The DEM's top row is north, which becomes
// +Y, as a heightmap image does.
import { BaseClient, BaseResponse, fromArrayBuffer, fromCustomClient } from 'geotiff';
import type { GeoTIFF, GeoTIFFImage } from 'geotiff';
import { resample } from '../io/heightmap';
import type { GreyImage } from '../io/png';

/** Meters per degree of latitude (and of longitude at the equator). */
const METERS_PER_DEGREE = 111_320;

export interface Dem {
  name: string;
  width: number;
  height: number;
  /** [minX, minY, maxX, maxY] in the raster's own coordinates: degrees for a geographic DEM, its linear unit otherwise. */
  bbox: [number, number, number, number];
  /** Degrees of longitude and latitude, rather than a projected grid in meters. */
  geographic: boolean;
  /** Meters per coordinate unit of a projected DEM (feet happen); 1 for degrees, which are turned to meters by latitude. */
  unitScale: number;
  nodata: number | null;
  /** The whole DEM at a glance, greys 0..1, for picking a box on. */
  preview: GreyImage;
  /** The preview's lowest and highest, meters. */
  previewRange: [number, number];
  /**
   * Reads a window of pixels ([x0, y0, x1, y1], y down from the top) at its
   * own resolution (nearest-neighbour down to `MAX_READ` a side past that),
   * the first row the top. No-data values come through as they are.
   */
  read(window: [number, number, number, number]): Promise<{ values: Float32Array; width: number; height: number }>;
}

/** The most pixels a side read from a DEM at once: a 1 m DEM over 5 km would be 25 million otherwise. */
export const MAX_READ = 2048;

/** A box on the DEM, in pixels, y down from the top, x1 and y1 exclusive. */
export interface DemBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const GEO_KEYS = { modelType: 'GTModelTypeGeoKey', geographic: 'GeographicTypeGeoKey', projected: 'ProjectedCSTypeGeoKey', projUnits: 'ProjLinearUnitsGeoKey', geogUnits: 'GeogLinearUnitsGeoKey' };
/** EPSG unit codes: 9001 meter, 9002 international foot, 9003 US survey foot. */
const UNIT_SCALE: Record<number, number> = { 9001: 1, 9002: 0.3048, 9003: 1200 / 3937 };

async function describe(name: string, tiff: GeoTIFF): Promise<Dem> {
  const image = await tiff.getImage(0);
  const keys = (image.getGeoKeys() ?? {}) as Record<string, number | undefined>;
  const modelType = keys[GEO_KEYS.modelType];
  const geographic = modelType === 2 || (modelType === undefined && keys[GEO_KEYS.geographic] !== undefined && keys[GEO_KEYS.projected] === undefined);
  if (!geographic && modelType !== 1 && keys[GEO_KEYS.projected] === undefined) {
    // No georeferencing at all: still usable, as pixels a meter apart.
    if (!image.fileDirectory.getValue('ModelPixelScale') && !image.fileDirectory.getValue('ModelTransformation')) {
      return describePlain(name, tiff, image);
    }
  }
  const unitScale = geographic ? 1 : (UNIT_SCALE[keys[GEO_KEYS.projUnits] ?? 9001] ?? 1);
  const bbox = image.getBoundingBox() as [number, number, number, number];
  const nodata = image.getGDALNoData();
  const preview = await previewOf(tiff, nodata);
  return { name, width: image.getWidth(), height: image.getHeight(), bbox, geographic, unitScale, nodata, preview: preview.image, previewRange: preview.range, read: reader(image, nodata) };
}

/** A TIFF with heights but no georeferencing: a pixel is taken as a meter. */
async function describePlain(name: string, tiff: GeoTIFF, image: GeoTIFFImage): Promise<Dem> {
  const nodata = image.getGDALNoData();
  const preview = await previewOf(tiff, nodata);
  const w = image.getWidth(), h = image.getHeight();
  return { name, width: w, height: h, bbox: [0, 0, w, h], geographic: false, unitScale: 1, nodata, preview: preview.image, previewRange: preview.range, read: reader(image, nodata) };
}

function reader(image: GeoTIFFImage, nodata: number | null) {
  return async (window: [number, number, number, number]) => {
    const w = window[2] - window[0], h = window[3] - window[1];
    const scale = Math.max(1, w / MAX_READ, h / MAX_READ);
    const width = Math.max(2, Math.round(w / scale)), height = Math.max(2, Math.round(h / scale));
    // Nearest, never bilinear: a blend with a no-data value would make a hole into a pit.
    const raster = (await image.readRasters({ window, width, height, resampleMethod: 'nearest', samples: [0], fillValue: nodata ?? 0 })) as unknown as ArrayLike<number>[];
    return { values: Float32Array.from(raster[0]), width, height };
  };
}

/** The whole DEM at about 256 pixels, from its smallest overview that is still that big (a cloud-optimised GeoTIFF has them). */
async function previewOf(tiff: GeoTIFF, nodata: number | null): Promise<{ image: GreyImage; range: [number, number] }> {
  const count = await tiff.getImageCount();
  let pick = await tiff.getImage(0);
  for (let i = 1; i < count; i++) {
    const candidate = await tiff.getImage(i);
    if (Math.max(candidate.getWidth(), candidate.getHeight()) >= 256) pick = candidate;
    else break;
  }
  const scale = Math.max(pick.getWidth(), pick.getHeight()) / 256;
  const width = Math.max(1, Math.round(pick.getWidth() / Math.max(1, scale))), height = Math.max(1, Math.round(pick.getHeight() / Math.max(1, scale)));
  const raster = (await pick.readRasters({ width, height, resampleMethod: 'nearest', samples: [0], fillValue: nodata ?? 0 })) as unknown as ArrayLike<number>[];
  const values = Float32Array.from(raster[0]);
  let lo = Infinity, hi = -Infinity;
  for (const v of values) {
    if (v === nodata || !Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) lo = hi = 0;
  const span = hi - lo || 1;
  const samples = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) samples[i] = values[i] === nodata || !Number.isFinite(values[i]) ? 0 : (values[i] - lo) / span;
  return { image: { width, height, depth: 16, samples }, range: [lo, hi] };
}

/** A GeoTIFF from its bytes. */
export async function openDem(name: string, bytes: Uint8Array): Promise<Dem> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  let tiff: GeoTIFF;
  try {
    tiff = await fromArrayBuffer(buffer);
  } catch {
    throw new Error(`${name} is not a GeoTIFF this app can read.`);
  }
  return describe(name, tiff);
}

/** A fetch to use for the tiles: the Rust side's in the app (buckets send no CORS headers), the browser's otherwise. */
export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

class Resp extends BaseResponse {
  constructor(private readonly response: Response) {
    super();
  }
  get status(): number {
    return this.response.status;
  }
  getHeader(name: string): string | undefined {
    return this.response.headers.get(name) || undefined;
  }
  async getData(): Promise<ArrayBuffer> {
    return this.response.arrayBuffer();
  }
}

class Client extends BaseClient {
  constructor(url: string, private readonly fetcher: FetchLike) {
    super(url);
  }
  async request({ headers, signal }: { headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Resp> {
    return new Resp(await this.fetcher(this.url, { headers, signal }));
  }
}

/** A cloud-optimised GeoTIFF read in place with range requests: only the parts asked for come over the wire. */
export async function openDemUrl(name: string, url: string, fetcher: FetchLike): Promise<Dem> {
  let tiff: GeoTIFF;
  try {
    tiff = await fromCustomClient(new Client(url, fetcher), { allowFullFile: false, maxRanges: 0 });
  } catch (err) {
    throw new Error(`Could not read ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return describe(name, tiff);
}

// --- Copernicus GLO-30 on AWS Open Data ---------------------------------------

/** The 1° × 1° Copernicus DEM tile holding a point, as AWS Open Data names it (its south-west corner). */
export function copernicusTile(lat: number, lon: number): { name: string; url: string } {
  const la = Math.floor(lat), lo = Math.floor(lon);
  const ns = la >= 0 ? 'N' : 'S', ew = lo >= 0 ? 'E' : 'W';
  const name = `Copernicus_DSM_COG_10_${ns}${String(Math.abs(la)).padStart(2, '0')}_00_${ew}${String(Math.abs(lo)).padStart(3, '0')}_00_DEM`;
  return { name, url: `https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif` };
}

/** The box of `radius` meters around a latitude and longitude on a geographic DEM, clipped to it. */
export function boxAround(dem: Dem, lat: number, lon: number, radius: number): DemBox {
  const [minX, minY, maxX, maxY] = dem.bbox;
  const px = dem.width / (maxX - minX), py = dem.height / (maxY - minY);
  const dLat = radius / METERS_PER_DEGREE, dLon = radius / (METERS_PER_DEGREE * Math.cos((lat * Math.PI) / 180));
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  return {
    x0: clamp(Math.floor((lon - dLon - minX) * px), 0, dem.width - 1),
    x1: clamp(Math.ceil((lon + dLon - minX) * px), 1, dem.width),
    y0: clamp(Math.floor((maxY - (lat + dLat)) * py), 0, dem.height - 1),
    y1: clamp(Math.ceil((maxY - (lat - dLat)) * py), 1, dem.height),
  };
}

/** What a box of the DEM covers on the ground, meters, width (east) then depth (north). */
export function boxMeters(dem: Dem, box: DemBox): [number, number] {
  const [minX, minY, maxX, maxY] = dem.bbox;
  const ux = (maxX - minX) / dem.width, uy = (maxY - minY) / dem.height;
  const dx = (box.x1 - box.x0) * ux, dy = (box.y1 - box.y0) * uy;
  if (!dem.geographic) return [dx * dem.unitScale, dy * dem.unitScale];
  const midLat = maxY - ((box.y0 + box.y1) / 2) * uy;
  return [dx * METERS_PER_DEGREE * Math.cos((midLat * Math.PI) / 180), dy * METERS_PER_DEGREE];
}

export interface DemFit {
  samples: number;
  /** Heights multiplied, for a relief that would otherwise be too flat to see; 1 for the truth. */
  exaggeration: number;
  /** Bring the lowest point to z = 0, rather than keeping heights above sea level. */
  levelLowest: boolean;
}

export interface DemResult {
  heights: Float32Array;
  size: [number, number];
  lowest: number;
  highest: number;
  /** How many samples had no data and were filled from their neighbours. */
  filled: number;
}

/** The box read onto the grid: the DEM's top row becomes +Y, holes are filled from around them, and the heights are in meters. */
export async function heightsFromDem(dem: Dem, box: DemBox, fit: DemFit): Promise<DemResult> {
  const { values, width, height } = await dem.read([box.x0, box.y0, box.x1, box.y1]);
  // The reader gives the top row first; the grid wants -Y (south) first.
  const grid = new Float32Array(width * height);
  for (let r = 0; r < height; r++) grid.set(values.subarray(r * width, (r + 1) * width), (height - 1 - r) * width);
  // Holes are filled at the DEM's own resolution, before any resampling could spread them.
  const filled = fillHoles(grid, height, width, dem.nodata);
  let lo = Infinity, hi = -Infinity;
  for (const h of grid) {
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  const base = fit.levelLowest ? lo : 0;
  for (let i = 0; i < grid.length; i++) grid[i] = (grid[i] - base) * fit.exaggeration;
  const heights = width === fit.samples && height === fit.samples ? grid : resample({ rows: height, cols: width, heights: grid }, fit.samples);
  return { heights, size: boxMeters(dem, box), lowest: (lo - base) * fit.exaggeration, highest: (hi - base) * fit.exaggeration, filled };
}

/** Replaces no-data samples (and NaNs) by the mean of their valid neighbours, pass after pass, growing inward; the count filled. */
export function fillHoles(grid: Float32Array, rows: number, cols: number, nodata: number | null): number {
  const hole = (v: number) => !Number.isFinite(v) || (nodata !== null && v === nodata);
  let count = 0;
  for (const v of grid) if (hole(v)) count++;
  if (count === 0) return 0;
  if (count === grid.length) {
    grid.fill(0);
    return count;
  }
  let left = count;
  for (let pass = 0; pass < 10_000 && left > 0; pass++) {
    const next = grid.slice();
    let changed = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (!hole(grid[i])) continue;
        let sum = 0, k = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
            const v = grid[rr * cols + cc];
            if (!hole(v)) {
              sum += v;
              k++;
            }
          }
        }
        if (k) {
          next[i] = sum / k;
          changed++;
        }
      }
    }
    grid.set(next);
    left -= changed;
    if (!changed) break;
  }
  return count;
}
