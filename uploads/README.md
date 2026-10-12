# uploads/

Drop-off folder for source files that cannot be downloaded automatically (e.g. Dryad).
See `pipeline/import_uploads.py`. The "Fetch external data" workflow imports recognised files
into `data/external/` and deletes them from this folder.

- Files up to 25 MB: zip them and upload the zip here through the GitHub web page.
- Larger files: attach them to a GitHub release tagged `source-uploads` instead (2 GB per file,
  and they never enter the git history).
