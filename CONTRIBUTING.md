# Contributing

## Correcting or adding content

All anatomy lives in plain YAML under `data/graph/`:

| File(s) | What they hold |
|---|---|
| `regions/*.yaml` | Structures: names, Latin, abbreviations, summary, clinical notes, geometry source |
| `tracts/*.yaml` | Fibre tracts: origin, course, decussation, termination, function |
| `pathways/*.yaml` | Step-by-step pathways: alternating regions and tracts, side (`ipsi` / `contra`) |
| `references.yaml` | The bibliography; every entry above cites at least one reference |

Rules:
- In a pathway, the step that holds a neuron's cell bodies names that neuron's `transmitter` and its
  `effect` at the next synapse (`excitatory`, `inhibitory`, `modulatory` or `mixed`). Add an
  optional `transmitter_note` for receptor-level detail.
- Cortical steps can give `layer_out` (layer of the cell bodies), `layer_in` (layer where axons
  end) and a `layer_note`.
- A region step marked `synapse: false` is one the axons only pass through, or sensory endings.

Run `python pipeline/validate.py` before sending a change. It checks the schema, references,
transmitters and source licences. If you are reporting an error rather than fixing it, please
[open an issue](https://github.com/Abynetio/Ame-s-Connectomic-Atlas/issues) with the source.

## Building locally

Requirements: Python 3.11+ and Node 20+.

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r pipeline/requirements.txt
python pipeline/fetch_mirror.py   # pinned source atlases (~40 MB) into data/raw/
python pipeline/validate.py       # schema, references, licence checks
python pipeline/build.py          # writes web/public/atlas/ (~11 MB)

cd web
npm install
npm run dev                       # http://localhost:5173
```

`npm run build` writes a static site to `web/dist/` that any static host can serve.

## Repository layout

```
data/graph/        curated regions, tracts, pathways, references (YAML, CC BY-SA 4.0)
data/sources.yaml  every external source, its licence, and whether it may be published
data/licenses/     verbatim upstream licence texts and notices
data/external/     sources fetched by the "Fetch external data" workflow (Dryad / OSF)
uploads/           drop-off folder for sources that cannot be downloaded automatically
schema/            JSON Schema for the knowledge graph
pipeline/          Python build: fetch, validate, mesh, streamlines, routes, slices
web/               Vite + TypeScript + Three.js viewer
docs/              design notes and README images
```

## Publishing

`.github/workflows/deploy.yml` builds the data and the site on every push and uploads them as the
`atlas-site` artifact. It deploys to GitHub Pages from the default branch when the repository is
public, or when the repository variable `DEPLOY_PAGES` is `true`. To turn it on, go to
*Settings → Pages* and set *Source* to *GitHub Actions*.

## Licences of contributions

By contributing you agree that code is released under MIT and content under CC BY-SA 4.0. Only add
geometry from sources whose licence allows redistribution. Register them in `data/sources.yaml`; the
validator rejects anything not marked `allowed`.
