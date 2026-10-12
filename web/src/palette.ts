// Colour per functional system (Okabe-Ito based, colour-blind friendly where possible).
export const SYSTEM_COLORS: Record<string, string> = {
  motor: "#e05a2b",
  somatosensory: "#2f8fd8",
  pain: "#2f8fd8",
  cerebellar: "#8e63ce",
  basal_ganglia: "#e6a700",
  limbic: "#d94f8a",
  memory: "#d94f8a",
  reward: "#d94f8a",
  visual: "#14a38b",
  visuospatial: "#4cb5a0",
  auditory: "#7ba428",
  vestibular: "#9bb04a",
  language: "#f08c3c",
  executive: "#6a8fbf",
  oculomotor: "#b07a5a",
  cranial_nerves: "#c27c58",
  autonomic: "#a0785a",
  arousal: "#c9a227",
  interoceptive: "#c06c84",
  gustatory: "#c06c84",
  olfactory: "#b5838d",
  interhemispheric: "#8d96a3",
  landmark: "#7f8a99",
};

export const SYSTEM_LABELS: Record<string, string> = {
  motor: "Motor",
  somatosensory: "Somatosensory",
  cerebellar: "Cerebellar",
  basal_ganglia: "Basal ganglia",
  limbic: "Limbic & memory",
  visual: "Visual",
  auditory: "Auditory",
  vestibular: "Vestibular",
  language: "Language",
  executive: "Executive",
  oculomotor: "Oculomotor",
  cranial_nerves: "Cranial nerves",
  autonomic: "Autonomic",
  arousal: "Arousal",
  pain: "Pain modulation",
  olfactory: "Olfactory",
  gustatory: "Gustatory",
  visuospatial: "Visuospatial",
  interhemispheric: "Commissural",
  landmark: "Landmarks",
};

export function colorFor(systems: string[], style?: string): string {
  if (style === "ventricle") return "#5aa9e6";
  if (style === "context") return "#a9b1bd";
  for (const s of systems) if (SYSTEM_COLORS[s]) return SYSTEM_COLORS[s];
  return "#9aa3ad";
}

/** Shade for the n-th neuron of a pathway: full colour and a lighter tint alternate, so each relay is visible. */
export const NEURON_TINT = 0.45;
export function neuronShade(hex: string, order: number): string {
  if (order % 2 === 0) return hex;
  const v = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * NEURON_TINT);
  const r = mix((v >> 16) & 255), g = mix((v >> 8) & 255), b = mix(v & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
