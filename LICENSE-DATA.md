# Data and content licence

The **code** in this repository (`pipeline/`, `web/`, `schema/`, workflows) is licensed under the MIT
licence — see `LICENSE`.

The **atlas content** — the curated knowledge graph in `data/graph/` (region, tract and pathway
descriptions, projections, clinical notes), the schematic geometry, and every derived data file
produced by `pipeline/build.py` (the `atlas/` folder of the published site) — is licensed under the
**Creative Commons Attribution-ShareAlike 4.0 International licence (CC BY-SA 4.0)**:
https://creativecommons.org/licenses/by-sa/4.0/legalcode

CC BY-SA 4.0 is required because the derived tractography geometry comes from the HCP842/HCP1065
atlases (Yeh et al.), which are themselves CC BY-SA 4.0.

Additional terms that travel with parts of the derived data:

- Files derived from Human Connectome Project data (HCP1065/HCP842 tractography) are also subject
  to the WU-Minn HCP Open Access Data Use Terms — see `DATA_USE_TERMS.md`.
- The ICBM152 template and CerebrA labels carry the McGill copyright notice in
  `data/licenses/ICBM152.txt`, which must be kept with copies.
- The ATAG atlas (CC BY 3.0) and THOMAS atlas (CC0) are credited in `ATTRIBUTION.md`.

Attribution for reuse: "Ame's Connectomic Atlas contributors, CC BY-SA 4.0", plus the source
citations in `ATTRIBUTION.md`.
