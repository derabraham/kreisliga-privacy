import { clone, contentHash, ensureIds, stableEntityHash } from './core.js?v=20260822-20';

export const CONTRIBUTION_FORMAT = 'kreisliga-manager-contribution';
export const CONTRIBUTION_VERSION = 1;
const MAX_CONTRIBUTION_COMPRESSED_BYTES = 25 * 1024 * 1024;
const MAX_CONTRIBUTION_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_CONTRIBUTION_ENTRIES = 500;
const TYPE_KEYS = Object.freeze({
  league: ['leagues', 'leagueFlows', 'clubs'],
  player: ['players']
});
const ENTITY_TYPE = Object.freeze({ leagues:'league', leagueFlows:'leagueFlow', clubs:'club', players:'player' });

function stable(value) {
  const seen = new WeakSet();
  const normalize = input => {
    if (input == null || typeof input !== 'object') return input;
    if (seen.has(input)) return '[Circular]';
    seen.add(input);
    if (Array.isArray(input)) return input.map(normalize);
    const out = {};
    for (const key of Object.keys(input).sort()) {
      if (key === 'databaseId') continue; // working-copy identity is not content
      out[key] = normalize(input[key]);
    }
    return out;
  };
  return JSON.stringify(normalize(value));
}
function fingerprint(value) { return `ent-${stableEntityHash(stable(value))}`; }
function normalizeKey(value){try{return String(value??'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ')}catch(_){return String(value??'').trim().toLowerCase()}}
function idOf(item, key) {
  if (key === 'leagueFlows') return String(item?.id || item?.flowId || item?.Region || item?.region || fingerprint(item));
  return String(item?.id || item?.playerId || '').trim();
}
function mapById(list, key) {
  const map = new Map();
  for (const item of Array.isArray(list) ? list : []) { const id=idOf(item,key); if(id) map.set(id,item); }
  return map;
}
function sameEntity(a,b){return stable(a)===stable(b)}
function safeAssetPath(value){const p=String(value||'').replace(/^\/+/, '');return p.startsWith('assets/')&&!p.includes('..')?p:null}
function collectEntityAssets(entity) {
  const out = new Set();
  for (const key of ['logoAsset','flagAsset','faceAsset','imageAsset','customFacePath']) { const p=safeAssetPath(entity?.[key]); if(p)out.add(p); }
  return out;
}

export function trackedContributionHash(type, data) {
  if (!TYPE_KEYS[type]) return null;
  const parts = {};
  for (const key of TYPE_KEYS[type]) {
    const rows = Array.isArray(data?.[key]) ? data[key] : [];
    parts[key] = rows.map(item => [idOf(item, key), fingerprint(item)]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
  }
  return `tracked-${stableEntityHash(stable(parts))}`;
}

export function createContributionWorkspace(baseDb, type, metadata = {}) {
  if (!baseDb || baseDb.source !== 'official') throw new Error('Community Contributions require an official database as their base.');
  if (!TYPE_KEYS[type]) throw new Error(`Unsupported contribution type: ${type}`);
  const officialId = String(baseDb.manifest?.templateDatabaseId || baseDb.data?.metadata?.templateDatabaseId || `official:${baseDb.manifest?.databaseSeasonId || ''}`);
  if (!officialId.startsWith('official:')) throw new Error('Contribution base is not an official database.');

  // Snapshot only the entity collections this contribution type is allowed to change.
  // This avoids cloning 30k+ clubs into a player-only contribution and, importantly,
  // takes the snapshot AFTER the editor has normalized the loaded official data.
  const snapshot = {};
  for (const key of TYPE_KEYS[type]) snapshot[key] = clone(baseDb.data?.[key] || []);

  return {
    type,
    base: {
      databaseId: officialId,
      seasonId: String(baseDb.manifest?.databaseSeasonId || baseDb.data?.metadata?.databaseSeasonId || ''),
      revisionId: baseDb.baseRevisionId || baseDb.manifest?.templateRevisionId || baseDb.manifest?.revisionId || null,
      contentHash: baseDb.baseContentHash || baseDb.data?.metadata?.baseOfficialContentHash || null,
      trackedHash: trackedContributionHash(type, snapshot),
      data: snapshot
    },
    metadata: { contributorName:'', discordName:'', notes:'', sources:[], ...metadata },
    status: 'editing',
    createdAt: new Date().toISOString(),
    _cachedRevision: 0,
    _cachedChanges: [],
    _journal: { adds: Object.create(null), touches: Object.create(null), removes: Object.create(null) }
  };
}


function contributionJournal(workspace) {
  if (!workspace._journal) workspace._journal = { adds: Object.create(null), touches: Object.create(null), removes: Object.create(null) };
  return workspace._journal;
}
function journalSet(bucket, collection) {
  if (!bucket[collection]) bucket[collection] = new Set();
  return bucket[collection];
}
export function noteContributionMutation(workspace, collection, entityOrId, operation = 'touch') {
  if (!workspace || !(TYPE_KEYS[workspace.type] || []).includes(collection)) return false;
  const id = String(typeof entityOrId === 'object' ? idOf(entityOrId, collection) : entityOrId || '').trim();
  if (!id) return false;
  const j = contributionJournal(workspace);
  const adds = journalSet(j.adds, collection), touches = journalSet(j.touches, collection), removes = journalSet(j.removes, collection);
  if (operation === 'add') {
    adds.add(id); touches.delete(id); removes.delete(id);
  } else if (operation === 'remove') {
    if (adds.has(id)) { adds.delete(id); touches.delete(id); removes.delete(id); }
    else { removes.add(id); touches.delete(id); }
  } else {
    if (!adds.has(id) && !removes.has(id)) touches.add(id);
  }
  workspace._cachedRevision = null;
  return true;
}

function mergeJournalRecovery(workspace, currentData, changes) {
  const j = workspace?._journal;
  if (!j) return changes;
  const seen = new Set(changes.map(c => `${c.collection}|${String(c.entityId)}`));
  for (const key of TYPE_KEYS[workspace.type] || []) {
    const before = workspace._baseMaps?.[key] || mapById(workspace.base.data[key], key);
    const after = mapById(currentData?.[key], key);
    const addRecovered = (id, preferredOperation = 'touch') => {
      const token = `${key}|${id}`; if (seen.has(token)) return;
      const a = before.get(id), b = after.get(id);
      if (preferredOperation === 'remove') {
        if (a && !b) { changes.push({entityType:ENTITY_TYPE[key],collection:key,entityId:id,operation:'remove',baseFingerprint:fingerprint(a),before:clone(a),after:null,recoveredFromJournal:true}); seen.add(token); }
        return;
      }
      if (!a && b) { changes.push({entityType:ENTITY_TYPE[key],collection:key,entityId:id,operation:'add',baseFingerprint:null,before:null,after:clone(b),recoveredFromJournal:true}); seen.add(token); return; }
      if (a && b && !sameEntity(a,b)) { changes.push({entityType:ENTITY_TYPE[key],collection:key,entityId:id,operation:'update',baseFingerprint:fingerprint(a),before:clone(a),after:clone(b),recoveredFromJournal:true}); seen.add(token); }
    };
    for (const id of j.adds?.[key] || []) addRecovered(String(id), 'add');
    for (const id of j.touches?.[key] || []) addRecovered(String(id), 'touch');
    for (const id of j.removes?.[key] || []) addRecovered(String(id), 'remove');
  }
  return changes;
}

export function contributionChangeSummary(workspace, currentData, changes = null) {
  const rows = Array.isArray(changes) ? changes : buildContributionChanges(workspace, currentData);
  const summary = { total: rows.length, added: 0, updated: 0, removed: 0, baseCount: 0, currentCount: 0 };
  for (const key of TYPE_KEYS[workspace?.type] || []) {
    summary.baseCount += Array.isArray(workspace?.base?.data?.[key]) ? workspace.base.data[key].length : 0;
    summary.currentCount += Array.isArray(currentData?.[key]) ? currentData[key].length : 0;
  }
  for (const row of rows) {
    if (row.operation === 'add') summary.added++;
    else if (row.operation === 'update') summary.updated++;
    else if (row.operation === 'remove') summary.removed++;
  }
  return summary;
}

export function buildContributionChanges(workspace, currentData) {
  if (!workspace?.base?.data) throw new Error('Contribution workspace has no base snapshot.');
  const changes=[];
  if (!workspace._baseMaps) workspace._baseMaps = Object.create(null);
  for (const key of TYPE_KEYS[workspace.type]) {
    const before=workspace._baseMaps[key] || (workspace._baseMaps[key]=mapById(workspace.base.data[key],key));
    const after=mapById(currentData?.[key],key);
    const ids=new Set([...before.keys(),...after.keys()]);
    for(const id of ids){
      const a=before.get(id), b=after.get(id);
      if(!a&&b) changes.push({entityType:ENTITY_TYPE[key],collection:key,entityId:id,operation:'add',baseFingerprint:null,before:null,after:clone(b)});
      else if(a&&!b) changes.push({entityType:ENTITY_TYPE[key],collection:key,entityId:id,operation:'remove',baseFingerprint:fingerprint(a),before:clone(a),after:null});
      else if(a&&b&&!sameEntity(a,b)) changes.push({entityType:ENTITY_TYPE[key],collection:key,entityId:id,operation:'update',baseFingerprint:fingerprint(a),before:clone(a),after:clone(b)});
    }
  }
  return mergeJournalRecovery(workspace, currentData, changes);
}

function rawPlayerFromCanonical(player) {
  const extra = player?.extraPositions ?? player?.secondaryPositions ?? [];
  const position = String(player?.position || 'CM').toUpperCase();
  const footMap={Left:'left',Right:'right',Both:'both',left:'left',right:'right',both:'both',links:'left',rechts:'right','beidfüßig':'both',beidfuessig:'both'};
  return {
    id: player?.externalPlayerId || player?.id || null,
    team_id: player?.sourceClubId || player?.clubId || '',
    first_name: player?.firstName || '', last_name: player?.lastName || '', nation: player?.nation || player?.nationality || '', position,
    additional_pos: Array.isArray(extra)?extra:[], player_image_url: player?.player_image_url || player?.imageUrl || '',
    overall: player?.overall ?? null, potential: player?.talent ?? player?.potential ?? null, age: player?.age ?? null,
    height_cm: player?.height_cm ?? player?.height ?? null, weight_kg: player?.weight_kg ?? player?.weight ?? null,
    foot: footMap[player?.foot] || String(player?.foot || 'right').toLowerCase(), TEM:player?.TEM??null,SCH:player?.SCH??null,PAS:player?.PAS??null,DRI:player?.DRI??null,DEF:player?.DEF??null,PHY:player?.PHY??null,TACT:player?.TACT??null,DISC:player?.DISC??null,
    DIV:player?.HEC??player?.DIV??null,HAN:player?.BSI??player?.HAN??null,KIC:player?.ABS??player?.KIC??null,REF:player?.REF??null,SPE:player?.TMP??player?.SPE??null,POS:player?.POS_GK??player?.POS??null,
    traits:Array.isArray(player?.traits)?player.traits:[]
  };
}

export function validateContribution(workspace,currentData){
  const changes=buildContributionChanges(workspace,currentData);const issues=[];const push=(severity,message,entityId=null)=>issues.push({severity,message,entityId});
  const changedIds=new Map();
  for(const change of changes){if(!changedIds.has(change.collection))changedIds.set(change.collection,new Set());changedIds.get(change.collection).add(String(change.entityId));}
  const changedAfter=type=>changes.filter(c=>c.entityType===type&&c.operation!=='remove'&&c.after).map(c=>c.after);
  const duplicateIdCounts=list=>{const counts=new Map();for(const item of list||[]){const id=String(item?.id||item?.playerId||'').trim();if(id)counts.set(id,(counts.get(id)||0)+1)}return counts};
  for(const [collection,label] of workspace.type==='league'?[['leagues','League'],['clubs','Club']]:[['players','Player']]){
    const counts=duplicateIdCounts(currentData?.[collection]);
    for(const id of changedIds.get(collection)||[]){if(!id)push('error',`${label} is missing an ID.`);else if((counts.get(id)||0)>1)push('error',`Duplicate ${label} ID: ${id}`,id)}
  }
  const nationNames=new Set((currentData?.nations||[]).flatMap(n=>[n?.name,n?.displayName,n?.id].filter(Boolean).map(x=>normalizeKey(x))));
  const clubIds=new Set((currentData?.clubs||[]).map(x=>String(x.id)));
  const leagueIds=new Set((currentData?.leagues||[]).map(x=>String(x.id)));
  const colors=/^#[0-9a-f]{6}$/i;
  if(workspace.type==='league'){
    const clubKeyCounts=new Map();for(const club of currentData?.clubs||[]){const name=String(club?.name||'').trim();if(!name)continue;const key=normalizeKey(`${name}|${club?.leagueId||club?.league||''}`);clubKeyCounts.set(key,(clubKeyCounts.get(key)||0)+1)}
    for(const league of changedAfter('league')){const id=String(league?.id||'');if(!String(league?.name||'').trim())push('error',`League ${id||'(new)'} has no name.`,id);const level=Number(league?.level);if(!Number.isFinite(level)||level<1||level>30)push('warning',`${league?.name||id}: unusual league level ${league?.level}.`,id)}
    for(const club of changedAfter('club')){const id=String(club?.id||'');const name=String(club?.name||'').trim();if(!name)push('error',`Club ${id||'(new)'} has no name.`,id);const key=normalizeKey(`${name}|${club?.leagueId||club?.league||''}`);if(name&&(clubKeyCounts.get(key)||0)>1)push('warning',`Possible duplicate club: ${name}.`,id);if(club?.leagueId&&!leagueIds.has(String(club.leagueId)))push('error',`${name||id} references unknown league ${club.leagueId}.`,id);const rating=Number(club?.rating);if(Number.isFinite(rating)&&(rating<1||rating>99))push('warning',`${name||id}: unusual rating ${rating}.`,id);for(const k of ['primarycolor','secondarycolor','primaryColor','secondaryColor'])if(club?.[k]&&!colors.test(String(club[k])))push('warning',`${name||id}: invalid ${k} ${club[k]}.`,id)}
  }
  if(workspace.type==='player'){
    const validPos=new Set(['GK','LB','CB','RB','CDM','CM','CAM','LM','RM','LW','RW','CF','ST']);const validFeet=new Set(['left','right','both','links','rechts','beide','beidfüßig','beidfuessig']);
    const playerKeyCounts=new Map();for(const p of currentData?.players||[]){const age=Number(p?.age);const dup=normalizeKey(`${p?.firstName||''}|${p?.lastName||''}|${Number.isFinite(age)?age:''}|${p?.clubId||''}`);if(dup!=='|||')playerKeyCounts.set(dup,(playerKeyCounts.get(dup)||0)+1)}
    for(const p of changedAfter('player')){const id=String(p?.id||p?.playerId||'');const label=String(p?.name||[p?.firstName,p?.lastName].filter(Boolean).join(' ')||id);if(p?.clubId&&!clubIds.has(String(p.clubId)))push('error',`${label} references unknown club ${p.clubId}.`,id);const nation=normalizeKey(p?.nation||p?.nationality||p?.country||'');if(nation&&nationNames.size&&!nationNames.has(nation))push('warning',`${label}: unknown nation ${p?.nation||p?.nationality||p?.country}.`,id);const pos=String(p?.position||'').toUpperCase();if(!validPos.has(pos))push('error',`${label}: invalid main position ${pos||'(empty)'}.`,id);const extras=p?.extraPositions??p?.secondaryPositions??[];for(const extra of Array.isArray(extras)?extras:[]){const e=String(extra||'').toUpperCase();if(['RWB','LWB'].includes(e)||!validPos.has(e))push('error',`${label}: invalid additional position ${e}.`,id)}const o=Number(p?.overall);if(!Number.isFinite(o)||o<1||o>99)push('warning',`${label}: unusual OVR ${p?.overall}.`,id);const pot=Number(p?.talent??p?.potential);if(Number.isFinite(pot)&&!((pot>=0.5&&pot<=5)||(pot>=20&&pot<=99)))push('warning',`${label}: unusual potential ${pot}.`,id);const age=Number(p?.age);if(Number.isFinite(age)&&(age<14||age>50))push('warning',`${label}: unusual age ${age}.`,id);const h=Number(p?.height_cm??p?.height);if(Number.isFinite(h)&&(h<140||h>220))push('warning',`${label}: unusual height ${h} cm.`,id);const w=Number(p?.weight_kg??p?.weight);if(Number.isFinite(w)&&(w<40||w>130))push('warning',`${label}: unusual weight ${w} kg.`,id);const foot=String(p?.foot||'').toLowerCase();if(foot&&!validFeet.has(foot))push('warning',`${label}: invalid foot ${p.foot}.`,id);const dup=normalizeKey(`${p?.firstName||''}|${p?.lastName||''}|${Number.isFinite(age)?age:''}|${p?.clubId||''}`);if(dup!=='|||'&&(playerKeyCounts.get(dup)||0)>1)push('warning',`Possible duplicate player: ${label} (${Number.isFinite(age)?age:'?'}, same club).`,id)}
  }
  const idsByCollection=new Map();for(const change of changes){const k=change.collection;if(!idsByCollection.has(k))idsByCollection.set(k,new Set());const set=idsByCollection.get(k);if(set.has(change.entityId))push('error',`Duplicate contribution entity ID: ${change.entityId}`,change.entityId);set.add(change.entityId)}
  return{changes,issues,errors:issues.filter(x=>x.severity==='error').length,warnings:issues.filter(x=>x.severity!=='error').length};
}

export async function exportContribution(workspace,currentDb) {
  if(!globalThis.JSZip)throw new Error('JSZip is not available');
  const validation=validateContribution(workspace,currentDb.data); const changes=validation.changes;
  const packageId=`contrib:${Date.now().toString(36)}:${stableEntityHash(JSON.stringify(changes).slice(0,100000))}`;
  const manifest={format:CONTRIBUTION_FORMAT,packageVersion:CONTRIBUTION_VERSION,contributionId:packageId,contributionType:workspace.type,scopeCollections:[...(TYPE_KEYS[workspace.type]||[])],seasonId:workspace.base.seasonId,baseDatabaseId:workspace.base.databaseId,baseRevisionId:workspace.base.revisionId||null,baseContentHash:workspace.base.contentHash||null,baseTrackedHash:workspace.base.trackedHash||trackedContributionHash(workspace.type,workspace.base.data),createdAt:workspace.createdAt||new Date().toISOString(),exportedAt:new Date().toISOString(),contributorName:workspace.metadata?.contributorName||'',discordName:workspace.metadata?.discordName||'',notes:workspace.metadata?.notes||'',sources:Array.isArray(workspace.metadata?.sources)?workspace.metadata.sources:[],changeCount:changes.length,validation:{errors:validation.errors,warnings:validation.warnings}};
  const zip=new JSZip();zip.file('manifest.json',JSON.stringify(manifest,null,2));zip.file('changes.json',JSON.stringify(changes,null,2));
  const referenced=new Set();for(const c of changes)for(const p of collectEntityAssets(c.after))referenced.add(p);
  for(const path of referenced){const blob=currentDb.assets?.get(path);if(blob)zip.file(path,blob)}
  if(workspace.type==='player'){
    const players=changes.filter(c=>c.entityType==='player'&&c.operation!=='remove'&&c.after).map(c=>rawPlayerFromCanonical(c.after));
    zip.file('player-pack.json',JSON.stringify({packName:`Community contribution ${workspace.base.seasonId}`,version:'1.0',author:manifest.contributorName,targetDatabaseId:manifest.baseDatabaseId,databaseSeasonId:manifest.seasonId,compatibleDatabaseRevisions:[manifest.baseRevisionId||'*'],players},null,2));
  }
  const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}});return{blob,manifest,changes,validation};
}

export async function importContribution(file){
  if(!globalThis.JSZip)throw new Error('JSZip is not available');
  const compressedBytes=Number(file?.size||file?.byteLength||0);if(compressedBytes>MAX_CONTRIBUTION_COMPRESSED_BYTES)throw new Error('Contribution package is too large.');
  const zip=await JSZip.loadAsync(file,{checkCRC32:true,createFolders:false});const entries=Object.entries(zip.files);if(entries.length>MAX_CONTRIBUTION_ENTRIES)throw new Error('Contribution package contains too many files.');
  for(const[path,e]of entries){if(path.startsWith('/')||path.includes('..')||path.includes('\\'))throw new Error(`Unsafe package path: ${path}`);if(!e.dir&&!['manifest.json','changes.json','player-pack.json'].includes(path)&&!path.startsWith('assets/'))throw new Error(`Unexpected file in contribution package: ${path}`)}
  const m=zip.file('manifest.json'),c=zip.file('changes.json');if(!m||!c)throw new Error('Contribution package is missing manifest.json or changes.json.');
  const manifest=JSON.parse(await m.async('string'));if(manifest.format!==CONTRIBUTION_FORMAT)throw new Error('This is not a KFM contribution package.');if(Number(manifest.packageVersion||0)!==CONTRIBUTION_VERSION)throw new Error(`Unsupported contribution package version: ${manifest.packageVersion}.`);if(!['league','player'].includes(String(manifest.contributionType||'')))throw new Error('Contribution type is invalid.');if(!String(manifest.baseDatabaseId||'').startsWith('official:'))throw new Error('Contribution does not reference an official base database.');
  const rawChanges=JSON.parse(await c.async('string'));if(!Array.isArray(rawChanges))throw new Error('changes.json is invalid.');if(rawChanges.length>100000)throw new Error('Contribution contains too many changes.');
  const allowedCollections=new Set(TYPE_KEYS[manifest.contributionType]||[]);
  const changes=[];const ignoredChanges=[];
  for(const change of rawChanges){
    const collection=String(change?.collection||'');
    // Recovery for packages exported by the first contribution prototype: a
    // player-only edit could accidentally serialize normalized league rows too.
    // Player contributions are never allowed to mutate leagues/clubs, so those
    // phantom rows are safe to ignore and are surfaced in Review instead of
    // rendering hundreds of "undefined" league entries.
    if(!allowedCollections.has(collection)){
      if(manifest.contributionType==='player'){ignoredChanges.push(change);continue;}
      throw new Error(`Invalid contribution collection: ${change?.collection}.`);
    }
    if(!['add','update','remove'].includes(String(change?.operation||'')))throw new Error(`Invalid contribution operation: ${change?.operation}.`);
    if(!String(change?.entityId||'').trim())throw new Error('Contribution contains a change without an entity ID.');
    changes.push(change);
  }
  if(ignoredChanges.length){manifest.legacyIgnoredChangeCount=ignoredChanges.length;manifest.changeCount=changes.length;}
  if(!changes.length) throw new Error('This contribution contains 0 usable changes. The earlier export did not capture the edit; please recreate it with the fixed Studio version.');
  const assets=new Map();for(const[path,e]of entries){if(e.dir||!path.startsWith('assets/'))continue;const blob=await e.async('blob');if(blob.size>MAX_CONTRIBUTION_ASSET_BYTES)throw new Error(`Contribution asset is too large: ${path}`);assets.set(path,blob)}
  return{manifest,changes,assets,ignoredChanges};
}

export function reviewContribution(pkg,baseData,baseHash=null,baseTrackedHash=null){
  const trackedExpected=String(pkg.manifest?.baseTrackedHash||'');
  const trackedActual=String(baseTrackedHash||'');
  const fullExpected=String(pkg.manifest?.baseContentHash||'');
  const fullActual=String(baseHash||'');
  const hashMatches=trackedExpected&&trackedActual ? trackedExpected===trackedActual : (!fullExpected||!fullActual||fullExpected===fullActual);const results=[];
  const basePlayers=baseData?.players||[],baseClubs=baseData?.clubs||[],baseLeagues=baseData?.leagues||[],baseNations=baseData?.nations||[];
  const playerDupKeys=new Set(basePlayers.map(p=>normalizeKey(`${p?.firstName||''}|${p?.lastName||''}|${p?.age||''}|${p?.clubId||''}`)));
  const clubDupKeys=new Set(baseClubs.map(c=>normalizeKey(`${c?.name||''}|${c?.leagueId||c?.league||''}`)));
  const leagueDupKeys=new Set(baseLeagues.map(l=>normalizeKey(`${l?.name||''}|${l?.country||l?.nationId||l?.association||''}|${l?.level||''}`)));
  const clubIds=new Set(baseClubs.map(c=>String(c?.id||'')));
  const leagueIds=new Set(baseLeagues.map(l=>String(l?.id||'')));
  const leagueNames=new Set(baseLeagues.map(l=>normalizeKey(l?.name||'')));
  const nationIds=new Set(baseNations.flatMap(n=>[n?.id,n?.nationId].filter(Boolean).map(String)));
  const nationNames=new Set(baseNations.flatMap(n=>[n?.name,n?.displayName].filter(Boolean).map(normalizeKey)));
  for(const change of pkg.changes||[]){if(change?.operation==='add'&&change?.entityType==='league'&&change?.after){leagueIds.add(String(change.after.id||change.entityId));leagueNames.add(normalizeKey(change.after.name||''))}}
  const validPos=new Set(['GK','LB','CB','RB','CDM','CM','CAM','LM','RM','LW','RW','CF','ST']);
  const severity={safe:0,review:1,conflict:2};
  // Build collection indexes once. Older/broken contribution files can contain
  // hundreds or thousands of rows; rebuilding a 30k-club Map for every change
  // made Review appear to hang indefinitely.
  const reviewMaps=new Map();
  const baseMapFor=collection=>{
    if(!reviewMaps.has(collection))reviewMaps.set(collection,mapById(baseData?.[collection]||[],collection));
    return reviewMaps.get(collection);
  };
  for(const change of pkg.changes||[]){
    const current=baseMapFor(change.collection).get(String(change.entityId));let status='safe';const reasons=[];
    const flag=(next,reason)=>{if(severity[next]>severity[status])status=next;if(reason&&!reasons.includes(reason))reasons.push(reason)};
    if(change.operation==='add'&&current)flag('conflict','ID already exists in current base.');
    if(change.operation!=='add'&&!current)flag('conflict','Entity no longer exists in current base.');
    if(change.operation==='add'&&change.entityType==='player'&&change.after){const key=normalizeKey(`${change.after.firstName||''}|${change.after.lastName||''}|${change.after.age||''}|${change.after.clubId||''}`);if(playerDupKeys.has(key))flag('review','Possible duplicate player (same name, age and club).')}
    if(change.operation==='add'&&change.entityType==='club'&&change.after){const key=normalizeKey(`${change.after.name||''}|${change.after.leagueId||change.after.league||''}`);if(clubDupKeys.has(key))flag('review','Possible duplicate club in the same league.')}
    if(change.operation==='add'&&change.entityType==='league'&&change.after){const key=normalizeKey(`${change.after.name||''}|${change.after.country||change.after.nationId||change.after.association||''}|${change.after.level||''}`);if(leagueDupKeys.has(key))flag('review','Possible duplicate league.')}
    if(!hashMatches&&current&&change.baseFingerprint&&fingerprint(current)!==change.baseFingerprint)flag('review','Base entity changed since the contribution was created.');

    const after=change.after;
    if(after&&change.entityType==='player'){
      const clubId=String(after.clubId||after.sourceClubId||'').trim();if(clubId&&!clubIds.has(clubId))flag('conflict',`Referenced club ${clubId} does not exist in the current base.`);
      const nationKey=normalizeKey(after.nation||after.nationality||after.country||'');if(nationKey&&nationNames.size&&!nationNames.has(nationKey))flag('review',`Nation ${after.nation||after.nationality||after.country} is not known in the current base.`);
      const pos=String(after.position||'').toUpperCase();if(!validPos.has(pos))flag('conflict',`Invalid main position ${pos||'(empty)'}.`);
      for(const extra of Array.isArray(after.extraPositions??after.secondaryPositions)?(after.extraPositions??after.secondaryPositions):[]){const p=String(extra||'').toUpperCase();if(!validPos.has(p)||p==='RWB'||p==='LWB')flag('conflict',`Invalid additional position ${p}.`)}
      const o=Number(after.overall);if(!Number.isFinite(o)||o<1||o>99)flag('review',`Unusual OVR ${after.overall}.`);
      const pot=Number(after.talent??after.potential);if(Number.isFinite(pot)&&!((pot>=0.5&&pot<=5)||(pot>=20&&pot<=99)))flag('review',`Unusual potential ${pot}.`);
      const age=Number(after.age);if(Number.isFinite(age)&&(age<14||age>50))flag('review',`Unusual age ${age}.`);
    }
    if(after&&change.entityType==='club'){
      const lid=String(after.leagueId||'').trim(),lname=normalizeKey(after.league||'');if(lid&&!leagueIds.has(lid))flag('conflict',`Referenced league ${lid} does not exist in the current/proposed base.`);else if(!lid&&lname&&!leagueNames.has(lname))flag('review',`League ${after.league} cannot be matched safely.`);
    }
    if(after&&change.entityType==='league'){
      const nid=String(after.nationId||'').trim(),nname=normalizeKey(after.country||after.nation||'');if(nid&&nationIds.size&&!nationIds.has(nid))flag('review',`Nation ID ${nid} is not known in the current base.`);else if(!nid&&nname&&nationNames.size&&!nationNames.has(nname))flag('review',`Nation ${after.country||after.nation} is not known in the current base.`);
    }
    const referencedAssets=[...collectEntityAssets(after)];for(const assetPath of referencedAssets){if(change.operation==='add'&&!pkg.assets?.has?.(assetPath))flag('review',`Asset ${assetPath} is referenced but not embedded in the contribution.`)}
    results.push({...change,reviewStatus:status,reviewReason:reasons.join(' '),accepted:status==='safe'});
  }
  return{hashMatches,results,summary:{safe:results.filter(x=>x.reviewStatus==='safe').length,review:results.filter(x=>x.reviewStatus==='review').length,conflicts:results.filter(x=>x.reviewStatus==='conflict').length}};
}

export function applyReviewedChanges(baseData,reviewRows){
  const data=clone(baseData);
  const accepted=(reviewRows||[]).filter(x=>x.accepted);
  const byCollection=new Map();
  for(const change of accepted){
    const key=String(change.collection||'');
    if(!byCollection.has(key))byCollection.set(key,[]);
    byCollection.get(key).push(change);
  }
  for(const [key,changes] of byCollection){
    const source=Array.isArray(data[key])?data[key]:[];
    const map=mapById(source,key);
    for(const change of changes){
      const id=String(change.entityId);
      if(change.operation==='remove')map.delete(id);
      else map.set(id,clone(change.after));
    }
    data[key]=[...map.values()];
  }
  return data;
}
