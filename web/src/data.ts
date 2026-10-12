// Types for atlas/graph.json (produced by pipeline/build.py) and decoders for the binary files.

export type Side = "L" | "R" | "M";
export type Vec3 = [number, number, number];

export interface Reference { cite: string; doi?: string }
export interface Source { id: string; name?: string; provider?: string; url?: string; info?: string; license: string; extra_terms?: string; refs?: string[]; allowed: boolean; note?: string }

export interface RegionSide {
  mesh?: number;
  centroid: Vec3;
  volume_mm3?: number;
  shape?: "ellipsoid" | "capsule";
  center?: Vec3;
  radii?: Vec3;
  path?: Vec3[];
  radius?: number;
}

export interface Region {
  id: string;
  name: string;
  latin?: string;
  abbrev?: string[];
  synonyms?: string[];
  group: string;
  systems: string[];
  kind: "data" | "schematic";
  source: string;
  style: "default" | "context" | "ventricle";
  sides: Partial<Record<Side, RegionSide>>;
  anchors?: Record<string, Record<"L" | "R", Vec3>>;
  summary: string;
  clinical?: string;
  geometry_note?: string;
  verify?: boolean;
  refs: string[];
}

export interface TractPartSide { bundle?: number; mesh?: number; centerline?: Vec3[]; path?: Vec3[] }
export interface TractPart {
  kind: "data" | "schematic";
  source?: string;
  role: "main" | "branch";
  label?: string | null;
  radius?: number;
  sides: Partial<Record<Side, TractPartSide>>;
}

export interface Endpoint { region: string; side: Side; fraction: number }

export interface Tract {
  id: string;
  name: string;
  latin?: string;
  abbrev?: string[];
  synonyms?: string[];
  kind: string;
  systems: string[];
  parts: TractPart[];
  origin: string;
  course?: string;
  termination: string;
  decussation?: string;
  transmitter?: string;
  function: string;
  clinical?: string;
  endpoints?: Partial<Record<Side, Endpoint[]>>;
  refs: string[];
}

export interface PathwayStep {
  region?: string;
  tract?: string;
  side: "ipsi" | "contra";
  anchor?: string;
  parts?: number[];
  role?: string;
  note?: string;
  synapse?: boolean;
}

export interface Pathway {
  id: string;
  name: string;
  system: string;
  start_label?: string;
  summary: string;
  steps: PathwayStep[];
  highlight?: { region: string; side: "ipsi" | "contra"; note?: string }[];
  clinical?: { site: string; finding: string }[];
  routes: Record<"L" | "R", { points: Vec3[]; spans: [number, number][] }>;
  refs: string[];
}

export interface Edge { from: string; to: string; laterality: string; via: string[]; pathways: string[]; evidence: string[] }

export interface MeshItem { key: string; nv: number; ni: number; itype: "u16" | "u32"; v: number; i: number }

export interface StreamlineMeta {
  file: string;
  scale: number;
  n_streamlines: number;
  n_points: number;
  lengths_offset: number;
  points_offset: number;
  bundles: { name: string; s0: number; s1: number; p0: number; p1: number }[];
}

export interface SliceView { file: string; axis: number; indices: number[]; tile: [number, number]; cols: number; rows: number }
export interface Slices { affine: number[][]; shape: [number, number, number]; step: number; views: Record<"axial" | "coronal" | "sagittal", SliceView> }

export interface Graph {
  meta: { title: string; space: string; mesh_scale: number; version: string };
  sources: Source[];
  references: Record<string, Reference>;
  regions: Region[];
  context: { id: string; name: string; mesh: number }[];
  tracts: Tract[];
  pathways: Pathway[];
  edges: Edge[];
  meshes: { file: string; items: MeshItem[] };
  streamlines: StreamlineMeta;
  slices: Slices | null;
}

export interface MeshData { positions: Float32Array; index: Uint16Array | Uint32Array }

export interface Atlas {
  graph: Graph;
  base: string;
  meshBuf: ArrayBuffer;
  tractBuf: ArrayBuffer;
  regionById: Map<string, Region>;
  tractById: Map<string, Tract>;
  pathwayById: Map<string, Pathway>;
}

async function fetchChecked(url: string): Promise<Response> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not load ${url} (${r.status})`);
  return r;
}

/** Binary geometry; hosts that only serve text get a base64 copy named `*.b64.txt`. */
async function loadBinary(url: string): Promise<ArrayBuffer> {
  const r = await fetchChecked(url);
  if (!url.endsWith(".b64.txt")) return r.arrayBuffer();
  const s = atob((await r.text()).trim());
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

export async function loadAtlas(base: string, onProgress?: (msg: string) => void): Promise<Atlas> {
  onProgress?.("Loading knowledge graph…");
  const graph: Graph = await (await fetchChecked(`${base}/graph.json`)).json();
  onProgress?.("Loading geometry…");
  const [meshBuf, tractBuf] = await Promise.all([loadBinary(`${base}/${graph.meshes.file}`), loadBinary(`${base}/${graph.streamlines.file}`)]);
  return {
    graph,
    base,
    meshBuf,
    tractBuf,
    regionById: new Map(graph.regions.map((r) => [r.id, r])),
    tractById: new Map(graph.tracts.map((t) => [t.id, t])),
    pathwayById: new Map(graph.pathways.map((p) => [p.id, p])),
  };
}

export function decodeMesh(atlas: Atlas, index: number): MeshData {
  const it = atlas.graph.meshes.items[index];
  const q = new Int16Array(atlas.meshBuf, it.v, it.nv * 3);
  const s = 1 / atlas.graph.meta.mesh_scale;
  const positions = new Float32Array(q.length);
  for (let k = 0; k < q.length; k++) positions[k] = q[k] * s;
  const idx = it.itype === "u16" ? new Uint16Array(atlas.meshBuf, it.i, it.ni) : new Uint32Array(atlas.meshBuf, it.i, it.ni);
  return { positions, index: idx };
}

/** Streamlines of one bundle as line-segment vertex positions (pairs) plus direction colours. */
export function decodeBundle(atlas: Atlas, bundle: number): { positions: Float32Array; colors: Float32Array } {
  const m = atlas.graph.streamlines;
  const b = m.bundles[bundle];
  const lengths = new Uint16Array(atlas.tractBuf, m.lengths_offset, m.n_streamlines);
  const pts = new Int16Array(atlas.tractBuf, m.points_offset, m.n_points * 3);
  let nseg = 0;
  for (let s = b.s0; s < b.s1; s++) nseg += Math.max(0, lengths[s] - 1);
  const positions = new Float32Array(nseg * 6);
  const colors = new Float32Array(nseg * 6);
  const k = 1 / m.scale;
  let p = b.p0;
  let o = 0;
  for (let s = b.s0; s < b.s1; s++) {
    const n = lengths[s];
    for (let i = 0; i < n - 1; i++) {
      const a = (p + i) * 3;
      const c = a + 3;
      const ax = pts[a] * k, ay = pts[a + 1] * k, az = pts[a + 2] * k;
      const bx = pts[c] * k, by = pts[c + 1] * k, bz = pts[c + 2] * k;
      positions.set([ax, ay, az, bx, by, bz], o);
      const dx = bx - ax, dy = by - ay, dz = bz - az;
      const len = Math.hypot(dx, dy, dz) || 1;
      // direction-encoded colour: red = left-right, green = anterior-posterior, blue = superior-inferior
      const r = Math.abs(dx) / len, g = Math.abs(dy) / len, bl = Math.abs(dz) / len;
      colors.set([r, g, bl, r, g, bl], o);
      o += 6;
    }
    p += n;
  }
  return { positions, colors };
}

export function mirrorSide(side: "L" | "R", rel: "ipsi" | "contra"): "L" | "R" {
  return rel === "ipsi" ? side : side === "L" ? "R" : "L";
}

/** All searchable strings for an item. */
export function searchText(x: { name: string; latin?: string; abbrev?: string[]; synonyms?: string[] }): string {
  return [x.name, x.latin ?? "", ...(x.abbrev ?? []), ...(x.synonyms ?? [])].join(" | ").toLowerCase();
}
