import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { ALLOCORTEX, Atlas, decodeBundle, decodeMesh, Pathway, PathwayStep, Region, Side, Tract, Vec3, mirrorSide, pathwayNeurons } from "./data";
import { EFFECT_COLOR, EFFECT_SIGN, NEURON_TINT, colorFor, neuronShade, transmitterShort } from "./palette";

export type PickKind = "region" | "tract" | "context";
export interface PickInfo { kind: PickKind; id: string; side: Side; name: string }

type Mode = "off" | "dim" | "on" | "focus";

const GLASS_VERT = /* glsl */ `
  varying vec3 vN; varying vec3 vV;
  #include <clipping_planes_pars_vertex>
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
    #include <clipping_planes_vertex>
  }`;
const GLASS_FRAG = /* glsl */ `
  uniform vec3 uColor; uniform float uOpacity; uniform float uRim;
  varying vec3 vN; varying vec3 vV;
  #include <clipping_planes_pars_fragment>
  void main() {
    #include <clipping_planes_fragment>
    float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
    gl_FragColor = vec4(uColor, uOpacity * (0.25 + uRim * f));
  }`;

const DASH_VERT = /* glsl */ `
  varying vec2 vUv; varying vec3 vN; varying vec3 vV;
  void main() {
    vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;
const DASH_FRAG = /* glsl */ `
  uniform vec3 uColor; uniform float uRepeat; uniform float uOpacity; uniform float uBright;
  varying vec2 vUv; varying vec3 vN; varying vec3 vV;
  void main() {
    if (fract(vUv.x * uRepeat) > 0.62) discard;
    float l = 0.45 + 0.55 * abs(dot(normalize(vN), normalize(vV)));
    gl_FragColor = vec4(min(uColor * l * uBright, vec3(1.0)), uOpacity);
  }`;

const ROUTE_FRAG = /* glsl */ `
  uniform vec3 uColor; uniform float uTime; uniform vec2 uSpan; uniform float uLength; uniform float uBright;
  uniform float uBounds[12]; uniform int uNeurons; uniform float uTint;
  varying vec2 vUv; varying vec3 vN; varying vec3 vV;
  void main() {
    float u = vUv.x;
    // which neuron of the chain this part of the route belongs to (bounds = synapse positions)
    float n = 0.0;
    for (int i = 0; i < 12; i++) { if (i < uNeurons - 1 && u > uBounds[i]) n += 1.0; }
    vec3 col = mix(uColor, vec3(1.0), mod(n, 2.0) * uTint);
    float l = 0.5 + 0.5 * abs(dot(normalize(vN), normalize(vV)));
    float inSpan = step(uSpan.x - 1e-4, u) * step(u, uSpan.y + 1e-4);
    float done = step(u, uSpan.y);
    // travelling pulses, ~25 mm apart, moving at ~40 mm/s
    float d = fract((u * uLength - uTime * 40.0) / 25.0);
    float pulse = smoothstep(0.0, 0.08, d) * (1.0 - smoothstep(0.08, 0.35, d));
    vec3 base = mix(vec3(0.55), col, 0.35 + 0.65 * done);
    vec3 c = base * l + pulse * 0.9 * done + inSpan * 0.25;
    float a = mix(0.35, 1.0, done);
    gl_FragColor = vec4(min(c * uBright, vec3(1.0)), a);
  }`;

interface TractObj { obj: THREE.Object3D; tract: Tract; part: number; side: Side; mode: Mode }

/** Hand-drawn (schematic) tracts and the animated route are drawn thin so they don't hide imaging data. */
const SCHEMATIC_TRACT_SCALE = 0.5;
const ROUTE_RADIUS = 0.4;
const GLASS_ORDER_UNDER = -10; // glass drawn first: the circuit is painted over it at full colour
const GLASS_ORDER_OVER = 10; // glass drawn last: the circuit is seen "through" the glass (softer)
const SLICE_ORDER = -20; // MRI slices first: they write depth, so tissue behind a slice is hidden and tissue in front stays visible

export class Viewer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly labels: CSS2DRenderer;
  readonly controls: OrbitControls;
  private atlas: Atlas;
  private regionObjs = new Map<string, THREE.Mesh>(); // key id:side
  private contextObjs: THREE.Mesh[] = [];
  private tractObjs = new Map<string, TractObj>(); // key id:part:side
  private routeGroup = new THREE.Group();
  /** all-pathways map: one thin tube per pathway (built once), plus a thick copy for the focused one */
  private overviewGroup = new THREE.Group();
  private overviewTubes = new Map<string, { thin: THREE.Mesh; thick: THREE.Mesh; pick: THREE.Vector3[] }>();
  private overviewState: { focus: string | null; hover: string | null; match: Set<string> | null } | null = null;
  private labelGroup = new THREE.Group();
  /** labels kept clear of the 3D markers: offset each frame by the marker's on-screen radius */
  private pins: { wrap: HTMLElement; pos: THREE.Vector3; r: number; priority: number }[] = [];
  private pinFrame = 0;
  private sliceGroup = new THREE.Group();
  private slicePlanes = new Map<string, THREE.Mesh>();
  private routeMat: THREE.ShaderMaterial | null = null;
  private t0 = performance.now();
  private raycaster = new THREE.Raycaster();
  private tween: { from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3]; t0: number; dur: number } | null = null;
  private glassOpacity = 0.28;
  private brightness = 1.25;
  private circuitOverGlass = true;
  private regionModes = new Map<THREE.Mesh, { region: Region; mode: Mode }>();
  private tissue: Record<"shell" | "ventricles" | "grey" | "white", THREE.Mesh[]> = { shell: [], ventricles: [], grey: [], white: [] };
  private layersVisible = false;
  private layerGroup = new THREE.Group();
  private current: { pw: Pathway; start: "L" | "R"; step: number } | null = null;
  glassVisible = true;
  colorMode: "system" | "direction" = "direction";

  constructor(container: HTMLElement, atlas: Atlas) {
    this.atlas = atlas;
    const w = container.clientWidth, h = container.clientHeight;
    this.camera = new THREE.PerspectiveCamera(35, w / h, 1, 3000);
    this.camera.up.set(0, 0, 1);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.setSize(w, h);
    this.labels.domElement.className = "label-layer";
    container.appendChild(this.labels.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.target.set(0, -20, 0);
    this.camera.position.set(-330, -20, 40);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(-1, 1, 2);
    this.camera.add(key);
    this.scene.add(this.camera);
    this.scene.add(this.routeGroup, this.overviewGroup, this.labelGroup, this.sliceGroup, this.layerGroup);

    this.buildContext();
    this.buildRegions();
    this.buildSlices();

    new ResizeObserver(() => this.resize(container)).observe(container);
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ------------------------------------------------------------------ construction
  private glassMaterial(color: THREE.ColorRepresentation, opacity: number) {
    return new THREE.ShaderMaterial({
      vertexShader: GLASS_VERT,
      fragmentShader: GLASS_FRAG,
      uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity }, uRim: { value: 1.6 } },
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      clipping: true,
    });
  }

  private meshFrom(index: number): THREE.BufferGeometry {
    const m = decodeMesh(this.atlas, index);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
    g.setIndex(new THREE.BufferAttribute(m.index, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }

  private buildContext() {
    const add = (geom: THREE.BufferGeometry, id: string, name: string, kind: "shell" | "ventricles" | "grey" | "white" = "shell") => {
      let mat: THREE.Material;
      if (kind === "shell") mat = this.glassMaterial(0xb8c0cc, this.glassOpacity);
      else if (kind === "ventricles") mat = this.glassMaterial(0x4f9fe0, 0.55);
      else
        mat = new THREE.MeshStandardMaterial({
          color: kind === "grey" ? 0x8a8174 : 0xf0e9d8, // grey matter: warm grey; white matter: myelin cream
          roughness: 0.8,
          transparent: true,
          opacity: 0.42,
          depthWrite: false,
        });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.renderOrder = this.circuitOverGlass ? GLASS_ORDER_UNDER : GLASS_ORDER_OVER;
      mesh.userData = { kind: "context", id, side: "M", name } satisfies PickInfo;
      mesh.visible = kind === "shell" || kind === "ventricles";
      this.tissue[kind].push(mesh);
      this.contextObjs.push(mesh);
      this.scene.add(mesh);
    };
    for (const c of this.atlas.graph.context) add(this.meshFrom(c.mesh), c.id, c.name, c.kind ?? "shell");
    // the shortened schematic spinal cord gets a glass shell as well
    const cord = this.atlas.regionById.get("spinal_cord")?.sides.M;
    if (cord?.path) add(this.schematicRegionGeometry(cord), "spinal_cord_glass", "Spinal cord (schematic)");
  }

  private schematicRegionGeometry(s: NonNullable<Region["sides"]["L"]>): THREE.BufferGeometry {
    if (s.shape === "ellipsoid") {
      const g = new THREE.SphereGeometry(1, 20, 14);
      g.scale(s.radii![0], s.radii![1], s.radii![2]);
      g.translate(...s.center!);
      return g;
    }
    const curve = new THREE.CatmullRomCurve3(s.path!.map((p) => new THREE.Vector3(...p)));
    return new THREE.TubeGeometry(curve, Math.max(16, s.path!.length), s.radius!, 18, false);
  }

  private buildRegions() {
    for (const r of this.atlas.graph.regions) {
      for (const [side, s] of Object.entries(r.sides) as [Side, Region["sides"]["L"]][]) {
        if (!s) continue;
        const geom = s.mesh !== undefined ? this.meshFrom(s.mesh) : this.schematicRegionGeometry(s);
        const color = colorFor(r.systems, r.style);
        const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.0, transparent: true, opacity: 1 });
        mat.userData.base = new THREE.Color(color);
        const mesh = new THREE.Mesh(geom, mat);
        mesh.userData = { kind: "region", id: r.id, side, name: r.name } satisfies PickInfo;
        if (r.kind === "schematic") {
          const wire = new THREE.LineSegments(
            new THREE.WireframeGeometry(geom),
            new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }),
          );
          wire.raycast = () => {};
          mesh.add(wire);
        }
        mesh.visible = false;
        this.regionObjs.set(`${r.id}:${side}`, mesh);
        this.scene.add(mesh);
      }
    }
  }

  private tractObject(t: Tract, part: number, side: Side): TractObj | null {
    const key = `${t.id}:${part}:${side}`;
    const hit = this.tractObjs.get(key);
    if (hit) return hit;
    const p = t.parts[part];
    const s = p.sides[side];
    if (!s) return null;
    const color = new THREE.Color(colorFor(t.systems));
    let obj: THREE.Object3D;
    if (s.bundle !== undefined) {
      const { positions, colors } = decodeBundle(this.atlas, s.bundle);
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      g.setAttribute("dirColor", new THREE.BufferAttribute(colors, 3));
      const sys = new Float32Array(colors.length);
      for (let i = 0; i < sys.length; i += 3) sys.set([color.r, color.g, color.b], i);
      g.setAttribute("sysColor", new THREE.BufferAttribute(sys, 3));
      g.setAttribute("color", new THREE.BufferAttribute(this.colorMode === "direction" ? colors.slice() : sys.slice(), 3));
      obj = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 }));
    } else if (s.mesh !== undefined) {
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, transparent: true, opacity: 0.9 });
      mat.userData.base = color.clone();
      obj = new THREE.Mesh(this.meshFrom(s.mesh), mat);
    } else {
      const pts = s.path!.map((q) => new THREE.Vector3(...q));
      const curve = new THREE.CatmullRomCurve3(pts);
      const len = curve.getLength();
      const g = new THREE.TubeGeometry(curve, Math.max(8, pts.length * 2), (p.radius ?? 0.8) * SCHEMATIC_TRACT_SCALE, 8, false);
      obj = new THREE.Mesh(
        g,
        new THREE.ShaderMaterial({
          vertexShader: DASH_VERT,
          fragmentShader: DASH_FRAG,
          uniforms: { uColor: { value: color }, uRepeat: { value: len / 2.2 }, uOpacity: { value: 1 }, uBright: { value: this.brightness } },
          transparent: true,
          side: THREE.DoubleSide,
        }),
      );
    }
    obj.userData = { kind: "tract", id: t.id, side, name: t.name } satisfies PickInfo;
    obj.visible = false;
    this.scene.add(obj);
    const rec: TractObj = { obj, tract: t, part, side, mode: "off" };
    this.tractObjs.set(key, rec);
    return rec;
  }

  private buildSlices() {
    const sl = this.atlas.graph.slices;
    if (!sl) return;
    const A = sl.affine;
    const [nx, ny, nz] = sl.shape;
    const ext = (ax: number, n: number) => [A[ax][3] - 0.5 * A[ax][ax], A[ax][3] + (n - 0.5) * A[ax][ax]] as [number, number];
    const ex = ext(0, nx), ey = ext(1, ny), ez = ext(2, nz);
    const loader = new THREE.TextureLoader();
    const mk = (view: "axial" | "coronal" | "sagittal", w: number, h: number) => {
      const v = sl.views[view];
      const tex = loader.load(`${this.atlas.base}/${v.file}`);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.repeat.set(1 / v.cols, 1 / v.rows);
      const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true, opacity: 0.92 });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      mesh.visible = false;
      mesh.raycast = () => {};
      mesh.renderOrder = SLICE_ORDER;
      this.slicePlanes.set(view, mesh);
      this.sliceGroup.add(mesh);
      return mesh;
    };
    const ax = mk("axial", ex[1] - ex[0], ey[1] - ey[0]);
    ax.position.set((ex[0] + ex[1]) / 2, (ey[0] + ey[1]) / 2, 0);
    const co = mk("coronal", ex[1] - ex[0], ez[1] - ez[0]);
    co.rotation.x = Math.PI / 2;
    co.position.set((ex[0] + ex[1]) / 2, 0, (ez[0] + ez[1]) / 2);
    const sa = mk("sagittal", ey[1] - ey[0], ez[1] - ez[0]);
    sa.rotation.set(Math.PI / 2, Math.PI / 2, 0, "ZXY");
    sa.position.set(0, (ey[0] + ey[1]) / 2, (ez[0] + ez[1]) / 2);
  }

  /** Show a slice at world coordinate `mm` (null hides it). Returns the actual coordinate. */
  setSlice(view: "axial" | "coronal" | "sagittal", mm: number | null): number | null {
    const sl = this.atlas.graph.slices;
    const plane = this.slicePlanes.get(view);
    if (!sl || !plane) return null;
    if (mm === null) {
      plane.visible = false;
      return null;
    }
    const v = sl.views[view];
    const ax = v.axis;
    const A = sl.affine;
    const k = (mm - A[ax][3]) / A[ax][ax];
    let best = 0;
    v.indices.forEach((ix, n) => {
      if (Math.abs(ix - k) < Math.abs(v.indices[best] - k)) best = n;
    });
    const world = A[ax][3] + A[ax][ax] * v.indices[best];
    const tex = (plane.material as THREE.MeshBasicMaterial).map!;
    const r = Math.floor(best / v.cols), c = best % v.cols;
    tex.offset.set(c / v.cols, 1 - (r + 1) / v.rows);
    if (ax === 2) plane.position.z = world;
    else if (ax === 1) plane.position.y = world;
    else plane.position.x = world;
    plane.visible = true;
    return world;
  }

  // ------------------------------------------------------------------ state changes
  private setRegionMode(id: string, side: Side | "both", mode: Mode) {
    const r = this.atlas.regionById.get(id);
    if (!r) return;
    for (const s of Object.keys(r.sides) as Side[]) {
      if (side !== "both" && s !== side && s !== "M") continue;
      const mesh = this.regionObjs.get(`${id}:${s}`)!;
      this.regionModes.set(mesh, { region: r, mode });
      this.styleRegion(mesh, r, mode);
    }
  }

  private styleRegion(mesh: THREE.Mesh, r: Region, mode: Mode) {
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const b = this.brightness;
    mesh.visible = mode !== "off";
    const context = r.style === "context" || r.style === "ventricle";
    mat.opacity = mode === "dim" ? Math.min(0.8, 0.3 * b) : context && mode === "on" ? 0.35 : mode === "focus" && context ? 0.6 : 1;
    mat.depthWrite = mat.opacity > 0.9;
    // brightness above 1 makes regions self-lit in their own colour; the focused step glows a little extra
    const glow = Math.max(0, b - 1) * 0.6 + (mode === "focus" ? 0.3 : 0);
    mat.emissive.copy(mat.userData.base as THREE.Color).multiplyScalar(glow);
  }

  private styleTract(rec: TractObj, mode: Mode) {
    rec.mode = mode;
    rec.obj.visible = mode !== "off";
    const b = this.brightness;
    const op = mode === "dim" ? Math.min(0.6, 0.18 * b) : mode === "focus" ? 1 : Math.min(1, 0.8 * b);
    const mat = (rec.obj as THREE.Mesh).material;
    if (mat instanceof THREE.ShaderMaterial) {
      mat.uniforms.uOpacity.value = op;
      mat.uniforms.uBright.value = b;
    } else if (mat instanceof THREE.LineBasicMaterial) {
      mat.opacity = op;
      mat.color.setScalar(b); // multiplies the per-vertex colours
    } else if (mat instanceof THREE.MeshStandardMaterial) {
      mat.opacity = op * 0.9;
      mat.emissive.copy(mat.userData.base as THREE.Color).multiplyScalar(Math.max(0, b - 1) * 0.6);
    }
  }

  /** Brightness of the highlighted circuit (1 = original colours). */
  setBrightness(b: number) {
    this.brightness = b;
    for (const [mesh, { region, mode }] of this.regionModes) if (mesh.visible) this.styleRegion(mesh, region, mode);
    for (const rec of this.tractObjs.values()) if (rec.obj.visible) this.styleTract(rec, rec.mode);
    if (this.routeMat) this.routeMat.uniforms.uBright.value = b;
    this.styleOverview();
  }

  /** Draw the circuit over the glass brain (full colour) or behind it (softer, more depth). */
  setCircuitOverGlass(on: boolean) {
    this.circuitOverGlass = on;
    for (const m of this.contextObjs) m.renderOrder = on ? GLASS_ORDER_UNDER : GLASS_ORDER_OVER;
  }

  private setTractMode(t: Tract, side: Side | "both", mode: Mode, parts?: number[]) {
    t.parts.forEach((p, i) => {
      if (parts && !parts.includes(i)) return;
      for (const s of Object.keys(p.sides) as Side[]) {
        if (side !== "both" && s !== side && s !== "M") continue;
        const rec = this.tractObject(t, i, s);
        if (rec) this.styleTract(rec, mode);
      }
    });
  }

  clearAll() {
    for (const m of this.regionObjs.values()) m.visible = false;
    for (const t of this.tractObjs.values()) {
      t.obj.visible = false;
      t.mode = "off";
    }
    this.routeGroup.clear();
    this.labelGroup.clear();
    this.pins = [];
    this.layerGroup.clear();
    this.routeMat = null;
    this.current = null;
    this.overviewGroup.visible = false;
    this.overviewState = null;
  }

  // ------------------------------------------------------------------ all-pathways map
  private overviewTube(pw: Pathway) {
    let rec = this.overviewTubes.get(pw.id);
    if (rec) return rec;
    const pts = pw.routes.L.points.map((p) => new THREE.Vector3(...p));
    if (pts.length < 2) pts.push(pts[0].clone().add(new THREE.Vector3(0, 0, 0.1)));
    const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
    const seg = Math.min(600, pts.length * 3);
    const mk = (r: number, order: number, onTop: boolean) => {
      const m = new THREE.Mesh(new THREE.TubeGeometry(curve, seg, r, 6, false), new THREE.MeshBasicMaterial({ color: colorFor([pw.system]), transparent: true, depthTest: !onTop }));
      m.renderOrder = order;
      m.raycast = () => {};
      this.overviewGroup.add(m);
      return m;
    };
    // a coarse copy of the route for screen-space picking
    const pick = curve.getSpacedPoints(Math.max(8, Math.round(curve.getLength() / 4)));
    // the highlighted route is drawn on top of the regions so it never hides inside a nucleus
    rec = { thin: mk(0.45, 20, false), thick: mk(1.1, 24, true), pick };
    this.overviewTubes.set(pw.id, rec);
    return rec;
  }

  /** Every pathway at once, coloured by system; `match` (a filter) dims the rest. */
  showOverview(pathways: Pathway[], focus: string | null, match: Set<string> | null, frame: boolean) {
    this.clearAll();
    this.overviewGroup.visible = true;
    this.overviewState = { focus, hover: null, match };
    const fpw = pathways.find((p) => p.id === focus);
    if (fpw) {
      for (const st of fpw.steps) {
        const side = mirrorSide("L", st.side);
        if (st.region) this.setRegionMode(st.region, side, "dim");
        if (st.tract) this.showTract(st.tract, side, "dim", st.parts);
      }
    }
    for (const pw of pathways) this.overviewTube(pw);
    this.styleOverview();
    if (fpw) {
      const pts = fpw.routes.L.points;
      const mid = pts[Math.floor(pts.length / 2)];
      if (mid) {
        const el = document.createElement("div");
        el.className = "map-label";
        el.style.borderColor = colorFor([fpw.system]);
        el.textContent = fpw.name;
        this.pin(new THREE.Vector3(...mid), 2, el, "above", 9);
      }
    }
    if (frame) this.focusPoints(pathways.flatMap((p) => p.routes.L.points), 80);
  }

  setOverviewHover(id: string | null) {
    if (!this.overviewState || this.overviewState.hover === id) return;
    this.overviewState.hover = id;
    this.styleOverview();
  }

  private styleOverview() {
    const st = this.overviewState;
    if (!st) return;
    for (const [id, rec] of this.overviewTubes) {
      const isFocus = id === st.focus;
      const lit = isFocus || id === st.hover;
      const inMatch = !st.match || st.match.has(id);
      (rec.thin.material as THREE.MeshBasicMaterial).opacity = lit ? 1 : inMatch ? (st.focus ? 0.38 : 0.7) : 0.08;
      (rec.thin.material as THREE.MeshBasicMaterial).color.set(colorFor([this.atlas.pathwayById.get(id)!.system])).multiplyScalar(this.brightness);
      rec.thick.visible = lit;
    }
  }

  /** Pathway whose route passes nearest the pointer on screen (within `tol` pixels). */
  pickPathway(ev: { clientX: number; clientY: number }, tol = 10): string | null {
    const st = this.overviewState;
    if (!st) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    const v = new THREE.Vector3();
    let best: string | null = null, bestD = tol;
    for (const [id, rec] of this.overviewTubes) {
      if (st.match && !st.match.has(id)) continue;
      let px = NaN, py = NaN;
      for (const p of rec.pick) {
        v.copy(p).project(this.camera);
        const x = ((v.x + 1) / 2) * rect.width, y = ((1 - v.y) / 2) * rect.height;
        if (!Number.isNaN(px) && v.z < 1) {
          // distance from the pointer to the projected segment
          const dx = x - px, dy = y - py, l2 = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((mx - px) * dx + (my - py) * dy) / l2));
          const d = Math.hypot(px + t * dx - mx, py + t * dy - my);
          if (d < bestD) {
            bestD = d;
            best = id;
          }
        }
        px = x;
        py = y;
      }
    }
    return best;
  }

  showRegion(id: string, side: Side | "both" = "both") {
    this.setRegionMode(id, side, "focus");
  }

  showTract(id: string, side: Side | "both" = "both", mode: Mode = "on", parts?: number[]) {
    const t = this.atlas.tractById.get(id);
    if (t) this.setTractMode(t, side, mode, parts);
  }

  showRegionContext(id: string, side: Side | "both", mode: Mode = "dim") {
    this.setRegionMode(id, side, mode);
  }

  showAllTracts(on: boolean) {
    for (const t of this.atlas.graph.tracts) this.setTractMode(t, "both", on ? "dim" : "off");
  }

  setColorMode(mode: "system" | "direction") {
    this.colorMode = mode;
    for (const rec of this.tractObjs.values()) {
      const g = (rec.obj as THREE.LineSegments).geometry as THREE.BufferGeometry | undefined;
      const src = g?.getAttribute(mode === "direction" ? "dirColor" : "sysColor") as THREE.BufferAttribute | undefined;
      const dst = g?.getAttribute("color") as THREE.BufferAttribute | undefined;
      if (src && dst) {
        (dst.array as Float32Array).set(src.array as Float32Array);
        dst.needsUpdate = true;
      }
    }
  }

  setGlass(visible: boolean, opacity?: number) {
    this.glassVisible = visible;
    if (opacity !== undefined) this.glassOpacity = opacity;
    for (const m of this.tissue.shell) {
      m.visible = visible;
      (m.material as THREE.ShaderMaterial).uniforms.uOpacity.value = this.glassOpacity;
    }
  }

  /** Show or hide a tissue layer: ventricles, grey matter or white matter. */
  setTissue(kind: "ventricles" | "grey" | "white", visible: boolean) {
    for (const m of this.tissue[kind]) m.visible = visible;
  }

  /** Schematic cortical-layer columns at the cortical steps of the current pathway. */
  setLayerColumns(visible: boolean) {
    this.layersVisible = visible;
    if (this.current) this.showPathway(this.current.pw, this.current.start, this.current.step, "none");
  }

  /** Display a pathway for a start side; returns the region/tract objects involved for the UI. */
  showPathway(pw: Pathway, start: "L" | "R", step: number, frame: "step" | "all" | "none" = "step") {
    this.clearAll();
    this.current = { pw, start, step };
    const neurons = pathwayNeurons(pw);
    const baseHex = colorFor([pw.system]);
    for (const st of pw.steps) {
      const side = mirrorSide(start, st.side);
      if (st.region) this.setRegionMode(st.region, side, "dim");
      if (st.tract) this.showTract(st.tract, side, "dim", st.parts);
    }
    for (const h of pw.highlight ?? []) this.setRegionMode(h.region, mirrorSide(start, h.side), "dim");
    const cur = pw.steps[step];
    const cs = mirrorSide(start, cur.side);
    if (cur.region) this.setRegionMode(cur.region, cs, "focus");
    if (cur.tract) this.showTract(cur.tract, cs, "focus", cur.parts);

    const route = pw.routes[start];
    const pts = route.points.map((p) => new THREE.Vector3(...p));
    if (pts.length >= 2) {
      const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
      const total = curve.getLength();
      // arc-length fraction at each route point
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
      const frac = (i: number) => cum[Math.min(i, cum.length - 1)] / (cum[cum.length - 1] || 1);
      const [a, b] = route.spans[step];
      const bounds = new Array(12).fill(2);
      neurons.slice(1).forEach((nr, i) => (bounds[i] = frac(route.spans[nr.from][0])));
      this.routeMat = new THREE.ShaderMaterial({
        vertexShader: DASH_VERT,
        fragmentShader: ROUTE_FRAG,
        uniforms: {
          uColor: { value: new THREE.Color(colorFor([pw.system])) },
          uTime: { value: 0 },
          uSpan: { value: new THREE.Vector2(frac(a), frac(b)) },
          uLength: { value: total },
          uBright: { value: this.brightness },
          uBounds: { value: bounds },
          uNeurons: { value: Math.max(1, neurons.length) },
          uTint: { value: NEURON_TINT },
        },
        transparent: true,
        depthTest: true,
      });
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.min(1200, pts.length * 4), ROUTE_RADIUS, 8, false), this.routeMat);
      tube.renderOrder = 20;
      tube.raycast = () => {};
      this.routeGroup.add(tube);
    }
    // cell bodies (spheres), synapses (cones pointing into the target) and pass-through rings
    const tangentAt = (i: number) => {
      const a = pts[Math.max(0, i - 2)], b = pts[Math.min(pts.length - 1, i + 2)];
      return b.clone().sub(a).normalize();
    };
    // markers are drawn on top of everything with a dark outline, so they read against same-coloured regions
    const addMarker = (geom: THREE.BufferGeometry, color: string, pos: THREE.Vector3, dir?: THREE.Vector3) => {
      const g = new THREE.Group();
      const fill = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }));
      const edge = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: 0x15181d, side: THREE.BackSide, depthTest: false, transparent: true }));
      edge.scale.setScalar(1.3);
      fill.renderOrder = 26;
      edge.renderOrder = 25;
      g.add(edge, fill);
      g.position.copy(pos);
      if (dir) g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      g.traverse((o) => (o.raycast = () => {}));
      this.routeGroup.add(g);
    };
    for (const nr of neurons) {
      const shade = neuronShade(baseHex, nr.order);
      const somaPt = pts[route.spans[nr.from][0]];
      if (somaPt) addMarker(new THREE.SphereGeometry(nr.from === step ? 2.2 : 1.8, 20, 14), shade, somaPt);
      const synIdx = route.spans[nr.to][0];
      const synPt = pts[synIdx];
      if (synPt) {
        const dir = tangentAt(synIdx);
        addMarker(new THREE.ConeGeometry(1.4, 3.2, 16), "#ffffff", synPt.clone().sub(dir.clone().multiplyScalar(3.4)), dir);
      }
      for (const k of nr.via) {
        const st = pw.steps[k];
        if (!st.region) continue;
        const i = route.spans[k][0];
        if (pts[i]) addMarker(new THREE.TorusGeometry(2.0, 0.35, 8, 28), "#ffffff", pts[i], tangentAt(i));
      }
    }
    if (this.layersVisible) this.addLayerColumns(pw, start, route.spans.map((s) => pts[s[0]]), neurons, baseHex);
    // step names sit above the markers, and transmitter tags below each synapse
    const markerR = (k: number) => (neurons.some((nr) => nr.to === k) ? 5.4 : neurons.some((nr) => nr.from === k) ? 3 : 2.8);
    pw.steps.forEach((st, k) => {
      if (!st.region) return;
      const r = this.atlas.regionById.get(st.region)!;
      const p = pts[route.spans[k][0]];
      if (!p) return;
      const el = document.createElement("div");
      el.className = "step-label" + (k === step ? " current" : "");
      el.textContent = `${k + 1}. ${r.abbrev?.[0] ?? r.name}`;
      // the current step and its neuron(s) win when labels collide
      const near = neurons.some((x) => (x.from === k || x.to === k) && step >= x.from && step <= x.to);
      const prio = (k === step ? 4 : near ? 2 : 0) + 1;
      this.pin(p, markerR(k), el, "above", prio);
      const nr = neurons.find((x) => x.to === k);
      const src = nr ? pw.steps[nr.from] : undefined;
      if (src?.transmitter && src.effect) {
        const tag = document.createElement("div");
        tag.className = "syn-tag" + (nr!.to === step || nr!.from === step ? " current" : "");
        tag.style.background = EFFECT_COLOR[src.effect];
        tag.textContent = `${transmitterShort(src.transmitter)} ${EFFECT_SIGN[src.effect]}`;
        if (nr!.to === step) tag.textContent += ` ${src.effect}`;
        this.pin(p, markerR(k), tag, "below", prio - 0.5);
      }
    });
    if (frame === "all") this.focusPoints(route.points, 60);
    else if (frame === "step") {
      // frame the current step together with its neighbours so the student keeps context
      const a = route.spans[Math.max(0, step - 1)][0];
      const b = route.spans[Math.min(route.spans.length - 1, step + 1)][1];
      this.focusPoints(route.points.slice(a, b + 1), 55);
    }
  }

  /** Stacked-disc cortical column at each cortical step; highlighted layers hold cell bodies or synapses. */
  private addLayerColumns(pw: Pathway, _start: "L" | "R", stepPts: (THREE.Vector3 | undefined)[], neurons: ReturnType<typeof pathwayNeurons>, baseHex: string) {
    const centre = new THREE.Vector3(0, -18, 12);
    pw.steps.forEach((st: PathwayStep, k) => {
      const p = stepPts[k];
      const r = st.region ? this.atlas.regionById.get(st.region) : undefined;
      if (!p || !r || !r.group.startsWith("cortex")) return;
      const allo = ALLOCORTEX.has(r.id);
      const layers = allo
        ? [{ name: "molecular", label: "Molecular", t: 0.4 }, { name: "pyramidal", label: "Pyramidal / granule cell", t: 0.25 }, { name: "polymorphic", label: "Polymorphic", t: 0.35 }]
        : [
            { name: "I", label: "I", t: 0.1 }, { name: "II", label: "II", t: 0.08 }, { name: "III", label: "III", t: 0.26 },
            { name: "IV", label: "IV", t: 0.1 }, { name: "V", label: "V", t: 0.22 }, { name: "VI", label: "VI", t: 0.24 },
          ];
      const parse = (s?: string) => new Set((s ?? "").match(/\b(VI|IV|V|III|II|I|molecular|pyramidal|polymorphic)\b/g) ?? []);
      const inSet = parse(st.layer_in), outSet = parse(st.layer_out);
      const inNeuron = neurons.find((n) => n.to === k), outNeuron = neurons.find((n) => n.from === k);
      const normal = p.clone().sub(centre).normalize();
      const H = 16, R = 5;
      const group = new THREE.Group();
      // clear the depth buffer just before the column so its discs occlude each other correctly
      // while still drawing on top of the glass, regions and tracts
      const clearGeom = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(9), 3));
      const clear = new THREE.Mesh(clearGeom, new THREE.MeshBasicMaterial({ transparent: true, colorWrite: false, depthWrite: false }));
      clear.renderOrder = 29;
      clear.frustumCulled = false;
      clear.onBeforeRender = (renderer) => renderer.clearDepth();
      group.add(clear);
      let y = H / 2;
      layers.forEach((L, i) => {
        const h = L.t * H;
        let color = i % 2 === 0 ? "#d9d4cb" : "#b9b2a6";
        if (outSet.has(L.name) && outNeuron) color = neuronShade(baseHex, outNeuron.order);
        else if (inSet.has(L.name) && inNeuron) color = neuronShade(baseHex, inNeuron.order);
        const disc = new THREE.Mesh(
          new THREE.CylinderGeometry(R, R, h * 0.92, 24),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 }),
        );
        disc.position.y = y - h / 2;
        disc.renderOrder = 30;
        group.add(disc);
        if (outSet.has(L.name) || inSet.has(L.name)) {
          const rim = new THREE.LineSegments(
            new THREE.EdgesGeometry(disc.geometry, 30),
            new THREE.LineBasicMaterial({ color: 0x15181d, transparent: true }),
          );
          rim.position.copy(disc.position);
          rim.renderOrder = 31;
          group.add(rim);
        }
        y -= h;
      });
      group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
      group.position.copy(p.clone().add(normal.clone().multiplyScalar(12)));
      group.traverse((o) => (o.raycast = () => {}));
      this.layerGroup.add(group);
      const parts: string[] = [];
      if (st.layer_out) parts.push(`cell bodies: ${allo ? st.layer_out : "layer " + st.layer_out}`);
      if (st.layer_in) parts.push(`synapses: ${allo ? st.layer_in : "layer " + st.layer_in}`);
      const el = document.createElement("div");
      el.className = "layer-label";
      el.textContent = parts.length ? parts.join(" · ") : allo ? "allocortex (3 layers)" : "neocortex (6 layers)";
      const lab = new CSS2DObject(el);
      lab.position.copy(p.clone().add(normal.clone().multiplyScalar(12 + H / 2 + 3)));
      this.layerGroup.add(lab);
    });
  }

  // ------------------------------------------------------------------ camera
  focusPoints(points: Vec3[], minRadius = 40) {
    if (!points.length) return;
    const box = new THREE.Box3().setFromPoints(points.map((p) => new THREE.Vector3(...p)));
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(minRadius, box.getSize(new THREE.Vector3()).length() / 2);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const vfov = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const hfov = Math.atan(Math.tan(vfov) * this.camera.aspect);
    const dist = (r / Math.sin(Math.min(vfov, hfov))) * 1.15;
    this.animateTo(c.clone().add(dir.multiplyScalar(dist)), c);
  }

  focusObject(kind: "region" | "tract", id: string, side: Side | "both" = "both") {
    const pts: Vec3[] = [];
    if (kind === "region") {
      const r = this.atlas.regionById.get(id);
      if (!r) return;
      for (const [s, sd] of Object.entries(r.sides)) {
        if (side !== "both" && s !== side && s !== "M") continue;
        const mesh = this.regionObjs.get(`${id}:${s}`);
        const bs = mesh?.geometry.boundingSphere;
        if (bs) {
          pts.push([bs.center.x - bs.radius, bs.center.y - bs.radius, bs.center.z - bs.radius]);
          pts.push([bs.center.x + bs.radius, bs.center.y + bs.radius, bs.center.z + bs.radius]);
        } else if (sd) pts.push(sd.centroid);
      }
      this.focusPoints(pts, 65);
    } else {
      const t = this.atlas.tractById.get(id);
      if (!t) return;
      for (const p of t.parts) for (const [s, sd] of Object.entries(p.sides)) {
        if (side !== "both" && s !== side && s !== "M") continue;
        pts.push(...(sd?.centerline ?? sd?.path ?? []));
      }
      this.focusPoints(pts, 45);
    }
  }

  viewPreset(name: string) {
    const t = new THREE.Vector3(0, -20, 0);
    const d = 340;
    const dirs: Record<string, [number, number, number]> = {
      left: [-1, 0, 0.08], right: [1, 0, 0.08], anterior: [0, 1, 0.1], posterior: [0, -1, 0.1],
      superior: [0, -0.02, 1], inferior: [0, 0.02, -1], oblique: [-0.8, 0.6, 0.45],
    };
    const v = new THREE.Vector3(...(dirs[name] ?? dirs.left)).normalize().multiplyScalar(d);
    this.animateTo(t.clone().add(v), t);
  }

  private animateTo(pos: THREE.Vector3, target: THREE.Vector3, dur = 700) {
    this.tween = { from: [this.camera.position.clone(), this.controls.target.clone()], to: [pos, target], t0: performance.now(), dur };
  }

  // ------------------------------------------------------------------ picking
  pick(ev: PointerEvent): PickInfo | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.raycaster.params.Line = { threshold: 1.2 };
    const objs: THREE.Object3D[] = [];
    for (const m of this.regionObjs.values()) if (m.visible) objs.push(m);
    for (const t of this.tractObjs.values()) if (t.obj.visible) objs.push(t.obj);
    const hits = this.raycaster.intersectObjects(objs, false);
    const h = hits.find((x) => (x.object.userData as PickInfo).kind);
    return h ? (h.object.userData as PickInfo) : null;
  }

  private pin(pos: THREE.Vector3, r: number, inner: HTMLElement, where: "above" | "below", priority: number) {
    const wrap = document.createElement("div");
    wrap.className = `pin ${where}`;
    wrap.append(inner);
    const obj = new CSS2DObject(wrap);
    obj.position.copy(pos);
    this.labelGroup.add(obj);
    this.pins.push({ wrap, pos: pos.clone(), r, priority });
  }

  private updatePins() {
    if (!this.pins.length) return;
    const h = this.renderer.domElement.clientHeight;
    const k = h / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    for (const p of this.pins) {
      const px = (p.r * k) / Math.max(1, this.camera.position.distanceTo(p.pos));
      p.wrap.style.setProperty("--gap", `${Math.min(140, px + 4).toFixed(1)}px`);
    }
  }

  /** Hide lower-priority labels that overlap a higher-priority one (checked every few frames). */
  private declutterPins() {
    if (!this.pins.length || this.pinFrame++ % 4) return;
    const placed: DOMRect[] = [];
    const order = [...this.pins].sort((a, b) => b.priority - a.priority);
    for (const p of order) {
      const el = p.wrap.firstElementChild as HTMLElement | null;
      if (!el || p.wrap.style.display === "none") continue;
      const r = el.getBoundingClientRect();
      const hit = placed.some((q) => r.left < q.right + 2 && r.right > q.left - 2 && r.top < q.bottom + 1 && r.bottom > q.top - 1);
      el.style.visibility = hit ? "hidden" : "";
      if (!hit) placed.push(r);
    }
  }

  // ------------------------------------------------------------------ loop
  private resize(container: HTMLElement) {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
  }

  private frame() {
    if (this.tween) {
      const k = Math.min(1, (performance.now() - this.tween.t0) / this.tween.dur);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.camera.position.lerpVectors(this.tween.from[0], this.tween.to[0], e);
      this.controls.target.lerpVectors(this.tween.from[1], this.tween.to[1], e);
      if (k >= 1) this.tween = null;
    }
    if (this.routeMat) this.routeMat.uniforms.uTime.value = (performance.now() - this.t0) / 1000;
    this.controls.update();
    this.updatePins();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
    this.declutterPins();
  }
}
