import{clone,deriveConfederations,ensureIds,emptyData}from'./core.js?v=20260822-12';

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

export async function loadOfficial(entry){
  const nations=await json('assets/data/nations.json');
  const [clubs,leagues,leagueFlows,players,comps]=await Promise.all([
    json(entry.clubsUrl),json(entry.leaguesUrl),json(entry.leagueFlowUrl),
    entry.playersUrl?json(entry.playersUrl,true):Promise.resolve([]),competitions()
  ]);
  const databaseId=`user:web-${entry.id}-${crypto.randomUUID?.()||Date.now()}`;
  const data=emptyData();
  Object.assign(data,{confederations:deriveConfederations(nations),nations:clone(nations),leagues:clone(leagues),leagueFlows:clone(leagueFlows),clubs:clone(clubs),players:Array.isArray(players)?clone(players):[],competitions:comps,metadata:{databaseId,databaseSeasonId:String(entry.id),startDate:entry.startDate,startYear:entry.startYear,templateDatabaseId:`official:${entry.id}`,schemaVersion:1}});
  ensureIds(data,databaseId);
  return{manifest:{databaseId,displayName:`${entry.label} — Web Copy`,version:'1.0.0',author:'',description:`Editable web copy of the official ${entry.label} database.`,startDate:entry.startDate,databaseSeasonId:String(entry.id),templateDatabaseId:`official:${entry.id}`,tags:['Custom']},data,assets:new Map(),source:'official'};
}
