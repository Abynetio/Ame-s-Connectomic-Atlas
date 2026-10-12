# Ame's Connectomic Atlas — Project Plan

A 3D, projection-level atlas of the human central nervous system for teaching
neuroanatomy at medical-school level and above (written with a future
neurosurgeon in mind). The goal is narrow and practical: for every structure
a student is expected to know, show **where it is in 3D, what it is called,
which tract carries its output, and where that output ends up**. Slice
atlases show the structures but leave the student to work out the wiring.
This atlas shows the wiring.

Status: **plan only — awaiting approval before implementation.**

---

## 1. What the finished product is

A static web app hosted on GitHub Pages, with no server and no install. A
student can:

1. **Explore the brain in 3D.** It shows a translucent brain on the MNI
   ICBM152 template. Nuclei and cortical areas are clickable surfaces, and
   tracts are streamline bundles or tubes.
2. **Ask "where does X project?"** Clicking a structure lists its efferents
   and afferents, each with the tract that carries it. Clicking a tract shows
   its origin, course, decussation, termination, neurotransmitter, and
   clinical relevance.
3. **Trace a pathway step by step.** For example, the dorsal column–medial
   lemniscus pathway: DRG → gracile/cuneate nuclei → internal arcuate fibres
   → decussation → medial lemniscus → VPL → posterior limb of the internal
   capsule → S1. Each synapse and crossing is highlighted in turn, and the
   camera follows the pathway.
4. **Cross-reference to slices.** Axial, coronal, and sagittal clip planes
   with the template MRI drawn on them connect the 3D picture back to the
   slice atlases the student already uses.
5. **Read the wiring diagram.** A 2D connectogram/wiring diagram (in the
   spirit of the Edlow dAAN connectograms) is linked to the 3D view, so
   selecting in one highlights in the other.
6. **Test themselves.** A lesion-localisation and "name the tract" quiz mode
   uses the same knowledge graph, e.g. "Right hemibody loss of
   proprioception plus left tongue deviation — where is the lesion?"

What it is **not**: it is not a research connectome, it does not claim to be
complete, and it is not a clinical or surgical-planning tool. A visible
disclaimer will say so.

---

## 2. The key design decision: two layers, kept separate

Diffusion tractography can show the 3D course of a bundle. It **cannot**
show direction, synapses, decussation logic, or which neuron projects
where, and it has well-known false positives and negatives. Tract-tracing
data (CoCoMac, Kennedy/Markov) does show directed projections, but it comes
from macaques and covers cortex only. Textbooks have the full directed
wiring, but no 3D geometry.

So the atlas keeps two layers that refer to each other but are never
conflated:

| Layer | What it holds | Where it comes from |
|---|---|---|
| **Knowledge graph** (the authority) | Regions, tracts, directed projections, multi-synaptic pathways, neurotransmitters, function, lesion syndromes, surgical notes, synonyms, references | Hand-curated YAML, written in our own words from the primary literature and standard references, every claim cited |
| **Geometry** (the illustration) | Meshes for regions, streamlines or tubes for tracts, all in MNI ICBM152 2009 space | Open atlases (tractography plus segmentations), and hand-authored schematic splines where no imaging atlas exists |

Each projection edge in the graph records its **evidence type**:

- `human-tractography`: the bundle is present in a population tractography atlas (Yeh HCP1065/HCP842).
- `human-tract-to-region`: termination probability comes from the Yeh 2022 tract-to-region connectome, or is recomputed from streamline endpoints.
- `nhp-tract-tracing`: the projection is established by tracer studies in macaque (CoCoMac literature, Markov et al. 2014). It is cited, not copied.
- `classical`: textbook or lesion consensus (e.g. Brodal, Nieuwenhuys, Haines, Blumenfeld), with the primary paper where possible.

Each geometry object records whether it is **data-derived** or
**schematic**. The UI renders schematic geometry in a distinct dashed or
hatched style, so students never mistake an artist's path for imaging data.

---

## 3. Data sources and their use policies

I checked licenses in October 2026. Each file's licence will also be
vendored into `data/licenses/` and re-checked at ingestion. Some hosts
(Zenodo, Dryad, OSF, NITRC) are unreachable from the build sandbox used to
write this plan. Those are marked *verify at download*, and their fetch
scripts will run in GitHub Actions or locally.

### 3.1 Sources you suggested

| Source | What it gives us | Licence / terms | Use in atlas |
|---|---|---|---|
| **Yeh 2022, *Nat Commun*** — population tract-to-region connectome (HCP1065) | Probability with which each of the major bundles connects to each cortical/subcortical region, from 1,065 subjects | Article is open access. Atlas and connectome are **CC BY-SA 4.0**, derived from HCP data, so **HCP Open-Access Data Use Terms** and the HCP acknowledgement also apply | **Core.** Supplies tract-terminal regions for association, projection, and commissural tracts. |
| **HCP1065 tractography atlas** (`ICBM152_adult.tt.gz`, GitHub mirror `frankyeh/data-atlas`, release tag `ICBM152_adult`, ~3 MB, **verified downloadable from the sandbox**) | Streamlines for **106 bundles**, including CST, corticobulbar, corticopontine (F/P/O), medial lemniscus, dentatorubrothalamic (decussating and non-decussating), reticular tract, medial forebrain bundle, ansa lenticularis, ansa subthalamica, fasciculus lenticularis/subthalamicus, fornix, thalamic radiations, optic and acoustic radiations, cerebellar peduncles, anterior commissure, CC segments, and CN II, III, V, VII, VIII | CC BY-SA 4.0 + HCP Data Use Terms (as above) | **Core geometry** for almost every tract. |
| **Yeh et al. population atlas** (bioRxiv 136473 → *NeuroImage* 2018, HCP842) and **HCP-YA Tractography Atlas on Zenodo 3627772** | The 2018 HCP842 atlas: 80 labelled tract volumes, including bundles absent from HCP1065: spinothalamic, lateral lemniscus, MLF, DLF, central tegmental tract, rubrospinal, posterior commissure, CN IV, CN X | CC BY-SA 4.0 + HCP terms. The label volume `HCP842_tractography.nii.gz` is also in the GitHub mirror. *Verify Zenodo licence field at download.* | **Core supplement.** Brainstem tracts are meshed from label volumes, and centrelines are skeletonised for animation. |
| **BALSA: IamBrain HCP Anatomy & Tractography Tutorial** (Van Essen & Elam, 2023) | Connectome Workbench scenes (HCP-MMP parcellation, XTRACT tracts on surfaces) | WU-Minn HCP Open-Access Data Use Terms. Redistribution of derived data is allowed under the same terms with acknowledgement. XTRACT itself ships with FSL (non-commercial) | **Reference and QA only.** Used to cross-check our tract endpoints against XTRACT. No files are redistributed. |
| **Harvard Ascending Arousal Network (AAN) Atlas v2** (Edlow et al., Dryad `10.5061/dryad.zw3r228d2`) | 1 mm MNI152 label maps of brainstem, hypothalamic, thalamic, and basal forebrain arousal nuclei (LC, DR, MnR, PPN, LDTg, PBC, mRt, PAG, VTA, …) plus the dAAN/vAAN connection list | **CC0** (all Dryad data is published CC0). Citation is requested, not required. | **Core** for brainstem and arousal nuclei. Its connectivity is encoded in the graph with `human-tractography` (ex vivo) evidence. |
| **Edlow et al. 100 µm ex vivo 7 T MRI** (Dryad `10.5061/dryad.119f80q`; *Sci Data* 2019) | Highest-resolution whole-brain MRI available | **CC0** (Dryad) | **Optional.** Used to author or verify schematic waypoints in the brainstem, and for downsampled inset views. Too large to ship (GB-scale). |
| **Edlow et al. dAAN connectograms** (PMC10369992, Fig. 5) | Design precedent for the 2D connectogram | Figure is copyright of the article. **We do not copy it.** We re-implement the idea from our own data. | Design inspiration only. |
| **MGH AAN background page** | Atlas methodology | — | Documentation and citation. |
| **CoCoMac** (NITRC / G-Node) | Collated macaque tract-tracing literature (several hundred studies) | **No explicit data licence found.** Treat as all rights reserved. | **Citation only.** We cite the underlying primary papers as `nhp-tract-tracing` evidence and never redistribute CoCoMac records. |
| **Kennedy lab Core-Nets** (ANR-11-BSV4-0005; Markov et al. 2014 *Cereb Cortex*; core-nets.org) | Quantitative retrograde-tracer connectivity (FLNe) for 29 injected / 91 macaque cortical areas | **No explicit licence found** for the dataset. The papers are copyrighted. | **Citation only**, as for CoCoMac. Scientific facts ("V1 projects to V2") are not copyrightable. Weights and tables are not reproduced. |
| **Université de Lyon "Atlasing the macaque connectome"** | PhD project description | — | Context only. |

### 3.2 Additional sources I propose

| Source | What it gives us | Licence | Use |
|---|---|---|---|
| **MNI ICBM152 2009 nonlinear asymmetric** (Fonov et al. 2011; via TemplateFlow S3, reachable, and the Yeh mirror) | Reference space, T1w/T2w background, brain surface | Permissive McGill/Collins notice: use, copy, modify, and distribute for any purpose **with the copyright notice kept** | **Core**: reference space and glass-brain surface. |
| **CerebrA** (Manera et al. 2020; Mindboggle-101 labels on ICBM2009c) | 102 cortical/subcortical labels matching the template | Same McGill permissive notice | **Core** coarse cortical gyri and lobes. |
| **THOMAS thalamic nuclei atlas** (Saranathan et al. 2021, *Sci Data*) | AV, VA, VLa, VLp, VPL, Pulvinar, LGN, MGN, CM, MD, Habenula, etc. | **CC0** | **Core**: thalamic relay nuclei, which are central to projection teaching. |
| **ATAG basal ganglia atlas** (Keuken et al. 2014, 7 T) | STN, SN, RN, GPi, GPe, striatum | **CC BY 3.0** (attribution, citation required) | **Core**: basal ganglia nuclei for the direct, indirect, and hyperdirect pathways. |
| **CIT168 subcortical atlas** (Pauli et al. 2018) | NAc, VTA, SNc/SNr split, hypothalamus, mammillary bodies, ventral pallidum, habenula, etc. | **CC BY 4.0** (OSF project). Built from HCP data, so we also add the HCP acknowledgement. *Verify at download.* | **Core** for limbic and reward circuitry. |
| **HCP-MMP1.0** (Glasser et al. 2016), volumetric MNI version | 180 cortical areas per hemisphere (e.g. 4, 3a/3b/1/2, FEF, 44/45, V1–V4, MT, A1…) | **HCP Open-Access Data Use Terms** (redistribution allowed under the same terms) | **Optional fine-cortex layer.** Toggleable. Also used to compute tract-to-region endpoints. |
| **CHA — Common Hierarchical Atlas** (Venkadesh, …, Yeh 2025) | Hierarchical cortical/subcortical parcellation in the same space as the tractography | **CC BY-SA 4.0** | Optional lobe/macro-region grouping. |
| **PAM50 spinal cord template** (De Leener et al. 2018; Spinal Cord Toolbox) | Cord in ICBM152-compatible space, with a 29-tract white-matter atlas (dorsal columns, lateral and anterior CST, spinothalamic, spinocerebellar, rubrospinal, reticulospinal, vestibulospinal…) | **Verify** (SCT is open source; the template licence still needs checking) | **Phase 3**: spinal cord extension. Fallback is schematic cord geometry. |
| **UBERON** anatomy ontology / NeuroNames | Stable IDs, synonyms, Latin terms | **CC BY 3.0** (UBERON) | IDs and synonyms on every region and tract. |
| *Terminologia Neuroanatomica* (FIPAT, 2017) | Official Latin and English nomenclature | Freely published by FIPAT. Terms are facts or names. | Naming standard. |

### 3.3 Sources deliberately **excluded** from the published bundle

| Source | Reason |
|---|---|
| Julich-Brain (CC BY-NC-SA 4.0), Brainnetome (NC, share-alike), Pijnenburg Brodmann (CC BY-NC-SA 4.0), SUIT cerebellar nuclei (CC BY-NC 3.0) | Non-commercial terms are **incompatible with CC BY-SA 4.0**, which the core tractography forces on us. Mixing them would make the bundle unlicensable. They can be added later as an optional "load from your own copy" overlay. |
| Brainstem Navigator (Bianciardi, NITRC) | Licence **forbids redistribution outside your organisation**. |
| Harvard-Oxford / XTRACT (FSL) | Conflicting FSL licence statements (non-commercial vs CC BY-SA 4.0). Not needed because CerebrA covers the same ground. |
| Allen Human Brain Atlas (general terms) | Non-commercial redistribution terms. (The 2020 3D reference atlas is CC BY 4.0 and can be reconsidered later.) |
| Textbook figures (Netter, Haines, Rhoton, etc.) | Copyrighted. We cite textbooks as references for facts and write everything in our own words. |

**Gap this leaves:** the deep cerebellar nuclei (dentate, interposed,
fastigial) and some small brainstem nuclei (e.g. vestibular nuclei, nucleus
ambiguus, solitary nucleus, cranial-nerve motor nuclei) have no
redistributable mesh. They will be **schematic ellipsoids** placed at
coordinates taken from the literature and checked against the 100 µm Edlow
volume (CC0), and labelled as schematic.

### 3.4 Resulting licence of this repository

- **Code**: MIT.
- **Curated knowledge graph** (our own text, our own YAML): **CC BY-SA 4.0**.
- **Derived geometry**: **CC BY-SA 4.0**, as required by the share-alike
  terms of the Yeh atlases. Files derived from HCP data also carry the
  **WU-Minn HCP Open-Access Data Use Terms** (a `DATA_USE_TERMS.md` beside
  them) and the mandated acknowledgement sentence.
- A generated `ATTRIBUTION.md` lists every source, its licence, its
  citation, and the files derived from it. The site footer shows the same
  information.

All of these licences permit public hosting on GitHub, including commercial
or educational reuse by others.

---

## 4. Teaching scope (v1 curriculum)

The target is the projection knowledge expected in a neurosurgical
residency neuroanatomy curriculum. It is organised by **system**, and each
system is a set of ordered **pathways** (chains of region → tract → region).

**Motor**
- Corticospinal (lateral and anterior; pyramidal decussation), corticobulbar (to CN motor nuclei, with the bilateral/unilateral innervation pattern of the facial nucleus)
- Corticopontocerebellar (fronto-, parieto-, occipito-, temporopontine → pontine nuclei → MCP)
- Rubrospinal, reticulospinal, vestibulospinal, tectospinal (tectospinal schematic)

**Somatosensory**
- Dorsal column–medial lemniscus
- Anterolateral system (spinothalamic, spinoreticular, spinomesencephalic)
- Trigeminal system (principal sensory and spinal nuclei → trigeminal lemniscus → VPM)
- Spinocerebellar tracts (dorsal, ventral, cuneocerebellar)

**Special senses**
- Visual: retina → optic nerve → chiasm → tract → LGN → optic radiation (including Meyer's loop) → V1. Also the pretectal (pupillary light reflex) and collicular branches.
- Auditory: CN VIII → cochlear nuclei → trapezoid body/SOC → lateral lemniscus → inferior colliculus → MGN → acoustic radiation → A1
- Vestibular: vestibular nuclei → MLF (VOR to III/IV/VI), vestibulospinal, vestibulocerebellar
- Olfactory and gustatory (solitary nucleus → VPMpc → insula)

**Cerebellum**
- Cerebro-ponto-cerebellar input; dentato-rubro-thalamo-cortical output (decussating and non-decussating DRTT); Guillain–Mollaret triangle (red nucleus → CTT → inferior olive → ICP → dentate)

**Basal ganglia**
- Direct, indirect, and hyperdirect pathways; nigrostriatal; ansa and fasciculus lenticularis → thalamic fasciculus → VA/VL; limbic and associative loops; MFB (relevant to DBS)

**Thalamocortical**
- Specific relay, association, and non-specific nuclei → cortical targets via the anterior, superior, and posterior thalamic radiations

**Limbic, memory, and emotion**
- Papez circuit (hippocampus → fornix → mammillary bodies → mammillothalamic tract → AN → cingulum → parahippocampal gyrus → entorhinal cortex)
- Amygdala outputs (stria terminalis, ventral amygdalofugal), uncinate fasciculus
- Mesolimbic and mesocortical dopamine (MFB)

**Arousal and neuromodulation** (Harvard AAN)
- LC (noradrenergic), raphe (serotonergic), PPN/LDTg (cholinergic), VTA (dopaminergic), hypothalamic (histaminergic TMN, orexinergic LH), basal forebrain (cholinergic) → thalamus and cortex

**Autonomic and hypothalamic**
- DLF, hypothalamo-hypophyseal tract (schematic), solitary nucleus connections

**Cortico-cortical association** (high surgical relevance: awake mapping, glioma surgery)
- SLF I–III, arcuate fasciculus, IFOF, ILF, uncinate, MdLF, frontal aslant, VOF, cingulum segments, extreme capsule, U-fibres
- Commissures: corpus callosum segments, anterior commissure, posterior commissure, fornix/hippocampal commissure

**Cranial nerves**
- Nucleus → intra-axial course → exit point for CN I–XII. Imaging-derived geometry for II, III, V, VII, VIII (HCP1065) and IV, X (HCP842). The rest are schematic.

**Spinal cord** (Phase 3)
- Cross-sectional tract positions at cervical, thoracic, lumbar, and sacral levels; somatotopy (Brown-Séquard and central cord syndromes)

Each pathway carries **clinical correlates**, e.g. Meyer's loop and
superior quadrantanopia in temporal lobectomy, the internal capsule genu in
corticobulbar lacunar stroke, Wallenberg syndrome, INO from MLF lesions,
and SLF/AF damage in insular glioma resection.

Expected size for v1 is about 250 regions, ~120 tracts, ~600 directed
projection edges, and ~45 named pathways.

---

## 5. Data model

The knowledge graph lives as plain YAML so it can be reviewed in a pull
request by anatomists who don't code.

```yaml
# data/graph/regions/thalamus.yaml
- id: VPL
  name: Ventral posterolateral nucleus
  latin: Nucleus ventralis posterolateralis thalami
  abbrev: [VPL]
  synonyms: [ventral posterior lateral nucleus]
  parent: thalamus.ventral_group
  uberon: UBERON:…        # resolved during curation
  geometry: { source: THOMAS, label: 7, kind: data }
  function: Relay of body somatosensation (DCML and anterolateral) to S1.
  refs: [mai2015, saranathan2021]

# data/graph/tracts/medial_lemniscus.yaml
- id: medial_lemniscus
  name: Medial lemniscus
  latin: Lemniscus medialis
  geometry: { source: HCP1065, bundle: ProjectionBrainstem_MedialLemniscusL, kind: data }
  course: [internal_arcuate_fibres, pyramidal_decussation_level, pons_tegmentum, midbrain_tegmentum]
  decussates_at: lower_medulla
  refs: [nieuwenhuys2008]

# data/graph/projections.yaml   (directed edges)
- from: nucleus_gracilis
  to: VPL
  via: [internal_arcuate_fibres, medial_lemniscus]
  laterality: contralateral
  transmitter: glutamate
  evidence: [classical, human-tractography]
  refs: [...]

# data/graph/pathways/dcml.yaml   (ordered chain used for "trace" mode)
- id: dcml
  system: somatosensory
  steps: [DRG, fasciculus_gracilis, nucleus_gracilis, internal_arcuate_fibres,
          medial_lemniscus, VPL, internal_capsule_posterior_limb, S1]
  clinical: [...]
```

JSON Schemas in `schema/` are enforced in CI. A validator also checks
referential integrity (every `via` tract exists, every geometry label is
present in its source volume), that every edge has at least one reference,
and that laterality is consistent across a pathway's decussations.

References are stored in `data/references.bib` with DOIs.

---

## 6. Build pipeline

The pipeline is Python (nibabel, numpy, scikit-image, trimesh, pyvista or
fast-simplification, dipy). It is reproducible and driven by a Makefile.

```
pipeline/
  fetch.py           # download every source by URL + SHA-256 pin into data/raw/ (git-ignored)
  read_tt.py         # parser for DSI Studio .tt.gz (MATLAB v4 container, delta-encoded int coords)
                     #   fallback: DSI Studio CLI `--action=exp` → .trk, then dipy
  streamlines.py     # per bundle: cluster (QuickBundles), subsample to ~150–400 representative
                     #   streamlines, compress to Float16 / quantised Int16 + offsets
  centerlines.py     # bundle centroid + tube radius profile (for animation and low-LOD mode);
                     #   skeletonise HCP842 label volumes for the brainstem tracts missing from HCP1065
  meshes.py          # label volume → marching cubes → Taubin smoothing → decimation → glTF/Draco
  schematic.py       # MNI waypoints from YAML → Catmull-Rom splines → tubes (marked schematic)
  endpoints.py       # streamline endpoints × parcellation (CerebrA / HCP-MMP / THOMAS / CIT168)
                     #   → tract-to-region table; cross-checked against Yeh 2022 published values
  validate.py        # schema + referential integrity + anatomical sanity (e.g. CST passes PLIC & pyramid)
  export.py          # emits web/public/atlas/{graph.json, meshes/*.glb, tracts/*.bin, ATTRIBUTION.md}
```

All geometry stays in **MNI ICBM152 2009 nonlinear asymmetric** space, in
millimetres. Any atlas in 2009a/b/c is checked for sub-millimetre alignment
and resampled if needed. The ATAG atlas's known 3 mm y-offset is already
corrected in the Yeh mirror, and this will be verified.

The payload budget is under 25 MB total, loaded lazily per system, so it
works on a student laptop and on mobile.

Raw downloads are **not committed**. Only the processed web assets are
committed or published, together with their licences.

---

## 7. Front end

- **Vite + TypeScript + Three.js** (MIT), as a static build.
- Rendering:
  - glass-brain cortex with adjustable opacity
  - region meshes coloured by system
  - tracts drawn as instanced line segments with a fibre-direction colour option
  - schematic geometry dashed
  - clip planes with an MRI slice texture
- Interaction:
  - search across names, Latin terms, abbreviations, and synonyms
  - info panel with efferents and afferents
  - "trace pathway" animation, where a pulse travels along tract centrelines and synapses flash
  - system filters
  - left/right hemisphere toggles
  - shareable URL state (`#pathway=dcml&step=4`)
- **Connectogram view** (d3, ISC) linked to the 3D selection.
- **Quiz mode**: questions generated from the graph (lesion → deficit, tract → origin/target, "which pathway crosses here?").
- **Accessibility**: keyboard navigation, colour-blind-safe palette, and text descriptions of every pathway, so the content is usable even without 3D.
- Deployed to **GitHub Pages** by a GitHub Actions workflow on push to `main`.

---

## 8. Repository layout

```
README.md  PLAN.md  LICENSE (MIT)  LICENSE-DATA (CC BY-SA 4.0)  ATTRIBUTION.md  DATA_USE_TERMS.md
data/
  graph/        regions/ tracts/ projections.yaml pathways/ clinical/   ← curated (CC BY-SA 4.0)
  schematic/    waypoints for tracts/nuclei without imaging geometry
  references.bib
  sources.yaml  ← URL, version, SHA-256, licence, citation for every external file
  licenses/     ← verbatim licence texts
schema/         JSON Schemas
pipeline/       Python build (MIT)
web/            Vite/Three.js app (MIT)
.github/workflows/  validate.yml, build-and-deploy.yml
```

---

## 9. Milestones

| Phase | Deliverable |
|---|---|
| **0. Foundation** | Repo skeleton, licences, `sources.yaml` with pinned checksums, JSON Schemas, CI validation |
| **1. Vertical slice** | Template brain, plus HCP1065 bundles for the **motor and somatosensory systems** (CST, corticobulbar, ML, thalamic radiations), plus THOMAS thalamus. "Trace pathway" works for CST and DCML. Deployed to Pages, so you can judge the look and feel early. |
| **2. Core brain** | All HCP1065 and HCP842 bundles; ATAG, CIT168, and AAN nuclei; CerebrA cortex; basal ganglia, cerebellar, limbic, arousal, visual, auditory, and vestibular pathways; cranial nerves; connectogram view |
| **3. Extensions** | Spinal cord (PAM50 or schematic), HCP-MMP fine cortex toggle, quiz mode, clinical-case cards, optional NHP evidence panel |
| **4. Review and release** | Content review by a neuroanatomist or neurosurgeon, errata process via GitHub issues, Zenodo DOI for the release, CITATION.cff |

---

## 10. Quality control

- **Every edge needs a citation**, enforced by CI.
- **Anatomical sanity checks** run in the pipeline. Examples: the CST must pass through the PLIC, cerebral peduncle, basis pontis, and pyramid. Meyer's loop must reach the temporal horn. The DRTT decussation must lie in the midbrain at the level of the inferior colliculus.
- **Cross-validation** of tract terminations against Yeh 2022 and XTRACT (BALSA tutorial scenes) to catch tractography artefacts. Known false-positive bundles are flagged in the UI.
- **Human review**: content PRs use a reviewer checklist, and a "Report an error" link on every info panel opens a pre-filled GitHub issue.
- **Explicit uncertainty**: contested anatomy (e.g. human IFOF terminations, MdLF, the existence of a distinct SLF I) is labelled "debated", with both views cited.

---

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Tractography misleads students (no direction, spurious fibres) | Two-layer model. Direction always comes from the graph, and evidence badges and disclaimers are shown. |
| Some small nuclei have no open-licensed mesh | Schematic ellipsoids, visibly marked. Each one is reviewed against the CC0 100 µm volume. |
| Licence contamination (NC or no-redistribution data) | Licences tracked per file in `sources.yaml`. CI fails if a published asset traces back to a non-allowed licence. |
| `.tt.gz` format parsing | Write a small parser, with DSI Studio CLI export as fallback. Validate streamline counts and bounding boxes against DSI Studio. |
| Source hosts unreachable from some environments | All fetches are scripted with checksums and run in GitHub Actions. The core tractography is mirrored on GitHub and is already verified reachable. |
| Scope creep | The v1 curriculum in §4 is the contract. Anything else goes to a "later" issue label. |

---

## 12. Defaults I will use unless you say otherwise

1. **Licensing**: MIT for code and CC BY-SA 4.0 for data and content, with NC-licensed atlases excluded (see §3.3).
2. **Nomenclature**: English names first, with Terminologia Neuroanatomica Latin and common abbreviations as synonyms.
3. **Macaque data** is used only as cited evidence for directed projections, never as human geometry.
4. **Spinal cord** is in scope but scheduled for Phase 3.
5. **Phase 1 vertical slice** (motor and somatosensory) is built first and deployed, so the look and feel can be reviewed before content scales up.
