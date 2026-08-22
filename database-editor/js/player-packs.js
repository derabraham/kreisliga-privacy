// Browser-side resolver for the same legacy Player Data Pack catalog used by the
// in-game Database Builder. The mobile app treats these unversioned legacy packs
// as 25/26-only content. The browser resolves them into a standalone custom DB;
// the exported .kfmdb therefore has no runtime dependency on an installed pack.

const SITE_ROOT = new URL('../../', import.meta.url);
const CATALOG_URL = new URL('assets/data/player_pack_catalog.json', SITE_ROOT);

let catalogPromise = null;

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

async function fetchPackData(pack) {
  const localUrl = new URL(`assets/player-packs/${encodeURIComponent(pack.id)}.json`, SITE_ROOT);
  let localError = null;
  try {
    const response = await fetch(localUrl, { cache: 'no-cache' });
    if (response.ok) return await response.json();
    localError = new Error(`local HTTP ${response.status}`);
  } catch (error) {
    localError = error;
  }
  // Development fallback. The GitHub Pages workflow places the packs on the
  // same origin, so production does not depend on cross-origin browser access.
  try {
    const response = await fetch(pack.url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (remoteError) {
    throw new Error(`${pack.name}: could not load pack (${remoteError?.message || localError?.message || 'unknown error'})`);
  }
}

export async function resolveCompatiblePlayerPacks({ databaseSeasonId, revisionId = null, clubs = [], onProgress = null } = {}) {
  const packs = await compatiblePlayerPacks(databaseSeasonId, revisionId);
  const resolveClubId = clubResolver(clubs);
  const playersById = new Map();
  const resolvedPacks = [];
  let skippedPlayers = 0;

  for (let index = 0; index < packs.length; index++) {
    const pack = packs[index];
    onProgress?.({ stage: 'download', pack, index, total: packs.length, playerCount: playersById.size });
    const data = await fetchPackData(pack);
    if (!data || !Array.isArray(data.players)) throw new Error(`${pack.name}: players array is missing.`);
    let added = 0;
    let skipped = 0;
    for (const raw of data.players) {
      const clubId = resolveClubId(raw);
      if (!clubId) { skipped++; skippedPlayers++; continue; }
      const player = convertPackPlayer(raw, pack.id, databaseSeasonId, clubId);
      if (!player.id) { skipped++; skippedPlayers++; continue; }
      playersById.set(player.id, player);
      added++;
    }
    resolvedPacks.push({ id: pack.id, name: pack.name, players: added, skipped });
    onProgress?.({ stage: 'resolved', pack, index: index + 1, total: packs.length, playerCount: playersById.size, added, skipped });
  }

  return { players: [...playersById.values()], packs: resolvedPacks, skippedPlayers };
}
