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

/** A mesh asset as the writers see it: the GLB bytes (none for a library part), its triangles, and its box. */
export interface ResolvedMesh {
  glb: Uint8Array | null;
  data: MeshData | null;
  bounds: Bounds;
  /** A library part's convex pieces, for the engine that collides with a mesh as its convex hull (MuJoCo). */
  pieces?: MeshData[];
}

export interface Resolved {
  meshes: Record<string, ResolvedMesh>;
}

export type ExportFile = { path: string; text: string } | { path: string; bytes: Uint8Array };

/** A robot package's files, written whole into a folder of the bundle; the world carries them under the asset. */
export interface ExportCopy {
  asset: string;
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
  /**
   * How the desktop app starts it, from the bundle's folder: a program (which
   * the user may point elsewhere, a venv's Python say), its arguments, and
   * any other programs the run needs on the PATH, checked before offering it.
   */
  run?: { program: string; args: string[]; needs: string[] };
}

/**
 * Claims a folder of the bundle for a robot package. Two placements of the
 * same package share it; a different package with the same model name cannot,
 * since the `model://` and `package://` URIs inside it are the folder's name,
 * so the caller leaves that one out with a note.
 */
export function claimFolder(copies: ExportCopy[], asset: string, to: string): 'new' | 'shared' | 'taken' {
  const existing = copies.find((c) => c.to === to);
  if (!existing) {
    copies.push({ asset, to });
    return 'new';
  }
  return existing.asset === asset ? 'shared' : 'taken';
}

export const vec = (v: Vec3, decimals = 6): string => v.map((x) => fmt(x, decimals)).join(' ');

/** The bundle's folder name from the world's. */
export const bundleName = (world: World): string => world.name.trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_') || 'world';

export { escapeXml, fmt };
