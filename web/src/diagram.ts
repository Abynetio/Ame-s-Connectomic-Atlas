// 2D views linked to the 3D scene:
//  - "Pathway wiring": the selected pathway as a left / midline / right lane diagram, one row per step,
//    with each neuron's stretch shaded, cell bodies, synapses and midline crossings marked.
//  - "Connectogram": every region-to-region projection of the knowledge graph on a ring, grouped by
//    level of the neuraxis (in the spirit of the Edlow et al. connectograms, drawn from this atlas's own data).
import { ALLOCORTEX, Atlas, Edge, Pathway, Region, Side, mirrorSide, pathwayNeurons } from "./data";
import { EFFECT_COLOR, EFFECT_SIGN, Effect, colorFor, neuronShade, transmitterShort } from "./palette";

export type DiagramSel = { type: "pathway" | "tract" | "region"; id: string } | null;
export interface DiagramState { sel: DiagramSel; start: "L" | "R"; step: number; system: string | null; overview?: boolean }
export interface DiagramHooks { select(sel: NonNullable<DiagramSel>): void; step(k: number): void }

const SVG = "http://www.w3.org/2000/svg";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function sv(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** Neuraxis levels, rostral to caudal; also the order of the connectogram ring. */
const LEVELS: { key: string; label: string; color: string; match: (g: string) => boolean }[] = [
  { key: "cortex", label: "Cerebral cortex", color: "#5b7bd5", match: (g) => g.startsWith("cortex") },
  { key: "forebrain", label: "Basal forebrain & ganglia", color: "#d29a1e", match: (g) => g.startsWith("basal_ganglia") || g === "basal_forebrain" || g === "telencephalon" },
  { key: "diencephalon", label: "Diencephalon", color: "#3fa39a", match: (g) => g.startsWith("diencephalon") || g === "visual" },
  { key: "midbrain", label: "Midbrain", color: "#a35fc4", match: (g) => g === "mesencephalon" },
  { key: "pons", label: "Pons", color: "#c4607a", match: (g) => g === "brainstem.pons" || g === "brainstem" },
  { key: "cerebellum", label: "Cerebellum", color: "#7b62d6", match: (g) => g.startsWith("cerebellum") },
  { key: "medulla", label: "Medulla", color: "#d0743c", match: (g) => g === "brainstem.medulla" },
  { key: "spinal", label: "Spinal cord", color: "#6f8a3a", match: (g) => g === "spinal" },
  { key: "peripheral", label: "Peripheral", color: "#8a8f98", match: (g) => g === "peripheral" },
];

function levelIndex(group: string): number {
  const i = LEVELS.findIndex((l) => l.match(group));
  return i < 0 ? LEVELS.length : i;
}

const SUBGROUP: Record<string, string> = {
  "cortex.frontal": "frontal", "cortex.parietal": "parietal", "cortex.temporal": "temporal", "cortex.occipital": "occipital",
  "cortex.limbic": "limbic", "cortex.insula": "insula", "basal_ganglia.striatum": "striatum", "basal_ganglia.pallidum": "pallidum",
  "basal_ganglia.subthalamus": "subthalamus", "diencephalon.thalamus": "thalamus", "diencephalon.hypothalamus": "hypothalamus",
  "diencephalon.epithalamus": "epithalamus", "cerebellum.nuclei": "deep nuclei",
};

function levelName(r: Region): string {
  const l = LEVELS[levelIndex(r.group)];
  const sub = SUBGROUP[r.group];
  return l ? (sub ? `${l.label.split(" &")[0]} · ${sub}` : l.label) : r.group;
}

function shortName(r: Region, max = 22, abbrevOk = true): string {
  const a = r.abbrev?.[0];
  if (abbrevOk && a && a.length <= 6 && r.name.length > max) return a;
  return r.name.length > max ? r.name.slice(0, max - 1) + "…" : r.name;
}

const HOME_VB = { x: 40, y: 40, w: 1120, h: 1120 };

/**
 * Synapse ending in textbook notation, pointing along (ux, uy) and ending at (x, y):
 * arrowhead = excitatory or mixed, bar = inhibitory, dot = modulatory.
 */
function synapseHead(x: number, y: number, ux: number, uy: number, effect: Effect | undefined, size: number, cls: string, fill: string): SVGElement {
  const px = -uy, py = ux;
  if (effect === "inhibitory") {
    const bx = x - ux * size * 0.25, by = y - uy * size * 0.25;
    return sv("path", { d: `M ${bx + px * size * 0.75} ${by + py * size * 0.75} L ${bx - px * size * 0.75} ${by - py * size * 0.75}`, class: `${cls} bar`, style: `stroke:${fill};stroke-width:${size * 0.38}px`, "stroke-linecap": "round" });
  }
  if (effect === "modulatory") return sv("circle", { cx: x - ux * size * 0.5, cy: y - uy * size * 0.5, r: size * 0.48, class: cls, fill });
  const bx = x - ux * size, by = y - uy * size;
  return sv("path", { d: `M ${x} ${y} L ${bx + px * size * 0.5} ${by + py * size * 0.5} L ${bx - px * size * 0.5} ${by - py * size * 0.5} Z`, class: cls, fill });
}

const ORDINAL = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth"];

export class Diagram {
  private atlas: Atlas;
  private hooks: DiagramHooks;
  private root: HTMLElement;
  private body: HTMLElement;
  private tip: HTMLElement;
  private tabs: Record<"pathway" | "network", HTMLButtonElement>;
  private tab: "pathway" | "network" = "pathway";
  private userTab: "pathway" | "network" | null = null;
  private state: DiagramState = { sel: null, start: "L", step: 0, system: null };
  private visible = false;
  private dirty = true;
  // connectogram view box (pan / zoom)
  private vb = { ...HOME_VB };
  private ringSvg: SVGSVGElement | null = null;
  private laneCleanup: (() => void) | null = null;

  constructor(root: HTMLElement, atlas: Atlas, hooks: DiagramHooks) {
    this.atlas = atlas;
    this.hooks = hooks;
    this.root = root;
    const bar = el("div", "dg-bar");
    const seg = el("div", "segmented dg-tabs");
    seg.setAttribute("role", "tablist");
    this.tabs = {
      pathway: el("button", "", "Pathway wiring"),
      network: el("button", "", "Connectogram"),
    };
    for (const k of ["pathway", "network"] as const) {
      this.tabs[k].type = "button";
      this.tabs[k].addEventListener("click", () => {
        this.userTab = k;
        this.tab = k;
        this.dirty = true;
        this.render();
      });
      seg.append(this.tabs[k]);
    }
    const reset = el("button", "ghost dg-reset", "Reset zoom");
    reset.type = "button";
    reset.addEventListener("click", () => {
      this.vb = { ...HOME_VB };
      this.applyViewBox();
    });
    bar.append(seg, el("span", "dg-legend muted"), reset);
    this.body = el("div", "dg-body");
    this.tip = el("div", "dg-tip");
    this.tip.hidden = true;
    root.append(bar, this.body, this.tip);
  }

  setVisible(v: boolean) {
    this.visible = v;
    if (v) this.render();
  }

  update(state: DiagramState) {
    const pathwayChanged = state.sel?.id !== this.state.sel?.id || state.sel?.type !== this.state.sel?.type || state.start !== this.state.start || state.system !== this.state.system || !!state.overview !== !!this.state.overview;
    this.state = { ...state };
    // follow the selection unless the student picked a tab by hand
    const want = state.sel?.type === "pathway" ? "pathway" : "network";
    // on the all-pathways map the connectogram leads, unless the student asked for the wiring
    if (state.overview) this.tab = state.sel && this.userTab === "pathway" ? "pathway" : "network";
    else if (state.sel?.type !== "pathway") this.tab = "network";
    else this.tab = this.userTab ?? want;
    if (pathwayChanged || this.tab === "network") this.dirty = true;
    if (this.visible) this.render();
  }

  // ------------------------------------------------------------------ shared
  private render() {
    const isPw = this.state.sel?.type === "pathway";
    this.tabs.pathway.disabled = !isPw;
    this.tabs.pathway.title = isPw ? "" : "Select a pathway to see its wiring";
    for (const k of ["pathway", "network"] as const) this.tabs[k].classList.toggle("active", this.tab === k);
    this.root.classList.toggle("network", this.tab === "network");
    const legend = this.root.querySelector(".dg-legend")!;
    if (this.tab === "pathway" && isPw) {
      if (this.dirty) this.renderPathway(this.atlas.pathwayById.get(this.state.sel!.id)!);
      else this.markLaneStep();
      legend.textContent = "● cell body · synapse: ▼ excitatory, ⊥ inhibitory, ○ modulatory · ✕ crosses the midline · dashed box = axons pass through";
    } else {
      this.renderNetwork();
      legend.textContent = "Arrow = excitatory, bar = inhibitory, dot = modulatory projection · dashed = crossed · colour = system · scroll to zoom, drag to pan";
    }
    this.dirty = false;
  }

  private showTip(e: MouseEvent, html: string) {
    this.tip.innerHTML = html;
    this.tip.hidden = false;
    const r = this.root.getBoundingClientRect();
    const x = Math.min(e.clientX - r.left + 14, r.width - this.tip.offsetWidth - 6);
    this.tip.style.left = `${Math.max(4, x)}px`;
    this.tip.style.top = `${e.clientY - r.top + 12}px`;
  }

  private hideTip = () => {
    this.tip.hidden = true;
  };

  private regionSide(regionId: string, rel: "ipsi" | "contra"): Side {
    const r = this.atlas.regionById.get(regionId)!;
    return r.sides.M ? "M" : mirrorSide(this.state.start, rel);
  }

  private tractSide(tractId: string, rel: "ipsi" | "contra"): Side {
    const t = this.atlas.tractById.get(tractId)!;
    return t.parts.every((p) => !!p.sides.M) ? "M" : mirrorSide(this.state.start, rel);
  }

  // ------------------------------------------------------------------ pathway wiring
  private renderPathway(pw: Pathway) {
    this.laneCleanup?.();
    this.ringSvg = null;
    this.body.innerHTML = "";
    const base = colorFor([pw.system]);
    const neurons = pathwayNeurons(pw);
    const neuronOfLink = (k: number) => neurons.find((n) => k >= n.from && k < n.to);
    const regionSteps = pw.steps.map((s, i) => (s.region ? i : -1)).filter((i) => i >= 0);
    const lv = (i: number) => levelIndex(this.atlas.regionById.get(pw.steps[i].region!)!.group);
    // ascending pathways (caudal → rostral) are drawn bottom-to-top so cortex is always at the top
    const ascending = regionSteps.length > 1 && lv(regionSteps[0]) > lv(regionSteps[regionSteps.length - 1]);

    const wrap = el("div", "lane-wrap");
    const grid = el("div", "lanes");
    const head = (txt: string, col: number) => {
      const d = el("div", "lane-head", txt);
      d.style.gridColumn = String(col);
      d.style.gridRow = "1";
      return d;
    };
    grid.append(head("Left", 1), head("midline", 2), head("Right", 3));
    const svg = sv("svg", { class: "lane-svg" }) as SVGSVGElement;
    const items: HTMLElement[] = [];
    const sides: Side[] = [];
    const n = pw.steps.length;
    pw.steps.forEach((st, k) => {
      const row = (ascending ? n - 1 - k : k) + 2;
      const side = st.region ? this.regionSide(st.region, st.side) : this.tractSide(st.tract!, st.side);
      sides.push(side);
      const col = side === "L" ? "1" : side === "R" ? "3" : "1 / span 3";
      let item: HTMLElement;
      if (st.region) {
        const r = this.atlas.regionById.get(st.region)!;
        const synaptic = st.synapse !== false;
        const outN = neurons.find((x) => x.from === k);
        const inN = neurons.find((x) => x.to === k);
        item = el("button", "lane-box" + (synaptic ? "" : " pass") + (side === "M" ? " mid" : ""));
        item.style.borderLeftColor = outN ? neuronShade(base, outN.order) : inN ? neuronShade(base, inN.order) : "var(--line)";
        const name = el("div", "lb-name", r.name);
        const lev = el("div", "lb-level", levelName(r));
        item.append(name, lev);
        const roles: string[] = [];
        if (inN) roles.push(`▲ ${ORDINAL[inN.order] ?? inN.order + 1}-order synapse`);
        if (outN) roles.push(`● ${ORDINAL[outN.order] ?? outN.order + 1}-order cell bodies`);
        if (!synaptic) roles.push(neurons.length && k < neurons[0].from ? "sensory endings" : "axons pass through");
        if (roles.length) item.append(el("div", "lb-role", roles.join(" · ")));
        const src = inN ? pw.steps[inN.from] : undefined;
        if (src?.transmitter && src.effect) {
          const tx = el("div", "lb-tx");
          const chip = el("span", "tx-chip", `${transmitterShort(src.transmitter)} ${EFFECT_SIGN[src.effect]}`);
          chip.style.background = EFFECT_COLOR[src.effect];
          tx.append(chip, ` ${src.transmitter} · ${src.effect}`);
          tx.title = src.transmitter_note ?? "";
          item.append(tx);
        }
        if (st.layer_in || st.layer_out) {
          const allo = ALLOCORTEX.has(r.id);
          const f = (v: string) => (allo ? v : `L${v}`);
          const parts = [st.layer_in ? `in: ${f(st.layer_in)}` : "", st.layer_out ? `out: ${f(st.layer_out)}` : ""].filter(Boolean);
          item.append(el("div", "lb-layer", `Cortical layer ${parts.join(" · ")}`));
        }
        item.title = st.role ?? r.name;
      } else {
        const t = this.atlas.tractById.get(st.tract!)!;
        const nn = neuronOfLink(k);
        item = el("button", "lane-pill" + (side === "M" ? " mid" : ""), t.name);
        item.style.borderColor = nn ? neuronShade(base, nn.order) : "var(--line)";
        item.title = st.note ?? t.name;
      }
      (item as HTMLButtonElement).type = "button";
      item.style.gridColumn = col;
      item.style.gridRow = String(row);
      item.dataset.step = String(k);
      item.addEventListener("click", () => this.hooks.step(k));
      grid.append(item);
      items.push(item);
    });
    const midline = el("div", "lane-mid");
    midline.style.gridRow = `1 / span ${n + 1}`;
    grid.append(midline);
    wrap.append(svg, grid);
    this.body.append(wrap);
    if (pw.highlight?.length) {
      const also = el("p", "muted dg-also");
      also.textContent = "Also note: " + pw.highlight.map((x) => this.atlas.regionById.get(x.region)?.name ?? x.region).join(", ");
      this.body.append(also);
    }

    const draw = () => {
      svg.innerHTML = "";
      const box = wrap.getBoundingClientRect();
      svg.setAttribute("width", String(box.width));
      svg.setAttribute("height", String(box.height));
      const midX = midline.getBoundingClientRect().left - box.left + midline.offsetWidth / 2;
      const defs = sv("defs");
      svg.append(defs);
      for (let k = 0; k + 1 < n; k++) {
        const a = items[k].getBoundingClientRect(), b = items[k + 1].getBoundingClientRect();
        const ax = a.left - box.left + a.width / 2, bx = b.left - box.left + b.width / 2;
        // edge leaves the side of the box facing the next item
        const ay = ascending ? a.top - box.top : a.bottom - box.top;
        const by = ascending ? b.bottom - box.top : b.top - box.top;
        const nn = neuronOfLink(k);
        const color = nn ? neuronShade(base, nn.order) : "#9aa3ad";
        const my = (ay + by) / 2;
        const d = `M ${ax} ${ay} C ${ax} ${my}, ${bx} ${my}, ${bx} ${by}`;
        svg.append(sv("path", { d, class: "lane-link", stroke: color }));
        // synapse: arrowhead into the target box
        const st = pw.steps[k + 1];
        if (st.region && st.synapse !== false) {
          const dir = ascending ? -1 : 1;
          const src = neurons.find((x) => x.to === k + 1);
          const eff = src ? pw.steps[src.from].effect : undefined;
          svg.append(synapseHead(bx, by, 0, dir, eff, 12, "lane-syn", eff ? EFFECT_COLOR[eff] : color));
        }
        // cell body: dot where the axon leaves its parent region
        const sa = pw.steps[k];
        if (sa.region && neurons.some((x) => x.from === k)) svg.append(sv("circle", { cx: ax, cy: ay, r: 5.5, class: "lane-soma", fill: color }));
        // midline crossing
        const sl = sides[k], sr = sides[k + 1];
        if (sl !== "M" && sr !== "M" && sl !== sr) {
          const g = sv("g", { class: "lane-cross" });
          g.append(sv("circle", { cx: midX, cy: my, r: 8 }));
          const t = sv("text", { x: midX, y: my + 4, "text-anchor": "middle" });
          t.textContent = "✕";
          g.append(t);
          const tt = sv("title");
          tt.textContent = `Crosses the midline between ${pw.steps[k].region ?? this.atlas.tractById.get(pw.steps[k].tract!)?.name} and ${this.atlas.tractById.get(pw.steps[k + 1].tract ?? "")?.name ?? pw.steps[k + 1].region}`;
          g.append(tt);
          svg.append(g);
        }
      }
    };
    const ro = new ResizeObserver(() => draw());
    ro.observe(wrap);
    this.laneCleanup = () => ro.disconnect();
    requestAnimationFrame(draw);
    this.markLaneStep();
  }

  private markLaneStep() {
    this.body.querySelectorAll<HTMLElement>("[data-step]").forEach((e) => {
      const cur = Number(e.dataset.step) === this.state.step;
      e.classList.toggle("current", cur);
      if (cur && this.visible) e.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }

  // ------------------------------------------------------------------ connectogram
  private networkNodes(): Region[] {
    const ids = new Set<string>();
    for (const e of this.atlas.graph.edges) ids.add(e.from).add(e.to);
    const regions = [...ids].map((id) => this.atlas.regionById.get(id)!).filter(Boolean);
    const c = (r: Region) => (r.sides.L ?? r.sides.M ?? r.sides.R)!.centroid;
    const sub = (r: Region) => Object.keys(SUBGROUP).indexOf(r.group);
    return regions.sort((a, b) => {
      const la = levelIndex(a.group), lb = levelIndex(b.group);
      if (la !== lb) return la - lb;
      if (sub(a) !== sub(b)) return sub(a) - sub(b);
      // within a level: brainstem / cord rostral to caudal, everything else anterior to posterior
      return la >= 3 ? c(b)[2] - c(a)[2] : c(b)[1] - c(a)[1];
    });
  }

  private renderNetwork() {
    this.laneCleanup?.();
    this.laneCleanup = null;
    if (!this.ringSvg) {
      this.body.innerHTML = "";
      this.ringSvg = this.buildRing();
      this.body.append(this.ringSvg);
    }
    this.highlightRing();
  }

  private edgeKey(e: Edge) {
    return `${e.from}>${e.to}>${e.laterality}`;
  }

  private buildRing(): SVGSVGElement {
    const C = 600, R = 360;
    const svg = sv("svg", { class: "ring" }) as SVGSVGElement;
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    const nodes = this.networkNodes();
    // abbreviations shared by several nodes (e.g. two dorsal root ganglia) would be ambiguous
    const abbrevCount = new Map<string, number>();
    for (const r of nodes) if (r.abbrev?.[0]) abbrevCount.set(r.abbrev[0], (abbrevCount.get(r.abbrev[0]) ?? 0) + 1);
    // angles with a gap between levels
    const GAP = 1.6;
    let slots = 0;
    nodes.forEach((r, i) => (slots += i && levelIndex(r.group) !== levelIndex(nodes[i - 1].group) ? GAP + 1 : 1));
    const step = (2 * Math.PI) / (slots + GAP);
    const ang = new Map<string, number>();
    let s = 0;
    nodes.forEach((r, i) => {
      if (i && levelIndex(r.group) !== levelIndex(nodes[i - 1].group)) s += GAP;
      ang.set(r.id, s * step);
      s += 1;
    });
    // centre the cortex block at the top
    const cortexIds = nodes.filter((r) => levelIndex(r.group) === 0).map((r) => ang.get(r.id)!);
    const rot = -Math.PI / 2 - (cortexIds.length ? (cortexIds[0] + cortexIds[cortexIds.length - 1]) / 2 : 0);
    for (const [k, v] of ang) ang.set(k, v + rot);
    const pos = (a: number, r: number) => [C + r * Math.cos(a), C + r * Math.sin(a)] as const;

    // level arcs and names
    const levelG = sv("g", { class: "ring-levels" });
    LEVELS.forEach((L, li) => {
      const members = nodes.filter((r) => levelIndex(r.group) === li);
      if (!members.length) return;
      const a0 = ang.get(members[0].id)! - step * 0.45, a1 = ang.get(members[members.length - 1].id)! + step * 0.45;
      const r = R + 152;
      const [x0, y0] = pos(a0, r), [x1, y1] = pos(a1, r);
      levelG.append(sv("path", { d: `M ${x0} ${y0} A ${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1} ${y1}`, stroke: L.color, class: "ring-arc" }));
      const am = (a0 + a1) / 2;
      const [tx, ty] = pos(am, R + 172);
      const t = sv("text", { x: tx, y: ty, class: "ring-level", "text-anchor": "middle", "dominant-baseline": "middle", fill: L.color });
      t.textContent = L.label;
      // keep level names upright and tangent to the ring
      let deg = ((((am * 180) / Math.PI + 90) % 360) + 360) % 360;
      if (deg > 90 && deg < 270) deg -= 180;
      t.setAttribute("transform", `rotate(${deg} ${tx} ${ty})`);
      levelG.append(t);
    });
    svg.append(levelG);

    // edges: quadratic curves bowed towards the centre
    const edgeG = sv("g", { class: "ring-edges" });
    for (const e of this.atlas.graph.edges) {
      const a = ang.get(e.from), b = ang.get(e.to);
      if (a === undefined || b === undefined) continue;
      const [x0, y0] = pos(a, R - 9), [x1, y1] = pos(b, R - 9);
      const pull = 0.18;
      const qx = C + ((x0 + x1) / 2 - C) * pull, qy = C + ((y0 + y1) / 2 - C) * pull;
      const pw = this.atlas.pathwayById.get(e.pathways[0]);
      const color = colorFor(pw ? [pw.system] : []);
      const g = sv("g", { class: "ring-edge" + (e.laterality === "contralateral" ? " contra" : "") });
      g.dataset.key = this.edgeKey(e);
      g.style.setProperty("--c", color);
      // arrowhead at the target, along the curve's end tangent
      const tx = x1 - qx, ty = y1 - qy, tl = Math.hypot(tx, ty) || 1;
      const ux = tx / tl, uy = ty / tl;
      const hx = x1 - ux * 4, hy = y1 - uy * 4;
      const w = 1.6 + Math.min(3, e.pathways.length - 1);
      const path = sv("path", { d: `M ${x0} ${y0} Q ${qx} ${qy} ${hx - ux * 8} ${hy - uy * 8}`, class: "re-line", "stroke-width": w });
      const effects = new Set((e.transmitters ?? []).map((t) => t.effect));
      const eff: Effect | undefined = effects.size === 1 ? [...effects][0] : effects.size > 1 ? "mixed" : undefined;
      const head = synapseHead(hx, hy, ux, uy, eff, 13, "re-head", "currentColor");
      const hit = sv("path", { d: `M ${x0} ${y0} Q ${qx} ${qy} ${x1} ${y1}`, class: "re-hit" });
      g.append(path, head, hit);
      g.addEventListener("mousemove", (ev) => this.showTip(ev as MouseEvent, this.edgeTip(e)));
      g.addEventListener("mouseleave", this.hideTip);
      g.addEventListener("click", () => {
        const cur = this.state.sel?.type === "pathway" && e.pathways.includes(this.state.sel.id) ? this.state.sel.id : e.pathways[0];
        this.hooks.select({ type: "pathway", id: cur });
      });
      edgeG.append(g);
    }
    svg.append(edgeG);

    // nodes and radial labels
    const nodeG = sv("g", { class: "ring-nodes" });
    for (const r of nodes) {
      const a = ang.get(r.id)!;
      const [x, y] = pos(a, R);
      const color = LEVELS[levelIndex(r.group)]?.color ?? "#999";
      const g = sv("g", { class: "ring-node" });
      g.dataset.id = r.id;
      g.append(sv("circle", { cx: x, cy: y, r: 6.5, fill: color, class: r.kind === "schematic" ? "schematic" : "" }));
      const [lx, ly] = pos(a, R + 13);
      let deg = (a * 180) / Math.PI;
      const flip = Math.cos(a) < 0;
      if (flip) deg += 180;
      const t = sv("text", { x: lx, y: ly, "text-anchor": flip ? "end" : "start", "dominant-baseline": "middle", transform: `rotate(${deg} ${lx} ${ly})` });
      t.textContent = shortName(r, 19, (abbrevCount.get(r.abbrev?.[0] ?? "") ?? 0) < 2);
      g.append(t);
      g.addEventListener("mousemove", (ev) => {
        const outs = this.atlas.graph.edges.filter((x) => x.from === r.id).length, ins = this.atlas.graph.edges.filter((x) => x.to === r.id).length;
        this.showTip(ev as MouseEvent, `<strong>${r.name}</strong><br><span class="muted">${levelName(r)} · projects to ${outs}, receives from ${ins}</span>`);
        svg.classList.add("hovering");
        this.ringFocus(new Set([r.id]), null, "hover");
      });
      g.addEventListener("mouseleave", () => {
        this.hideTip();
        svg.classList.remove("hovering");
        this.highlightRing();
      });
      g.addEventListener("click", () => this.hooks.select({ type: "region", id: r.id }));
      nodeG.append(g);
    }
    svg.append(nodeG);
    this.attachPanZoom(svg);
    this.ringSvg = svg;
    this.applyViewBox();
    return svg;
  }

  private edgeTip(e: Edge): string {
    const name = (id: string) => this.atlas.regionById.get(id)?.name ?? id;
    const via = e.via.map((v) => this.atlas.tractById.get(v)?.name ?? v).join(", ");
    const pws = e.pathways.map((p) => this.atlas.pathwayById.get(p)?.name ?? p).join("; ");
    const tx = (e.transmitters ?? []).map((t) => `<span class="tx-chip" style="background:${EFFECT_COLOR[t.effect]}">${transmitterShort(t.transmitter)} ${EFFECT_SIGN[t.effect]}</span> ${t.transmitter} · ${t.effect}`).join("<br>");
    return `<strong>${name(e.from)} → ${name(e.to)}</strong><br>${e.laterality === "contralateral" ? "crossed (contralateral)" : "uncrossed (ipsilateral)"} · via ${via}${tx ? `<br>${tx}` : ""}<br><span class="muted">${pws}</span>`;
  }

  /** Emphasise a set of nodes and edges, dimming the rest. */
  private ringFocus(nodes: Set<string>, edges: Set<string> | null, mode: "hover" | "sel", strong?: Set<string>) {
    const svg = this.ringSvg;
    if (!svg) return;
    const sys = this.state.system;
    const any = nodes.size > 0 || (edges?.size ?? 0) > 0;
    svg.querySelectorAll<SVGGElement>(".ring-edge").forEach((g) => {
      const [from, to] = g.dataset.key!.split(">");
      const e = this.atlas.graph.edges.find((x) => this.edgeKey(x) === g.dataset.key)!;
      const inSys = !sys || e.pathways.some((p) => this.atlas.pathwayById.get(p)?.system === sys);
      const on = edges ? edges.has(g.dataset.key!) : nodes.has(from) || nodes.has(to);
      g.classList.toggle("on", any && on);
      g.classList.toggle("strong", !!strong?.has(g.dataset.key!));
      g.classList.toggle("off", (any && !on) || (!any && !inSys));
    });
    const touched = new Set(nodes);
    if (edges) for (const k of edges) for (const id of k.split(">").slice(0, 2)) touched.add(id);
    else if (any) for (const e of this.atlas.graph.edges) if (nodes.has(e.from) || nodes.has(e.to)) touched.add(e.from).add(e.to);
    svg.querySelectorAll<SVGGElement>(".ring-node").forEach((g) => {
      g.classList.toggle("sel", nodes.has(g.dataset.id!));
      g.classList.toggle("on", any && touched.has(g.dataset.id!));
      g.classList.toggle("off", any && !touched.has(g.dataset.id!));
    });
    svg.classList.toggle("hovering", mode === "hover");
  }

  private highlightRing() {
    const sel = this.state.sel;
    if (!sel) return this.ringFocus(new Set(), null, "sel");
    if (sel.type === "region") return this.ringFocus(new Set([sel.id]), null, "sel");
    if (sel.type === "tract") {
      const edges = new Set(this.atlas.graph.edges.filter((e) => e.via.includes(sel.id)).map((e) => this.edgeKey(e)));
      return this.ringFocus(new Set(), edges, "sel");
    }
    const pw = this.atlas.pathwayById.get(sel.id)!;
    const edges = new Set(this.atlas.graph.edges.filter((e) => e.pathways.includes(sel.id)).map((e) => this.edgeKey(e)));
    // the neuron containing the current step is drawn heavier
    const strong = new Set<string>();
    const n = pathwayNeurons(pw).find((x) => this.state.step >= x.from && this.state.step <= x.to);
    if (n) {
      const a = pw.steps[n.from].region!, b = pw.steps[n.to].region!;
      for (const e of this.atlas.graph.edges) if (e.from === a && e.to === b && e.pathways.includes(sel.id)) strong.add(this.edgeKey(e));
    }
    const nodes = new Set(pw.steps.filter((s) => s.region).map((s) => s.region!));
    this.ringFocus(new Set(), edges, "sel", strong);
    this.ringSvg?.querySelectorAll<SVGGElement>(".ring-node").forEach((g) => g.classList.toggle("sel", nodes.has(g.dataset.id!) && g.classList.contains("on")));
  }

  private applyViewBox() {
    const { x, y, w, h } = this.vb;
    this.ringSvg?.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
  }

  private attachPanZoom(svg: SVGSVGElement) {
    const toUnits = (dx: number, dy: number) => {
      const r = svg.getBoundingClientRect();
      const k = Math.max(this.vb.w / r.width, this.vb.h / r.height);
      return [dx * k, dy * k];
    };
    svg.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const r = svg.getBoundingClientRect();
        const k = Math.max(this.vb.w / r.width, this.vb.h / r.height);
        // point under the cursor stays put
        const ox = this.vb.x + (e.clientX - r.left - (r.width - this.vb.w / k) / 2) * k;
        const oy = this.vb.y + (e.clientY - r.top - (r.height - this.vb.h / k) / 2) * k;
        const f = Math.exp(e.deltaY * 0.0015);
        const w = Math.min(2400, Math.max(200, this.vb.w * f));
        const s = w / this.vb.w;
        this.vb = { x: ox - (ox - this.vb.x) * s, y: oy - (oy - this.vb.y) * s, w, h: this.vb.h * s };
        this.applyViewBox();
      },
      { passive: false },
    );
    let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
    svg.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY, vx: this.vb.x, vy: this.vb.y, moved: false };
    });
    svg.addEventListener("pointermove", (e) => {
      if (!drag || !(e.buttons & 1)) return;
      const [dx, dy] = toUnits(e.clientX - drag.x, e.clientY - drag.y);
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 3 && !drag.moved) {
        drag.moved = true;
        svg.setPointerCapture(e.pointerId);
      }
      if (!drag.moved) return;
      this.vb.x = drag.vx - dx;
      this.vb.y = drag.vy - dy;
      this.applyViewBox();
    });
    svg.addEventListener("pointerup", () => (drag = null));
    // a drag must not count as a click on a node or edge
    svg.addEventListener(
      "click",
      (e) => {
        if (svg.dataset.dragged === "1") e.stopPropagation();
        svg.dataset.dragged = "";
      },
      true,
    );
    svg.addEventListener("pointerup", () => {
      if (drag?.moved) svg.dataset.dragged = "1";
    }, true);
  }
}

