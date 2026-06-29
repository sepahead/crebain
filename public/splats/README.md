# Gaussian Splat test assets (`public/splats/`)

Local test scenes for the SparkJS (`@sparkjsdev/spark` v0.1.10) renderer in
`CrebainViewer`. **This whole directory is git-ignored** — the files are large
and are downloaded/generated locally, not committed. Re-create them with the
commands below.

Spark in this app parses `.ply` / `.compressed.ply` / `.spz` / `.splat` /
`.ksplat` (see `isSplatFormat()` in `src/components/viewer/types.ts`). Load a
scene by dragging the file onto the viewer, via `Ctrl/Cmd+O`, or by dropping a
URL. In the running dev server each file is served at
`http://localhost:5173/splats/<name>`.

> Loader note: `loadSplat()` passes the source filename to `SplatMesh` so Spark
> can identify the format. The headerless antimatter15 `.splat` format has no
> magic bytes, so without a filename/`fileType` hint Spark throws
> `Unknown splat file type: undefined`.

## Direct downloads (single-file, `curl`-able)

| file | format | size | scene | source | license |
|------|--------|------|-------|--------|---------|
| `bicycle-mini.splat` | splat | 17 MB | Mip-NeRF360 *bicycle* (7k mini) | `huggingface.co/datasets/dylanebert/3dgs` | non-commercial research (Mip-NeRF360) |
| `train.splat` | splat | 31 MB | Tanks&Temples *Train* | `huggingface.co/cakewalk/splat-data` | non-commercial research |
| `truck.splat` | splat | 78 MB | Tanks&Temples *Truck* | `huggingface.co/cakewalk/splat-data` | non-commercial research |
| `truck.ksplat` | ksplat | 28 MB | Tanks&Temples *Truck* | `projects.markkellogg.org` (GaussianSplats3D) | non-commercial research |
| `garden.ksplat` | ksplat | 72 MB | Mip-NeRF360 *Garden* | `projects.markkellogg.org` (GaussianSplats3D) | non-commercial research |
| `devils-tower-wy.splat` | splat | 105 MB | Devils Tower, Wyoming (landmark) | `huggingface.co/datasets/kleinfour/splat-data` | no declared license — local eval only |
| `snow-street.spz` | spz | 9.5 MB | snowy street | `sparkjs.dev` sample | Spark lib MIT; asset terms unstated |

```bash
cd public/splats
curl -sL -o bicycle-mini.splat   https://huggingface.co/datasets/dylanebert/3dgs/resolve/main/bicycle/bicycle-7k-mini.splat
curl -sL -o train.splat          https://huggingface.co/cakewalk/splat-data/resolve/main/train.splat
curl -sL -o truck.splat          https://huggingface.co/cakewalk/splat-data/resolve/main/truck.splat
curl -sL -o snow-street.spz      https://sparkjs.dev/assets/splats/snow-street.spz
curl -sL -o devils-tower-wy.splat https://huggingface.co/datasets/kleinfour/splat-data/resolve/main/DevilsTowerWY.splat
# mkkellogg blocks spoofed UAs (mod_security 406) — use default UA + a Referer:
curl -sL -e https://projects.markkellogg.org/threejs/demo_gaussian_splats_3d.php -o truck.ksplat  https://projects.markkellogg.org/threejs/assets/data/truck/truck.ksplat
curl -sL -e https://projects.markkellogg.org/threejs/demo_gaussian_splats_3d.php -o garden.ksplat https://projects.markkellogg.org/threejs/assets/data/garden/garden.ksplat
```

## SuperSplat scenes (city / area / landmark — converted from SOGS)

SuperSplat (`superspl.at`) publishes scenes as a **SOGS** bundle (a `meta.json`
manifest + `*.webp` textures) streamed from
`https://d28zzqy0iyovbz.cloudfront.net/<scene-id>/v1/`. The app's `loadSplat()`
pulls a single `fileBytes` blob and can't follow the multi-file manifest, so
these are converted to a single `.compressed.ply` with PlayCanvas
`splat-transform` (`-H 0` strips spherical harmonics to keep them small).

All three below are **CC BY 4.0** — attribution required:

| file | size | scene | superspl.at | author | license |
|------|------|-------|-------------|--------|---------|
| `cleehill-radome-superplat.compressed.ply` | 37 MB | Cleehill Radome Tower (UK radar dome) | `/scene/2a5b049f` | **ijenko** | CC BY 4.0 |
| `cochem-castle-superplat.compressed.ply` | 31 MB | Reichsburg Cochem, Germany | `/scene/9b18007e` | **dok11** | CC BY 4.0 |
| `urban-street-indonesia-superplat.compressed.ply` | 16 MB | Urban street, Yogyakarta | `/scene/f90fd697` | **droneku_id** | CC BY 4.0 |

Conversion recipe (per scene id):

```bash
# 1. SOGS scenes (most): download meta.json + every referenced .webp, then convert
ID=9b18007e BASE=https://d28zzqy0iyovbz.cloudfront.net/$ID/v1
curl -sL -o meta.json $BASE/meta.json
for f in $(grep -oE '[A-Za-z0-9_]+\.webp' meta.json | sort -u); do curl -sL -o "$f" "$BASE/$f"; done
bunx @playcanvas/splat-transform@latest meta.json -H 0 out.compressed.ply

# 2. Single-file scenes (e.g. the radome): the CDN serves a gzip-wrapped compressed.ply
curl -sL -o scene.gz https://d28zzqy0iyovbz.cloudfront.net/2a5b049f/v1/scene.compressed.ply
gunzip -c scene.gz > scene.ply
bunx @playcanvas/splat-transform@latest scene.ply -H 0 out.compressed.ply
```

> The Stonehenge drone scene (`/scene/02a52a76`) was used during testing but is
> **not included** — it has no declared license and download is not author-enabled.
>
> `splat-transform` writes SPZ **v4** (NGSP container), which Spark v0.1.10
> cannot read (it expects the older gzip-wrapped SPZ). Use `.compressed.ply`
> output for SuperSplat → Spark, not `.spz`.

## Licensing

Treat the research/non-commercial and "no declared license" assets as **local
evaluation only** — do not redistribute or use commercially. The CC BY 4.0
SuperSplat scenes may be reused with attribution to the authors listed above.
