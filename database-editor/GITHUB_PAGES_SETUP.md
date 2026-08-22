# KFM Database Studio on GitHub Pages

The editor is a static sub-page of the existing website and is served at:

`https://kreisliga-fussballmanager.de/database-editor/`

No link from the homepage is required.

## Data files

The editor reads the game data from `/assets/data/`. Keep at least these files in the repository:

```text
assets/data/database_seasons.json
assets/data/nations.json
assets/data/clubs.json
assets/data/leagues.json
assets/data/league_flow.json
assets/data/26_clubs.json
assets/data/26_leagues.json
assets/data/26_league_flow.json
assets/data/int_competitions.json
```

`int_competitions.json` supplies the international club competitions (Champions League, Europa League, AFC/CAF/CONCACAF competitions, etc.). The editor also adds the built-in national-team tournaments and Club World Cup definition used by the game.

## Empty-database workbase

A newly created custom database is not visually empty. It starts with the standard confederations and nations from `nations.json`, the built-in competition definitions and a virtual **League Level 1** for every nation. Leagues, clubs and players remain empty and can then be added manually.

## Flags

Reusable flags live in `/assets/flags/` and are listed in `/assets/flags/flags.json`. Both mappings below are accepted:

```json
{
  "Afghanistan": "af",
  "Germany": "de.png"
}
```

A missing extension is automatically treated as `.png`. Names are matched in a normalized form, including umlauts/diacritics. A website flag selected in the nation editor is embedded into the exported `.kfmdb` so the package stays portable.

## Club logos without committing 35,000 PNG files

Do **not** commit all club logos to this website repository. The repository-level GitHub Pages workflow (normally `.github/workflows/pages.yml`) should download the `kreisliga-logos` ZIP parts during the GitHub Pages build, extract them into `/assets/logos/` only inside the deployment artifact, and then deploy the site.

**Important:** this Database Studio archive intentionally does not contain the repository's `.github/` workflow. The Studio therefore does not assume that the deployment step exists; verify the workflow in the actual website repository before publishing. The repository therefore stays small, while the live site can resolve a club such as `T_0000033` as:

`/assets/logos/T_0000033.png`

The Database Studio uses `logoAsset` when present and otherwise falls back to the club/team ID. Images use lazy loading, so opening a 20-team league only requests the logos that are actually rendered.

For this workflow, set the repository's **Settings → Pages → Build and deployment → Source** to **GitHub Actions** once. A push to `main` then builds and deploys the site.

## Navigation and squad grid

Structure navigation follows:

`Database → Confederation → Nation → League Level → League → Club → Players`

The breadcrumb is kept on one compact, horizontally scrollable line. Club squads use a spreadsheet-style grid with nation dropdown + flag, main-position dropdown, multi-select additional positions, club autocomplete + logo, keyboard navigation, and tab-separated paste from Excel/Google Sheets.

## JSZip

The editor currently loads JSZip from jsDelivr. It can be self-hosted later by replacing the CDN script in `database-editor/index.html` with a local copy.

## Player data packs when cloning an official database

The web editor can now mirror the in-game **Resolve compatible player packs into the new custom database** workflow.

The browser cannot read which packs are installed inside the Android app. The recommended Pages artifact contains the current public KFM player-pack JSON files under `assets/player-packs/`. They do not need to be committed to the website repository if the repository-level workflow downloads them during deployment.

The resolver intentionally prefers **same-origin** files and derives the real filename from the catalog/release URL (for example `LaLiga.json` instead of assuming `laliga.json`). If those files are not present, v20 next reads the matching source blob through GitHub's CORS-enabled **Git tree/blob REST API at the release tag**. This avoids the current browser CORS problem on `release-assets.githubusercontent.com` whenever the pack JSON also exists in the source repository. The legacy release download/API paths are retained only as final fallbacks. Failures report pack name, attempted URL, source and HTTP/fetch status. A custom clone is not silently finalized when one of the selected compatible packs fails.

When you open **Official database** in Database Studio, a compatible season shows the checkbox **Resolve compatible player packs into the copy**. If selected, the browser loads the compatible pack JSONs, maps their players to the clubs in that official season and embeds the resolved player rows directly into the new custom database. The exported `.kfmdb` is therefore self-contained and does not require those packs to be installed later on the phone.

Current legacy pack definitions are compatible with database season `25` (25/26), matching the current mobile-app fallback behavior. A season with no compatible packs shows the option disabled.


## Required Pages artifact for Player Packs

For the resolver to stay same-origin, the deployed artifact should contain:

```text
assets/data/player_pack_catalog.json
assets/player-packs/<actual pack filenames>.json
```

The filename casing must match the catalog/release file exactly on GitHub Pages. If the actual repository workflow is supplied separately, verify that it copies/downloads these files into the final Pages artifact; this Studio ZIP deliberately contains no large asset folders.

## Player packs for the browser (required for Resolve Player Packs)

The Android app can download GitHub Release assets natively. As of 2026, GitHub release assets may be delivered from `release-assets.githubusercontent.com` without a usable `Access-Control-Allow-Origin` response header, so a static browser page cannot safely depend on the release URL itself.

v20 therefore first tries the GitHub repository tree/blob API when same-origin files are missing. For the **most reliable** local/Pages setup (and as a fallback if a release asset is not also stored in the repository tag), mirror the catalogued JSON packs into the website itself:

```bash
node database-editor/scripts/sync-player-packs.mjs
```

On Windows you can also run:

```text
SYNC_PLAYER_PACKS.cmd
```

The script reads `assets/data/player_pack_catalog.json`, downloads each catalogued release asset with Node (no browser CORS), preserves the real filename/casing such as `LaLiga.json`, validates the `players` array and writes the files to:

```text
assets/player-packs/
```

For GitHub Pages, add the following **before** the step that uploads/builds the Pages artifact in your existing workflow:

```yaml
- name: Sync KFM player packs for browser
  run: node database-editor/scripts/sync-player-packs.mjs
```

Do not publish the artifact if that step fails. This prevents the Studio from seeing a pack in the catalog while the actual JSON file is absent from Pages.
