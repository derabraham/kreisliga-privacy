# KFM Database Studio

Desktop web editor for Kreisliga Manager `.kfmdb` databases, intended for the existing GitHub Pages site at:

`https://kreisliga-fussballmanager.de/database-editor/`

## Structure

The editor follows the in-game hierarchy:

`Database → Confederation → Nation → League Level → League → Club → Players`

The hierarchy is compact, the breadcrumb stays on one line, and every structural level can be opened and edited. A new database starts with confederations, nations, built-in competitions, and a Level 1 workbase for every nation; leagues, clubs, and players start empty.

## Squad editing

Every club opens into a spreadsheet-style player grid designed for fast desktop entry. It includes nation dropdowns with flags, main-position dropdowns, multi-select additional positions, club autocomplete with logos, keyboard navigation, bulk row creation, and tab-separated paste from Excel or Google Sheets.

## Competitions

Official web copies load `assets/data/int_competitions.json` in addition to the national-team tournaments and Club World Cup fallback, so international competitions such as UEFA Champions League are available in the web editor as well.

## Flags and logos

Flags are resolved from `/assets/flags/flags.json`; short values such as `de` are normalized to `de.png`.

Club logos resolve from `logoAsset` or, as a fallback, from `/assets/logos/<TEAM_ID>.png`. The included GitHub Pages Action downloads the logo release ZIPs at deployment time, so tens of thousands of PNGs do not need to be committed to this repository.

See `GITHUB_PAGES_SETUP.md` for deployment details.

## `.kfmdb`

Import/export uses the game package layout. Existing package assets are retained during editing and written back to the standalone export.

## Desktop editor details

- Breadcrumbs are clickable (`Database → AFC → Afghanistan → Level 1 → …`) and use English nation display names without changing the save-compatible internal nation value.
- Player columns are sortable and use the compact order: Main Position, First Name, Last Name, Age, Nation, Height, Weight, Overall, Potential, Additional Positions, Foot, Club, Details.
- RWB/LWB are not offered by the editor; legacy values are normalized to RB/LB in the editable copy.
- Player and hierarchy select-all controls support bulk move/copy/duplicate/delete through the floating action bar.
- The player details drawer uses the game attribute names, a 3-3-2-3-3 attribute layout, and the in-game trait IDs through an Add Trait picker.
- Nation confederation points use the same static seed-score calculation as `confederation-coefficient-engine.js` when no explicit coefficient is stored.
- Club colour editing reads and writes the app's `primarycolor` / `secondarycolor` fields (plus camelCase compatibility aliases) and shows a live preview.
