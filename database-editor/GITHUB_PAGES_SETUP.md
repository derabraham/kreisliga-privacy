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

Do **not** commit all club logos to this website repository. The included workflow at:

`.github/workflows/pages.yml`

downloads the 13 `kreisliga-logos` v2 ZIP parts during the GitHub Pages build, extracts them into `/assets/logos/` only inside the deployment artifact, and then deploys the site. The repository therefore stays small, while the live site can resolve a club such as `T_0000033` as:

`/assets/logos/T_0000033.png`

The Database Studio uses `logoAsset` when present and otherwise falls back to the club/team ID. Images use lazy loading, so opening a 20-team league only requests the logos that are actually rendered.

For this workflow, set the repository's **Settings → Pages → Build and deployment → Source** to **GitHub Actions** once. A push to `main` then builds and deploys the site.

## Navigation and squad grid

Structure navigation follows:

`Database → Confederation → Nation → League Level → League → Club → Players`

The breadcrumb is kept on one compact, horizontally scrollable line. Club squads use a spreadsheet-style grid with nation dropdown + flag, main-position dropdown, multi-select additional positions, club autocomplete + logo, keyboard navigation, and tab-separated paste from Excel/Google Sheets.

## JSZip

The editor currently loads JSZip from jsDelivr. It can be self-hosted later by replacing the CDN script in `database-editor/index.html` with a local copy.
