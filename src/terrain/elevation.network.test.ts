// The one test that goes out on the network: a Copernicus GLO-30 tile read in
// place from AWS Open Data with range requests. Skipped unless asked for
// (PLASTIKWORLD_NETWORK=1), since CI and a train have no business fetching it.
import { describe, expect, it } from 'vitest';
import { boxAround, copernicusTile, heightsFromDem, openDemUrl } from './elevation';

const online = process.env.PLASTIKWORLD_NETWORK === '1';

describe.skipIf(!online)('Copernicus DEM over the network', () => {
  it('reads a few kilometres around the Matterhorn, summit and all', async () => {
    const tile = copernicusTile(45.9763, 7.6586);
    const dem = await openDemUrl(tile.name, tile.url, (url, init) => fetch(url, init));
    expect(dem.geographic).toBe(true);
    expect([dem.width, dem.height]).toEqual([3600, 3600]);
    const box = boxAround(dem, 45.9763, 7.6586, 2000);
    const result = await heightsFromDem(dem, box, { samples: 129, exaggeration: 1, levelLowest: false });
    expect(result.size[0]).toBeGreaterThan(3500);
    expect(result.size[1]).toBeGreaterThan(3500);
    // The Matterhorn is 4478 m; the 30 m DEM's highest sample, resampled onto a 31 m grid, lands around 4330 m.
    expect(result.highest).toBeGreaterThan(4200);
    expect(result.highest).toBeLessThan(4500);
    expect(result.lowest).toBeGreaterThan(2000);
    expect(result.filled).toBe(0);
  }, 120_000);
});
