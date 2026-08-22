KFM DATABASE STUDIO - OFFICIAL DATA
===================================

Place the same JSON files used by Kreisliga Manager in this directory.
The website editor loads them dynamically; the large data files are intentionally not duplicated in this ZIP.

Required base files typically include:
- database_seasons.json
- nations.json
- clubs.json
- leagues.json
- league_flow.json
- 26_clubs.json
- 26_leagues.json
- 26_league_flow.json

Optional:
- int_competitions.json
- club_world_cup.json
- player JSON files referenced through playersUrl in database_seasons.json

The editor is served from /database-editor/ but resolves these files against the website root /assets/data/.
