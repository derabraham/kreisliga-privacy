// Canonical Database / Era settings shared by custom databases and career runtime.
// Stored in data/metadata.json as metadata.databaseSettings. Legacy databases normalize to modern defaults.
export const DATABASE_SETTINGS_VERSION = 2;
export const DEFAULT_DATABASE_SETTINGS = Object.freeze({
  version: DATABASE_SETTINGS_VERSION,
  eraYear: 2026,
  financeScale: 1,
  annualInflation: 0,
  globalizationFactor: 1,
  transferMarketActivity: 1,
  attendanceScale: 1,
  youthInternationalization: 1,
  transferValueScale: null,
  wageScale: null,
  clubRevenueScale: null,
  prizeMoneyScale: null,
  careerLeaguePlayerGateEnabled: false,
  careerLeagueMinPlayersPerClub: 16
});
const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
const numberOr=(v,f)=>Number.isFinite(Number(v))?Number(v):f;
const inherit=v=>(v==null||v==='')?null:clamp(numberOr(v,1),0.01,4);
const boolOrFalse=v=>v===true||v===1||String(v||'').trim().toLowerCase()==='true'||String(v||'').trim()==='1';
const ref=v=>String(v??'').trim();
const lower=v=>ref(v).toLocaleLowerCase();
const isTechnicalLeague=league=>league?.isYouthLeague===true||/\bU(?:15|17|19)\b/i.test(ref(league?.name||league?.leagueName));
const isTechnicalClub=club=>{
  const id=ref(club?.id);
  return !id || club?.inactive===true || club?.isFreeAgentClub===true || id==='FREE_AGENTS' ||
    club?.isYouthTeam===true || club?.isNationalTeam===true || club?.isYouthNationalTeam===true || /_U(?:15|17|19)$/i.test(id);
};

export function normalizeDatabaseSettings(value=null,fallbackYear=2026){
  const r=value&&typeof value==='object'?value:{};
  return{
    version:DATABASE_SETTINGS_VERSION,
    eraYear:Math.round(clamp(numberOr(r.eraYear,fallbackYear||2026),1850,2200)),
    financeScale:clamp(numberOr(r.financeScale,1),0.01,4),
    annualInflation:clamp(numberOr(r.annualInflation,0),-0.05,0.15),
    globalizationFactor:clamp(numberOr(r.globalizationFactor,1),0,2),
    transferMarketActivity:clamp(numberOr(r.transferMarketActivity,1),0.1,2),
    attendanceScale:clamp(numberOr(r.attendanceScale,1),0.1,3),
    youthInternationalization:clamp(numberOr(r.youthInternationalization,1),0,2),
    transferValueScale:inherit(r.transferValueScale),
    wageScale:inherit(r.wageScale),
    clubRevenueScale:inherit(r.clubRevenueScale),
    prizeMoneyScale:inherit(r.prizeMoneyScale),
    careerLeaguePlayerGateEnabled:boolOrFalse(r.careerLeaguePlayerGateEnabled),
    careerLeagueMinPlayersPerClub:Math.round(clamp(numberOr(r.careerLeagueMinPlayersPerClub,16),1,40))
  };
}

/**
 * Analyses which senior leagues are career-ready according to the database setting.
 * A league qualifies only when every active senior club has at least the configured
 * number of database players assigned to it. The source database is never mutated.
 */
export function analyzeCareerLeaguePopulation(data={}, settingsValue=null){
  const settings=normalizeDatabaseSettings(settingsValue ?? data?.metadata?.databaseSettings ?? null, Number(data?.metadata?.startYear||2026));
  const minPlayersPerClub=settings.careerLeagueMinPlayersPerClub;
  const leagues=(Array.isArray(data?.leagues)?data.leagues:[]).filter(league=>league&&league.inactive!==true&&!isTechnicalLeague(league));
  const clubs=(Array.isArray(data?.clubs)?data.clubs:[]).filter(club=>club&&!isTechnicalClub(club));
  const players=(Array.isArray(data?.players)?data.players:[]).filter(player=>player&&player.inactive!==true&&player.isRetired!==true&&player.retired!==true);

  const leagueById=new Map();
  const leagueByName=new Map();
  for(const league of leagues){
    const id=ref(league?.id||league?.leagueId);
    const name=ref(league?.name||league?.leagueName);
    if(id) leagueById.set(id,league);
    if(name&&!leagueByName.has(lower(name))) leagueByName.set(lower(name),league);
  }

  const clubsById=new Map();
  const clubsByName=new Map();
  for(const club of clubs){
    const id=ref(club?.id);
    const name=ref(club?.name||club?.clubName);
    if(id) clubsById.set(id,club);
    if(name&&!clubsByName.has(lower(name))) clubsByName.set(lower(name),club);
  }

  const playerCountsByClubId=new Map();
  const seenPlayerIds=new Set();
  const bump=id=>{if(id)playerCountsByClubId.set(id,(playerCountsByClubId.get(id)||0)+1)};
  for(const player of players){
    const playerId=ref(player?.id||player?.playerId);
    if(playerId){if(seenPlayerIds.has(playerId))continue;seenPlayerIds.add(playerId);}
    const directId=ref(player?.clubId||player?.teamId||player?.club_id||player?.team_id||player?.club?.id||player?.team?.id);
    if(directId&&clubsById.has(directId)){bump(directId);continue;}
    const name=ref(player?.clubName||player?.teamName||(typeof player?.club==='string'?player.club:'')||(typeof player?.team==='string'?player.team:''));
    const club=name?clubsByName.get(lower(name)):null;
    if(club) bump(ref(club.id));
  }

  const clubsByLeagueKey=new Map();
  const keyForLeague=league=>{
    const id=ref(league?.id||league?.leagueId);
    return id?`id:${id}`:`name:${lower(league?.name||league?.leagueName)}`;
  };
  for(const league of leagues) clubsByLeagueKey.set(keyForLeague(league),[]);
  for(const club of clubs){
    const leagueId=ref(club?.leagueId);
    let league=leagueId?leagueById.get(leagueId):null;
    if(!league){
      const leagueName=ref(club?.league||club?.leagueName);
      if(leagueName) league=leagueByName.get(lower(leagueName))||null;
    }
    if(!league) continue;
    const key=keyForLeague(league);
    if(!clubsByLeagueKey.has(key)) clubsByLeagueKey.set(key,[]);
    clubsByLeagueKey.get(key).push(club);
  }

  const details=[];
  const eligibleLeagueIds=[];
  const eligibleLeagueNames=[];
  for(const league of leagues){
    const leagueClubs=clubsByLeagueKey.get(keyForLeague(league))||[];
    let lowestClub=null;
    let lowestCount=Infinity;
    for(const club of leagueClubs){
      const count=playerCountsByClubId.get(ref(club.id))||0;
      if(count<lowestCount){lowestCount=count;lowestClub=club;}
    }
    if(!leagueClubs.length) lowestCount=0;
    const eligible=leagueClubs.length>0&&lowestCount>=minPlayersPerClub;
    const id=ref(league?.id||league?.leagueId);
    const name=ref(league?.name||league?.leagueName);
    if(eligible){if(id)eligibleLeagueIds.push(id);if(name)eligibleLeagueNames.push(name);}
    details.push({
      leagueId:id,
      leagueName:name,
      clubCount:leagueClubs.length,
      minPlayerCount:lowestCount,
      lowestClubId:ref(lowestClub?.id),
      lowestClubName:ref(lowestClub?.name||lowestClub?.clubName),
      eligible
    });
  }
  return{
    enabled:settings.careerLeaguePlayerGateEnabled,
    minPlayersPerClub,
    totalLeagues:details.length,
    eligibleLeagues:details.filter(x=>x.eligible).length,
    ineligibleLeagues:details.filter(x=>!x.eligible).length,
    eligibleLeagueIds,
    eligibleLeagueNames,
    details
  };
}

export function ensureDatabaseSettings(data, fallbackYear = 2026) {
  if (!data || typeof data !== 'object') return normalizeDatabaseSettings(null, fallbackYear);
  data.metadata = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
  const year = Number(data.metadata.startYear || String(data.metadata.startDate || '').slice(0, 4) || fallbackYear || 2026);
  data.metadata.databaseSettings = normalizeDatabaseSettings(data.metadata.databaseSettings, year);
  return data.metadata.databaseSettings;
}
