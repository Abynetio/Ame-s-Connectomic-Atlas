import "./style.css";
import { ALLOCORTEX, Atlas, Edge, Pathway, PathwayStep, Region, Side, Tract, loadAtlas, mirrorSide, pathwayNeurons, searchText } from "./data";
import { SYSTEM_COLORS, SYSTEM_LABELS, colorFor, neuronShade } from "./palette";
import { Diagram } from "./diagram";
import { PickInfo, Viewer } from "./viewer";

type Sel = { type: "pathway" | "tract" | "region"; id: string } | null;

const REPO = "https://github.com/Abynetio/Ame-s-Connectomic-Atlas";
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

function h(tag: string, attrs: Record<string, string | boolean | undefined> = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const sideName = (s: Side) => (s === "L" ? "left" : s === "R" ? "right" : "midline");

class App {
  atlas: Atlas;
  viewer: Viewer;
  sel: Sel = null;
  start: "L" | "R" = "L";
  step = 0;
  tab: "pathways" | "tracts" | "regions" = "pathways";
  query = "";
  system: string | null = null;
  playTimer: number | null = null;
  diagram: Diagram;
  mode: "3d" | "split" | "2d" = "3d";

  constructor(atlas: Atlas) {
    this.atlas = atlas;
    this.viewer = new Viewer($("#stage"), atlas);
    this.diagram = new Diagram($("#diagram"), atlas, { select: (s) => this.select(s), step: (k) => this.gotoStep(k) });
    this.bindChrome();
    this.renderSystems();
    this.renderList();
    window.addEventListener("hashchange", () => this.fromHash());
    if (!this.fromHash()) this.select({ type: "pathway", id: "lateral_corticospinal_hand" });
  }

  // ------------------------------------------------------------------ URL state
  private toHash() {
    if (!this.sel) return;
    const p = new URLSearchParams({ [this.sel.type]: this.sel.id });
    if (this.sel.type === "pathway") {
      p.set("side", this.start);
      p.set("step", String(this.step + 1));
    }
    if (this.mode !== "3d") p.set("view", this.mode);
    const s = `#${p.toString()}`;
    if (location.hash === s) return;
    try {
      history.replaceState(null, "", s);
    } catch {
      // sandboxed embeds may refuse history updates; the atlas works without shareable URLs
    }
  }

  private fromHash(): boolean {
    const p = new URLSearchParams(location.hash.slice(1));
    const view = p.get("view");
    this.setMode(view === "split" || view === "2d" ? view : "3d", false);
    for (const type of ["pathway", "tract", "region"] as const) {
      const id = p.get(type);
      if (!id) continue;
      if (type === "pathway") {
        this.start = p.get("side") === "R" ? "R" : "L";
        this.step = Math.max(0, Number(p.get("step") ?? 1) - 1);
      }
      this.select({ type, id }, { keepStep: type === "pathway" });
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ chrome
  private bindChrome() {
    $("#search").addEventListener("input", (e) => {
      this.query = (e.target as HTMLInputElement).value.trim().toLowerCase();
      this.renderList();
    });
    document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) =>
      b.addEventListener("click", () => {
        this.tab = b.dataset.tab as App["tab"];
        document.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("active", x === b));
        this.renderList();
      }),
    );
    document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => b.addEventListener("click", () => this.setMode(b.dataset.mode as App["mode"])));
    document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) => b.addEventListener("click", () => this.viewer.viewPreset(b.dataset.view!)));
    $<HTMLInputElement>("#glass").addEventListener("change", (e) => this.viewer.setGlass((e.target as HTMLInputElement).checked));
    $<HTMLInputElement>("#glass-opacity").addEventListener("input", (e) => this.viewer.setGlass(true, Number((e.target as HTMLInputElement).value)));
    $<HTMLInputElement>("#brightness").addEventListener("input", (e) => this.viewer.setBrightness(Number((e.target as HTMLInputElement).value)));
    $<HTMLInputElement>("#over-glass").addEventListener("change", (e) => this.viewer.setCircuitOverGlass((e.target as HTMLInputElement).checked));
    for (const [id, kind] of [["#show-ventricles", "ventricles"], ["#show-grey", "grey"], ["#show-white", "white"]] as const) {
      $<HTMLInputElement>(id).addEventListener("change", (e) => this.viewer.setTissue(kind, (e.target as HTMLInputElement).checked));
    }
    $<HTMLInputElement>("#show-layers").addEventListener("change", (e) => this.viewer.setLayerColumns((e.target as HTMLInputElement).checked));
    $<HTMLInputElement>("#all-tracts").addEventListener("change", (e) => {
      this.viewer.showAllTracts((e.target as HTMLInputElement).checked);
      if (!(e.target as HTMLInputElement).checked && this.sel) this.select(this.sel, { keepStep: true, keepCamera: true });
    });
    $<HTMLSelectElement>("#color-mode").addEventListener("change", (e) => this.viewer.setColorMode((e.target as HTMLSelectElement).value as "system" | "direction"));
    for (const view of ["axial", "coronal", "sagittal"] as const) {
      const cb = $<HTMLInputElement>(`#slice-${view}`);
      const range = $<HTMLInputElement>(`#slice-${view}-mm`);
      const out = $(`#slice-${view}-val`);
      const update = () => {
        const mm = this.viewer.setSlice(view, cb.checked ? Number(range.value) : null);
        out.textContent = mm === null ? "" : `${view === "axial" ? "z" : view === "coronal" ? "y" : "x"} = ${mm.toFixed(0)}`;
      };
      cb.addEventListener("change", update);
      range.addEventListener("input", update);
    }
    $("#about-btn").addEventListener("click", () => this.showAbout());
    $("#menu-btn").addEventListener("click", () => document.body.classList.toggle("show-sidebar"));
    $("#info-toggle").addEventListener("click", () => document.body.classList.toggle("info-collapsed"));

    const canvas = this.viewer.renderer.domElement;
    const tip = $("#tooltip");
    let down = { x: 0, y: 0 };
    canvas.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener("pointerup", (e) => {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      const hit = this.viewer.pick(e);
      if (hit && hit.kind !== "context") this.select({ type: hit.kind, id: hit.id });
    });
    let raf = 0;
    canvas.addEventListener("pointermove", (e) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const hit: PickInfo | null = this.viewer.pick(e);
        if (!hit) {
          tip.hidden = true;
          return;
        }
        tip.hidden = false;
        tip.textContent = `${hit.name}${hit.side !== "M" ? ` (${sideName(hit.side)})` : ""}`;
        const r = canvas.getBoundingClientRect();
        tip.style.left = `${e.clientX - r.left + 14}px`;
        tip.style.top = `${e.clientY - r.top + 10}px`;
      });
    });
    canvas.addEventListener("pointerleave", () => (tip.hidden = true));
    window.addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (this.sel?.type !== "pathway") return;
      if (e.key === "ArrowRight") this.gotoStep(this.step + 1);
      if (e.key === "ArrowLeft") this.gotoStep(this.step - 1);
    });
  }

  private renderSystems() {
    const used = new Set<string>();
    for (const x of [...this.atlas.graph.pathways.map((p) => [p.system]), ...this.atlas.graph.tracts.map((t) => t.systems), ...this.atlas.graph.regions.map((r) => r.systems)]) for (const s of x) used.add(s);
    const box = $("#systems");
    box.innerHTML = "";
    const chip = (key: string | null, label: string) => {
      const b = h("button", { class: "chip" + (this.system === key ? " active" : ""), type: "button" }, key ? h("span", { class: "dot", style: `background:${SYSTEM_COLORS[key] ?? "#999"}` }) : "", label);
      b.addEventListener("click", () => {
        this.system = this.system === key ? null : key;
        this.renderSystems();
        this.renderList();
        this.syncDiagram();
      });
      return b;
    };
    box.append(chip(null, "All"));
    for (const k of Object.keys(SYSTEM_LABELS)) if (used.has(k)) box.append(chip(k, SYSTEM_LABELS[k]));
  }

  // ------------------------------------------------------------------ list
  private renderList() {
    const list = $("#list");
    list.innerHTML = "";
    const q = this.query;
    const sysOk = (systems: string[]) => !this.system || systems.includes(this.system);
    const item = (type: NonNullable<Sel>["type"], id: string, name: string, sub: string, color: string, extra = "") => {
      const active = this.sel?.type === type && this.sel.id === id;
      const li = h("li", {}, h("button", { class: "item" + (active ? " active" : ""), type: "button" }, h("span", { class: "dot", style: `background:${color}` }), h("span", { class: "name" }, name), sub ? h("span", { class: "sub" }, sub) : "", extra ? h("span", { class: "badge" }, extra) : ""));
      li.firstElementChild!.addEventListener("click", () => {
        this.select({ type, id });
        document.body.classList.remove("show-sidebar");
      });
      return li;
    };
    const counts = { pathways: 0, tracts: 0, regions: 0 };
    const pw = this.atlas.graph.pathways.filter((p) => sysOk([p.system]) && (!q || p.name.toLowerCase().includes(q) || p.summary.toLowerCase().includes(q)));
    const tr = this.atlas.graph.tracts.filter((t) => sysOk(t.systems) && (!q || searchText(t).includes(q)));
    const rg = this.atlas.graph.regions.filter((r) => sysOk(r.systems) && (!q || searchText(r).includes(q)));
    counts.pathways = pw.length;
    counts.tracts = tr.length;
    counts.regions = rg.length;
    document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => (b.querySelector(".count")!.textContent = String(counts[b.dataset.tab as keyof typeof counts])));

    if (this.tab === "pathways") {
      const bySys = groupBy(pw, (p) => p.system);
      for (const [sys, items] of bySys) {
        list.append(h("li", { class: "group" }, SYSTEM_LABELS[sys] ?? sys));
        for (const p of items) list.append(item("pathway", p.id, p.name, `${p.steps.length} steps`, colorFor([p.system])));
      }
    } else if (this.tab === "tracts") {
      const byKind = groupBy(tr, (t) => t.kind);
      const order = ["projection", "association", "commissural", "cerebellar", "brainstem", "spinal", "cranial_nerve"];
      for (const k of order) {
        const items = byKind.get(k);
        if (!items) continue;
        list.append(h("li", { class: "group" }, KIND_LABELS[k] ?? k));
        for (const t of items) list.append(item("tract", t.id, t.name, t.abbrev?.[0] ?? "", colorFor(t.systems), t.parts.every((p) => p.kind === "schematic") ? "schematic" : ""));
      }
    } else {
      const byGroup = groupBy(rg, (r) => groupLabel(r.group));
      for (const [g, items] of byGroup) {
        list.append(h("li", { class: "group" }, g));
        for (const r of items) list.append(item("region", r.id, r.name, r.abbrev?.[0] ?? "", colorFor(r.systems, r.style), r.kind === "schematic" ? "schematic" : ""));
      }
    }
    if (!list.children.length) list.append(h("li", { class: "empty" }, "Nothing matches."));
  }

  // ------------------------------------------------------------------ selection
  select(sel: NonNullable<Sel>, opts: { keepStep?: boolean; keepCamera?: boolean } = {}) {
    this.stopPlay();
    const exists = sel.type === "pathway" ? this.atlas.pathwayById.has(sel.id) : sel.type === "tract" ? this.atlas.tractById.has(sel.id) : this.atlas.regionById.has(sel.id);
    if (!exists) return;
    if (!opts.keepStep || this.sel?.id !== sel.id) {
      if (!opts.keepStep) this.step = 0;
    }
    this.sel = sel;
    const allTracts = $<HTMLInputElement>("#all-tracts").checked;
    if (sel.type === "pathway") {
      const pw = this.atlas.pathwayById.get(sel.id)!;
      this.step = Math.min(this.step, pw.steps.length - 1);
      this.viewer.showPathway(pw, this.start, this.step, opts.keepCamera ? "none" : opts.keepStep && this.step > 0 ? "step" : "all");
    } else if (sel.type === "tract") {
      this.viewer.clearAll();
      this.viewer.showTract(sel.id, "both", "focus");
      if (!opts.keepCamera) this.viewer.focusObject("tract", sel.id);
    } else {
      this.viewer.clearAll();
      this.viewer.showRegion(sel.id, "both");
      // show partner structures dimly so the student sees where it projects
      for (const e of this.edgesOf(sel.id)) this.viewer.showRegionContext(e.from === sel.id ? e.to : e.from, "both", "dim");
      if (!opts.keepCamera) this.viewer.focusObject("region", sel.id);
    }
    if (allTracts) this.viewer.showAllTracts(true);
    if (sel.type === "tract") this.viewer.showTract(sel.id, "both", "focus");
    this.renderInfo();
    this.renderList();
    this.syncDiagram();
    this.toHash();
    document.body.classList.remove("info-collapsed");
  }

  setMode(mode: App["mode"], updateHash = true) {
    this.mode = mode;
    $("#workspace").className = `mode-${mode}`;
    document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    this.diagram.setVisible(mode !== "3d");
    if (updateHash) this.toHash();
  }

  private syncDiagram() {
    this.diagram.update({ sel: this.sel, start: this.start, step: this.step, system: this.system });
  }

  private gotoStep(n: number) {
    if (this.sel?.type !== "pathway") return;
    const pw = this.atlas.pathwayById.get(this.sel.id)!;
    if (n < 0 || n >= pw.steps.length) return;
    this.step = n;
    this.viewer.showPathway(pw, this.start, n);
    this.renderInfo();
    this.syncDiagram();
    this.toHash();
  }

  private stopPlay() {
    if (this.playTimer !== null) clearInterval(this.playTimer);
    this.playTimer = null;
  }

  private togglePlay() {
    if (this.playTimer !== null) {
      this.stopPlay();
      this.renderInfo();
      return;
    }
    const pw = this.atlas.pathwayById.get(this.sel!.id)!;
    if (this.step >= pw.steps.length - 1) this.gotoStep(0);
    this.playTimer = window.setInterval(() => {
      if (this.step >= pw.steps.length - 1) {
        this.stopPlay();
        this.renderInfo();
        return;
      }
      this.gotoStep(this.step + 1);
    }, 2600);
    this.renderInfo();
  }

  private edgesOf(regionId: string): Edge[] {
    return this.atlas.graph.edges.filter((e) => e.from === regionId || e.to === regionId);
  }

  // ------------------------------------------------------------------ info panel
  private link(type: NonNullable<Sel>["type"], id: string, text?: string): HTMLElement {
    const obj = type === "region" ? this.atlas.regionById.get(id) : type === "tract" ? this.atlas.tractById.get(id) : this.atlas.pathwayById.get(id);
    const a = h("a", { href: `#${type}=${id}`, class: "xref" }, text ?? obj?.name ?? id);
    a.addEventListener("click", (e) => {
      e.preventDefault();
      this.select({ type, id });
    });
    return a;
  }

  private layerLine(st: PathwayStep): HTMLElement | "" {
    if (!st.layer_in && !st.layer_out) return "";
    const allo = !!st.region && ALLOCORTEX.has(st.region);
    const fmt = (v: string) => (allo ? `${v} layer` : `layer ${v}`);
    const parts = [st.layer_out ? `Cell bodies in ${fmt(st.layer_out)}` : "", st.layer_in ? `Synapses in ${fmt(st.layer_in)}` : ""].filter(Boolean);
    return h("div", { class: "step-layer" }, parts.join(" · "), st.layer_note ? h("div", { class: "muted" }, st.layer_note) : "");
  }

  /** One line per neuron: where its cell body sits, which tracts carry its axon, where it synapses. */
  private neuronSection(pw: Pathway): HTMLElement {
    const neurons = pathwayNeurons(pw);
    const base = colorFor([pw.system]);
    const ord = ["First-order", "Second-order", "Third-order", "Fourth-order", "Fifth-order", "Sixth-order"];
    const sideOf = (st: PathwayStep) => {
      const r = st.region ? this.atlas.regionById.get(st.region) : undefined;
      return r?.sides.M ? "" : ` (${sideName(mirrorSide(this.start, st.side))})`;
    };
    const ul = h("ul", { class: "neurons" });
    for (const n of neurons) {
      const a = pw.steps[n.from], b = pw.steps[n.to];
      const tracts = n.via.filter((k) => pw.steps[k].tract).map((k) => this.link("tract", pw.steps[k].tract!));
      const passes = n.via.filter((k) => pw.steps[k].region).map((k) => this.link("region", pw.steps[k].region!));
      ul.append(
        h(
          "li",
          {},
          h("span", { class: "swatch", style: `background:${neuronShade(base, n.order)}` }),
          h(
            "div",
            {},
            h("strong", {}, `${ord[n.order] ?? `Neuron ${n.order + 1}`} neuron`),
            h("div", {}, "● Cell body: ", this.link("region", a.region!), sideOf(a), a.layer_out ? ` — layer ${a.layer_out}` : ""),
            tracts.length ? h("div", {}, "Axon: ", ...tracts.flatMap((t, i) => [i ? " → " : "", t])) : "",
            passes.length ? h("div", { class: "muted" }, "○ Passes through: ", ...passes.flatMap((t, i) => [i ? ", " : "", t])) : "",
            h("div", {}, "▲ Synapses in: ", this.link("region", b.region!), sideOf(b), b.layer_in ? ` — layer ${b.layer_in}` : ""),
          ),
        ),
      );
    }
    return h(
      "div",
      { class: "section" },
      h("h3", {}, "Neurons in this pathway"),
      h("p", { class: "muted" }, "In 3D: coloured spheres mark cell bodies, white cones mark synapses (pointing into the target), white rings mark structures the axons pass through. Each neuron's stretch of the route has its own shade."),
      ul,
    );
  }

  private refsBlock(refs: string[]): HTMLElement {
    const ol = h("ol", { class: "refs" });
    for (const r of refs) {
      const ref = this.atlas.graph.references[r];
      if (!ref) continue;
      ol.append(h("li", {}, ref.cite, ref.doi ? h("span", {}, " ", h("a", { href: `https://doi.org/${ref.doi}`, target: "_blank", rel: "noopener" }, `doi:${ref.doi}`)) : ""));
    }
    return h("details", { class: "section" }, h("summary", {}, `References (${refs.length})`), ol);
  }

  private provenance(kind: string, source: string, note?: string): HTMLElement {
    const src = this.atlas.graph.sources.find((s) => s.id === source);
    if (kind === "schematic" || source === "schematic") {
      return h("div", { class: "prov schematic" }, h("strong", {}, "Schematic geometry. "), note ?? "Drawn from atlas literature; the position is approximate and is not imaging data.");
    }
    return h("div", { class: "prov data" }, h("strong", {}, "Imaging-derived geometry: "), src ? `${src.name ?? src.id} — ${src.license}` : source, note ? h("div", { class: "muted" }, note) : "");
  }

  private field(label: string, text?: string): HTMLElement | null {
    if (!text) return null;
    return h("div", { class: "field" }, h("div", { class: "label" }, label), h("p", {}, text));
  }

  private renderInfo() {
    const box = $("#info-body");
    box.innerHTML = "";
    if (!this.sel) return;
    if (this.sel.type === "pathway") box.append(this.pathwayInfo(this.atlas.pathwayById.get(this.sel.id)!));
    else if (this.sel.type === "tract") box.append(this.tractInfo(this.atlas.tractById.get(this.sel.id)!));
    else box.append(this.regionInfo(this.atlas.regionById.get(this.sel.id)!));
    box.scrollTop = 0;
  }

  private header(kindLabel: string, name: string, color: string, latin?: string, tags: string[] = []): HTMLElement {
    return h(
      "header",
      { class: "info-head" },
      h("div", { class: "kind" }, h("span", { class: "dot", style: `background:${color}` }), kindLabel),
      h("h2", {}, name),
      latin ? h("div", { class: "latin" }, latin) : "",
      tags.length ? h("div", { class: "tags" }, ...tags.map((t) => h("span", { class: "tag" }, t))) : "",
    );
  }

  private pathwayInfo(pw: Pathway): HTMLElement {
    const frag = h("div");
    frag.append(this.header(`Pathway · ${SYSTEM_LABELS[pw.system] ?? pw.system}`, pw.name, colorFor([pw.system])));
    const sideSel = h("div", { class: "segmented", role: "group", "aria-label": "Starting side" });
    for (const s of ["L", "R"] as const) {
      const b = h("button", { type: "button", class: this.start === s ? "active" : "" }, `Start: ${s === "L" ? "left" : "right"} ${pw.start_label ?? "side"}`);
      b.addEventListener("click", () => {
        this.start = s;
        this.viewer.showPathway(pw, s, this.step, "all");
        this.renderInfo();
        this.syncDiagram();
        this.toHash();
      });
      sideSel.append(b);
    }
    frag.append(sideSel, h("p", { class: "summary" }, pw.summary));

    const controls = h("div", { class: "player" });
    const prev = h("button", { type: "button", "aria-label": "Previous step", disabled: this.step === 0 }, "◀");
    const play = h("button", { type: "button", class: "primary" }, this.playTimer !== null ? "Pause" : "Play pathway");
    const next = h("button", { type: "button", "aria-label": "Next step", disabled: this.step === pw.steps.length - 1 }, "▶");
    prev.addEventListener("click", () => this.gotoStep(this.step - 1));
    next.addEventListener("click", () => this.gotoStep(this.step + 1));
    play.addEventListener("click", () => this.togglePlay());
    controls.append(prev, play, next, h("span", { class: "muted" }, `Step ${this.step + 1} / ${pw.steps.length}`));
    frag.append(controls);

    const ol = h("ol", { class: "steps" });
    pw.steps.forEach((st, k) => {
      const obj = st.region ? this.atlas.regionById.get(st.region)! : this.atlas.tractById.get(st.tract!)!;
      const midline = st.region ? !!this.atlas.regionById.get(st.region)!.sides.M : this.atlas.tractById.get(st.tract!)!.parts.every((p) => !!p.sides.M);
      const side: Side = midline ? "M" : mirrorSide(this.start, st.side);
      const li = h(
        "li",
        { class: (k === this.step ? "current " : "") + (st.region ? "region" : "tract") },
        h("button", { type: "button", class: "step-btn" }, h("span", { class: "step-name" }, obj.name), h("span", { class: "step-side" }, `${sideName(side)}${st.side === "contra" && !midline ? " · crossed" : ""}`)),
        st.role ? h("div", { class: "step-role" }, st.role) : "",
        st.note ? h("div", { class: "step-note" }, st.note) : "",
        this.layerLine(st),
        k === this.step ? h("div", { class: "step-more" }, this.link(st.region ? "region" : "tract", st.region ?? st.tract!, "Open details →")) : "",
      );
      li.querySelector(".step-btn")!.addEventListener("click", () => this.gotoStep(k));
      ol.append(li);
    });
    frag.append(h("div", { class: "section" }, h("h3", {}, "Steps"), ol));
    frag.append(this.neuronSection(pw));

    if (pw.highlight?.length) {
      frag.append(h("div", { class: "section" }, h("h3", {}, "Also note"), h("ul", {}, ...pw.highlight.map((x) => h("li", {}, this.link("region", x.region), ` (${sideName(mirrorSide(this.start, x.side))}) — ${x.note ?? ""}`)))));
    }
    if (pw.clinical?.length) {
      const tbl = h("table", { class: "clinical" }, h("thead", {}, h("tr", {}, h("th", {}, "Lesion site"), h("th", {}, "Finding"))), h("tbody", {}, ...pw.clinical.map((c) => h("tr", {}, h("td", {}, c.site), h("td", {}, c.finding)))));
      frag.append(h("div", { class: "section" }, h("h3", {}, "Lesion localisation"), tbl));
    }
    frag.append(this.refsBlock(pw.refs));
    return frag;
  }

  private tractInfo(t: Tract): HTMLElement {
    const frag = h("div");
    frag.append(this.header(`Tract · ${KIND_LABELS[t.kind] ?? t.kind}`, t.name, colorFor(t.systems), t.latin, [...(t.abbrev ?? []), ...(t.synonyms ?? [])]));
    frag.append(
      ...[
        this.field("Origin", t.origin),
        this.field("Course", t.course),
        this.field("Termination", t.termination),
        this.field("Decussation", t.decussation),
        this.field("Transmitter", t.transmitter),
        this.field("Function", t.function),
        t.clinical ? h("div", { class: "field clinical-box" }, h("div", { class: "label" }, "Clinical & surgical relevance"), h("p", {}, t.clinical)) : null,
      ].filter(Boolean) as HTMLElement[],
    );

    if (t.endpoints) {
      const sec = h("div", { class: "section" }, h("h3", {}, "Where the streamlines end"), h("p", { class: "muted" }, "Share of HCP1065 streamline end-points falling in or within 4 mm of each atlas region (computed by this atlas; not a measure of synaptic connectivity)."));
      for (const [side, items] of Object.entries(t.endpoints)) {
        if (!items?.length) continue;
        const ul = h("ul", { class: "bars" });
        for (const it of items) {
          const r = this.atlas.regionById.get(it.region);
          ul.append(h("li", {}, h("span", { class: "bar", style: `width:${Math.round(it.fraction * 100)}%;background:${colorFor(r?.systems ?? [])}` }), h("span", { class: "bar-label" }, r ? this.link("region", r.id) : it.region, ` ${it.side !== "M" ? `(${sideName(it.side)})` : ""} ${Math.round(it.fraction * 100)}%`)));
        }
        sec.append(h("div", { class: "label" }, side === "M" ? "Bundle" : `${side === "L" ? "Left" : "Right"}-origin bundle`), ul);
      }
      frag.append(sec);
    }

    const geo = h("div", { class: "section" }, h("h3", {}, "Geometry"));
    t.parts.forEach((p) => geo.append(this.provenance(p.kind, p.source ?? "schematic", p.label ?? undefined)));
    frag.append(geo);

    const pws = this.atlas.graph.pathways.filter((p) => p.steps.some((s) => s.tract === t.id));
    if (pws.length) frag.append(h("div", { class: "section" }, h("h3", {}, "Part of pathways"), h("ul", {}, ...pws.map((p) => h("li", {}, this.link("pathway", p.id))))));
    frag.append(this.refsBlock(t.refs));
    return frag;
  }

  private regionInfo(r: Region): HTMLElement {
    const frag = h("div");
    frag.append(this.header(`Region · ${groupLabel(r.group)}`, r.name, colorFor(r.systems, r.style), r.latin, [...(r.abbrev ?? []), ...(r.synonyms ?? [])]));
    frag.append(h("p", { class: "summary" }, r.summary));
    if (r.clinical) frag.append(h("div", { class: "field clinical-box" }, h("div", { class: "label" }, "Clinical & surgical relevance"), h("p", {}, r.clinical)));

    const out = this.atlas.graph.edges.filter((e) => e.from === r.id);
    const inn = this.atlas.graph.edges.filter((e) => e.to === r.id);
    const edgeList = (edges: Edge[], dir: "out" | "in") =>
      h(
        "ul",
        { class: "edges" },
        ...edges.map((e) =>
          h(
            "li",
            {},
            this.link("region", dir === "out" ? e.to : e.from),
            h("span", { class: "muted" }, ` · ${e.laterality} · via `),
            ...e.via.flatMap((v, i) => [i ? ", " : "", this.link("tract", v)]),
            h("div", { class: "evidence" }, ...e.evidence.map((x) => h("span", { class: `ev ev-${x}` }, EVIDENCE_LABELS[x] ?? x))),
          ),
        ),
      );
    if (out.length) frag.append(h("div", { class: "section" }, h("h3", {}, "Projects to"), edgeList(out, "out")));
    if (inn.length) frag.append(h("div", { class: "section" }, h("h3", {}, "Receives from"), edgeList(inn, "in")));

    const ending = this.atlas.graph.tracts
      .map((t) => {
        let best = 0;
        for (const items of Object.values(t.endpoints ?? {})) for (const it of items ?? []) if (it.region === r.id) best = Math.max(best, it.fraction);
        return { t, best };
      })
      .filter((x) => x.best >= 0.05)
      .sort((a, b) => b.best - a.best);
    if (ending.length) {
      frag.append(h("div", { class: "section" }, h("h3", {}, "Tracts with streamline end-points here"), h("ul", {}, ...ending.map((x) => h("li", {}, this.link("tract", x.t.id), h("span", { class: "muted" }, ` · ${Math.round(x.best * 100)}% of end-points`))))));
    }
    const pws = this.atlas.graph.pathways.filter((p) => p.steps.some((s) => s.region === r.id));
    if (pws.length) frag.append(h("div", { class: "section" }, h("h3", {}, "Part of pathways"), h("ul", {}, ...pws.map((p) => h("li", {}, this.link("pathway", p.id))))));
    frag.append(h("div", { class: "section" }, h("h3", {}, "Geometry"), this.provenance(r.kind, r.source, r.geometry_note)));
    frag.append(this.refsBlock(r.refs));
    return frag;
  }

  private showAbout() {
    const dlg = $<HTMLDialogElement>("#about");
    const used = new Set<string>(["schematic"]);
    for (const r of this.atlas.graph.regions) used.add(r.source);
    for (const t of this.atlas.graph.tracts) for (const p of t.parts) used.add(p.source ?? "schematic");
    used.add("icbm152");
    const rows = this.atlas.graph.sources.filter((s) => s.allowed && used.has(s.id));
    const body = $("#about-sources");
    body.innerHTML = "";
    for (const s of rows) {
      const refs = (s.refs ?? []).map((r) => this.atlas.graph.references[r]?.cite).filter(Boolean).join(" ");
      body.append(h("tr", {}, h("td", {}, s.name ?? s.id), h("td", {}, s.license, s.extra_terms ? h("div", { class: "muted" }, s.extra_terms) : ""), h("td", { class: "muted" }, refs)));
    }
    dlg.showModal();
  }
}

const KIND_LABELS: Record<string, string> = {
  projection: "Projection",
  association: "Association",
  commissural: "Commissural",
  cerebellar: "Cerebellar",
  brainstem: "Brainstem",
  spinal: "Spinal",
  cranial_nerve: "Cranial nerves",
};

const EVIDENCE_LABELS: Record<string, string> = {
  classical: "textbook / lesion consensus",
  "human-tractography": "human tractography",
  "human-tract-to-region": "human tract-to-region",
  "nhp-tract-tracing": "macaque tract-tracing",
};

function groupLabel(g: string): string {
  const [a, b] = g.split(".");
  const top: Record<string, string> = { cortex: "Cortex", diencephalon: "Diencephalon", basal_ganglia: "Basal ganglia", mesencephalon: "Midbrain", brainstem: "Brainstem", cerebellum: "Cerebellum", spinal: "Spinal cord", ventricles: "Ventricles", basal_forebrain: "Basal forebrain", visual: "Visual", peripheral: "Peripheral", telencephalon: "Telencephalon" };
  const t = top[a] ?? a;
  return b ? `${t} — ${b.replace(/_/g, " ")}` : t;
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(x);
  }
  return m;
}

async function boot() {
  const status = $("#loading");
  try {
    const atlas = await loadAtlas("./atlas", (m) => (status.textContent = m));
    status.remove();
    const app = new App(atlas);
    (window as unknown as { app: App }).app = app;
    $("#repo-link").setAttribute("href", REPO);
  } catch (e) {
    status.textContent = `Failed to load the atlas: ${(e as Error).message}. If you are running locally, build the data first (see README).`;
    status.classList.add("error");
  }
}

boot();
