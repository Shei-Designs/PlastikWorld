import { describe, expect, it } from 'vitest';
import { flatHeights, gazeboSize, heightAt, resample, rollingField } from './heightmap';
import { encodeGreyPng } from './png';
import type { Terrain } from '../model/types';

const ramp: Terrain = { kind: 'heightmap', size: [4, 2], friction: 1, rows: 2, cols: 3, height: 2, heights: [0, 0.5, 1, 0, 0.5, 1] };

describe('heightmaps', () => {
  it('samples heights bilinearly in meters', () => {
    expect(heightAt(ramp, -2, 0)).toBeCloseTo(0);
    expect(heightAt(ramp, 0, 0)).toBeCloseTo(1);
    expect(heightAt(ramp, 2, 1)).toBeCloseTo(2);
    expect(heightAt(ramp, 1, -0.5)).toBeCloseTo(1.5);
    expect(heightAt(ramp, 9, 9)).toBe(0);
    expect(heightAt({ kind: 'plane', size: [1, 1], friction: 1 }, 0, 0)).toBe(0);
  });

  it('resamples onto a square grid', () => {
    const out = resample(ramp, 5);
    expect(out).toHaveLength(25);
    expect(out[0]).toBeCloseTo(0);
    expect(out[4]).toBeCloseTo(1);
    expect(out[2]).toBeCloseTo(0.5);
    expect(out[24]).toBeCloseTo(1);
  });

  it('picks the 2^n + 1 size Gazebo wants', () => {
    expect(gazeboSize(2)).toBe(3);
    expect(gazeboSize(65)).toBe(65);
    expect(gazeboSize(66)).toBe(129);
    expect(gazeboSize(200)).toBe(257);
  });

  it('makes a field that is flat in the middle and within 0..1', () => {
    const field = rollingField(33, 33);
    expect(field).toHaveLength(33 * 33);
    expect(field.every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(field[16 * 33 + 16]).toBeCloseTo(0.5);
    expect(flatHeights(2, 2)).toEqual([0, 0, 0, 0]);
  });

  it('writes a 16-bit greyscale PNG', () => {
    const png = encodeGreyPng(3, 2, [0, 0.5, 1, 1, 0.5, 0]);
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(png.buffer, png.byteOffset);
    expect(view.getUint32(16)).toBe(3); // width
    expect(view.getUint32(20)).toBe(2); // height
    expect(png[24]).toBe(16); // bit depth
    expect(png[25]).toBe(0); // greyscale
    expect(new TextDecoder().decode(png.subarray(png.length - 8, png.length - 4))).toBe('IEND');
  });
});
