# Ame's Connectomic Atlas

A 3D, projection-level atlas of the human central nervous system for teaching neuroanatomy at
medical-school level and above. Slice atlases show the structures but leave the student to work out
which neurons project where. This atlas shows the wiring directly. For each structure it gives:

- where it is, in 3D (MNI ICBM152 space, cord shortened),
- its English and Latin names, abbreviations and synonyms,
- which tract carries its output, and where that output ends,
- step-by-step pathways (e.g. dorsal column–medial lemniscus): each synapse and decussation, plus a
  lesion-localisation table.

**Status: v0.2 preview.**
- Phase 1 is complete: the motor and somatosensory systems.
- Phase 2 is under way, covering the visual, auditory, vestibular, basal ganglia, limbic and
  language systems.

See [PLAN.md](PLAN.md) for the full roadmap, data sources and licensing rationale.

> Not for clinical use. Diffusion tractography shows the course of bundles, not synapses or
> direction, and it has false positives and negatives.

## What is in v0.1

| Content | Count |
|---|---|
| Regions | 110: 31 cortical gyri, thalamic nuclei (THOMAS), basal ganglia (ATAG, CIT168), midbrain/limbic nuclei (CIT168), brainstem, cerebellum, ventricles, and ascending-arousal nuclei (Harvard AAN), and schematic brainstem, spinal and special-sense nuclei |
| Tracts | 78: all 106 HCP1065 bundles (grouped L/R), HCP842 brainstem tracts, and schematic spinal, brainstem and basal-ganglia connections |
| Pathways | 26: see below |
| Projections | 59 directed region-to-region edges derived from the pathways |
| References | 30, every DOI checked in CI |

Pathways by system:
- **Motor:** lateral corticospinal (hand, leg), anterior corticospinal, corticobulbar to the face
- **Cerebellar:** cortico-ponto-cerebellar, dentatorubrothalamic
- **Somatosensory:** dorsal column–medial lemniscus (upper and lower limb), anterolateral,
  trigeminal touch, trigeminal pain
- **Visual:** retino-geniculo-calcarine, pupillary light reflex
- **Auditory:** ascending pathway
- **Vestibular:** horizontal VOR
- **Basal ganglia:** direct, indirect and hyperdirect pathways, nigrostriatal
- **Limbic:** mesolimbic, Papez circuit
- **Language:** dorsal and ventral streams
- **Arousal and pain modulation:** dorsal (thalamic) and ventral (hypothalamic / basal forebrain)
  arousal routes, descending pain modulation (PAG → RVM → dorsal horn)

Viewer features:
- search across names, Latin terms, abbreviations and synonyms
- system filters
- pathway tracing with a left/right starting side, an animated route and step labels
- "projects to / receives from" lists for every region
- the share of each tract's streamline end-points that falls in each atlas region (computed from HCP1065)
- axial, coronal and sagittal MRI slices
- direction-encoded or system colouring of streamlines
- shareable URLs (e.g. `#pathway=dcml_lower_limb&side=L&step=5`)
- a mobile layout

Two layers are kept separate on purpose:
- The **knowledge graph** (`data/graph/*.yaml`) is the authority on what projects where. It is
  hand-written and every entry is cited.
- The **geometry** comes from open imaging atlases. Where no openly licensed atlas exists (spinal
  cord, small brainstem nuclei, dentate nucleus), structures are drawn as **schematic** shapes:
  wireframe nuclei and dashed tracts. Their positions are approximate and are flagged `verify: true`.

## Repository layout

```
data/graph/        curated regions, tracts, pathways, references (YAML, CC BY-SA 4.0)
data/sources.yaml  every external source, its licence, and whether it may be published
data/licenses/     verbatim upstream licence texts
data/external/     files fetched by the "Fetch external data" workflow (Dryad/OSF/Zenodo)
schema/            JSON Schema for the knowledge graph
pipeline/          Python build: fetch, validate, mesh, streamlines, routes, slices
web/               Vite + TypeScript + Three.js viewer
```

## Building locally

Requirements: Python 3.11+ and Node 20+.

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r pipeline/requirements.txt
python pipeline/fetch_mirror.py          # downloads pinned source atlases (~40 MB) into data/raw/
python pipeline/validate.py              # schema, references, licence checks
python pipeline/build.py                 # writes web/public/atlas/ (~10 MB)

cd web
npm install
npm run dev                              # http://localhost:5173
```

`npm run build` produces a static site in `web/dist/` that can be served from any static host.

## Publishing

`.github/workflows/deploy.yml` builds the data and the site on every push and uploads it as the
`atlas-site` artifact. It deploys to GitHub Pages on the default branch when:
- the repository is public, or
- the repository variable `DEPLOY_PAGES` is `true` (GitHub Pages for private repositories needs a
  paid plan).

Enable Pages under *Settings → Pages → Source: GitHub Actions*.

## Contributing content

Edit or add YAML under `data/graph/`; `python pipeline/validate.py` tells you what is wrong. Every
entry needs at least one reference from `data/graph/references.yaml`. Anatomical corrections are
very welcome. Please open an issue with the source.

## Licences

- Code: MIT ([LICENSE](LICENSE)).
- Content and derived data: CC BY-SA 4.0 ([LICENSE-DATA.md](LICENSE-DATA.md)).
- HCP-derived tractography also comes under the HCP Open Access Data Use Terms
  ([DATA_USE_TERMS.md](DATA_USE_TERMS.md)).
- Source credits are in [ATTRIBUTION.md](ATTRIBUTION.md).
