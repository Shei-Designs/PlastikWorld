// What the engine writers share: the files an export is made of, and the
// meshes and robots resolved for them (the writers never read disks).
import type { Vec3, World } from '../model/types';
import { escapeXml, fmt } from './format';

/** Triangles in meters, Z up. */
export interface MeshData {
  positions: Float32Array;
  indices: Uint32Array;
  /** Linear RGB per vertex, or null for a plain grey. */
  colors: Float32Array | null;
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export function boundsOf(data: MeshData): Bounds {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const p = data.positions;
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : { min: [0, 0, 0], max: [0, 0, 0] };
}

/** A mesh asset as the writers see it: the GLB bytes, its triangles, and its box. */
export interface ResolvedMesh {
  glb: Uint8Array | null;
  data: MeshData | null;
  bounds: Bounds;
}

export interface Resolved {
  meshes: Record<string, ResolvedMesh>;
}

export type ExportFile = { path: string; text: string } | { path: string; bytes: Uint8Array };

/** A folder to be copied whole into the bundle (a robot package). */
export interface ExportCopy {
  from: string;
  to: string;
}

export interface ExportBundle {
  /** The bundle's folder name. */
  name: string;
  files: ExportFile[];
  copies: ExportCopy[];
  /** Things the user should know: a robot the engine cannot read, a mesh with no triangles. */
  notes: string[];
  /** How to run it, shown after the export. */
  launch: string;
}

/**
 * Claims a folder of the bundle for a robot package. Two placements of the
 * same package share it; a different package with the same model name cannot,
 * since the `model://` and `package://` URIs inside it are the folder's name,
 * so the caller leaves that one out with a note.
 */
export function claimFolder(copies: ExportCopy[], from: string, to: string): 'new' | 'shared' | 'taken' {
  const existing = copies.find((c) => c.to === to);
  if (!existing) {
    copies.push({ from, to });
    return 'new';
  }
  return existing.from === from ? 'shared' : 'taken';
}

export const vec = (v: Vec3, decimals = 6): string => v.map((x) => fmt(x, decimals)).join(' ');

/** The bundle's folder name from the world's. */
export const bundleName = (world: World): string => world.name.trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_') || 'world';

export { escapeXml, fmt };
