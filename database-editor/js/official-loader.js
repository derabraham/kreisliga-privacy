import{clone,deriveConfederations,ensureIds,emptyData,contentHash}from'./core.js?v=20260822-20';
import{ensureDatabaseSettings}from'./database-settings.js?v=20260822-20';
import{resolveCompatiblePlayerPacks}from'./player-packs.js?v=20260822-20';

// The editor lives in /database-editor/, while the website already has a shared
// /assets folder. Resolve official KFM JSON paths against the website root so
// existing database_seasons.json entries such as "assets/data/26_clubs.json"
// keep working on GitHub Pages and on a custom domain.
const SITE_ROOT=new URL('../../',import.meta.url);
function siteUrl(path){
  const raw=String(path||'').trim();
  if(!raw)return raw;
  if(/^(?:https?:)?\/\//i.test(raw)||raw.startsWith('data:')||raw.startsWith('blob:'))return raw;
  return new URL(raw.replace(/^\/+/,''),SITE_ROOT).href;
}
async function json(url,optional=false){
  try{
    const r=await fetch(siteUrl(url),{cache:'no-cache'});
    if(!r.ok){if(optional)return null;throw new Error(`${url}: HTTP ${r.status}`)}
    return await r.json();
  }catch(e){if(optional)return null;throw e}
}

async function competitions(){
  const out=[];
  const defs=await json('assets/data/int_competitions.json',true);
  for(const[code,d]of Object.entries(defs||{}))out.push({
    id:`COMP:${code}`,code,ruleId:code,ruleType:'club_international',scope:'club-international',
    name:d.name||code,displayName:d.name||code,confederation:d.confederation||'FIFA',
    groupSize:Number(d.groupSize||0),direct:Number(d.direct||0),qualifyingRounds:clone(d.qualifyingRounds||[]),
    nationSlots:clone(d.nationSlots||{}),active:true,isBuiltInRule:true
  });

  // Keep this list aligned with the in-game Database Builder so the website
  // does not silently omit the World Cup / continental national-team formats.
  for(const d of [
    {code:'WC',name:'World Cup',confederation:'WORLD',teamsFinals:48,groups:12,groupSize:4,bestThird:8},
    {code:'EURO',name:'European Championship',confederation:'UEFA',teamsFinals:24,groups:6,groupSize:4,bestThird:4},
    {code:'AFCON',name:'Africa Cup',confederation:'CAF',teamsFinals:24,groups:6,groupSize:4,bestThird:4},
    {code:'COPA',name:'Copa América',confederation:'CONMEBOL',teamsFinals:8,groups:2,groupSize:4,bestThird:0},
    {code:'ASIAN',name:'Asian Cup',confederation:'AFC',teamsFinals:24,groups:6,groupSize:4,bestThird:4},
    {code:'GOLD',name:'Gold Cup',confederation:'CONCACAF',teamsFinals:16,groups:4,groupSize:4,bestThird:0},
    {code:'OFCNC',name:'OFC Nations Cup',confederation:'OFC',teamsFinals:8,groups:2,groupSize:4,bestThird:0}
  ])out.push({
    id:`COMP:${d.code}`,code:d.code,ruleId:d.code,ruleType:'national_team_tournament',scope:'national-team',
    name:d.name,displayName:d.name,confederation:d.confederation,teamsFinals:d.teamsFinals,groups:d.groups,
    groupSize:d.groupSize,bestThird:d.bestThird,active:true,isBuiltInRule:true
  });

  // Some app builds currently rely on the engine fallback instead of shipping
  // club_world_cup.json. The web editor should still expose CWC in that case.
  const cwc=await json('assets/data/club_world_cup.json',true);
  const cwcDef=cwc||{competitionKey:'CWC',name:'Club World Cup',teamCount:32,groupCount:8,groupSize:4,qualifiersPerGroup:2};
  const code=cwcDef.competitionKey||'CWC';
  if(!out.some(x=>x.code===code))out.push({
    id:`COMP:${code}`,code,ruleId:code,ruleType:'club_world_cup',scope:'club-international',
    name:cwcDef.name||'Club World Cup',displayName:cwcDef.name||'Club World Cup',confederation:'WORLD',
    teamCount:Number(cwcDef.teamCount||32),groupCount:Number(cwcDef.groupCount||8),groupSize:Number(cwcDef.groupSize||4),
    qualifiersPerGroup:Number(cwcDef.qualifiersPerGroup||2),allocations:clone(cwcDef.allocations||{}),active:true,isBuiltInRule:true
  });
  return out;
}

export async function listOfficial(){const c=await json('assets/data/database_seasons.json');return c.seasons||[]}

// A new community database is intentionally not a completely blank object.
// Confederations, nations and built-in competition definitions provide the same
// workbase users already know from the in-game editor. Leagues/clubs/players stay empty.
export async function loadReferenceScaffold(){
  const nations=await json('assets/data/nations.json');
  const data=emptyData();
  data.nations=clone(Array.isArray(nations)?nations:[]);
  data.confederations=deriveConfederations(data.nations);
  data.competitions=await competitions();
  return data;
}

export async function loadOfficial(entry, options={}){
  const nations=await json('assets/data/nations.json');
  const [clubs,leagues,leagueFlows,players,comps]=await Promise.all([
    json(entry.clubsUrl),json(entry.leaguesUrl),json(entry.leagueFlowUrl),
    entry.playersUrl?json(entry.playersUrl,true):Promise.resolve([]),competitions()
  ]);
  const sourceDatabaseId=`official:${entry.id}`;
  const data=emptyData();
  Object.assign(data,{confederations:deriveConfederations(nations),nations:clone(nations),leagues:clone(leagues),leagueFlows:clone(leagueFlows),clubs:clone(clubs),players:Array.isArray(players)?clone(players):[],competitions:comps,metadata:{databaseId:sourceDatabaseId,databaseSeasonId:String(entry.id),startDate:entry.startDate,startYear:entry.startYear,templateDatabaseId:sourceDatabaseId,schemaVersion:1}});
  ensureDatabaseSettings(data, Number(entry.startYear||2026));
  ensureIds(data,sourceDatabaseId);
  const baseData=clone(data);
  const baseContentHash=contentHash(baseData);
  const baseRevisionId=entry.revisionId||entry.currentRevisionId||entry.currentRevision||null;

  const deferredPackIds=Array.isArray(options.deferredPlayerPackIds)?[...new Set(options.deferredPlayerPackIds.map(String).filter(Boolean))]:[];
  let deferredPackReason=null;
  if(options.resolvePlayerPacks===true){
    const resolved=await resolveCompatiblePlayerPacks({
      databaseSeasonId:String(entry.id),revisionId:baseRevisionId,clubs:data.clubs,onProgress:options.onPackProgress||null
    });
    if(resolved.failures?.length){
      if(options.deferPlayerPacksToAndroid===true){
        deferredPackReason=resolved.environmentFailure?'browser-source-unavailable':'browser-pack-load-failed';
      }else{
        const total=resolved.packs.length+resolved.failures.length;
        const error=new Error(`${resolved.packs.length}/${total} player packs loaded; ${resolved.failures.length} failed.`);
        error.code='PLAYER_PACK_PARTIAL_FAILURE';error.playerPackResult=resolved;throw error;
      }
    }else{
      if(resolved.duplicatePlayerIds?.length){
        const examples=resolved.duplicatePlayerIds.slice(0,8).map(x=>`${x.id} (${x.packId})`).join(', ');
        const error=new Error(`Duplicate Player IDs detected while resolving packs: ${resolved.duplicatePlayerIds.length}${examples?` · ${examples}`:''}`);
        error.code='PLAYER_PACK_DUPLICATE_IDS';error.playerPackResult=resolved;throw error;
      }
      if(resolved.duplicatePlayers?.length){
        const examples=resolved.duplicatePlayers.slice(0,8).map(x=>`${x.name||x.identity} (${x.otherPackId} / ${x.packId})`).join(', ');
        const error=new Error(`Possible duplicate players detected across compatible packs: ${resolved.duplicatePlayers.length}${examples?` · ${examples}`:''}`);
        error.code='PLAYER_PACK_DUPLICATE_PLAYERS';error.playerPackResult=resolved;throw error;
      }
      const byId=new Map();
      for(const player of data.players||[]){const id=String(player?.id||'').trim();if(id)byId.set(id,player)}
      for(const player of resolved.players||[]){const id=String(player?.id||'').trim();if(id)byId.set(id,player)}
      data.players=[...byId.values()];
      data.metadata={...(data.metadata||{}),playerPackMode:'self-contained',resolvedPlayerPackIds:(resolved.packs||[]).map(pack=>pack.id),resolvedPlayerPacks:clone(resolved.packs||[]),resolvedPlayerPackPlayerCount:Number(resolved.players?.length||0),resolvedPlayerPackSkippedPlayers:Number(resolved.skippedPlayers||0),resolvedPlayerPacksAt:new Date().toISOString()};
    }
  }else if(options.deferPlayerPacksToAndroid===true){
    deferredPackReason='requested';
  }
  if(deferredPackReason){
    data.metadata={...(data.metadata||{}),playerPackMode:'resolve-on-android-import',deferredPlayerPackResolution:{requested:true,mode:'installed-compatible-on-android-import',sourceDatabaseId, databaseSeasonId:String(entry.id),revisionId:baseRevisionId||null,packIds:deferredPackIds,reason:deferredPackReason,requestedAt:new Date().toISOString()}};
  }

  const databaseId=`user:web-${entry.id}-${crypto.randomUUID?.()||Date.now()}`;
  data.metadata={...(data.metadata||{}),databaseId,templateDatabaseId:sourceDatabaseId,templateRevisionId:baseRevisionId,baseOfficialContentHash:baseContentHash};
  ensureIds(data,databaseId);
  return{manifest:{databaseId,displayName:`${entry.label} — Web Copy`,version:'1.0.0',author:'',description:`Editable web copy of the official ${entry.label} database.`,startDate:entry.startDate,databaseSeasonId:String(entry.id),templateDatabaseId:sourceDatabaseId,templateRevisionId:baseRevisionId,tags:['Custom']},data,assets:new Map(),source:'official',baseData,baseContentHash,baseRevisionId,officialEntry:clone(entry)};
}


// Lightweight editable loader for community contribution workspaces. It loads
// only the collections required by the selected contribution type and skips the
// expensive full-content hash / duplicate base clone used by normal custom-copy
// creation. The official source identity is still preserved in templateDatabaseId.
export async function loadOfficialContributionBase(entry, contributionType='player'){
  const type=String(contributionType||'player');
  const nations=await json('assets/data/nations.json');
  const data=emptyData();
  data.nations=clone(Array.isArray(nations)?nations:[]);
  data.confederations=deriveConfederations(data.nations);
  if(type==='league'){
    const [clubs,leagues,leagueFlows]=await Promise.all([
      json(entry.clubsUrl),json(entry.leaguesUrl),json(entry.leagueFlowUrl)
    ]);
    data.clubs=clone(Array.isArray(clubs)?clubs:[]);
    data.leagues=clone(Array.isArray(leagues)?leagues:[]);
    data.leagueFlows=clone(Array.isArray(leagueFlows)?leagueFlows:[]);
  }else{
    const [clubs,leagues,players]=await Promise.all([
      json(entry.clubsUrl),json(entry.leaguesUrl),entry.playersUrl?json(entry.playersUrl,true):Promise.resolve([])
    ]);
    data.clubs=clone(Array.isArray(clubs)?clubs:[]);
    data.leagues=clone(Array.isArray(leagues)?leagues:[]);
    data.players=Array.isArray(players)?clone(players):[];
  }
  const sourceDatabaseId=`official:${entry.id}`;
  const baseRevisionId=entry.revisionId||entry.currentRevisionId||entry.currentRevision||null;
  const databaseId=`user:web-contrib-${entry.id}-${crypto.randomUUID?.()||Date.now()}`;
  data.metadata={databaseId,sourceOfficialDatabaseId:sourceDatabaseId,databaseSeasonId:String(entry.id),startDate:entry.startDate,startYear:entry.startYear,templateDatabaseId:sourceDatabaseId,templateRevisionId:baseRevisionId,schemaVersion:1};
  ensureDatabaseSettings(data,Number(entry.startYear||2026));
  ensureIds(data,databaseId);
  return{
    manifest:{databaseId,displayName:`${entry.label} — Contribution Workspace`,version:'1.0.0',author:'',description:`Temporary ${type} contribution workspace for ${entry.label}.`,startDate:entry.startDate,databaseSeasonId:String(entry.id),templateDatabaseId:sourceDatabaseId,templateRevisionId:baseRevisionId,tags:['Contribution','Working Copy']},
    data,assets:new Map(),source:'official',baseData:null,baseContentHash:null,baseRevisionId,officialEntry:clone(entry),lightweightContribution:true
  };
}

// Lightweight base loader used when a .kfmcontrib is opened for review.
// It intentionally loads only the collections required for entity-level conflict
// checks. The complete official database is loaded lazily only when the user
// chooses Inspector or Merge.
export async function loadOfficialReviewBase(entry, contributionType='player'){
  const type=String(contributionType||'player');
  const nations=await json('assets/data/nations.json');
  const data=emptyData();
  data.nations=clone(Array.isArray(nations)?nations:[]);
  data.confederations=deriveConfederations(data.nations);
  if(type==='league'){
    const [clubs,leagues,leagueFlows]=await Promise.all([
      json(entry.clubsUrl),json(entry.leaguesUrl),json(entry.leagueFlowUrl)
    ]);
    data.clubs=clone(Array.isArray(clubs)?clubs:[]);
    data.leagues=clone(Array.isArray(leagues)?leagues:[]);
    data.leagueFlows=clone(Array.isArray(leagueFlows)?leagueFlows:[]);
  }else{
    const [clubs,players]=await Promise.all([
      json(entry.clubsUrl),entry.playersUrl?json(entry.playersUrl,true):Promise.resolve([])
    ]);
    data.clubs=clone(Array.isArray(clubs)?clubs:[]);
    data.players=Array.isArray(players)?clone(players):[];
  }
  const sourceDatabaseId=`official:${entry.id}`;
  data.metadata={databaseId:sourceDatabaseId,databaseSeasonId:String(entry.id),startDate:entry.startDate,startYear:entry.startYear,templateDatabaseId:sourceDatabaseId,schemaVersion:1};
  ensureDatabaseSettings(data,Number(entry.startYear||2026));
  ensureIds(data,sourceDatabaseId);
  return{
    manifest:{databaseId:sourceDatabaseId,displayName:entry.label||`Official ${entry.id}`,databaseSeasonId:String(entry.id),templateDatabaseId:sourceDatabaseId,templateRevisionId:entry.revisionId||entry.currentRevisionId||entry.currentRevision||null,startDate:entry.startDate},
    data,baseData:data,assets:new Map(),source:'official-review-base',
    baseContentHash:null,
    baseRevisionId:entry.revisionId||entry.currentRevisionId||entry.currentRevision||null,
    officialEntry:clone(entry),lightweight:true
  };
}
