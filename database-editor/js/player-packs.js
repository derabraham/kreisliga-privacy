// Browser-side resolver for the same legacy Player Data Pack catalog used by the
// in-game Database Builder. The mobile app treats these unversioned legacy packs
// as 25/26-only content. The browser resolves them into a standalone custom DB;
// the exported .kfmdb therefore has no runtime dependency on an installed pack.

const SITE_ROOT = new URL('../../', import.meta.url);
const CATALOG_URL = new URL('assets/data/player_pack_catalog.json', SITE_ROOT);

let catalogPromise = null;
const packPayloadCache = new Map();

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function normalizeSeasonId(value) {
  return String(value ?? '').trim() || '25';
}

function normalizeText(value) {
  try {
    return String(value ?? '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ');
  } catch (_) {
    return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  }
}

function hashStableString(value) {
  let h = 2166136261;
  const s = String(value ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function stablePackPlayerKey(rawPlayer, packId) {
  const p = rawPlayer || {};
  const external = p.id ?? p.player_id ?? p.playerId ?? p.external_id ?? p.externalId ?? p.fifa_id ?? p.sofifa_id ?? p.tm_id ?? p.transfermarkt_id ?? null;
  const pack = normalizeText(packId || 'unknown-pack');
  if (external != null && String(external).trim()) return `pack:${pack}:external:${normalizeText(external)}`;
  return [
    'pack', pack,
    'club', normalizeText(p.team_id || p.clubId || p.teamName || p.team_name || ''),
    'name', normalizeText([p.first_name, p.last_name].filter(Boolean).join(' ') || p.name || p.fullName || ''),
    'nation', normalizeText(p.nation || p.country || ''),
    'pos', normalizeText(p.position || ''),
    'rating', normalizeText(p.overall ?? ''),
    'birth', normalizeText(p.birth_date || p.dateOfBirth || p.dob || '')
  ].join(':');
}

function stablePackPlayerId(rawPlayer, packId) {
  return `PACK_${hashStableString(stablePackPlayerKey(rawPlayer, packId))}`;
}

const EXTERNAL_POSITIONS = new Set(['GK','LB','CB','RB','CDM','CM','CAM','LM','RM','LW','RW','CF','ST']);
function normalizePosition(value) {
  let pos = String(value || '').trim().toUpperCase();
  if (pos === 'LWB') pos = 'LB';
  if (pos === 'RWB') pos = 'RB';
  return EXTERNAL_POSITIONS.has(pos) ? pos : 'CM';
}

function normalizeFoot(value) {
  const foot = String(value || '').trim().toLowerCase();
  if (foot === 'left' || foot === 'links') return 'Left';
  if (foot === 'right' || foot === 'rechts') return 'Right';
  if (foot === 'both' || foot === 'beide') return 'Both';
  return 'Right';
}

function normalizeTrait(value) {
  const map = {
    'team player':'teamplayer','cheerful':'frohnatur','ambitious':'ehrgeizig','calm professional':'ruhiger_profi',
    'hot-headed':'hitzkopf','selfish':'eigensinnig','lazy in training':'trainingsfaul','inconsistent':'unbestaendig',
    'party animal':'feierbiest','chronic latecomer':'serien_zu_spaet','local star':'lokaler_star','club icon':'vereinsikone',
    'locker-room clown':'kabinenclown','quiet outsider':'stiller_aussenseiter','durable':'robust',
    'injury-prone':'verletzungsanfaellig','slightly injury-prone':'leicht_verletzungsanfaellig','glass bones':'glasknochen',
    'risk passer':'risiko_passer','safe passer':'sicherheitspasser','tactically disciplined':'taktisch_diszipliniert',
    'free-spirited':'freiheitsliebend'
  };
  const raw = String(value || '').trim();
  if (!raw) return null;
  return map[raw.toLowerCase()] || raw;
}

function clubResolver(clubs) {
  const byId = new Map();
  const bySource = new Map();
  const normalizeName = value => normalizeText(value).replace(/[^a-z0-9]+/g, ' ').trim();
  for (const club of clubs || []) {
    const id = String(club?.id || '').trim();
    if (id) byId.set(id, club);
    const sourceId = String(club?.sourceClubId || club?.id || '').trim();
    if (!sourceId) continue;
    if (!bySource.has(sourceId)) bySource.set(sourceId, []);
    bySource.get(sourceId).push(club);
  }
  return raw => {
    const requestedId = String(raw?.team_id ?? raw?.club_id ?? raw?.clubId ?? '').trim();
    if (!requestedId) return null;
    const candidates = bySource.get(requestedId) || [];
    const providedName = normalizeName(raw?.team_name ?? raw?.club_name ?? raw?.teamName ?? raw?.clubName ?? '');
    if (providedName && candidates.length) {
      const named = candidates.find(club => normalizeName(club?.name) === providedName);
      if (named?.id) return String(named.id);
    }
    if (byId.has(requestedId)) return requestedId;
    if (candidates.length === 1 && candidates[0]?.id) return String(candidates[0].id);
    return null;
  };
}

function convertPackPlayer(raw, packId, seasonId, resolvedClubId) {
  const stableId = stablePackPlayerId(raw, packId);
  const sourcePlayerKey = stablePackPlayerKey(raw, packId);
  const extras = Array.isArray(raw?.additional_pos) ? raw.additional_pos.map(normalizePosition) : [];
  const position = normalizePosition(raw?.position || 'ST');
  return {
    id: stableId,
    stableId,
    sourcePlayerKey,
    databaseSeasonId: normalizeSeasonId(seasonId),
    externalPlayerId: raw?.id ?? raw?.player_id ?? raw?.playerId ?? raw?.external_id ?? raw?.externalId ?? null,
    databaseSource: 'custom',
    clubId: resolvedClubId,
    clubName: raw?.team_name || raw?.club_name || raw?.teamName || raw?.clubName || '',
    firstName: raw?.first_name || '',
    lastName: raw?.last_name || '',
    name: [raw?.first_name, raw?.last_name].filter(Boolean).join(' '),
    nation: raw?.nation || 'Germany',
    position,
    extraPositions: [...new Set(extras.filter(pos => pos !== position))],
    secondaryPositions: [...new Set(extras.filter(pos => pos !== position))],
    overall: raw?.overall ?? null,
    talent: raw?.potential ?? null,
    potential: raw?.potential ?? null,
    age: raw?.age ?? null,
    height_cm: raw?.height_cm ?? null,
    height: raw?.height_cm ?? null,
    weight_kg: raw?.weight_kg ?? null,
    weight: raw?.weight_kg ?? null,
    foot: normalizeFoot(raw?.foot),
    TEM: raw?.TEM ?? null,
    SCH: raw?.SCH ?? null,
    PAS: raw?.PAS ?? null,
    DRI: raw?.DRI ?? null,
    DEF: raw?.DEF ?? null,
    PHY: raw?.PHY ?? null,
    TACT: raw?.TACT ?? null,
    DISC: raw?.DISC ?? null,
    HEC: raw?.DIV ?? null,
    BSI: raw?.HAN ?? null,
    ABS: raw?.KIC ?? null,
    REF: raw?.REF ?? null,
    TMP: raw?.SPE ?? null,
    POS_GK: raw?.POS ?? null,
    traits: Array.isArray(raw?.traits) ? raw.traits.map(normalizeTrait).filter(Boolean) : [],
    faceMode: 'placeholder',
    usePlaceholderFace: true,
    customFacePath: null,
    customFaceDataUrl: null
  };
}

export async function playerPackCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetch(CATALOG_URL, { cache: 'no-cache' }).then(async response => {
      if (!response.ok) throw new Error(`Player pack catalog: HTTP ${response.status}`);
      const data = await response.json();
      return Array.isArray(data) ? data : [];
    });
  }
  return clone(await catalogPromise);
}

export async function compatiblePlayerPacks(databaseSeasonId, revisionId = null) {
  const seasonId = normalizeSeasonId(databaseSeasonId);
  const targetDatabaseId = `official:${seasonId}`;
  const revision = String(revisionId || '');
  const catalog = await playerPackCatalog();
  return catalog.filter(pack => {
    if (String(pack?.targetDatabaseId || `official:${normalizeSeasonId(pack?.databaseSeasonId)}`) !== targetDatabaseId) return false;
    const revisions = Array.isArray(pack?.compatibleDatabaseRevisions) && pack.compatibleDatabaseRevisions.length ? pack.compatibleDatabaseRevisions : ['*'];
    return revisions.includes('*') || !revision || revisions.includes(revision);
  });
}

function candidateLocalPackUrls(pack) {
  const candidates=[];
  const add=value=>{if(!value)return;try{const u=new URL(value,SITE_ROOT);if(u.origin===SITE_ROOT.origin&&!candidates.some(x=>x.href===u.href))candidates.push(u)}catch(_){}};
  add(pack?.webPath);add(pack?.assetPath);
  const remote=String(pack?.url||'').trim();
  if(remote){try{const u=new URL(remote);const file=decodeURIComponent(u.pathname.split('/').pop()||'');if(file)add(`assets/player-packs/${file}`)}catch(_){}}
  if(pack?.fileName)add(`assets/player-packs/${pack.fileName}`);
  if(pack?.id)add(`assets/player-packs/${pack.id}.json`);
  return candidates;
}

const githubReleaseCache=new Map();
const githubSourceTreeCache=new Map();
const githubRepoMetaCache=new Map();
function githubReleaseParts(url){
  try{
    const u=new URL(url);if(u.hostname!=='github.com')return null;
    const m=u.pathname.match(/^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/i);
    if(!m)return null;
    return{owner:m[1],repo:m[2],tag:decodeURIComponent(m[3]),file:decodeURIComponent(m[4])};
  }catch(_){return null}
}
function decodeBase64Utf8(value){
  const clean=String(value||'').replace(/\s+/g,'');
  const binary=atob(clean);const bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}
async function githubSourceTree(parts,attempts){
  const key=`${parts.owner}/${parts.repo}@${parts.tag}`;
  let promise=githubSourceTreeCache.get(key);
  if(!promise){
    const url=`https://api.github.com/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/git/trees/${encodeURIComponent(parts.tag)}?recursive=1`;
    promise=fetchTimed(url,{headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}},10000).then(async r=>{
      if(!r.ok)throw new Error(`GitHub source tree HTTP ${r.status}`);
      const json=await r.json();const byName=new Map();
      for(const item of json?.tree||[]){if(item?.type!=='blob'||!item?.path||!item?.sha)continue;const name=String(item.path).split('/').pop();if(name&&!byName.has(name))byName.set(name,item)}
      return{url,byName,truncated:Boolean(json?.truncated)};
    });
    githubSourceTreeCache.set(key,promise);
  }
  try{const tree=await promise;attempts.push({source:'GitHub source tree',url:tree.url,status:200});return tree}
  catch(error){attempts.push({source:'GitHub source tree',url:`https://api.github.com/repos/${parts.owner}/${parts.repo}/git/trees/${parts.tag}?recursive=1`,status:null,error:error?.message||String(error)});return null}
}
async function githubRepoDefaultBranch(parts,attempts){
  const key=`${parts.owner}/${parts.repo}`;
  let promise=githubRepoMetaCache.get(key);
  if(!promise){
    const url=`https://api.github.com/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}`;
    promise=fetchTimed(url,{headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}},10000).then(async r=>{
      if(!r.ok)throw new Error(`GitHub repository metadata HTTP ${r.status}`);
      const json=await r.json();return{url,branch:String(json?.default_branch||'').trim()};
    });
    githubRepoMetaCache.set(key,promise);
  }
  try{const meta=await promise;attempts.push({source:'GitHub repository metadata',url:meta.url,status:200});return meta.branch||null}
  catch(error){attempts.push({source:'GitHub repository metadata',url:`https://api.github.com/repos/${parts.owner}/${parts.repo}`,status:null,error:error?.message||String(error)});return null}
}
async function githubBlobFromTree(parts,tree,attempts,sourceLabel){
  const item=tree?.byName?.get(parts.file);if(!item)return null;
  const blobUrl=`https://api.github.com/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/git/blobs/${encodeURIComponent(item.sha)}`;
  try{
    const response=await fetchTimed(blobUrl,{headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}},12000);
    attempts.push({source:`${sourceLabel} blob`,url:blobUrl,status:response.status});
    if(!response.ok)return null;
    const meta=await response.json();
    if(String(meta?.encoding||'').toLowerCase()!=='base64'||!meta?.content)return null;
    const data=JSON.parse(decodeBase64Utf8(meta.content));
    return{data,source:sourceLabel,url:`github:${parts.owner}/${parts.repo}/${item.path}`,attempts};
  }catch(error){attempts.push({source:`${sourceLabel} blob`,url:blobUrl,status:null,error:error?.name==='AbortError'?'timeout':(error?.message||String(error))});return null}
}
async function githubRepositorySource(parts,attempts){
  // First try the release tag. If the release was assembled from generated assets
  // that were never committed to that tag, also inspect the repository's current
  // default branch. This is the last browser-only source attempt before deferring
  // pack resolution to Android import.
  const taggedTree=await githubSourceTree(parts,attempts);
  const tagged=await githubBlobFromTree(parts,taggedTree,attempts,'GitHub release-tag source');
  if(tagged)return tagged;

  const defaultBranch=await githubRepoDefaultBranch(parts,attempts);
  if(defaultBranch&&defaultBranch!==parts.tag){
    const defaultTree=await githubSourceTree({...parts,tag:defaultBranch},attempts);
    const current=await githubBlobFromTree(parts,defaultTree,attempts,`GitHub ${defaultBranch} source`);
    if(current)return current;
  }
  return null;
}

async function fetchTimed(url,options={},timeoutMs=12000){
  const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),timeoutMs);
  try{return await fetch(url,{credentials:'omit',redirect:'follow',referrerPolicy:'no-referrer',...options,signal:ctrl.signal,cache:'no-cache'})}finally{clearTimeout(timer)}
}
async function responseJson(response){
  const text=await response.text();
  try{return JSON.parse(text)}catch(_){throw new Error(`Expected JSON but received ${response.headers.get('content-type')||'unknown content type'} (${text.slice(0,80).replace(/\s+/g,' ')})`)}
}
async function githubReleaseAsset(parts,attempts,originalUrl=''){
  const key=`${parts.owner}/${parts.repo}@${parts.tag}`;
  let promise=githubReleaseCache.get(key);
  if(!promise){
    const api=`https://api.github.com/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/releases/tags/${encodeURIComponent(parts.tag)}`;
    promise=fetchTimed(api,{headers:{Accept:'application/vnd.github+json'}},10000).then(async r=>{
      if(!r.ok)throw new Error(`GitHub release API HTTP ${r.status}`);
      return r.json();
    });
    githubReleaseCache.set(key,promise);
  }
  let release;
  try{release=await promise;attempts.push({source:'GitHub release metadata',url:`https://api.github.com/repos/${parts.owner}/${parts.repo}/releases/tags/${encodeURIComponent(parts.tag)}`,status:200})}
  catch(error){attempts.push({source:'GitHub release metadata',url:`https://api.github.com/repos/${parts.owner}/${parts.repo}/releases/tags/${encodeURIComponent(parts.tag)}`,status:null,error:error?.message||String(error)});return null}
  const asset=(release?.assets||[]).find(x=>String(x?.name||'')===parts.file);
  if(!asset)return null;

  // GitHub explicitly recommends browser_download_url for browser clients.
  // v17 skipped that path for GitHub releases and jumped directly to the API
  // binary endpoint, which can add a CORS-sensitive redirect/preflight.
  const browserUrl=String(asset.browser_download_url||originalUrl||'').trim();
  if(browserUrl){
    try{
      const response=await fetchTimed(browserUrl,{headers:{Accept:'application/json,text/plain,*/*'}},15000);
      attempts.push({source:'GitHub browser download',url:browserUrl,status:response.status});
      if(response.ok)return{data:await responseJson(response),source:'GitHub browser download',url:browserUrl,attempts};
    }catch(error){attempts.push({source:'GitHub browser download',url:browserUrl,status:null,error:error?.name==='AbortError'?'timeout':(error?.message||String(error))})}
  }

  if(!asset?.url)return null;
  try{
    const response=await fetchTimed(asset.url,{headers:{Accept:'application/octet-stream'}},15000);
    attempts.push({source:'GitHub API asset',url:asset.url,status:response.status});
    if(response.ok)return{data:await responseJson(response),source:'GitHub API asset',url:asset.browser_download_url||asset.url,attempts};
  }catch(error){attempts.push({source:'GitHub API asset',url:asset.url,status:null,error:error?.name==='AbortError'?'timeout':(error?.message||String(error))})}
  return null;
}

async function fetchPackData(pack) {
  const cacheKey=String(pack?.url||pack?.webPath||pack?.assetPath||pack?.fileName||pack?.id||'');
  const cached=cacheKey?packPayloadCache.get(cacheKey):null;
  if(cached)return{data:cached.data,source:`${cached.source} (memory cache)`,url:cached.url,attempts:[{source:'Memory cache',url:cached.url,status:200}]};
  const attempts=[];
  const remember=result=>{if(cacheKey&&result?.data)packPayloadCache.set(cacheKey,{data:result.data,source:result.source,url:result.url});return result};
  for(const url of candidateLocalPackUrls(pack)){
    try{
      const response=await fetchTimed(url,{cache:'no-cache'},5000);
      attempts.push({source:'Pages',url:url.href,status:response.status});
      if(response.ok)return remember({data:await response.json(),source:'Pages',url:url.href,attempts});
    }catch(error){attempts.push({source:'Pages',url:url.href,status:null,error:error?.name==='AbortError'?'timeout':(error?.message||String(error))})}
  }

  const remote=String(pack?.url||'').trim();
  const gh=githubReleaseParts(remote);
  if(gh){
    // Modern GitHub release-asset responses may be unreadable to browser fetch
    // because the final release-assets host omits CORS headers. Prefer the
    // CORS-enabled GitHub repository API at the release tag first.
    const sourceAsset=await githubRepositorySource(gh,attempts);if(sourceAsset)return remember(sourceAsset);

    // Keep the historical public release URL as a fallback for mirrors / browser
    // environments where GitHub still exposes it with usable CORS headers.
    if(remote){
      try{
        const response=await fetchTimed(remote,{headers:{Accept:'application/json,text/plain,*/*'}},15000);
        attempts.push({source:'GitHub release direct',url:remote,status:response.status});
        if(response.ok)return remember({data:await responseJson(response),source:'GitHub release direct',url:remote,attempts});
      }catch(error){attempts.push({source:'GitHub release direct',url:remote,status:null,error:error?.name==='AbortError'?'timeout':(error?.message||String(error))})}
    }
    const apiAsset=await githubReleaseAsset(gh,attempts,remote);if(apiAsset)return remember(apiAsset);
  }else if(remote){
    try{const response=await fetchTimed(remote,{headers:{Accept:'application/json,text/plain,*/*'}},12000);attempts.push({source:'Remote',url:remote,status:response.status});if(response.ok)return remember({data:await responseJson(response),source:'Remote',url:remote,attempts})}catch(error){attempts.push({source:'Remote',url:remote,status:null,error:error?.name==='AbortError'?'timeout':(error?.message||String(error))})}
  }
  const localMiss=attempts.filter(a=>a.source==='Pages').every(a=>a.status===404);
  const details=attempts.slice(0,8).map(a=>`${a.source}: ${a.url} → ${a.status?`HTTP ${a.status}`:(a.error||'fetch failed')}`).join(' | ');
  const hint=localMiss?' Same-origin player-pack files are missing. KFM also tried the CORS-enabled GitHub repository source API before falling back to release downloads.':'';
  const error=new Error(`Pack: ${pack?.name||pack?.id||'Unknown'}; ${details||'no usable source'}.${hint}`);error.attempts=attempts;throw error;
}

async function mapLimit(items,limit,worker){
  const results=new Array(items.length);let cursor=0;
  const run=async()=>{while(true){const index=cursor++;if(index>=items.length)return;try{results[index]={ok:true,value:await worker(items[index],index)}}catch(error){results[index]={ok:false,error}}}};
  await Promise.all(Array.from({length:Math.max(1,Math.min(limit,items.length||1))},run));return results;
}

export async function resolveCompatiblePlayerPacks({ databaseSeasonId, revisionId = null, clubs = [], onProgress = null } = {}) {
  const packs=await compatiblePlayerPacks(databaseSeasonId,revisionId);
  const resolveClubId=clubResolver(clubs);const playersById=new Map();const playerIdentityOwners=new Map();const resolvedPacks=[];const failures=[];const duplicatePlayerIds=[];const duplicatePlayers=[];let skippedPlayers=0;
  if(!packs.length)return{players:[],packs:[],failures:[],duplicatePlayerIds:[],duplicatePlayers:[],skippedPlayers:0,totalPacks:0};

  // Environment preflight: resolve one real pack before starting 25 concurrent
  // fallbacks. If same-origin files are missing AND the browser cannot use the
  // GitHub release API, fail once and immediately instead of issuing ~100 doomed
  // requests and making the page look frozen.
  let firstLoaded=null;
  try{
    onProgress?.({stage:'download',pack:packs[0],index:0,total:packs.length,completed:0,playerCount:0});
    firstLoaded=await fetchPackData(packs[0]);
    onProgress?.({stage:'downloaded',pack:packs[0],index:0,total:packs.length,completed:1,source:firstLoaded.source});
  }catch(error){
    failures.push({pack:clone(packs[0]),message:error?.message||String(error),attempts:error?.attempts||[]});
    for(let i=1;i<packs.length;i++)failures.push({pack:clone(packs[i]),message:'Not attempted because the browser could not resolve the first compatible player pack.',attempts:[]});
    onProgress?.({stage:'failed',pack:packs[0],index:1,total:packs.length,error});
    return{players:[],packs:[],failures,duplicatePlayerIds,duplicatePlayers,skippedPlayers,totalPacks:packs.length,environmentFailure:true};
  }

  const downloads=new Array(packs.length);downloads[0]={ok:true,value:firstLoaded};
  let completed=1;
  const rest=await mapLimit(packs.slice(1),6,async(pack,offset)=>{
    const index=offset+1;onProgress?.({stage:'download',pack,index,total:packs.length,completed,playerCount:playersById.size});
    const loaded=await fetchPackData(pack);completed++;onProgress?.({stage:'downloaded',pack,index,total:packs.length,completed,source:loaded.source});return loaded;
  });
  for(let i=1;i<packs.length;i++)downloads[i]=rest[i-1];

  for(let index=0;index<packs.length;index++){
    const pack=packs[index],result=downloads[index];
    if(!result?.ok){const error=result?.error;failures.push({pack:clone(pack),message:error?.message||String(error),attempts:error?.attempts||[]});onProgress?.({stage:'failed',pack,index:index+1,total:packs.length,error});continue}
    const loaded=result.value,data=loaded.data;if(!data||!Array.isArray(data.players)){failures.push({pack:clone(pack),message:'players array is missing.',attempts:loaded.attempts||[]});continue}
    let added=0,skipped=0;
    for(const raw of data.players){
      const clubId=resolveClubId(raw);if(!clubId){skipped++;skippedPlayers++;continue}
      const player=convertPackPlayer(raw,pack.id,databaseSeasonId,clubId);if(!player.id){skipped++;skippedPlayers++;continue}
      if(playersById.has(player.id))duplicatePlayerIds.push({id:player.id,packId:pack.id});
      const identity=normalizeText(`${player.firstName}|${player.lastName}|${player.age??''}|${clubId}`);const previousOwner=playerIdentityOwners.get(identity);
      if(identity&&previousOwner&&previousOwner!==pack.id)duplicatePlayers.push({identity,packId:pack.id,otherPackId:previousOwner,name:player.name,clubId});else if(identity)playerIdentityOwners.set(identity,pack.id);
      playersById.set(player.id,player);added++;
    }
    resolvedPacks.push({id:pack.id,name:pack.name,players:added,skipped,source:loaded.source,url:loaded.url});onProgress?.({stage:'resolved',pack,index:index+1,total:packs.length,playerCount:playersById.size,added,skipped});
  }
  return{players:[...playersById.values()],packs:resolvedPacks,failures,duplicatePlayerIds,duplicatePlayers,skippedPlayers,totalPacks:packs.length};
}
