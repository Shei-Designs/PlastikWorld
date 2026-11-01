import { describe, expect, it } from 'vitest';
import { writeArrayBuffer } from 'geotiff';
import { boxAround, boxMeters, copernicusTile, fillHoles, heightsFromDem, openDem } from './elevation';

/**
 * A GeoTIFF as a DEM tile is: one band of heights, north up, georeferenced in
 * degrees (EPSG:4326) with a tie point at the top-left corner and a pixel
 * scale. 60 × 40 pixels of 0.01°, a ramp rising to the east and north, a
 * no-data hole in the middle.
 */
function tile(): Uint8Array {
  const width = 60, height = 40;
  const values = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) values[y * width + x] = 100 + x * 2 + (height - 1 - y) * 3;
  values[20 * width + 30] = -9999;
  values[20 * width + 31] = -9999;
  const buffer = writeArrayBuffer(values, {
    width,
    height,
    BitsPerSample: [32],
    SampleFormat: [3],
    SamplesPerPixel: 1,
    PhotometricInterpretation: 1,
    ModelTiepoint: [0, 0, 0, 7, 46, 0],
    ModelPixelScale: [0.01, 0.01, 0],
    GTModelTypeGeoKey: 2,
    GTRasterTypeGeoKey: 1,
    GeographicTypeGeoKey: 4326,
    GDAL_NODATA: '-9999',
  });
  return new Uint8Array(buffer);
}

describe('elevation from a GeoTIFF', () => {
  it('reads the tile as a geographic DEM with a preview', async () => {
    const dem = await openDem('tile.tif', tile());
    expect([dem.width, dem.height]).toEqual([60, 40]);
    expect(dem.geographic).toBe(true);
    expect(dem.bbox.map((v) => Math.round(v * 100) / 100)).toEqual([7, 45.6, 7.6, 46]);
    expect(dem.nodata).toBe(-9999);
    expect(dem.preview.width).toBe(60);
    expect(dem.previewRange[0]).toBeCloseTo(100);
  });

  it('puts a box on the grid in meters, north up, holes filled', async () => {
    const dem = await openDem('tile.tif', tile());
    const box = { x0: 20, y0: 10, x1: 40, y1: 30 };
    const [w, d] = boxMeters(dem, box);
    // 20 pixels of 0.01° : 0.2° of latitude is 22.3 km; of longitude at 45.8° about 15.5 km.
    expect(d).toBeCloseTo(0.2 * 111320, 0);
    expect(w).toBeCloseTo(0.2 * 111320 * Math.cos((45.8 * Math.PI) / 180), 0);
    const result = await heightsFromDem(dem, box, { samples: 65, exaggeration: 1, levelLowest: false });
    expect(result.heights).toHaveLength(65 * 65);
    expect(result.filled).toBeGreaterThan(0);
    // South-west corner of the box: x = 20, image row 29 (the bottom of the box) → 100 + 40 + (39 - 29) * 3.
    expect(result.heights[0]).toBeCloseTo(170, 0);
    // North-east corner: x = 39, image row 10 → 100 + 78 + 29 * 3.
    expect(result.heights[65 * 65 - 1]).toBeCloseTo(265, 0);
    // The hole at (30, 20) was filled with something near its neighbours, not -9999.
    expect(Math.min(...result.heights)).toBeGreaterThan(160);
    expect(result.lowest).toBeCloseTo(170, 0);
    const levelled = await heightsFromDem(dem, box, { samples: 65, exaggeration: 2, levelLowest: true });
    expect(levelled.heights[0]).toBeCloseTo(0, 0);
    expect(levelled.highest).toBeCloseTo((265 - 170) * 2, 0);
  });

  it('finds the box around a place and names the Copernicus tile', async () => {
    const dem = await openDem('tile.tif', tile());
    const box = boxAround(dem, 45.8, 7.3, 2000);
    expect(box.x0).toBeLessThan(30);
    expect(box.x1).toBeGreaterThan(30);
    expect(box.y0).toBeLessThan(20);
    expect(box.y1).toBeGreaterThan(20);
    const [w, d] = boxMeters(dem, box);
    expect(w).toBeGreaterThan(3500);
    expect(d).toBeGreaterThan(3500);
    expect(copernicusTile(45.8, 7.3)).toEqual({ name: 'Copernicus_DSM_COG_10_N45_00_E007_00_DEM', url: 'https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N45_00_E007_00_DEM/Copernicus_DSM_COG_10_N45_00_E007_00_DEM.tif' });
    expect(copernicusTile(-33.9, -70.6).name).toBe('Copernicus_DSM_COG_10_S34_00_W071_00_DEM');
  });

  it('fills holes from their neighbours', () => {
    const grid = new Float32Array([1, 1, 1, 1, NaN, 1, 1, 1, 1]);
    expect(fillHoles(grid, 3, 3, null)).toBe(1);
    expect(grid[4]).toBe(1);
  });
});
