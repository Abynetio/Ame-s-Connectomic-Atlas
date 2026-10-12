import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { Atlas, decodeBundle, decodeMesh, Pathway, Region, Side, Tract, Vec3, mirrorSide } from "./data";
import { colorFor } from "./palette";

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
  uniform vec3 uColor; uniform float uRepeat; uniform float uOpacity;
  varying vec2 vUv; varying vec3 vN; varying vec3 vV;
  void main() {
    if (fract(vUv.x * uRepeat) > 0.62) discard;
    float l = 0.45 + 0.55 * abs(dot(normalize(vN), normalize(vV)));
    gl_FragColor = vec4(uColor * l, uOpacity);
  }`;

const ROUTE_FRAG = /* glsl */ `
  uniform vec3 uColor; uniform float uTime; uniform vec2 uSpan; uniform float uLength;
  varying vec2 vUv; varying vec3 vN; varying vec3 vV;
  void main() {
    float u = vUv.x;
    float l = 0.5 + 0.5 * abs(dot(normalize(vN), normalize(vV)));
    float inSpan = step(uSpan.x - 1e-4, u) * step(u, uSpan.y + 1e-4);
    float done = step(u, uSpan.y);
    // travelling pulses, ~25 mm apart, moving at ~40 mm/s
    float d = fract((u * uLength - uTime * 40.0) / 25.0);
    float pulse = smoothstep(0.0, 0.08, d) * (1.0 - smoothstep(0.08, 0.35, d));
    vec3 base = mix(vec3(0.55), uColor, 0.35 + 0.65 * done);
    vec3 c = base * l + pulse * 0.9 * done + inSpan * 0.25;
    float a = mix(0.35, 1.0, done);
    gl_FragColor = vec4(c, a);
  }`;

interface TractObj { obj: THREE.Object3D; tract: Tract; part: number; side: Side }

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
  private labelGroup = new THREE.Group();
  private sliceGroup = new THREE.Group();
  private slicePlanes = new Map<string, THREE.Mesh>();
  private routeMat: THREE.ShaderMaterial | null = null;
  private t0 = performance.now();
  private raycaster = new THREE.Raycaster();
  private tween: { from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3]; t0: number; dur: number } | null = null;
  private glassOpacity = 0.28;
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
    this.scene.add(this.routeGroup, this.labelGroup, this.sliceGroup);

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
    for (const c of this.atlas.graph.context) {
      const mesh = new THREE.Mesh(this.meshFrom(c.mesh), this.glassMaterial(0xb8c0cc, this.glassOpacity));
      mesh.renderOrder = 10;
      mesh.userData = { kind: "context", id: c.id, side: "M", name: c.name } satisfies PickInfo;
      this.contextObjs.push(mesh);
      this.scene.add(mesh);
    }
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
      obj = new THREE.Mesh(this.meshFrom(s.mesh), new THREE.MeshStandardMaterial({ color, roughness: 0.5, transparent: true, opacity: 0.9 }));
    } else {
      const pts = s.path!.map((q) => new THREE.Vector3(...q));
      const curve = new THREE.CatmullRomCurve3(pts);
      const len = curve.getLength();
      const g = new THREE.TubeGeometry(curve, Math.max(8, pts.length * 2), p.radius ?? 0.8, 10, false);
      obj = new THREE.Mesh(
        g,
        new THREE.ShaderMaterial({
          vertexShader: DASH_VERT,
          fragmentShader: DASH_FRAG,
          uniforms: { uColor: { value: color }, uRepeat: { value: len / 2.2 }, uOpacity: { value: 1 } },
          transparent: true,
          side: THREE.DoubleSide,
        }),
      );
    }
    obj.userData = { kind: "tract", id: t.id, side, name: t.name } satisfies PickInfo;
    obj.visible = false;
    this.scene.add(obj);
    const rec = { obj, tract: t, part, side };
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
      mesh.renderOrder = 5;
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
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mesh.visible = mode !== "off";
      const context = r.style === "context" || r.style === "ventricle";
      mat.opacity = mode === "dim" ? 0.3 : context && mode === "on" ? 0.35 : mode === "focus" && context ? 0.6 : 1;
      mat.depthWrite = mat.opacity > 0.9;
      mat.emissive.set(mode === "focus" ? 0x555555 : 0x000000);
    }
  }

  private setTractMode(t: Tract, side: Side | "both", mode: Mode, parts?: number[]) {
    t.parts.forEach((p, i) => {
      if (parts && !parts.includes(i)) return;
      for (const s of Object.keys(p.sides) as Side[]) {
        if (side !== "both" && s !== side && s !== "M") continue;
        const rec = this.tractObject(t, i, s);
        if (!rec) continue;
        rec.obj.visible = mode !== "off";
        const mat = (rec.obj as THREE.Mesh).material as THREE.Material & { opacity: number; uniforms?: Record<string, THREE.IUniform> };
        const op = mode === "dim" ? 0.18 : mode === "focus" ? 1 : 0.8;
        if (mat.uniforms?.uOpacity) mat.uniforms.uOpacity.value = op;
        else mat.opacity = op;
      }
    });
  }

  clearAll() {
    for (const m of this.regionObjs.values()) m.visible = false;
    for (const t of this.tractObjs.values()) t.obj.visible = false;
    this.routeGroup.clear();
    this.labelGroup.clear();
    this.routeMat = null;
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
    for (const m of this.contextObjs) {
      m.visible = visible;
      (m.material as THREE.ShaderMaterial).uniforms.uOpacity.value = this.glassOpacity;
    }
  }

  /** Display a pathway for a start side; returns the region/tract objects involved for the UI. */
  showPathway(pw: Pathway, start: "L" | "R", step: number, frame: "step" | "all" | "none" = "step") {
    this.clearAll();
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
      this.routeMat = new THREE.ShaderMaterial({
        vertexShader: DASH_VERT,
        fragmentShader: ROUTE_FRAG,
        uniforms: {
          uColor: { value: new THREE.Color(colorFor([pw.system])) },
          uTime: { value: 0 },
          uSpan: { value: new THREE.Vector2(frac(a), frac(b)) },
          uLength: { value: total },
        },
        transparent: true,
        depthTest: true,
      });
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.min(1200, pts.length * 4), 0.75, 10, false), this.routeMat);
      tube.renderOrder = 20;
      tube.raycast = () => {};
      this.routeGroup.add(tube);
    }
    // labels and synapse markers for region steps
    pw.steps.forEach((st, k) => {
      if (!st.region) return;
      const r = this.atlas.regionById.get(st.region)!;
      const p = pts[route.spans[k][0]];
      if (!p) return;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(k === step ? 1.8 : 1.2, 16, 12), new THREE.MeshBasicMaterial({ color: k === step ? 0xffffff : 0xffd166 }));
      dot.position.copy(p);
      dot.raycast = () => {};
      this.routeGroup.add(dot);
      const el = document.createElement("div");
      el.className = "step-label" + (k === step ? " current" : "");
      el.textContent = `${k + 1}. ${r.abbrev?.[0] ?? r.name}`;
      const lab = new CSS2DObject(el);
      lab.position.copy(p);
      this.labelGroup.add(lab);
    });
    if (frame === "all") this.focusPoints(route.points, 60);
    else if (frame === "step") {
      // frame the current step together with its neighbours so the student keeps context
      const a = route.spans[Math.max(0, step - 1)][0];
      const b = route.spans[Math.min(route.spans.length - 1, step + 1)][1];
      this.focusPoints(route.points.slice(a, b + 1), 55);
    }
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
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}
