# Legacy save compatibility check

The Database Builder changes were checked against the current KFM v3.2 source.

Important behavior in `js/state.js`:

- Saves that already contain the new `databaseId` use the general database registry/revision path.
- Legacy saves **without** `databaseId` continue through `inferDatabaseSeasonIdFromCareer(...)` and are activated as an official database.
- `databaseSeasonId = "25"` resolves to `official:25`.
- `databaseSeasonId = "26"` resolves to `official:26`.

A synthetic runtime check against the actual v3.2 `database-registry.js` was run:

```text
25 -> official:25 -> season 25
26 -> official:26 -> season 26
```

The load-career code also resolves built-in/legacy saves against their own season database first, while custom saves with an explicit `databaseId` are resolved only against their pinned custom revision.

This materially reduces the risk of the new custom database system changing the base database of existing careers.

## What was not tested

No real historical career save file was supplied in this task, so this is **not** a claim that every old save from every previous app version has been fully end-to-end simulated. Other unrelated save migrations can still contain bugs. For maximum confidence, run one representative old 25/26 save and one representative 26/27 save through the current Android build and save/reload them once.
