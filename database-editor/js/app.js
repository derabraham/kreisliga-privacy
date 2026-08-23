import {
  emptyData, ensureIds, makeId, indexes, validate, ratingClass, esc,
  POSITIONS, FEET, download, leagueNation, additionalPlayerGenerationMode, shouldGenerateAdditionalPlayers, ADDITIONAL_PLAYER_AUTO_THRESHOLD,
  calculateAutomaticClubRating, syncAutomaticClubRatings
} from './core.js?v=20260823-01';
import { importKfmdb, exportKfmdb } from './kfmdb.js?v=20260823-01';
import { listOfficial, loadOfficial, loadOfficialContributionBase, loadOfficialReviewBase, loadReferenceScaffold } from './official-loader.js?v=20260822-22';
import { compatiblePlayerPacks } from './player-packs.js?v=20260822-22';
import { ensureDatabaseSettings, normalizeDatabaseSettings } from './database-settings.js?v=20260822-22';
import { createContributionWorkspace, buildContributionChanges, validateContribution, exportContribution, importContribution, reviewContribution, applyReviewedChanges, trackedContributionHash, noteContributionMutation, contributionChangeSummary } from './contributions.js?v=20260822-22';


const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const state = {
  db: null,
  view: 'overview',
  search: '',
  playerTeamSearch: '',
  page: 1,
  pageSize: 100,
  selected: new Set(),
  playerSort: { key: null, dir: 1 },
  tableSorts: {},
  structure: { confederation: null, nationId: null, level: null, leagueId: null, clubId: null },
  imageTarget: null,
  flagTarget: null,
  pendingNationFlag: null,
  flags: [],
  flagLookupMap: new Map(),
  nationDisplayCache: new Map(),
  nationUiCache: null,
  objectUrls: new Map(),
  clubEditors: [],
  contribution: null,
  reviewPackage: null,
  reviewModel: null,
  reviewBaseDb: null,
  reviewEntry: null,
  reviewInspect: false,
  dataRevision: 0,
  indexCache: null,
  searchTimer: null
};

const els = {
  content: $('#content'),
  title: $('#viewTitle'),
  subtitle: $('#viewSubtitle'),
  breadcrumbs: $('#breadcrumbs'),
  actions: $('#viewActions'),
  dbName: $('#dbName'),
  dbMeta: $('#dbMeta'),
  chip: $('#databaseChip'),
  exportBtn: $('#exportBtn'),
  metadataBtn: $('#metadataBtn'),
  modal: $('#modalRoot'),
  toast: $('#toastRoot'),
  main: $('.main')
};

$('#brandLogo')?.addEventListener('error', e => { e.currentTarget.style.display = 'none'; });

function toast(message, type = 'ok') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  els.toast.append(node);
  setTimeout(() => node.remove(), 3200);
}

const IMAGE_PRESETS = Object.freeze({
  club: { maxWidth: 96, maxHeight: 96, quality: 0.84, label: 'Team logo' },
  player: { maxWidth: 128, maxHeight: 128, quality: 0.82, label: 'Player image' },
  flag: { maxWidth: 96, maxHeight: 64, quality: 0.86, label: 'Nation flag' }
});

function readableBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadImageSource(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = 'async';
    const loaded = new Promise((resolve, reject) => {
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('The selected image could not be decoded.'));
    });
    image.src = url;
    return await loaded;
  } finally {
    // The image has already decoded by the time the promise resolves.
    // Delay revocation one task so Safari can still paint it to canvas.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

async function optimizeImageFile(fileOrBlob, presetName, originalName = '') {
  const preset = IMAGE_PRESETS[presetName] || IMAGE_PRESETS.club;
  const sourceBlob = fileOrBlob instanceof Blob ? fileOrBlob : new Blob([fileOrBlob]);
  const image = await loadImageSource(sourceBlob);
  const sourceWidth = Number(image.naturalWidth || image.width || 1);
  const sourceHeight = Number(image.naturalHeight || image.height || 1);
  const scale = Math.min(1, preset.maxWidth / sourceWidth, preset.maxHeight / sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('Image processing is not available in this browser.');
  ctx.clearRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, width, height);
  const makeBlob = (type, quality) => new Promise(resolve => canvas.toBlob(resolve, type, quality));
  let optimized = await makeBlob('image/webp', preset.quality);
  let ext = 'webp';
  if (!optimized) {
    optimized = await makeBlob('image/png');
    ext = 'png';
  }
  if (!optimized) throw new Error('Could not optimize the selected image.');
  const base = String(originalName || 'image').replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '_') || 'image';
  const file = new File([optimized], `${base}.${ext}`, { type: optimized.type || (ext === 'webp' ? 'image/webp' : 'image/png'), lastModified: Date.now() });
  return {
    file,
    ext,
    width,
    height,
    originalBytes: Number(sourceBlob.size || 0),
    optimizedBytes: Number(file.size || 0),
    preset
  };
}

function optimizationToast(result) {
  if (!result) return '';
  const before = readableBytes(result.originalBytes);
  const after = readableBytes(result.optimizedBytes);
  return `${result.preset.label} optimized to ${result.width}×${result.height} ${result.ext.toUpperCase()} (${before} → ${after}).`;
}

function resetTransient() {
  state.page = 1;
  state.search = '';
  state.playerTeamSearch = '';
  state.selected.clear();
  removeSelectionBar();
}

function resetStructure() {
  state.structure = { confederation: null, nationId: null, level: null, leagueId: null, clubId: null };
}

function findClubEditor(id) {
  return state.clubEditors.find(editor => String(editor.id) === String(id)) || null;
}

function clubEditorsForLeague(leagueId) {
  return state.clubEditors.filter(editor => String(editor.leagueId) === String(leagueId));
}

function disposeClubEditor(id) {
  const editor = findClubEditor(id);
  if (!editor) return;
  if (editor.pendingLogoUrl) { try { URL.revokeObjectURL(editor.pendingLogoUrl); } catch (_) {} }
  state.clubEditors = state.clubEditors.filter(item => String(item.id) !== String(id));
}

function disposeAllClubEditors() {
  for (const editor of state.clubEditors) {
    if (editor?.pendingLogoUrl) { try { URL.revokeObjectURL(editor.pendingLogoUrl); } catch (_) {} }
  }
  state.clubEditors = [];
}

function setDb(db) {
  disposeAllClubEditors();
  state.db = db;
  state.dataRevision += 1;
  state.indexCache = null;
  state.nationDisplayCache = new Map();
  state.nationUiCache = null;
  ensureIds(db.data, db.manifest.databaseId);
  ensureDatabaseSettings(db.data, Number(db.data?.metadata?.startYear || String(db.manifest?.startDate||'2026').slice(0,4) || 2026));
  // Keep legacy saves compatible while presenting only the position set used by
  // the current game. Old RWB/LWB values are mapped to RB/LB in the editable copy.
  for (const player of db.data.players || []) {
    player.position = normalizePositionCode(player.position || 'CM');
    const extras = player.extraPositions ?? player.secondaryPositions ?? [];
    const normalizedExtras = [...new Set((Array.isArray(extras) ? extras : String(extras || '').split(','))
      .map(normalizeOptionalPositionCode)
      .filter(pos => POSITIONS.includes(pos) && pos !== player.position))];
    player.extraPositions = normalizedExtras;
    player.secondaryPositions = [...normalizedExtras];
  }
  const autoRatingSync = syncAutomaticClubRatings(db.data);
  if (autoRatingSync.changed) db.dirty = true;
  resetTransient();
  resetStructure();
  els.dbName.textContent = db.manifest.displayName;
  els.dbMeta.textContent = db.dirty ? `Unsaved changes · ${db.data.clubs.length.toLocaleString()} clubs · ${db.data.players.length.toLocaleString()} players` : `${db.manifest.version || '1.0.0'} · ${db.data.clubs.length.toLocaleString()} clubs · ${db.data.players.length.toLocaleString()} players`;
  els.chip.classList.add('loaded');
  els.exportBtn.disabled = false;
  els.metadataBtn.disabled = false;
  render();
}

function requireDb() {
  if (state.db) return true;
  toast('Load or create a database first.', 'error');
  return false;
}

function dirty() {
  if (!state.db) return;
  state.db.dirty = true;
  state.dataRevision += 1;
  state.indexCache = null;
  state.nationDisplayCache = new Map();
  state.nationUiCache = null;
  if (state.contribution) state.contribution._cachedRevision = null;
  els.dbMeta.textContent = `Unsaved changes · ${state.db.data.clubs.length.toLocaleString()} clubs · ${state.db.data.players.length.toLocaleString()} players`;
}


function markContributionEntity(collection, entityOrId, operation = 'touch') {
  const w = state.contribution;
  if (!w) return false;
  const changed = noteContributionMutation(w, collection, entityOrId, operation);
  if (changed) w._cachedRevision = null;
  return changed;
}
function markPlayerAdded(player) { return markContributionEntity('players', player, 'add'); }
function markPlayerTouched(player) { return markContributionEntity('players', player, 'touch'); }
function markPlayerRemoved(playerOrId) { return markContributionEntity('players', playerOrId, 'remove'); }

function dbIndexes(){
  if(!state.db) return indexes(emptyData());
  if(state.indexCache?.revision===state.dataRevision) return state.indexCache.value;
  const value=indexes(state.db.data);
  state.indexCache={revision:state.dataRevision,value};
  return value;
}

function refreshAutomaticClubRatings(clubIds=null,{markDirty=false}={}){
  if(!state.db) return { changed:0, eligible:0, changes:[] };
  const result=syncAutomaticClubRatings(state.db.data,clubIds);
  if(result.changed){
    state.dataRevision += 1;
    state.indexCache = null;
    if(markDirty){
      state.db.dirty = true;
      if(state.contribution) state.contribution._cachedRevision = null;
      els.dbMeta.textContent = `Unsaved changes · ${state.db.data.clubs.length.toLocaleString()} clubs · ${state.db.data.players.length.toLocaleString()} players`;
    }
  }
  return result;
}

function refreshAutomaticClubRatingsForPlayers(players,{markDirty=false}={}){
  const ids=new Set((Array.isArray(players)?players:[players]).map(player=>String(player?.clubId||'')).filter(Boolean));
  return ids.size?refreshAutomaticClubRatings(ids,{markDirty}):{changed:0,eligible:0,changes:[]};
}

function contributionChangesCached(){
  const w=state.contribution;
  if(!w||!state.db)return [];
  if(w._cachedRevision===state.dataRevision&&Array.isArray(w._cachedChanges))return w._cachedChanges;
  const changes=buildContributionChanges(w,state.db.data);
  w._cachedRevision=state.dataRevision;
  w._cachedChanges=changes;
  return changes;
}

function modal(title, body, footer = '', extraClass = '') {
  els.modal.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal ${extraClass}">
        <div class="modal-head"><h2>${esc(title)}</h2><button class="btn icon" data-close type="button">×</button></div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>
    </div>`;
  $('[data-close]', els.modal)?.addEventListener('click', closeModal);
  $('.modal-backdrop', els.modal)?.addEventListener('mousedown', event => {
    if (event.target.classList.contains('modal-backdrop')) closeModal();
  });
}

function closeModal() { els.modal.innerHTML = ''; }
function optionList(values, current = '') { return values.map(v => `<option value="${esc(v)}" ${String(v) === String(current) ? 'selected' : ''}>${esc(v)}</option>`).join(''); }
function field(label, name, value = '', type = 'text', extra = '') { return `<div class="field"><label>${esc(label)}</label><input name="${esc(name)}" type="${esc(type)}" value="${esc(value)}" ${extra}></div>`; }

function stats() {
  const d = state.db.data;
  return [
    { n: d.confederations.length, l: 'Confederations' },
    { n: d.nations.length, l: 'Nations' },
    { n: d.leagues.length, l: 'Leagues' },
    { n: d.clubs.length, l: 'Clubs' },
    { n: d.players.length, l: 'Players' },
    { n: d.competitions.length, l: 'Competitions' }
  ];
}

function go(view) {
  state.view = view;
  resetTransient();
  if (view !== 'structure') resetStructure();
  render();
}

function structureGo(part, value) {
  const order = ['confederation', 'nationId', 'level', 'leagueId', 'clubId'];
  const idx = order.indexOf(part);
  state.structure[part] = value;
  for (let i = idx + 1; i < order.length; i++) state.structure[order[i]] = null;
  resetTransient();
  state.view = 'structure';
  render();
}

function structureRoot() {
  resetTransient();
  resetStructure();
  state.view = 'structure';
  render();
}

function renderBreadcrumbs() {
  if (!state.db) {
    els.breadcrumbs.innerHTML = '<span class="crumb current">Database</span>';
    return;
  }

  const st = state.structure || {};
  const inStructure = state.view === 'structure';
  const items = [{ label: 'Database', structureRoot: inStructure, view: inStructure ? null : 'overview' }];

  if (inStructure) {
    const nation = state.db.data.nations.find(n => String(n.id) === String(st.nationId));
    const league = state.db.data.leagues.find(l => String(l.id) === String(st.leagueId));
    const club = state.db.data.clubs.find(c => String(c.id) === String(st.clubId));
    if (st.confederation) items.push({ label: String(st.confederation).toUpperCase(), structurePart: 'confederation', value: st.confederation });
    if (nation) items.push({ label: nationDisplayName(nation), structurePart: 'nationId', value: nation.id });
    if (st.level != null) items.push({ label: `Level ${st.level}`, structurePart: 'level', value: st.level });
    if (league) items.push({ label: league.name || 'League', structurePart: 'leagueId', value: league.id });
    if (club) items.push({ label: club.name || 'Club', structurePart: 'clubId', value: club.id });
  } else if (state.view !== 'overview') {
    items.push({ label: viewName(state.view) });
  }

  els.breadcrumbs.innerHTML = items.map((item, index) => {
    const last = index === items.length - 1;
    const attrs = item.structureRoot ? 'data-crumb-root="1"' : item.view ? `data-crumb-view="${esc(item.view)}"` : item.structurePart ? `data-crumb-part="${esc(item.structurePart)}" data-crumb-value="${esc(item.value ?? '')}"` : '';
    return `${index ? '<span class="crumb-sep" aria-hidden="true">›</span>' : ''}<button class="crumb ${last ? 'current' : ''}" ${attrs} type="button" ${last ? 'aria-current="page"' : ''}>${esc(item.label)}</button>`;
  }).join('');

  $('[data-crumb-root]', els.breadcrumbs)?.addEventListener('click', structureRoot);
  $$('[data-crumb-view]', els.breadcrumbs).forEach(button => button.addEventListener('click', () => go(button.dataset.crumbView)));
  $$('[data-crumb-part]', els.breadcrumbs).forEach(button => button.addEventListener('click', () => {
    const value = button.dataset.crumbPart === 'level' ? Number(button.dataset.crumbValue) : button.dataset.crumbValue;
    structureGo(button.dataset.crumbPart, value);
  }));
}

function viewName(view) {
  return ({ overview:'Overview',structure:'Structure',players:'Players',competitions:'Competitions',validator:'Validator',settings:'Database Settings',leagueContrib:'Contribute Leagues',playerContrib:'Contribute Players',reviewContrib:'Review Contributions' })[view] || 'Overview';
}

function render() {
  $$('#nav button').forEach(button => button.classList.toggle('active', button.dataset.view === state.view));
  els.main?.classList.toggle('hierarchy-mode', Boolean(state.db && state.view === 'structure'));
  removeSelectionBar();
  if (state.view === 'leagueContrib') { renderContributionLanding('league'); renderBreadcrumbs(); return; }
  if (state.view === 'playerContrib') { renderContributionLanding('player'); renderBreadcrumbs(); return; }
  if (state.view === 'reviewContrib') { renderReviewContributions(); renderBreadcrumbs(); return; }
  if (!state.db) {
    els.title.textContent = 'Overview';
    els.subtitle.textContent = 'Load an official database, import a .kfmdb file or start from scratch.';
    els.actions.innerHTML = '';
    renderBreadcrumbs();
    els.content.innerHTML = `
      <div class="empty-state"><div><div class="symbol">⬡</div><h2>Build a Kreisliga Manager database on desktop</h2>
      <p>Load the official 25/26 or 26/27 data, import a database from your phone, or create a fresh database. Export the result as a game-ready .kfmdb package.</p>
      <div class="empty-actions"><button class="btn primary" data-action="official">Open official database</button><button class="btn" data-action="import">Import .kfmdb</button><button class="btn" data-action="new">New database</button></div></div></div>`;
    bindGlobalActions();
    return;
  }

  els.actions.innerHTML = '';
  if (state.view === 'overview') renderOverview();
  else if (state.view === 'structure') renderStructure();
  else if (state.view === 'players') renderPlayers();
  else if (state.view === 'competitions') renderCompetitions();
  else if (state.view === 'validator') renderValidator();
  else if (state.view === 'settings') renderDatabaseSettings();
  else renderOverview();
  renderBreadcrumbs();
  bindGlobalActions();
  renderContributionBanner();
  renderReviewInspectBanner();
}

function bindGlobalActions() {
  $$('[data-action="official"]').forEach(x => x.addEventListener('click', openOfficial));
  $$('[data-action="import"]').forEach(x => x.addEventListener('click', () => $('#kfmdbInput').click()));
  $$('[data-action="new"]').forEach(x => x.addEventListener('click', newDatabase));
}

function renderOverview() {
  els.title.textContent = 'Overview';
  els.subtitle.textContent = 'Database statistics, metadata and shortcuts.';
  const s = stats();
  els.actions.innerHTML = '<button class="btn" id="overviewValidate" type="button">Run validator</button>';
  els.content.innerHTML = `
    <div class="stats">${s.map(x => `<div class="stat"><strong>${Number(x.n).toLocaleString()}</strong><span>${esc(x.l)}</span></div>`).join('')}</div>
    <div class="overview-grid">
      <div class="card"><h3>Database information</h3><dl class="meta-list">
        <dt>Name</dt><dd>${esc(state.db.manifest.displayName)}</dd><dt>Author</dt><dd>${esc(state.db.manifest.author || '—')}</dd>
        <dt>Version</dt><dd>${esc(state.db.manifest.version || '1.0.0')}</dd><dt>Start date</dt><dd>${esc(state.db.manifest.startDate || '—')}</dd>
        <dt>Database ID</dt><dd class="muted">${esc(state.db.manifest.databaseId)}</dd><dt>Template</dt><dd>${esc(state.db.manifest.templateDatabaseId || 'None')}</dd>
      </dl></div>
      <div class="card"><h3>Quick actions</h3><div class="quick-grid">
        <button data-go="structure"><b>Structure explorer</b><span>Confederations → nations → leagues → clubs</span></button>
        <button data-go="players"><b>Player grid</b><span>Fast Excel-style multi-row data entry</span></button>
        <button data-go="validator"><b>Validator</b><span>Check references and identities</span></button>
        <button id="quickExport"><b>Export .kfmdb</b><span>Install it in the game</span></button>
      </div></div>
    </div>`;
  $('#overviewValidate').addEventListener('click', () => go('validator'));
  $('#quickExport').addEventListener('click', doExport);
  $$('[data-go]').forEach(button => button.addEventListener('click', () => go(button.dataset.go)));
}

function searchToolbar(label, extras = '') {
  return `<div class="toolbar"><div class="search"><input id="searchInput" placeholder="${esc(label)}" value="${esc(state.search)}"></div>${extras}</div>`;
}

function paginate(list, pageSize = state.pageSize) {
  const pages = Math.max(1, Math.ceil(list.length / pageSize));
  state.page = Math.min(state.page, pages);
  const start = (state.page - 1) * pageSize;
  return { rows: list.slice(start, start + pageSize), pages, start, pageSize };
}

function pager(total, pages, start, pageSize = state.pageSize) {
  return `<div class="pager"><span>${total ? `${start + 1}-${Math.min(start + pageSize, total)} / ${total}` : '0 entries'}</span><div class="pager-controls"><button class="btn small" data-page="prev" ${state.page <= 1 ? 'disabled' : ''} type="button">‹</button><span>${state.page} / ${pages}</span><button class="btn small" data-page="next" ${state.page >= pages ? 'disabled' : ''} type="button">›</button></div></div>`;
}

function rerenderKeepingInputFocus(input, inputId, selectionStart, selectionEnd) {
  const shouldRestore = document.activeElement === input;
  render();
  if (!shouldRestore) return;
  const next = document.getElementById(inputId);
  if (!next) return;
  next.focus({ preventScroll: true });
  if (typeof next.setSelectionRange === 'function' && Number.isFinite(selectionStart) && Number.isFinite(selectionEnd)) {
    try { next.setSelectionRange(selectionStart, selectionEnd); } catch (_) {}
  }
}

function bindSearch() {
  const input = $('#searchInput');
  if (input) input.addEventListener('input', () => {
    state.search = input.value; state.page = 1;
    const selectionStart = input.selectionStart;
    const selectionEnd = input.selectionEnd;
    if (state.searchTimer) clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      state.searchTimer = null;
      rerenderKeepingInputFocus(input, 'searchInput', selectionStart, selectionEnd);
    }, 90);
  });
  $$('[data-page]').forEach(button => button.addEventListener('click', () => { state.page += button.dataset.page === 'next' ? 1 : -1; render(); }));
}

function compareTableValues(a, b) {
  const av = a ?? '', bv = b ?? '';
  if (typeof av === 'boolean' || typeof bv === 'boolean') return Number(Boolean(av)) - Number(Boolean(bv));
  if (typeof av === 'number' && typeof bv === 'number' && Number.isFinite(av) && Number.isFinite(bv)) return av - bv;
  const an = Number(av), bn = Number(bv);
  if (av !== '' && bv !== '' && Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  return String(av).localeCompare(String(bv), 'en', { sensitivity: 'base', numeric: true });
}

function sortTableRows(scope, rows, valueForKey) {
  const cfg = state.tableSorts?.[scope];
  if (!cfg?.key) return rows;
  return rows.map((row, index) => ({ row, index })).sort((a, b) => {
    const cmp = compareTableValues(valueForKey(a.row, cfg.key), valueForKey(b.row, cfg.key));
    return cmp ? cmp * (cfg.dir || 1) : a.index - b.index;
  }).map(entry => entry.row);
}

function tableSortHeader(scope, key, label) {
  const cfg = state.tableSorts?.[scope];
  const active = cfg?.key === key;
  const arrow = !active ? '↕' : cfg.dir > 0 ? '↑' : '↓';
  const aria = active ? (cfg.dir > 0 ? 'ascending' : 'descending') : 'none';
  return `<button type="button" class="sort-header ${active ? 'active' : ''}" data-table-sort-scope="${esc(scope)}" data-table-sort-key="${esc(key)}" aria-label="Sort by ${esc(label)}" aria-sort="${aria}"><span>${esc(label)}</span><em>${arrow}</em></button>`;
}

function bindTableSort(scope) {
  $$(`[data-table-sort-scope="${scope}"]`).forEach(button => button.addEventListener('click', event => {
    event.stopPropagation();
    const key = button.dataset.tableSortKey;
    const current = state.tableSorts[scope] || { key: null, dir: 1 };
    state.tableSorts[scope] = current.key === key ? { key, dir: current.dir * -1 } : { key, dir: 1 };
    state.page = 1;
    render();
  }));
}

function confederationCode(c) { return String(c?.ruleId || c?.id || c?.name || c?.displayName || 'FIFA').toUpperCase(); }
function nationForLeague(l) {
  if (l?.nationId) {
    const byId = state.db.data.nations.find(n => String(n.id) === String(l.nationId));
    if (byId) return byId;
  }
  const name = leagueNation(l);
  return state.db.data.nations.find(n => String(n.name) === String(name)) || null;
}
function leaguesForNation(nation) { return state.db.data.leagues.filter(l => String(l.nationId || '') === String(nation.id) || leagueNation(l) === nation.name); }
function clubsForLeague(league) { return dbIndexes().clubsByLeague.get(String(league.id)) || []; }
function playersForClub(club) { return dbIndexes().playersByClub.get(String(club.id)) || []; }

function currentStructureStage() {
  const s = state.structure;
  if (s.clubId) return 'club';
  if (s.leagueId) return 'league';
  if (s.level != null) return 'level';
  if (s.nationId) return 'nation';
  if (s.confederation) return 'confederation';
  return 'root';
}

function renderStructure() {
  const stage = currentStructureStage();
  if (stage === 'root') renderConfederations();
  else if (stage === 'confederation') renderConfederationNations();
  else if (stage === 'nation') renderNationLevels();
  else if (stage === 'level') renderLevelLeagues();
  else if (stage === 'league') renderLeagueClubs();
  else if (stage === 'club') renderClubPlayers();
}

function renderConfederations() {
  const sortScope = 'confederations';
  els.title.textContent = 'Structure';
  els.subtitle.textContent = 'Open a confederation and drill down through the complete football pyramid.';
  els.actions.innerHTML = '<button class="btn primary" id="addConfederation" type="button">＋ Add confederation</button>';
  const known = new Map();
  for (const c of state.db.data.confederations) known.set(confederationCode(c), c);
  for (const n of state.db.data.nations) if (!known.has(String(n.confederation || 'FIFA').toUpperCase())) known.set(String(n.confederation || 'FIFA').toUpperCase(), { id: n.confederation || 'FIFA', ruleId: n.confederation || 'FIFA', name: n.confederation || 'FIFA' });
  const q = state.search.toLowerCase();
  const ix = dbIndexes();
  let list = [...known.values()].filter(c => !q || [c.name, c.displayName, c.ruleId].join(' ').toLowerCase().includes(q)).map(c => {
    const code = confederationCode(c);
    const nations = state.db.data.nations.filter(n => String(n.confederation || 'FIFA').toUpperCase() === code);
    const nationIds = new Set(nations.map(n => String(n.id)));
    const nationNames = new Set(nations.map(n => String(n.name)));
    const leagues = state.db.data.leagues.filter(l => nationIds.has(String(l.nationId || '')) || nationNames.has(leagueNation(l)));
    const leagueIds = new Set(leagues.map(l => String(l.id)));
    const clubs = state.db.data.clubs.filter(club => leagueIds.has(String(club.leagueId || '')));
    let playerCount = 0;
    for (const club of clubs) playerCount += ix.playersByClub.get(String(club.id))?.length || 0;
    return { source: c, code, label: c.displayName || c.name || code, nations: nations.length, leagues: leagues.length, clubs: clubs.length, players: playerCount };
  });
  list = sortTableRows(sortScope, list, (row, key) => ({ confederation: row.label, nations: row.nations, leagues: row.leagues, clubs: row.clubs, players: row.players })[key]);
  const { rows, pages, start } = paginate(list);
  const body = rows.map(row => `<tr class="drill-row" data-open-conf="${esc(row.code)}"><td><div class="entity-cell"><span class="entity-mark">${esc(row.code.slice(0, 3))}</span><div><b>${esc(row.label)}</b><small>${esc(row.code)}</small></div></div></td><td>${row.nations.toLocaleString()}</td><td>${row.leagues.toLocaleString()}</td><td>${row.clubs.toLocaleString()}</td><td>${row.players.toLocaleString()}</td><td><button class="btn small" data-edit-conf="${esc(row.code)}" type="button">Edit</button></td></tr>`).join('');
  els.content.innerHTML = searchToolbar('Search confederation…') + `<div class="table-wrap"><table class="directory-table"><thead><tr><th>${tableSortHeader(sortScope, 'confederation', 'Confederation')}</th><th>${tableSortHeader(sortScope, 'nations', 'Nations')}</th><th>${tableSortHeader(sortScope, 'leagues', 'Leagues')}</th><th>${tableSortHeader(sortScope, 'clubs', 'Clubs')}</th><th>${tableSortHeader(sortScope, 'players', 'Players')}</th><th>Actions</th></tr></thead><tbody>${body}</tbody></table></div>${pager(list.length, pages, start)}`;
  bindSearch();
  bindTableSort(sortScope);
  $('#addConfederation').addEventListener('click', () => editConfederation(null));
  $$('[data-open-conf]').forEach(row => row.addEventListener('click', event => { if (!event.target.closest('button')) structureGo('confederation', row.dataset.openConf); }));
  $$('[data-edit-conf]').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); editConfederation(button.dataset.editConf); }));
}

function editConfederation(code) {
  const existing = state.db.data.confederations.find(c => confederationCode(c) === String(code || '').toUpperCase()) || null;
  modal(existing ? 'Edit confederation' : 'Add confederation', `<div class="form-grid">${field('Display name', 'name', existing?.displayName || existing?.name || '')}${field('Rule / code', 'ruleId', existing?.ruleId || existing?.id || '', 'text', existing ? 'readonly' : '')}</div>`, '<button class="btn" data-cancel type="button">Cancel</button><button class="btn primary" id="saveConf" type="button">Save</button>');
  $('[data-cancel]', els.modal).addEventListener('click', closeModal);
  $('#saveConf').addEventListener('click', () => {
    const name = $('[name="name"]', els.modal).value.trim();
    const ruleId = $('[name="ruleId"]', els.modal).value.trim().toUpperCase();
    if (!name || !ruleId) return toast('Name and rule code are required.', 'error');
    if (existing) { existing.name = name; existing.displayName = name; }
    else state.db.data.confederations.push({ id: ruleId, ruleId, name, displayName: name, databaseId: state.db.manifest.databaseId });
    dirty(); closeModal(); render();
  });
}

function renderConfederationNations() {
  const sortScope = 'nations';
  const code = state.structure.confederation;
  els.title.textContent = code;
  els.subtitle.textContent = 'Choose a nation to open its league levels and football pyramid.';
  els.actions.innerHTML = '<button class="btn primary" id="addNation" type="button">＋ Add nation</button>';
  const q = state.search.toLowerCase();
  let list = state.db.data.nations
    .filter(n => String(n.confederation || 'FIFA').toUpperCase() === String(code).toUpperCase())
    .filter(n => !q || [n.name, nationDisplayName(n), n.region].join(' ').toLowerCase().includes(q))
    .map(n => {
      const leagues = leaguesForNation(n);
      const leagueIds = new Set(leagues.map(l => String(l.id)));
      const clubs = state.db.data.clubs.filter(c => leagueIds.has(String(c.leagueId || '')));
      const playerCount = clubs.reduce((sum, c) => sum + playersForClub(c).length, 0);
      return { ...n, _displayName: nationDisplayName(n) || 'Unnamed nation', _levels: new Set(leagues.map(l => Number(l.level || 1))).size, _leagues: leagues.length, _clubs: clubs.length, _players: playerCount, _points: databaseConfederationPoints(n) };
    });
  list = sortTableRows(sortScope, list, (n, key) => ({ nation: n._displayName, levels: n._levels, leagues: n._leagues, clubs: n._clubs, players: n._players, points: n._points, nationalTeam: n.nationalTeamActive !== false })[key]);
  const { rows, pages, start } = paginate(list);
  const allSelected = Boolean(list.length) && list.every(n => state.selected.has(String(n.id)));
  const body = rows.map(n => {
    const selected = state.selected.has(String(n.id));
    return `<tr class="drill-row ${selected ? 'selected' : ''}" data-open-nation="${esc(n.id)}"><td class="select-col"><input type="checkbox" data-select-entity="${esc(n.id)}" ${selected ? 'checked' : ''}></td><td><div class="entity-cell"><span class="flag-box">${flagHtml(n)}</span><div><b>${esc(n._displayName)}</b><small>${esc(n.region || code)}</small></div></div></td><td>${n._levels}</td><td>${n._leagues}</td><td>${n._clubs}</td><td>${n._players.toLocaleString()}</td><td>${n._points.toFixed(3)}</td><td><span class="pill ${n.nationalTeamActive === false ? '' : 'blue'}">${n.nationalTeamActive === false ? 'Disabled' : 'Active'}</span></td><td><div class="table-actions"><button class="btn small" data-edit-nation="${esc(n.id)}" type="button">Edit</button><button class="btn small danger" data-delete-nation="${esc(n.id)}" type="button">Delete</button></div></td></tr>`;
  }).join('');
  els.content.innerHTML = searchToolbar('Search nation…') + `<div class="table-wrap"><table class="directory-table"><thead><tr><th class="select-col"><input type="checkbox" id="selectAllEntities" ${allSelected ? 'checked' : ''} aria-label="Select all nations"></th><th>${tableSortHeader(sortScope, 'nation', 'Nation')}</th><th>${tableSortHeader(sortScope, 'levels', 'Levels')}</th><th>${tableSortHeader(sortScope, 'leagues', 'Leagues')}</th><th>${tableSortHeader(sortScope, 'clubs', 'Clubs')}</th><th>${tableSortHeader(sortScope, 'players', 'Players')}</th><th>${tableSortHeader(sortScope, 'points', 'Conf. points')}</th><th>${tableSortHeader(sortScope, 'nationalTeam', 'National team')}</th><th>Actions</th></tr></thead><tbody>${body}</tbody></table></div>${pager(list.length, pages, start)}`;
  bindSearch();
  bindTableSort(sortScope);
  bindEntitySelection(list, 'nation');
  $('#addNation').addEventListener('click', () => editNation(null, code));
  $$('[data-open-nation]').forEach(row => row.addEventListener('click', event => { if (!event.target.closest('button,input')) structureGo('nationId', row.dataset.openNation); }));
  $$('[data-edit-nation]').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); editNation(button.dataset.editNation, code); }));
  $$('[data-delete-nation]').forEach(button => button.addEventListener('click', event => {
    event.stopPropagation();
    const nation = state.db.data.nations.find(n => String(n.id) === String(button.dataset.deleteNation));
    if (!nation || !confirm(`Delete ${nationDisplayName(nation)}? Existing leagues may become invalid.`)) return;
    state.db.data.nations = state.db.data.nations.filter(n => String(n.id) !== String(nation.id));
    state.selected.delete(String(nation.id));
    dirty(); render();
  }));
  updateSelectionBar('nation');
}

function renderNationLevels() {
  const sortScope = 'levels';
  const nation = state.db.data.nations.find(n => String(n.id) === String(state.structure.nationId));
  if (!nation) { structureGo('confederation', state.structure.confederation); return; }
  els.title.textContent = nationDisplayName(nation);
  els.subtitle.textContent = 'Select one or more league levels for bulk deletion. Deleting a level also removes its leagues, clubs and players.';
  els.actions.innerHTML = `<button class="btn" id="editNationTop" type="button">Edit nation</button><button class="btn primary" id="addLeagueTop" type="button">＋ Add league</button>`;
  const leagues = leaguesForNation(nation);
  const levels = [...new Set([1, ...leagues.map(l => Number(l.level || 1))])].sort((a, b) => a - b);
  const q = state.search.toLowerCase();
  let visible = levels.filter(level => !q || String(level).includes(q) || leagues.filter(l => Number(l.level || 1) === level).some(l => [l.name, l.association, l.region].join(' ').toLowerCase().includes(q))).map(level => {
    const levelLeagues = leagues.filter(l => Number(l.level || 1) === level);
    const ids = new Set(levelLeagues.map(l => String(l.id)));
    const clubs = state.db.data.clubs.filter(c => ids.has(String(c.leagueId || '')));
    const players = clubs.reduce((sum, c) => sum + playersForClub(c).length, 0);
    const regional = levelLeagues.some(l => l.region || l.association);
    return { id: `LEVEL:${nation.id}:${level}`, level, leagues: levelLeagues.length, clubs: clubs.length, players, structure: regional ? 'Regional' : 'National', regional };
  });
  visible = sortTableRows(sortScope, visible, (row, key) => ({ level: row.level, leagues: row.leagues, clubs: row.clubs, players: row.players, structure: row.structure })[key]);
  const selectable = visible.filter(row => row.leagues > 0);
  const { rows, pages, start } = paginate(visible);
  const allSelected = Boolean(selectable.length) && selectable.every(row => state.selected.has(String(row.id)));
  const body = rows.map(row => {
    const selected = state.selected.has(String(row.id));
    const disabled = row.leagues < 1;
    return `<tr class="drill-row ${selected ? 'selected' : ''}" data-open-level="${row.level}"><td class="select-col"><input type="checkbox" data-select-entity="${esc(row.id)}" ${selected ? 'checked' : ''} ${disabled ? 'disabled' : ''} aria-label="Select League Level ${row.level}"></td><td><div class="entity-cell"><span class="level-badge">${row.level}</span><div><b>League Level ${row.level}</b><small>${row.regional ? 'Regional / association structure' : 'National structure'}</small></div></div></td><td>${row.leagues}</td><td>${row.clubs}</td><td>${row.players.toLocaleString()}</td><td>${row.regional ? '<span class="pill blue">Regional</span>' : '<span class="pill">National</span>'}</td></tr>`;
  }).join('');
  els.content.innerHTML = searchToolbar('Search level or league…') + `<div class="table-wrap"><table class="directory-table"><thead><tr><th class="select-col"><input type="checkbox" id="selectAllEntities" ${allSelected ? 'checked' : ''} ${selectable.length ? '' : 'disabled'} aria-label="Select all league levels"></th><th>${tableSortHeader(sortScope, 'level', 'Level')}</th><th>${tableSortHeader(sortScope, 'leagues', 'Leagues')}</th><th>${tableSortHeader(sortScope, 'clubs', 'Clubs')}</th><th>${tableSortHeader(sortScope, 'players', 'Players')}</th><th>${tableSortHeader(sortScope, 'structure', 'Structure')}</th></tr></thead><tbody>${body}</tbody></table></div>${pager(visible.length, pages, start)}`;
  bindSearch();
  bindTableSort(sortScope);
  bindEntitySelection(selectable, 'level');
  $('#editNationTop').addEventListener('click', () => editNation(nation.id, state.structure.confederation));
  $('#addLeagueTop').addEventListener('click', () => editLeague(null, nation, 1));
  $$('[data-open-level]').forEach(row => row.addEventListener('click', event => { if (!event.target.closest('input')) structureGo('level', Number(row.dataset.openLevel)); }));
  updateSelectionBar('level');
}

function renderLevelLeagues() {
  const sortScope = 'leagues';
  const nation = state.db.data.nations.find(n => String(n.id) === String(state.structure.nationId));
  if (!nation) return structureGo('confederation', state.structure.confederation);
  const level = Number(state.structure.level);
  els.title.textContent = `League Level ${level}`;
  els.subtitle.textContent = `${nationDisplayName(nation)} · open a league to manage clubs.`;
  els.actions.innerHTML = '<button class="btn primary" id="addLeague" type="button">＋ Add league</button>';
  const ix = dbIndexes();
  const q = state.search.toLowerCase();
  let list = leaguesForNation(nation).filter(l => Number(l.level || 1) === level).filter(l => !q || [l.name, l.association, l.region].join(' ').toLowerCase().includes(q)).map(l => ({ ...l, _clubs: ix.clubsByLeague.get(String(l.id))?.length || 0 }));
  list = sortTableRows(sortScope, list, (l, key) => ({ league: l.name || '', clubs: l._clubs, association: l.association || '', region: l.region || '' })[key]);
  const { rows, pages, start } = paginate(list);
  const allSelected = Boolean(list.length) && list.every(l => state.selected.has(String(l.id)));
  const body = rows.map(l => {
    const selected = state.selected.has(String(l.id));
    return `<tr class="drill-row ${selected ? 'selected' : ''}" data-open-league="${esc(l.id)}"><td class="select-col"><input type="checkbox" data-select-entity="${esc(l.id)}" ${selected ? 'checked' : ''}></td><td><div class="entity-cell"><span class="entity-mark league">L${level}</span><div><b>${esc(l.name)}</b><small>${esc(l.association || l.region || nationDisplayName(nation))}</small></div></div></td><td>${l._clubs}</td><td>${esc(l.association || '—')}</td><td>${esc(l.region || '—')}</td><td><div class="table-actions"><button class="btn small" data-edit-league="${esc(l.id)}" type="button">Edit</button><button class="btn small danger" data-delete-league="${esc(l.id)}" type="button">Delete</button></div></td></tr>`;
  }).join('');
  els.content.innerHTML = searchToolbar('Search league, association or region…') + `<div class="table-wrap"><table class="directory-table"><thead><tr><th class="select-col"><input type="checkbox" id="selectAllEntities" ${allSelected ? 'checked' : ''} aria-label="Select all leagues"></th><th>${tableSortHeader(sortScope, 'league', 'League')}</th><th>${tableSortHeader(sortScope, 'clubs', 'Clubs')}</th><th>${tableSortHeader(sortScope, 'association', 'Association')}</th><th>${tableSortHeader(sortScope, 'region', 'Region')}</th><th>Actions</th></tr></thead><tbody>${body || '<tr><td colspan="6"><div class="table-empty">No league exists at this level yet. Use “Add league” to create the first one.</div></td></tr>'}</tbody></table></div>${pager(list.length, pages, start)}`;
  bindSearch();
  bindTableSort(sortScope);
  bindEntitySelection(list, 'league');
  $('#addLeague').addEventListener('click', () => editLeague(null, nation, level));
  $$('[data-open-league]').forEach(row => row.addEventListener('click', event => { if (!event.target.closest('button,input')) structureGo('leagueId', row.dataset.openLeague); }));
  $$('[data-edit-league]').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); editLeague(button.dataset.editLeague, nation, level); }));
  $$('[data-delete-league]').forEach(button => button.addEventListener('click', event => {
    event.stopPropagation();
    const league = state.db.data.leagues.find(l => String(l.id) === String(button.dataset.deleteLeague));
    if (!league) return;
    const impact = cascadeImpactForLeagueIds(new Set([String(league.id)]));
    if (!confirm(`Delete ${league.name}?\n\nThis also permanently removes ${impact.clubs.toLocaleString()} club${impact.clubs === 1 ? '' : 's'} and ${impact.players.toLocaleString()} player${impact.players === 1 ? '' : 's'} from this league.`)) return;
    const removed = cascadeDeleteLeagueIds(new Set([String(league.id)]));
    state.selected.delete(String(league.id));
    dirty(); render();
    toast(cascadeDeleteMessage(removed));
  }));
  updateSelectionBar('league');
}

function makeClubEditor(source, league) {
  const editorId = source?.id || makeId('CLUB');
  const draft = source ? structuredClone(source) : {
    id: editorId, clubId: editorId, databaseId: state.db.manifest.databaseId,
    name: '', shortName: '', rating: 50, stadium: '', mitglieder: 0, region: '',
    primarycolor: '#1e9ed2', secondarycolor: '#0b2235',
    primaryColor: '#1e9ed2', secondaryColor: '#0b2235', additionalPlayerGeneration: 'auto',
    leagueId: league.id, league: league.name, level: Number(league.level || 1), databaseNation: leagueNation(league)
  };
  return {
    id: editorId,
    sourceId: source?.id || null,
    isNew: !source,
    leagueId: league.id,
    draft,
    pendingLogoFile: null,
    pendingLogoUrl: ''
  };
}

function startClubRowEdit(id, league) {
  if (!league) return;
  const source = id ? state.db.data.clubs.find(c => String(c.id) === String(id)) : null;
  if (source) {
    const existingEditor = state.clubEditors.find(editor => String(editor.sourceId) === String(source.id));
    if (existingEditor) {
      render();
      requestAnimationFrame(() => {
        const row = $$('[data-club-editor-row]').find(node => String(node.dataset.clubEditorRow) === String(existingEditor.id));
        row?.querySelector('[data-club-field="name"]')?.focus();
      });
      return;
    }
  }
  const editor = makeClubEditor(source, league);
  state.clubEditors.unshift(editor);
  if (!source) { state.search = ''; state.page = 1; }
  render();
  requestAnimationFrame(() => {
    const row = $$('[data-club-editor-row]').find(node => String(node.dataset.clubEditorRow) === String(editor.id));
    row?.querySelector('[data-club-field="name"]')?.focus();
  });
}

function startClubRowBatch(count, league) {
  if (!league) return;
  const amount = Math.max(1, Math.min(50, Number(count) || 1));
  const editors = Array.from({ length: amount }, () => makeClubEditor(null, league));
  state.clubEditors.unshift(...editors);
  state.search = '';
  state.page = 1;
  render();
  requestAnimationFrame(() => {
    const row = $$('[data-club-editor-row]').find(node => String(node.dataset.clubEditorRow) === String(editors[0]?.id));
    row?.querySelector('[data-club-field="name"]')?.focus();
  });
  toast(`${amount} editable club rows added. Save each row when it is ready.`);
}

function clubRowLogoHtml(editor) {
  if (editor?.pendingLogoUrl) {
    const initials = String(editor.draft?.shortName || editor.draft?.name || '?').replace(/[^A-Za-z0-9ÄÖÜäöü]/g, '').slice(0, 2).toUpperCase() || '?';
    return `<span class="club-logo-box club-grid-logo-preview"><span class="club-logo-initials">${esc(initials)}</span><img src="${esc(editor.pendingLogoUrl)}" alt="" decoding="async"></span>`;
  }
  return clubLogoHtml(editor?.draft, false);
}

function clubEditRowHtml(editor, league) {
  if (!editor) return '';
  const d = editor.draft;
  const clubPlayers = editor.isNew ? [] : playersForClub(d);
  const players = clubPlayers.length;
  const automaticRating = calculateAutomaticClubRating(clubPlayers);
  if (automaticRating != null) d.rating = automaticRating;
  const primary = String(d.primarycolor || d.primaryColor || '#1e9ed2');
  const secondary = String(d.secondarycolor || d.secondaryColor || '#0b2235');
  const generationMode = additionalPlayerGenerationMode(d);
  const generationLabel = generationMode==='auto' ? (players>=ADDITIONAL_PLAYER_AUTO_THRESHOLD ? `Auto → no extras (${players})` : `Auto → fill (${players}/${ADDITIONAL_PLAYER_AUTO_THRESHOLD})`) : generationMode==='off' ? 'Database players only' : 'Always fill squad';
  return `<tr class="club-edit-row" data-club-editor-row="${esc(editor.id)}">
    <td class="select-col"><span class="club-edit-dot" title="Unsaved / editing">●</span></td>
    <td class="club-logo-col"><div class="club-grid-logo-editor">${clubRowLogoHtml(editor)}<button class="grid-logo-upload" data-club-logo-upload type="button" title="Upload team logo">＋</button></div></td>
    <td><input class="club-grid-input" data-club-field="name" value="${esc(d.name || '')}" placeholder="Club name"></td>
    <td><input class="club-grid-input" data-club-field="shortName" value="${esc(d.shortName || '')}" placeholder="Short"></td>
    <td><input class="club-grid-input numeric" data-club-field="rating" type="number" min="0" max="100" step="0.01" value="${esc(d.rating ?? 50)}" ${automaticRating != null ? 'disabled' : ''} title="${automaticRating != null ? `Automatic: average of the strongest ${ADDITIONAL_PLAYER_AUTO_THRESHOLD} player OVRs` : `Manual until ${ADDITIONAL_PLAYER_AUTO_THRESHOLD} rated players exist`}"></td>
    <td class="club-readonly-number">${players}</td>
    <td><select class="club-grid-select" data-club-field="additionalPlayerGeneration" title="${esc(generationLabel)}"><option value="auto" ${generationMode==='auto'?'selected':''}>${esc(generationLabel)}</option><option value="always" ${generationMode==='always'?'selected':''}>Always fill squad</option><option value="off" ${generationMode==='off'?'selected':''}>Database players only</option></select></td>
    <td><input class="club-grid-input" data-club-field="stadium" value="${esc(d.stadium || '')}" placeholder="Stadium"></td>
    <td><input class="club-grid-input numeric" data-club-field="mitglieder" type="number" min="0" step="1" value="${esc(d.mitglieder ?? 0)}"></td>
    <td><input class="club-grid-input" data-club-field="region" value="${esc(d.region || '')}" placeholder="Region"></td>
    <td class="club-color-cell"><input class="club-grid-color" data-club-field="primarycolor" type="color" value="${esc(primary)}" title="Primary colour"></td>
    <td class="club-color-cell"><input class="club-grid-color" data-club-field="secondarycolor" type="color" value="${esc(secondary)}" title="Secondary colour"></td>
    <td><div class="club-grid-save-actions"><button class="btn small primary" data-save-club-row type="button">Save</button><button class="btn small" data-cancel-club-row type="button">Cancel</button></div></td>
  </tr>`;
}

function applyClubEditorField(input) {
  const row = input.closest('[data-club-editor-row]');
  const editor = findClubEditor(row?.dataset.clubEditorRow);
  if (!editor) return;
  const key = input.dataset.clubField;
  let value = input.value;
  if (key === 'rating' || key === 'mitglieder') value = Number(value) || 0;
  editor.draft[key] = value;
  if (key === 'primarycolor') editor.draft.primaryColor = value;
  if (key === 'secondarycolor') editor.draft.secondaryColor = value;
}

function saveClubRowEdit(editorId, league) {
  const editor = findClubEditor(editorId);
  if (!editor) return;
  const row = $$('[data-club-editor-row]').find(node => String(node.dataset.clubEditorRow) === String(editor.id));
  $$('[data-club-field]', row || document).forEach(applyClubEditorField);
  const d = editor.draft;
  if (!String(d.name || '').trim()) return toast('Club name is required.', 'error');
  d.name = String(d.name).trim(); d.shortName = String(d.shortName || '').trim();
  d.stadium = String(d.stadium || '').trim(); d.region = String(d.region || '').trim();
  d.rating = Number(d.rating || 0); d.mitglieder = Number(d.mitglieder || 0);
  d.additionalPlayerGeneration = ['auto','always','off'].includes(String(d.additionalPlayerGeneration||'')) ? String(d.additionalPlayerGeneration) : 'auto';
  d.leagueId = league.id; d.league = league.name; d.level = Number(league.level || 1); d.databaseNation = leagueNation(league);
  d.primaryColor = d.primarycolor || d.primaryColor || '#1e9ed2';
  d.secondaryColor = d.secondarycolor || d.secondaryColor || '#0b2235';
  d.primarycolor = d.primaryColor; d.secondarycolor = d.secondaryColor;

  const source = editor.sourceId ? state.db.data.clubs.find(c => String(c.id) === String(editor.sourceId)) : null;
  const oldName = source?.name || '';
  if (editor.pendingLogoFile) {
    const oldAsset = String(source?.logoAsset || d.logoAsset || '').trim();
    const extRaw = (editor.pendingLogoFile.name.split('.').pop() || 'png').toLowerCase();
    const ext = ['png','jpg','jpeg','webp'].includes(extRaw) ? extRaw : 'png';
    const path = `assets/club-logos/${String(d.id).replace(/[^a-z0-9_-]/gi, '_')}.${ext}`;
    if (oldAsset && oldAsset !== path && state.db.assets.has(oldAsset)) state.db.assets.delete(oldAsset);
    if (oldAsset && oldAsset !== path && state.objectUrls.has(oldAsset)) {
      try { URL.revokeObjectURL(state.objectUrls.get(oldAsset)); } catch (_) {}
      state.objectUrls.delete(oldAsset);
    }
    state.db.assets.set(path, editor.pendingLogoFile);
    d.logoAsset = path;
  }
  if (source) Object.assign(source, d);
  else state.db.data.clubs.unshift(d);
  if (oldName && oldName !== d.name) {
    for (const p of state.db.data.players) if (String(p.clubId || '') === String(d.id)) p.clubName = d.name;
  }
  ensureIds(state.db.data, state.db.manifest.databaseId);
  disposeClubEditor(editor.id);
  dirty(); render();
  const remaining = clubEditorsForLeague(league.id).length;
  toast(`${source ? 'Club updated.' : 'Club added.'}${remaining ? ` ${remaining} unsaved club row${remaining === 1 ? '' : 's'} remaining.` : ''}`);
}

function renderLeagueClubs() {
  const sortScope = 'clubs';
  const league = state.db.data.leagues.find(l => String(l.id) === String(state.structure.leagueId));
  if (!league) return structureGo('level', state.structure.level);
  const editors = clubEditorsForLeague(league.id);
  els.title.textContent = league.name;
  els.subtitle.textContent = 'Select clubs for bulk actions, edit clubs directly in the table, or open one to manage its squad.';
  els.actions.innerHTML = `<button class="btn" id="editLeagueTop" type="button">Edit league</button><button class="btn" id="add10Clubs" type="button">＋ 10 clubs</button><button class="btn primary" id="addClub" type="button">＋ Add club</button>`;
  const leagueClubIds = new Set(clubsForLeague(league).map(c => String(c.id)));
  refreshAutomaticClubRatings(leagueClubIds,{markDirty:true});
  const ix = dbIndexes();
  const q = state.search.toLowerCase();
  const editingSourceIds = new Set(editors.map(editor => String(editor.sourceId || '')).filter(Boolean));
  let list = clubsForLeague(league).filter(c => !q || [c.name, c.shortName, c.region, c.stadium].join(' ').toLowerCase().includes(q)).map(c => ({ ...c, _players: ix.playersByClub.get(String(c.id))?.length || 0 }));
  if (editingSourceIds.size) list = list.filter(c => !editingSourceIds.has(String(c.id)));
  list = sortTableRows(sortScope, list, (c, key) => ({
    club: c.name || '', shortName: c.shortName || '', rating: Number(c.rating ?? 50), players: c._players,
    generation: additionalPlayerGenerationMode(c), stadium: c.stadium || '', members: Number(c.mitglieder ?? 0), region: c.region || '',
    primary: c.primarycolor || c.primaryColor || '', secondary: c.secondarycolor || c.secondaryColor || ''
  })[key]);
  const { rows, pages, start } = paginate(list);
  const allSelected = Boolean(list.length) && list.every(c => state.selected.has(String(c.id)));
  const normalRows = rows.map(c => {
    const selected = state.selected.has(String(c.id));
    const primary = String(c.primarycolor || c.primaryColor || '#1e9ed2');
    const secondary = String(c.secondarycolor || c.secondaryColor || '#0b2235');
    return `<tr class="drill-row ${selected ? 'selected' : ''}" data-open-club="${esc(c.id)}">
      <td class="select-col"><input type="checkbox" data-select-entity="${esc(c.id)}" ${selected ? 'checked' : ''}></td>
      <td class="club-logo-col">${clubLogoHtml(c, true)}</td>
      <td><div class="club-name-cell"><b>${esc(c.name)}</b></div></td>
      <td>${esc(c.shortName || '—')}</td>
      <td><span class="rating ${ratingClass(c.rating)}">${esc(Number(c.rating ?? 50).toFixed(1))}</span></td>
      <td>${c._players}</td>
      <td><span class="pill ${shouldGenerateAdditionalPlayers(c,c._players)?'':'blue'}" title="Auto stops additional generation once ${ADDITIONAL_PLAYER_AUTO_THRESHOLD} database players exist.">${esc(additionalPlayerGenerationMode(c)==='auto' ? (c._players>=ADDITIONAL_PLAYER_AUTO_THRESHOLD?'Auto · no extras':'Auto · fill') : additionalPlayerGenerationMode(c)==='off'?'DB only':'Always fill')}</span></td>
      <td class="truncate-cell" title="${esc(c.stadium || '')}">${esc(c.stadium || '—')}</td>
      <td>${Number(c.mitglieder ?? 0).toLocaleString()}</td>
      <td class="truncate-cell" title="${esc(c.region || '')}">${esc(c.region || '—')}</td>
      <td class="club-color-cell"><span class="club-color-swatch" style="--swatch:${esc(primary)}" title="${esc(primary)}"></span></td>
      <td class="club-color-cell"><span class="club-color-swatch" style="--swatch:${esc(secondary)}" title="${esc(secondary)}"></span></td>
      <td><div class="table-actions club-row-actions"><button class="btn small" data-edit-club="${esc(c.id)}" type="button">Edit</button><button class="btn small danger" data-delete-club="${esc(c.id)}" type="button">Delete</button></div></td>
    </tr>`;
  }).join('');
  const editRows = editors.map(editor => clubEditRowHtml(editor, league)).join('');
  const body = editRows + normalRows;
  const clubCols = `<colgroup><col class="club-col-select"><col class="club-col-logo"><col class="club-col-name"><col class="club-col-short"><col class="club-col-rating"><col class="club-col-players"><col class="club-col-generation"><col class="club-col-stadium"><col class="club-col-members"><col class="club-col-region"><col class="club-col-color"><col class="club-col-color"><col class="club-col-actions"></colgroup>`;
  const editNote = editors.length
    ? `<span class="grid-note club-draft-note"><b>${editors.length}</b> unsaved club row${editors.length === 1 ? '' : 's'} · each row stays editable until you save or cancel it.</span>`
    : '<span class="grid-note">Add or edit clubs directly in the table.</span>';
  els.content.innerHTML = searchToolbar('Search club, stadium or region…', editNote) + `<div class="table-wrap club-grid"><table class="directory-table">${clubCols}<thead><tr><th class="select-col"><input type="checkbox" id="selectAllEntities" ${allSelected ? 'checked' : ''} aria-label="Select all clubs"></th><th>Logo</th><th>${tableSortHeader(sortScope, 'club', 'Club')}</th><th>${tableSortHeader(sortScope, 'shortName', 'Short')}</th><th>${tableSortHeader(sortScope, 'rating', 'Rating')}</th><th>${tableSortHeader(sortScope, 'players', 'Players')}</th><th>${tableSortHeader(sortScope, 'generation', 'Additional players')}</th><th>${tableSortHeader(sortScope, 'stadium', 'Stadium')}</th><th>${tableSortHeader(sortScope, 'members', 'Members')}</th><th>${tableSortHeader(sortScope, 'region', 'Region')}</th><th>${tableSortHeader(sortScope, 'primary', 'Primary')}</th><th>${tableSortHeader(sortScope, 'secondary', 'Secondary')}</th><th>Actions</th></tr></thead><tbody>${body || '<tr><td colspan="13"><div class="table-empty">No clubs yet. Use “Add club” or “10 clubs” to create editable rows.</div></td></tr>'}</tbody></table></div>${pager(list.length, pages, start)}`;
  bindSearch();
  bindTableSort(sortScope);
  bindEntitySelection(list, 'club');
  $('#editLeagueTop').addEventListener('click', () => editLeague(league.id, nationForLeague(league), league.level));
  $('#addClub').addEventListener('click', () => startClubRowEdit(null, league));
  $('#add10Clubs').addEventListener('click', () => startClubRowBatch(10, league));
  $$('[data-open-club]').forEach(row => row.addEventListener('click', event => { if (!event.target.closest('button,input')) structureGo('clubId', row.dataset.openClub); }));
  $$('[data-edit-club]').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); startClubRowEdit(button.dataset.editClub, league); }));
  $$('[data-delete-club]').forEach(button => button.addEventListener('click', event => {
    event.stopPropagation();
    const club = state.db.data.clubs.find(c => String(c.id) === String(button.dataset.deleteClub));
    if (!club || !confirm(`Delete ${club.name}? Its players will become free agents.`)) return;
    state.db.data.clubs = state.db.data.clubs.filter(c => String(c.id) !== String(club.id));
    for (const p of state.db.data.players) if (String(p.clubId) === String(club.id)) { p.clubId = ''; p.clubName = ''; }
    state.selected.delete(String(club.id));
    dirty(); render();
  }));
  $$('[data-club-editor-row]').forEach(editorRow => {
    const editorId = editorRow.dataset.clubEditorRow;
    editorRow.addEventListener('input', event => { const input = event.target.closest('[data-club-field]'); if (input) applyClubEditorField(input); });
    editorRow.addEventListener('change', event => { const input = event.target.closest('[data-club-field]'); if (input) applyClubEditorField(input); });
    $('[data-club-logo-upload]', editorRow)?.addEventListener('click', () => { state.imageTarget = { type: 'club-row', id: editorId }; $('#imageInput').click(); });
    $('[data-save-club-row]', editorRow)?.addEventListener('click', () => saveClubRowEdit(editorId, league));
    $('[data-cancel-club-row]', editorRow)?.addEventListener('click', () => { disposeClubEditor(editorId); render(); });
  });
  updateSelectionBar('club');
}

function renderClubPlayers() {
  const club = state.db.data.clubs.find(c => String(c.id) === String(state.structure.clubId));
  if (!club) return structureGo('leagueId', state.structure.leagueId);
  els.title.textContent = club.name;
  els.subtitle.textContent = 'Spreadsheet squad editor. Paste rows from Excel or Google Sheets and edit multiple players quickly.';
  els.actions.innerHTML = `<button class="btn" id="editClubTop" type="button">Edit club</button><button class="btn" id="add20" type="button">＋ 20 rows</button><button class="btn primary" id="addPlayer" type="button">＋ Add player</button>`;
  renderPlayerGrid(playersForClub(club), { club, structureMode: true });
  $('#editClubTop')?.addEventListener('click', () => {
    const league = state.db.data.leagues.find(l => String(l.id) === String(state.structure.leagueId));
    if (!league) return;
    state.structure.clubId = null;
    resetTransient();
    startClubRowEdit(club.id, league);
  });
}

function editNation(id, confederationCodeValue) {
  const n = state.db.data.nations.find(x => String(x.id) === String(id)) || null;
  state.pendingNationFlag = null;
  const currentFlag = flagHtml(n || { name: '' }, true);
  const currentWeb = n?.flagWebAsset || '';
  const confederations = [...(state.db.data.confederations || [])].sort((a, b) => String(a.displayName || a.name || confederationCode(a)).localeCompare(String(b.displayName || b.name || confederationCode(b)), 'en', { sensitivity: 'base' }));
  const currentConfCode = String(n?.confederation || confederationCodeValue || 'UEFA').toUpperCase();
  const confederationOptions = confederations.map(c => {
    const code = confederationCode(c);
    const selected = [c.id, c.ruleId, code].some(v => String(v || '').toUpperCase() === currentConfCode) ? 'selected' : '';
    return `<option value="${esc(c.id || c.ruleId || code)}" ${selected}>${esc(c.displayName || c.name || code)} (${esc(code)})</option>`;
  }).join('');
  modal(n ? 'Edit nation' : 'Add nation', `
    <div class="flag-editor-head"><div class="flag-preview-large" id="nationFlagPreview">${currentFlag}</div><div><b>${esc(n ? nationDisplayName(n) : 'New nation')}</b><span>${n ? `Internal game value: ${esc(n.name)} · ` : ''}The flag and English display name are resolved without changing the internal save value.</span></div></div>
    <div class="form-grid">
      ${field('Nation name', 'name', n?.name || '')}
      ${field('Short name', 'shortName', n?.shortName || '')}
      <div class="field"><label>Confederation</label><select name="confederationRef">${confederationOptions}</select><small class="field-help">Choose from the confederations that exist in this database.</small></div>
      ${field('Country key / ISO', 'countryKey', n?.countryKey || n?.iso || '')}
      ${field('Region', 'region', n?.region || '')}
      ${field('Team rating', 'team_rating', n?.team_rating ?? 50, 'number', 'step="0.1" min="0" max="100"')}
      ${field('Confederation points', 'confederationPoints', n ? databaseConfederationPoints(n) : '', 'number', 'step="0.001" min="0"')}
      <div class="field full national-team-toggle"><label class="checkbox-card"><input id="nationalTeamActive" name="nationalTeamActive" type="checkbox" ${n?.nationalTeamActive === false ? '' : 'checked'}><span><b>Create / enable national team</b><small>The national team is generated from this nation by the game. No separate team object is required.</small></span></label></div>
      <div class="field full"><label>Flag library</label><select id="flagSelect"><option value="">Automatic / no website flag</option>${state.flags.map(f => `<option value="${esc(f.file)}" data-key="${esc(f.key)}" ${currentWeb === f.file ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select><small class="field-help">Reusable flags are listed from /assets/flags/flags.json.</small></div>
      <div class="field full"><label>Custom flag</label><div class="inline-actions"><button class="btn" id="uploadFlag" type="button">Upload custom flag</button><button class="btn ghost" id="clearFlag" type="button">Clear flag</button></div><small class="field-help">Selected/uploaded flags are embedded into the exported .kfmdb, so the package remains portable.</small></div>
    </div>`, '<button class="btn" data-cancel type="button">Cancel</button><button class="btn primary" id="saveNation" type="button">Save nation</button>', 'nation-modal');
  $('[data-cancel]', els.modal).addEventListener('click', closeModal);
  $('#flagSelect').addEventListener('change', event => {
    const option = event.target.selectedOptions[0];
    const file = event.target.value;
    if (!file) {
      state.pendingNationFlag = { type: 'clear' };
      $('#nationFlagPreview').innerHTML = '<span class="flag-empty">—</span>';
      return;
    }
    state.pendingNationFlag = { type: 'website', file, key: option?.dataset?.key || '' };
    $('#nationFlagPreview').innerHTML = `<img class="nation-flag large" src="${esc(flagWebsiteUrl(file))}" alt="">`;
  });
  $('#uploadFlag').addEventListener('click', () => { state.flagTarget = { nationId: n?.id || null, pending: true }; $('#flagInput').click(); });
  $('#clearFlag').addEventListener('click', () => {
    state.pendingNationFlag = { type: 'clear' };
    $('#flagSelect').value = '';
    $('#nationFlagPreview').innerHTML = '<span class="flag-empty">—</span>';
  });
  $('#saveNation').addEventListener('click', async () => {
    const form = $('.modal', els.modal);
    const values = Object.fromEntries($$('[name]', form).map(input => [input.name, input.value]));
    if (!values.name.trim()) return toast('Nation name is required.', 'error');
    const idValue = n?.id || makeId('NATION');
    const target = n || { id: idValue, nationId: idValue, databaseId: state.db.manifest.databaseId };
    target.name = values.name.trim();
    target.shortName = values.shortName.trim();
    const selectedConf = state.db.data.confederations.find(c => String(c.id || c.ruleId) === String(values.confederationRef)) || state.db.data.confederations.find(c => confederationCode(c) === String(values.confederationRef || '').toUpperCase());
    if (!selectedConf) return toast('Please choose a valid confederation.', 'error');
    target.confederationId = selectedConf.id || selectedConf.ruleId;
    target.confederation = selectedConf.ruleId || selectedConf.id || confederationCode(selectedConf);
    target.countryKey = values.countryKey.trim();
    target.region = values.region.trim();
    target.team_rating = Number(values.team_rating || 0);
    if (String(values.confederationPoints || '').trim() !== '') {
      const points = Math.max(0, Number(values.confederationPoints) || 0);
      target.confederationPoints = points;
      target.confederation_points = points;
    } else {
      delete target.confederationPoints;
      delete target.confederation_points;
    }
    target.nationalTeamActive = Boolean($('#nationalTeamActive', form)?.checked);
    if (!n) state.db.data.nations.push(target);
    await applyPendingNationFlag(target);
    ensureIds(state.db.data, state.db.manifest.databaseId);
    dirty(); closeModal(); render();
  });
}

async function applyPendingNationFlag(nation) {
  const pending = state.pendingNationFlag;
  state.pendingNationFlag = null;
  if (!pending) return;
  if (pending.type === 'clear') {
    const old = String(nation.flagAsset || '').trim();
    if (old && state.db.assets.has(old)) state.db.assets.delete(old);
    delete nation.flagAsset; delete nation.flagWebAsset; delete nation.flagKey;
    return;
  }
  let blob, ext, webFile = '';
  if (pending.type === 'upload') {
    blob = pending.file;
    ext = (pending.file.name.split('.').pop() || 'webp').toLowerCase();
  } else if (pending.type === 'website') {
    const response = await fetch(flagWebsiteUrl(pending.file));
    if (!response.ok) throw new Error(`Could not load selected flag (HTTP ${response.status})`);
    const sourceBlob = await response.blob();
    const optimized = await optimizeImageFile(sourceBlob, 'flag', pending.file || 'flag');
    blob = optimized.file;
    ext = optimized.ext;
    webFile = pending.file;
  }
  const oldAsset = String(nation.flagAsset || '').trim();
  const path = `assets/flags/${String(nation.id).replace(/[^a-z0-9_-]/gi, '_')}.${ext}`;
  if (oldAsset && oldAsset !== path && state.db.assets.has(oldAsset)) state.db.assets.delete(oldAsset);
  state.db.assets.set(path, blob);
  nation.flagAsset = path;
  if (webFile) nation.flagWebAsset = webFile; else delete nation.flagWebAsset;
  if (pending.key) nation.flagKey = pending.key; else delete nation.flagKey;
}

function editLeague(id, nation, level) {
  const l = state.db.data.leagues.find(x => String(x.id) === String(id)) || null;
  modal(l ? 'Edit league' : 'Add league', `<div class="form-grid">${field('League name', 'name', l?.name || '')}${field('Level', 'level', l?.level ?? level ?? 1, 'number', 'min="1"')}${field('Association', 'association', l?.association || '')}${field('Region', 'region', l?.region || '')}<div class="field full"><label>Nation</label><select name="nationId">${state.db.data.nations.slice().sort((a,b)=>nationDisplayName(a).localeCompare(nationDisplayName(b),'en')).map(n => `<option value="${esc(n.id)}" ${String(l?.nationId || nation?.id) === String(n.id) ? 'selected' : ''}>${esc(nationDisplayName(n))}</option>`).join('')}</select></div></div>`, '<button class="btn" data-cancel type="button">Cancel</button><button class="btn primary" id="saveLeague" type="button">Save league</button>');
  $('[data-cancel]', els.modal).addEventListener('click', closeModal);
  $('#saveLeague').addEventListener('click', () => {
    const values = Object.fromEntries($$('[name]', els.modal).map(input => [input.name, input.value]));
    const targetNation = state.db.data.nations.find(n => String(n.id) === String(values.nationId));
    if (!values.name.trim() || !targetNation) return toast('League name and nation are required.', 'error');
    const target = l || { id: makeId('LEAGUE'), leagueId: makeId('LEAGUE'), databaseId: state.db.manifest.databaseId };
    const oldName = target.name;
    target.name = values.name.trim();
    target.level = Math.max(1, Number(values.level || 1));
    target.association = values.association.trim();
    target.region = values.region.trim();
    target.nationId = targetNation.id;
    target.country = targetNation.name;
    target.databaseNation = targetNation.name;
    if (!l) state.db.data.leagues.push(target);
    if (oldName && oldName !== target.name) for (const c of state.db.data.clubs) if (String(c.leagueId) === String(target.id)) c.league = target.name;
    ensureIds(state.db.data, state.db.manifest.databaseId);
    dirty(); closeModal(); render();
  });
}

function flagAssetUrl(path) {
  if (!path) return '';
  if (state.objectUrls.has(path)) return state.objectUrls.get(path);
  const blob = state.db?.assets?.get(path);
  if (!blob) return '';
  const url = URL.createObjectURL(blob);
  state.objectUrls.set(path, url);
  return url;
}

function websiteAssetUrl(path) {
  const raw = String(path || '').trim();
  if (!raw) return '';
  if (/^(?:https?:)?\/\//i.test(raw) || raw.startsWith('data:') || raw.startsWith('blob:')) return raw;
  return new URL(`../${raw.replace(/^\/+/, '')}`, window.location.href).href;
}

function clubLogoUrl(club) {
  if (!club) return '';
  const packaged = flagAssetUrl(club.logoAsset);
  if (packaged) return packaged;
  const direct = String(club.logoCdn || club.logoUrl || club.logo || '').trim();
  if (direct) return websiteAssetUrl(direct);
  const asset = String(club.logoAsset || '').trim();
  if (asset) return websiteAssetUrl(asset);
  const sourceId = String(club.sourceClubId || club.id || club.clubId || '').trim().replace(/\.(png|webp|jpe?g)$/i, '');
  return sourceId ? websiteAssetUrl(`assets/logos/${sourceId}.png`) : '';
}

function clubLogoHtml(club, compact = false) {
  const initials = String(club?.shortName || club?.name || '?').replace(/[^A-Za-z0-9ÄÖÜäöü]/g, '').slice(0, 2).toUpperCase() || '?';
  const src = clubLogoUrl(club);
  return `<span class="club-logo-box ${compact ? 'compact' : ''}"><span class="club-logo-initials">${esc(initials)}</span>${src ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}</span>`;
}

function flagWebsiteUrl(file) { return new URL(`../assets/flags/${String(file).replace(/^\/+/, '')}`, window.location.href).href; }

function normalizeFlagFile(value) {
  let file = String(value || '').trim().replace(/^assets\/flags\//i, '').replace(/^\/+/, '');
  if (file && !/\.[a-z0-9]{2,5}$/i.test(file)) file += '.png';
  return file;
}

function flagLookupKey(value) {
  return String(value || '')
    .trim().toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}


const GAME_NATION_TRANSLATIONS = Object.freeze({
  "afghanistan": "Afghanistan",
  "agypten": "Egypt",
  "albanien": "Albania",
  "algerien": "Algeria",
  "andorra": "Andorra",
  "angola": "Angola",
  "antigua_und_barbuda": "Antigua and Barbuda",
  "argentinien": "Argentina",
  "armenien": "Armenia",
  "aruba": "Aruba",
  "aserbaidschan": "Azerbaijan",
  "athiopien": "Ethiopia",
  "australien": "Australia",
  "bahrain": "Bahrain",
  "bangladesch": "Bangladesh",
  "barbados": "Barbados",
  "belarus": "Belarus",
  "belgien": "Belgium",
  "benin": "Benin",
  "bermuda": "Bermuda",
  "bhutan": "Bhutan",
  "bolivien": "Bolivia",
  "bonaire": "Bonaire",
  "bosnien_und_herzegowina": "Bosnia and Herzegovina",
  "botswana": "Botswana",
  "brasilien": "Brazil",
  "brunei": "Brunei",
  "bulgarien": "Bulgaria",
  "burkina_faso": "Burkina Faso",
  "burundi": "Burundi",
  "chile": "Chile",
  "china": "China",
  "costa_rica": "Costa Rica",
  "curacao": "Curaçao",
  "danemark": "Denmark",
  "demokratische_republik_kongo": "Democratic Republic of the Congo",
  "deutschland": "Germany",
  "dominikanische_republik": "Dominican Republic",
  "dschibuti": "Djibouti",
  "ecuador": "Ecuador",
  "el_salvador": "El Salvador",
  "elfenbeinkuste": "Ivory Coast",
  "england": "England",
  "eritrea": "Eritrea",
  "estland": "Estonia",
  "eswatini": "Eswatini",
  "faroer_inseln": "Faroe Islands",
  "fidschi": "Fiji",
  "finnland": "Finland",
  "frankreich": "France",
  "gabun": "Gabon",
  "gambia": "Gambia",
  "georgien": "Georgia",
  "ghana": "Ghana",
  "gibraltar": "Gibraltar",
  "grenada": "Grenada",
  "griechenland": "Greece",
  "guinea": "Guinea",
  "guinea_bissau": "Guinea-Bissau",
  "guyana": "Guyana",
  "haiti": "Haiti",
  "honduras": "Honduras",
  "hongkong": "Hong Kong",
  "indien": "India",
  "indonesien": "Indonesia",
  "irak": "Iraq",
  "iran": "Iran",
  "irland": "Ireland",
  "island": "Iceland",
  "israel": "Israel",
  "italien": "Italy",
  "jamaika": "Jamaica",
  "japan": "Japan",
  "jemen": "Yemen",
  "jordanien": "Jordan",
  "kambodscha": "Cambodia",
  "kamerun": "Cameroon",
  "kanada": "Canada",
  "kap_verde": "Cape Verde",
  "kasachstan": "Kazakhstan",
  "katar": "Qatar",
  "kenia": "Kenya",
  "kirgisistan": "Kyrgyzstan",
  "kolumbien": "Colombia",
  "komoren": "Comoros",
  "kosovo": "Kosovo",
  "kroatien": "Croatia",
  "kuba": "Cuba",
  "kuwait": "Kuwait",
  "laos": "Laos",
  "lesotho": "Lesotho",
  "lettland": "Latvia",
  "libanon": "Lebanon",
  "liberia": "Liberia",
  "libyen": "Libya",
  "litauen": "Lithuania",
  "luxemburg": "Luxembourg",
  "macau": "Macau",
  "madagaskar": "Madagascar",
  "malawi": "Malawi",
  "malaysia": "Malaysia",
  "malediven": "Maldives",
  "mali": "Mali",
  "malta": "Malta",
  "marokko": "Morocco",
  "mauretanien": "Mauritania",
  "mauritius": "Mauritius",
  "mexiko": "Mexico",
  "mikronesien": "Micronesia",
  "moldau": "Moldova",
  "mongolei": "Mongolia",
  "montenegro": "Montenegro",
  "mosambik": "Mozambique",
  "myanmar": "Myanmar",
  "namibia": "Namibia",
  "neuseeland": "New Zealand",
  "niederlande": "Netherlands",
  "niger": "Niger",
  "nigeria": "Nigeria",
  "nordirland": "Northern Ireland",
  "nordmazedonien": "North Macedonia",
  "norwegen": "Norway",
  "oman": "Oman",
  "osterreich": "Austria",
  "osttimor": "East Timor",
  "pakistan": "Pakistan",
  "panama": "Panama",
  "palastina": "Palestine",
  "papua_neuguinea": "Papua New Guinea",
  "paraguay": "Paraguay",
  "peru": "Peru",
  "philippinen": "Philippines",
  "polen": "Poland",
  "portugal": "Portugal",
  "republik_kongo": "Republic of the Congo",
  "ruanda": "Rwanda",
  "rumanien": "Romania",
  "russland": "Russia",
  "saint_barthelemy": "Saint Barthélemy",
  "salomonen": "Solomon Islands",
  "sambia": "Zambia",
  "samoa": "Samoa",
  "san_marino": "San Marino",
  "sansibar": "Zanzibar",
  "sao_tome_principe": "São Tomé & Príncipe",
  "saudi_arabien": "Saudi Arabia",
  "schottland": "Scotland",
  "schweden": "Sweden",
  "schweiz": "Switzerland",
  "senegal": "Senegal",
  "serbien": "Serbia",
  "seychellen": "Seychelles",
  "sierra_leone": "Sierra Leone",
  "simbabwe": "Zimbabwe",
  "singapur": "Singapore",
  "sint_maarten": "Sint Maarten",
  "slowakei": "Slovakia",
  "slowenien": "Slovenia",
  "somalia": "Somalia",
  "spanien": "Spain",
  "sri_lanka": "Sri Lanka",
  "st_kitts_und_nevis": "St. Kitts and Nevis",
  "st_lucia": "St. Lucia",
  "st_martin": "St. Martin",
  "st_vincent_und_die_grenadinen": "St. Vincent and the Grenadines",
  "sudafrika": "South Africa",
  "sudan": "Sudan",
  "sudkorea": "South Korea",
  "sudsudan": "South Sudan",
  "suriname": "Suriname",
  "syrien": "Syria",
  "tadschikistan": "Tajikistan",
  "taiwan": "Taiwan",
  "tansania": "Tanzania",
  "thailand": "Thailand",
  "togo": "Togo",
  "tonga": "Tonga",
  "trinidad_und_tobago": "Trinidad and Tobago",
  "tschad": "Chad",
  "tschechien": "Czech Republic",
  "tunesien": "Tunisia",
  "turkei": "Turkey",
  "turkmenistan": "Turkmenistan",
  "tuvalu": "Tuvalu",
  "uganda": "Uganda",
  "ukraine": "Ukraine",
  "ungarn": "Hungary",
  "uruguay": "Uruguay",
  "usa": "USA",
  "usbekistan": "Uzbekistan",
  "vanuatu": "Vanuatu",
  "venezuela": "Venezuela",
  "vereinigte_arabische_emirate": "United Arab Emirates",
  "vietnam": "Vietnam",
  "wales": "Wales",
  "zentralafrikanische_republik": "Central African Republic",
  "zypern": "Cyprus",
  "amerikanisch_samoa": "American Samoa",
  "anguilla": "Anguilla",
  "aquatorialguinea": "Equatorial Guinea",
  "bahamas": "Bahamas",
  "belize": "Belize",
  "kaimaninseln": "Cayman Islands",
  "cookinseln": "Cook Islands",
  "dominica": "Dominica",
  "guam": "Guam",
  "guatemala": "Guatemala",
  "jungferninseln_us": "US Virgin Islands",
  "jungferninseln_uk": "British Virgin Islands",
  "nordkorea": "North Korea",
  "liechtenstein": "Liechtenstein",
  "montserrat": "Montserrat",
  "nepal": "Nepal",
  "neukaledonien": "New Caledonia",
  "nicaragua": "Nicaragua",
  "puerto_rico": "Puerto Rico",
  "tahiti": "Tahiti",
  "turks_und_caicosinseln": "Turks and Caicos Islands"
});

function gameNationKey(value) {
  return String(value || '')
    .replace(/^nation[._\s-]+/i, '').replace(/_/g, ' ')
    .trim().toLowerCase()
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

const GAME_NATION_TRANSLATION_LOOKUP = (() => {
  const map = new Map();
  for (const [key, label] of Object.entries(GAME_NATION_TRANSLATIONS)) {
    map.set(gameNationKey(key), label);
    map.set(gameNationKey(label), label);
  }
  const aliases = {
    'czech': 'Czech Republic', 'czechia': 'Czech Republic',
    'cote d ivoire': 'Ivory Coast', 'côte d’ivoire': 'Ivory Coast', 'cote divoire': 'Ivory Coast',
    'turkiye': 'Turkey', 'türkiye': 'Turkey',
    'united states': 'USA', 'united states of america': 'USA',
    'timor leste': 'East Timor', 'cabo verde': 'Cape Verde',
    'palestinian territories': 'Palestine', 'palestinian territory': 'Palestine',
    'hong kong sar china': 'Hong Kong', 'macao sar china': 'Macau', 'macao': 'Macau',
    'congo kinshasa': 'Democratic Republic of the Congo', 'dr congo': 'Democratic Republic of the Congo',
    'congo brazzaville': 'Republic of the Congo', 'republic of congo': 'Republic of the Congo',
    'korea republic': 'South Korea', 'republic of korea': 'South Korea',
    'korea democratic peoples republic': 'North Korea', 'democratic peoples republic of korea': 'North Korea'
  };
  for (const [alias, label] of Object.entries(aliases)) map.set(gameNationKey(alias), label);
  return map;
})();

const GAME_NATION_CODE_OVERRIDES = Object.freeze({
  'gb-eng':'England','gb-sct':'Scotland','gb-wls':'Wales','gb-nir':'Northern Ireland','xk':'Kosovo',
  'cz':'Czech Republic','ci':'Ivory Coast','tr':'Turkey','us':'USA','cv':'Cape Verde','tl':'East Timor',
  'ps':'Palestine','hk':'Hong Kong','mo':'Macau','cd':'Democratic Republic of the Congo','cg':'Republic of the Congo',
  'kr':'South Korea','kp':'North Korea'
});

const EN_REGION_NAMES = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch (_) { return null; }
})();

function flagHtml(nation, large = false) {
  if (!nation) return '<span class="flag-empty">—</span>';
  let src = flagAssetUrl(nation.flagAsset);
  if (!src && nation.flagWebAsset) src = flagWebsiteUrl(normalizeFlagFile(nation.flagWebAsset));
  if (!src) {
    const wantedName = flagLookupKey(nation.name || nation.displayName);
    const wantedKey = flagLookupKey(nation.flagKey);
    const hit = state.flags.find(f => f.lookup === wantedName || (wantedKey && (f.lookup === wantedKey || flagLookupKey(f.key) === wantedKey)));
    if (hit) src = flagWebsiteUrl(hit.file);
  }
  if (!src) return '<span class="flag-empty">—</span>';
  return `<img class="nation-flag ${large ? 'large' : ''}" src="${esc(src)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">`;
}

async function loadFlags() {
  try {
    const response = await fetch('../assets/flags/flags.json', { cache: 'no-cache' });
    if (!response.ok) return;
    const json = await response.json();
    state.flags = (Array.isArray(json)
      ? json.map(x => ({ label: String(x.label || x.name || x.key || x.file), key: String(x.key || x.label || x.name || ''), file: normalizeFlagFile(x.file || x.path || '') }))
      : Object.entries(json || {}).map(([label, file]) => ({ label, key: label, file: normalizeFlagFile(file) })))
      .filter(x => x.file)
      .map(x => ({ ...x, lookup: flagLookupKey(x.label || x.key) }));
    state.flagLookupMap = new Map();
    for (const flag of state.flags) {
      for (const key of [flag.lookup, flagLookupKey(flag.key), gameNationKey(flag.label), gameNationKey(flag.key)]) {
        if (key && !state.flagLookupMap.has(key)) state.flagLookupMap.set(key, flag);
      }
    }
    state.nationDisplayCache = new Map();
    state.nationUiCache = null;
  } catch (error) {
    console.warn('KFM flag manifest could not be loaded:', error);
  }
}

function openFlagPicker(nation) {
  if (!state.flags.length) {
    toast('No reusable flags found. Add images and entries to /assets/flags/flags.json.', 'error');
    return;
  }
  modal('Choose flag', `<div class="toolbar"><div class="search"><input id="flagSearch" placeholder="Search flags…"></div></div><div class="flag-picker" id="flagPicker">${flagPickerRows(state.flags)}</div>`, '<button class="btn" data-cancel type="button">Cancel</button>');
  $('[data-cancel]', els.modal).addEventListener('click', closeModal);
  $('#flagSearch').addEventListener('input', event => { const q = event.target.value.toLowerCase(); $('#flagPicker').innerHTML = flagPickerRows(state.flags.filter(f => f.label.toLowerCase().includes(q))); bindFlagPicker(nation); });
  bindFlagPicker(nation);
}

function flagPickerRows(flags) {
  return flags.map(f => `<button class="flag-option" data-flag-file="${esc(f.file)}" data-flag-key="${esc(f.key)}" type="button"><img src="${esc(flagWebsiteUrl(f.file))}" alt=""><span>${esc(f.label)}</span></button>`).join('');
}

function bindFlagPicker(nation) {
  $$('[data-flag-file]', els.modal).forEach(button => button.addEventListener('click', async () => {
    if (!nation) { toast('Save the nation once, then choose its flag.', 'error'); return; }
    const file = button.dataset.flagFile;
    try {
      const response = await fetch(flagWebsiteUrl(file));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const ext = (file.split('.').pop() || 'png').toLowerCase();
      const path = `assets/flags/${String(nation.id).replace(/[^a-z0-9_-]/gi, '_')}.${ext}`;
      state.db.assets.set(path, blob);
      nation.flagAsset = path;
      nation.flagWebAsset = file;
      nation.flagKey = button.dataset.flagKey;
      dirty(); closeModal(); toast('Flag selected and embedded into the database package.'); render();
    } catch (error) { toast(`Could not load flag: ${error.message}`, 'error'); }
  }));
}


function nationDisplayName(value) {
  const nation = value && typeof value === 'object' ? value : null;
  const raw = String(nation?.name || nation?.displayName || value || '').trim();
  if (!raw) return '';

  const cacheKey = [raw, nation?.displayName || '', nation?.flagKey || '', nation?.flagWebAsset || ''].join('\u0001');
  const cached = state.nationDisplayCache.get(cacheKey);
  if (cached) return cached;

  const directCandidates = [raw, nation?.displayName, nation?.flagKey];
  for (const candidate of directCandidates) {
    const exact = GAME_NATION_TRANSLATION_LOOKUP.get(gameNationKey(candidate));
    if (exact) { state.nationDisplayCache.set(cacheKey, exact); return exact; }
  }

  const rawLookup = flagLookupKey(raw);
  const explicitKey = flagLookupKey(nation?.flagKey || '');
  const hit = state.flagLookupMap.get(rawLookup) || state.flagLookupMap.get(gameNationKey(raw)) ||
    (explicitKey ? (state.flagLookupMap.get(explicitKey) || state.flagLookupMap.get(gameNationKey(nation?.flagKey))) : null);
  const code = String(hit?.file || nation?.flagWebAsset || '').replace(/^.*\//, '').replace(/\.[^.]+$/, '').toLowerCase();

  if (GAME_NATION_CODE_OVERRIDES[code]) {
    const label = GAME_NATION_CODE_OVERRIDES[code];
    state.nationDisplayCache.set(cacheKey, label);
    return label;
  }

  if (hit?.label || hit?.key) {
    const exact = GAME_NATION_TRANSLATION_LOOKUP.get(gameNationKey(hit.label || hit.key));
    if (exact) { state.nationDisplayCache.set(cacheKey, exact); return exact; }
  }

  if (/^[a-z]{2}$/.test(code) && EN_REGION_NAMES) {
    const translated = EN_REGION_NAMES.of(code.toUpperCase());
    if (translated && translated.toUpperCase() !== code.toUpperCase()) {
      const exact = GAME_NATION_TRANSLATION_LOOKUP.get(gameNationKey(translated)) || translated;
      state.nationDisplayCache.set(cacheKey, exact);
      return exact;
    }
  }

  state.nationDisplayCache.set(cacheKey, raw);
  return raw;
}

function nationByInternalName(value) {
  if (!state.db) return null;
  return dbIndexes().nationByName.get(String(value)) || null;
}

function nationUiRows() {
  if (state.nationUiCache) return state.nationUiCache;
  state.nationUiCache = [...(state.db?.data?.nations || [])]
    .map(n => ({ nation: n, label: nationDisplayName(n) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }));
  return state.nationUiCache;
}

function nationOptions(current = '') {
  const rows = nationUiRows();
  const known = rows.some(row => String(row.nation.name) === String(current));
  const extra = current && !known ? `<option value="${esc(current)}" selected>${esc(GAME_NATION_TRANSLATION_LOOKUP.get(gameNationKey(current)) || current)}</option>` : '';
  return extra + rows.map(({ nation, label }) => `<option value="${esc(nation.name)}" ${String(nation.name) === String(current) ? 'selected' : ''}>${esc(label)}</option>`).join('');
}

function lazyNationOption(current = '') {
  const nation = nationByInternalName(current);
  const label = nationDisplayName(nation || current) || current || '—';
  return `<option value="${esc(current)}" selected>${esc(label)}</option>`;
}

function hydrateNationSelect(select) {
  if (!select || select.dataset.nationHydrated === '1') return;
  const current = select.value;
  select.innerHTML = nationOptions(current);
  select.value = current;
  select.dataset.nationHydrated = '1';
}

// Player JSON can come from a different database revision or from a hand-made
// pack. Resolve its human-readable nation/club values to the canonical records
// of the database that is currently open. The grid itself stores the internal
// nation name and club ID, so doing this once at import time avoids the old
// "open the dropdown once to make the logo appear" behaviour.
function addImportAlias(map, value, entity) {
  const raw = value && typeof value === 'object'
    ? String(value.name || value.displayName || value.id || value.code || '')
    : String(value || '');
  const key = flagLookupKey(raw);
  if (!key) return;
  const existing = map.get(key);
  if (existing === undefined) map.set(key, entity);
  else if (existing !== entity) map.set(key, null); // ambiguous alias: never guess
}

function importLookupMaps() {
  const nationById = new Map();
  const nationByAlias = new Map();
  for (const nation of state.db?.data?.nations || []) {
    for (const id of [nation.id, nation.nationId, nation.countryKey, nation.iso, nation.iso2, nation.iso3]) {
      const raw = String(id || '').trim();
      if (raw && !nationById.has(raw.toLowerCase())) nationById.set(raw.toLowerCase(), nation);
    }
    for (const alias of [nation.name, nation.displayName, nation.shortName, nation.countryKey, nation.iso, nation.iso2, nation.iso3, nation.flagKey, nationDisplayName(nation)]) {
      addImportAlias(nationByAlias, alias, nation);
    }
    const flagCode = String(nation.flagWebAsset || '').replace(/^.*\//, '').replace(/\.[^.]+$/, '').trim();
    if (flagCode) addImportAlias(nationByAlias, flagCode, nation);
  }

  const clubById = new Map();
  const clubByAlias = new Map();
  for (const club of state.db?.data?.clubs || []) {
    for (const id of [club.id, club.clubId, club.sourceClubId, club.teamId, club.sourceId]) {
      const raw = String(id || '').trim();
      if (raw && !clubById.has(raw.toLowerCase())) clubById.set(raw.toLowerCase(), club);
    }
    for (const alias of [club.name, club.displayName, club.shortName, club.clubName]) addImportAlias(clubByAlias, alias, club);
  }
  return { nationById, nationByAlias, clubById, clubByAlias };
}

function resolveImportedNation(player, lookup) {
  const directCandidates = [player.nationId, player.countryId, player.nationalityId];
  for (const candidate of directCandidates) {
    const hit = lookup.nationById.get(String(candidate || '').trim().toLowerCase());
    if (hit) return hit;
  }
  const textCandidates = [player.nation, player.nationality, player.country, player.nationName, player.countryName];
  for (const candidate of textCandidates) {
    const raw = candidate && typeof candidate === 'object'
      ? (candidate.name || candidate.displayName || candidate.id || candidate.code || '')
      : candidate;
    const rawText = String(raw || '').trim();
    if (!rawText) continue;
    const byId = lookup.nationById.get(rawText.toLowerCase());
    if (byId) return byId;
    const byAlias = lookup.nationByAlias.get(flagLookupKey(rawText));
    if (byAlias) return byAlias;
  }
  return null;
}

function resolveImportedClub(player, lookup) {
  const idCandidates = [player.clubId, player.teamId, player.sourceClubId, player.club?.id, player.team?.id];
  for (const candidate of idCandidates) {
    const raw = String(candidate || '').trim();
    if (!raw) continue;
    const hit = lookup.clubById.get(raw.toLowerCase());
    if (hit) return hit;
    const aliasHit = lookup.clubByAlias.get(flagLookupKey(raw));
    if (aliasHit) return aliasHit;
  }
  const textCandidates = [player.clubName, player.teamName, player.club, player.team];
  for (const candidate of textCandidates) {
    const raw = candidate && typeof candidate === 'object'
      ? (candidate.name || candidate.displayName || candidate.shortName || '')
      : candidate;
    const rawText = String(raw || '').trim();
    if (!rawText) continue;
    const hit = lookup.clubByAlias.get(flagLookupKey(rawText));
    if (hit) return hit;
  }
  return null;
}

function normalizeImportedPlayer(rawPlayer, lookup, usedPlayerIds) {
  const player = { ...(rawPlayer || {}) };
  let id = String(player.id || player.playerId || '').trim();
  if (!id || usedPlayerIds.has(id)) id = makeId('PLAYER');
  usedPlayerIds.add(id);
  player.id = id;
  player.playerId = id;
  player.databaseId = state.db.manifest.databaseId;

  player.position = normalizePositionCode(player.position || 'CM');
  const extras = player.extraPositions ?? player.secondaryPositions ?? [];
  const normalizedExtras = [...new Set((Array.isArray(extras) ? extras : String(extras || '').split(','))
    .map(normalizeOptionalPositionCode)
    .filter(pos => POSITIONS.includes(pos) && pos !== player.position))];
  player.extraPositions = normalizedExtras;
  player.secondaryPositions = [...normalizedExtras];

  const nation = resolveImportedNation(player, lookup);
  if (nation) {
    player.nation = nation.name;
    player.nationId = nation.id;
  }

  const club = resolveImportedClub(player, lookup);
  if (club) {
    player.clubId = club.id;
    player.clubName = club.name;
  } else if (!String(player.clubId || '').trim()) {
    player.clubId = '';
    player.clubName = String(player.clubName || player.teamName || '').trim();
  }

  player.name = [player.firstName, player.lastName].filter(Boolean).join(' ') || String(player.name || '').trim();
  return { player, nationResolved: Boolean(nation), clubResolved: Boolean(club) };
}

function confederationCompetitionFamily(compKey) {
  const key = String(compKey || '').toUpperCase();
  if (['UCL','AFC_CL','CAF_CL','CON_CL','SUD_CL','OFC_CL'].includes(key)) return 1;
  if (['UEL','AFC_CC','CAF_CC','CON_CC','SUD_CS'].includes(key)) return 2;
  return 3;
}

function confederationSlotFields(compKey) {
  return ({
    UCL:['uefa_cl_direct','uefa_cl_quali'], UEL:['uefa_el_direct','uefa_el_quali'], UECL:['uefa_ecl_direct','uefa_ecl_quali'],
    AFC_CL:['afc_cl_direct','afc_cl_quali'], AFC_CC:['afc_cc_direct','afc_cc_quali'], AFC_CH:['afc_ch_direct','afc_ch_quali'],
    CAF_CL:['caf_cl_direct','caf_cl_quali'], CAF_CC:['caf_cc_direct','caf_cc_quali'],
    CON_CL:['con_cl_direct','con_cl_quali'], CON_CC:['con_cc_direct','con_cc_quali'],
    SUD_CL:['sud_cl_direct','sud_cl_quali'], SUD_CS:['sud_cs_direct','sud_cs_quali'], OFC_CL:['ofc_cl_quali','']
  })[String(compKey || '').toUpperCase()] || ['', ''];
}

function confederationFamilyKeys(compKey) {
  const key = String(compKey || '').toUpperCase();
  if (['UCL','AFC_CL','CAF_CL','CON_CL','OFC_CL'].includes(key)) return ['champions_league','champions_cup','copa_libertadores'];
  if (key === 'SUD_CL') return ['copa_libertadores','champions_league'];
  if (key === 'UEL') return ['europa_league'];
  if (key === 'UECL') return ['europa_conference_league','conference_league'];
  if (key === 'SUD_CS') return ['copa_sudamericana','confederation_cup'];
  if (key.includes('_CC')) return ['confederation_cup','caribbean_cup'];
  if (key.includes('_CH')) return ['challenge_league','challenge_cup'];
  return [];
}

function getStaticNationSlots(row, compKey) {
  const [directField, qualiField] = confederationSlotFields(compKey);
  let direct = Math.max(0, Math.trunc(Number(row?.[directField]) || 0));
  let quali = Math.max(0, Math.trunc(Number(row?.[qualiField]) || 0));
  const nested = row?.club_competitions || row?.clubCompetitions;
  if (nested && typeof nested === 'object') {
    for (const family of confederationFamilyKeys(compKey)) {
      const rec = nested[family];
      if (!rec) continue;
      direct = Math.max(direct, Math.max(0, Math.trunc(Number(rec.direct_qualification ?? rec.directQualification ?? rec.direct) || 0)));
      quali = Math.max(quali, Math.max(0, Math.trunc(Number(rec.qualification_rounds ?? rec.qualificationRounds ?? rec.qualifying_rounds ?? rec.quali) || 0)));
      break;
    }
  }
  return { direct, quali };
}

function databaseConfederationPoints(row) {
  const explicit = Number(row?.confederation_points ?? row?.confederationPoints ?? row?.coefficientSeedScore);
  if (Number.isFinite(explicit) && explicit >= 0) return Math.max(0.05, Math.round((explicit + Number.EPSILON) * 1000) / 1000);
  const weights = { topDirect:7, topQualifying:4, secondDirect:3, secondQualifying:1.8, thirdDirect:1.4, thirdQualifying:0.8, teamRating:0.035, relevantLeague:0.35 };
  const keysByConfed = {
    UEFA:['UCL','UEL','UECL'], CONMEBOL:['SUD_CL','SUD_CS'], AFC:['AFC_CL','AFC_CC','AFC_CH'],
    CAF:['CAF_CL','CAF_CC'], CONCACAF:['CON_CL','CON_CC'], OFC:['OFC_CL']
  };
  const confed = String(row?.confederation || '').trim().toUpperCase();
  let score = 0;
  for (const compKey of keysByConfed[confed] || []) {
    const slots = getStaticNationSlots(row, compKey);
    const family = confederationCompetitionFamily(compKey);
    if (family === 1) score += slots.direct * weights.topDirect + slots.quali * weights.topQualifying;
    else if (family === 2) score += slots.direct * weights.secondDirect + slots.quali * weights.secondQualifying;
    else score += slots.direct * weights.thirdDirect + slots.quali * weights.thirdQualifying;
  }
  const ratingRaw = row?.team_rating ?? row?.teamRating ?? row?.rating;
  const rating = Number.isFinite(Number(ratingRaw)) ? Number(ratingRaw) : 50;
  const relevant = Math.max(0, Math.trunc(Number(row?.relevant_leagues ?? row?.relevantLeagues) || 0));
  score += rating * weights.teamRating + relevant * weights.relevantLeague;
  return Math.max(0.05, Math.round((score + Number.EPSILON) * 1000) / 1000);
}

const STUDIO_POSITION_ALIASES = Object.freeze({
  GK:'GK', G:'GK', TW:'GK', GOALKEEPER:'GK', KEEPER:'GK', TORWART:'GK',
  RB:'RB', RWB:'RB', RV:'RB', RIGHTBACK:'RB', RIGHTWINGBACK:'RB',
  CB:'CB', LCB:'CB', RCB:'CB', IV:'CB', ZIV:'CB', LIV:'CB', RIV:'CB', CENTERBACK:'CB', CENTREBACK:'CB',
  LB:'LB', LWB:'LB', LV:'LB', LEFTBACK:'LB', LEFTWINGBACK:'LB',
  CDM:'CDM', DM:'CDM', ZDM:'CDM', LZDM:'CDM', RZDM:'CDM', DEFENSIVEMIDFIELDER:'CDM', DEFENSIVEMIDFIELD:'CDM',
  CM:'CM', ZM:'CM', LZM:'CM', RZM:'CM', CENTRALMIDFIELDER:'CM', CENTREMIDFIELDER:'CM', CENTRALMIDFIELD:'CM',
  CAM:'CAM', AM:'CAM', ZOM:'CAM', LZOM:'CAM', RZOM:'CAM', ATTACKINGMIDFIELDER:'CAM', OFFENSIVEMIDFIELDER:'CAM',
  RM:'RM', RIGHTMIDFIELDER:'RM', RIGHTMIDFIELD:'RM',
  RW:'RW', RF:'RW', RIGHTWINGER:'RW', RIGHTFORWARD:'RW',
  LM:'LM', LEFTMIDFIELDER:'LM', LEFTMIDFIELD:'LM',
  LW:'LW', LF:'LW', LEFTWINGER:'LW', LEFTFORWARD:'LW',
  ST:'ST', LST:'ST', ZST:'ST', RST:'ST', STRIKER:'ST', FORWARD:'ST',
  CF:'CF', SS:'CF', HS:'CF', LHS:'CF', ZHS:'CF', RHS:'CF', CENTERFORWARD:'CF', CENTREFORWARD:'CF', SECONDSTRIKER:'CF'
});
function studioPositionKey(value) {
  return String(value || '').trim().toUpperCase().replace(/[\s._\-/]+/g, '');
}
function normalizePositionCode(value) {
  const raw = String(value || '').trim().toUpperCase();
  return STUDIO_POSITION_ALIASES[studioPositionKey(value)] || (POSITIONS.includes(raw) ? raw : 'CM');
}
function normalizeOptionalPositionCode(value) {
  const raw = String(value || '').trim().toUpperCase();
  return STUDIO_POSITION_ALIASES[studioPositionKey(value)] || (POSITIONS.includes(raw) ? raw : '');
}

function positionClass(value) {
  const pos = normalizePositionCode(value);
  if (pos === 'GK') return 'pos-gk';
  if (['RB','CB','LB'].includes(pos)) return 'pos-def';
  if (['CDM','CM','CAM','RM','LM'].includes(pos)) return 'pos-mid';
  return 'pos-att';
}

function playerFaceMode(player) {
  if (player?.usePlaceholderFace === true || String(player?.faceMode || '').toLowerCase() === 'placeholder') return 'placeholder';
  const hasOwnImage = Boolean(player?.faceAsset || player?.imageAsset || player?.customFaceDataUrl || player?.customFacePath || player?.customFace || player?.player_image_url || player?.imageUrl || player?.image);
  if (String(player?.faceMode || '').toLowerCase() === 'upload' || hasOwnImage) return 'upload';
  return 'placeholder';
}

function playerFaceSource(player) {
  if (!player || playerFaceMode(player) !== 'upload') return '';
  const packaged = flagAssetUrl(player.faceAsset || player.imageAsset);
  if (packaged) return packaged;
  const direct = String(player.customFaceDataUrl || player.customFace || player.player_image_url || player.imageUrl || player.image || player.customFacePath || '').trim();
  if (!direct) return '';
  if (/^(?:https?:)?\/\//i.test(direct) || direct.startsWith('data:') || direct.startsWith('blob:')) return direct;
  return websiteAssetUrl(direct);
}

function playerSilhouetteIcon() {
  return `<span class="silhouette-shape" aria-hidden="true"></span>`;
}

function playerFaceCell(player) {
  const mode = playerFaceMode(player);
  const src = playerFaceSource(player);
  const preview = mode === 'upload' && src
    ? `<span class="player-face-preview uploaded"><img src="${esc(src)}" alt="" loading="lazy" decoding="async" onerror="this.parentElement.classList.remove('uploaded');this.remove()"></span>`
    : mode === 'generated'
      ? `<span class="player-face-preview generated" title="AI-generated face mode"><b>AI</b></span>`
      : `<span class="player-face-preview placeholder" title="Placeholder face">${playerSilhouetteIcon()}</span>`;
  return `<div class="grid-face-cell" data-face-mode="${esc(mode)}">${preview}<div class="grid-face-actions"><button type="button" class="grid-face-btn ${mode === 'upload' ? 'active' : ''}" data-player-face-upload="${esc(player.id)}" title="Upload player image" aria-label="Upload player image">＋</button><button type="button" class="grid-face-btn ai ${mode === 'generated' ? 'active' : ''}" data-player-face-generated="${esc(player.id)}" title="Use AI-generated KFM face" aria-label="Use AI-generated face">AI</button><button type="button" class="grid-face-btn silhouette ${mode === 'placeholder' ? 'active' : ''}" data-player-face-placeholder="${esc(player.id)}" title="Use placeholder" aria-label="Use placeholder">${playerSilhouetteIcon()}</button></div></div>`;
}

function clearCustomPlayerFace(player) {
  const oldAsset = String(player?.faceAsset || player?.imageAsset || '').trim();
  if (oldAsset && state.db?.assets?.has(oldAsset)) state.db.assets.delete(oldAsset);
  if (oldAsset && state.objectUrls.has(oldAsset)) {
    try { URL.revokeObjectURL(state.objectUrls.get(oldAsset)); } catch (_) {}
    state.objectUrls.delete(oldAsset);
  }
  delete player.faceAsset;
  delete player.imageAsset;
  delete player.customFaceDataUrl;
  delete player.customFacePath;
  delete player.customFace;
  delete player.player_image_url;
  delete player.imageUrl;
  delete player.image;
}

function setPlayerFaceMode(player, mode) {
  if (!player) return;
  clearCustomPlayerFace(player);
  player.faceMode = mode;
  player.usePlaceholderFace = mode === 'placeholder';
  dirty();
}

const TRAITS = [
  ['teamplayer','Team player','🤝'], ['frohnatur','Cheerful','😄'], ['ehrgeizig','Ambitious','🔥'], ['ruhiger_profi','Calm professional','🧊'],
  ['hitzkopf','Hot-headed','⚡'], ['eigensinnig','Individualist','🎯'], ['trainingsfaul','Lazy in training','😴'], ['unbestaendig','Inconsistent','🎢'],
  ['feierbiest','Party animal','🍻'], ['serien_zu_spaet','Often late','⏰'], ['lokaler_star','Local star','⭐'], ['vereinsikone','Club icon','🏆'],
  ['kabinenclown','Dressing-room joker','🤡'], ['stiller_aussenseiter','Quiet outsider','🕶️'], ['robust','Robust','💪'], ['verletzungsanfaellig','Injury prone','🤕'],
  ['leicht_verletzungsanfaellig','Slightly injury prone','🩹'], ['glasknochen','Fragile','🦴'], ['risiko_passer','Risk-taking passer','🎲'],
  ['sicherheitspasser','Safe passer','🧱'], ['taktisch_diszipliniert','Tactically disciplined','📋'], ['freiheitsliebend','Free spirit','🌪️']
];

const ATTR_LABELS = {
  TEM:'Pace', SCH:'Shooting', PAS:'Passing', DRI:'Dribbling', DEF:'Defending', PHY:'Physical',
  TACT:'Tactics', DISC:'Discipline', HEC:'Diving', BSI:'Handling', ABS:'Kicking', REF:'Reflexes', TMP:'Speed', POS_GK:'Positioning'
};

function playerSortValue(player, key) {
  if (key === 'nation') return nationDisplayName(nationByInternalName(player.nation) || player.nation);
  if (key === 'clubId') {
    const club = dbIndexes().clubById.get(String(player.clubId));
    return club?.name || player.clubName || '';
  }
  if (key === 'extraPositions') return (player.extraPositions || player.secondaryPositions || []).join(',');
  if (key === 'foot') return String(player.foot || '').toLowerCase();
  if (key === 'faceMode') return playerFaceMode(player);
  return player[key] ?? '';
}

function sortPlayerRows(rows) {
  const { key, dir } = state.playerSort || {};
  if (!key) return rows;
  return [...rows].sort((a, b) => {
    const av = playerSortValue(a, key), bv = playerSortValue(b, key);
    const an = Number(av), bn = Number(bv);
    let cmp;
    if (av !== '' && bv !== '' && Number.isFinite(an) && Number.isFinite(bn)) cmp = an - bn;
    else cmp = String(av).localeCompare(String(bv), 'en', { sensitivity: 'base', numeric: true });
    return cmp * (dir || 1);
  });
}

function playerSearchList() {
  const q = state.search.trim().toLowerCase();
  const teamQ = state.playerTeamSearch.trim().toLowerCase();
  const ix = dbIndexes();
  return state.db.data.players.filter(player => {
    const nation = nationByInternalName(player.nation);
    const club = ix.clubById.get(String(player.clubId));
    const playerHaystack = [
      player.firstName, player.lastName, player.name,
      player.nation, nationDisplayName(nation || player.nation),
      player.position, club?.name, player.clubName
    ].join(' ').toLowerCase();
    if (q && !playerHaystack.includes(q)) return false;
    if (teamQ) {
      const teamHaystack = [club?.name, club?.shortName, club?.id, club?.league, player.clubName].join(' ').toLowerCase();
      if (!teamHaystack.includes(teamQ)) return false;
    }
    return true;
  });
}

function newPlayer(clubId = '') {
  const club = dbIndexes().clubById.get(String(clubId));
  const id = makeId('PLAYER');
  return { id, playerId: id, firstName: '', lastName: '', name: '', nation: state.db.data.nations[0]?.name || '', position: 'CM', extraPositions: [], secondaryPositions: [], overall: 60, talent: 3, age: 18, height_cm: 180, weight_kg: 75, foot: 'rechts', clubId: clubId || '', clubName: club?.name || '', faceMode: 'placeholder', usePlaceholderFace: true, attributes: {}, traits: [], databaseId: state.db.manifest.databaseId };
}

const PLAYER_PAGE_SIZE = 60;

const playerColumns = [
  ['position', 'POS', 'position', 'grid-position'],
  ['firstName', 'First Name', 'text', 'grid-name'],
  ['lastName', 'Last Name', 'text', 'grid-name'],
  ['age', 'Age', 'number', 'grid-age'],
  ['nation', 'Nation', 'nation', 'grid-nation'],
  ['height_cm', 'Height', 'number', 'grid-measure'],
  ['weight_kg', 'Weight', 'number', 'grid-measure'],
  ['overall', 'Overall', 'number', 'grid-rating'],
  ['talent', 'Potential', 'potential', 'grid-potential'],
  ['extraPositions', 'Additional Positions', 'positions', 'grid-additional'],
  ['foot', 'Foot', 'foot', 'grid-foot'],
  ['clubId', 'Club', 'club', 'grid-club']
];

function playerCell(p, key, type, cls) {
  let v = key === 'extraPositions' ? (p.extraPositions ?? p.secondaryPositions ?? []) : (p[key] ?? '');
  if (key === 'extraPositions' && Array.isArray(v)) v = v.join(', ');
  if (type === 'nation') {
    const nation = nationByInternalName(v);
    return `<div class="grid-nation-cell"><span class="grid-nation-flag">${flagHtml(nation)}</span><select class="cell-select ${cls}" data-pid="${esc(p.id)}" data-pkey="${key}" data-nation-lazy="1" title="${esc(nationDisplayName(nation || v))}">${lazyNationOption(v)}</select></div>`;
  }
  if (type === 'position') {
    const normalized = normalizePositionCode(v || 'CM');
    return `<div class="position-select-wrap ${positionClass(normalized)}"><select class="cell-select position-select ${cls}" data-pid="${esc(p.id)}" data-pkey="${key}">${optionList(POSITIONS, normalized)}</select></div>`;
  }
  if (type === 'positions') return `<div class="grid-multi-cell"><input class="cell-input ${cls}" data-pid="${esc(p.id)}" data-pkey="${key}" value="${esc(v)}" placeholder="RB, LB"><button class="grid-picker-btn" data-open-positions="${esc(p.id)}" type="button" title="Choose additional positions">＋</button></div>`;
  if (type === 'foot') return `<select class="cell-select ${cls}" data-pid="${esc(p.id)}" data-pkey="${key}"><option value="rechts" ${v === 'rechts' || v === 'Right' ? 'selected' : ''}>Right</option><option value="links" ${v === 'links' || v === 'Left' ? 'selected' : ''}>Left</option><option value="beidfüßig" ${v === 'beidfüßig' || v === 'Both' ? 'selected' : ''}>Both</option></select>`;
  if (type === 'club') {
    const c = dbIndexes().clubById.get(String(v));
    return `<div class="grid-club-cell">${c ? clubLogoHtml(c, true) : '<span class="club-logo-box compact empty">—</span>'}<input class="cell-input ${cls}" data-pid="${esc(p.id)}" data-pkey="${key}" data-club-query value="${esc(c?.name || p.clubName || '')}" autocomplete="off" title="${esc(c?.name || p.clubName || '')}"></div>`;
  }
  if (type === 'potential') return `<input class="cell-input ${cls}" type="number" min="0.5" max="5" step="0.5" data-pid="${esc(p.id)}" data-pkey="${key}" value="${esc(v)}">`;
  const extra = key === 'overall' ? 'min="1" max="99"' : key === 'age' ? 'min="14" max="60"' : '';
  return `<input class="cell-input ${cls}" ${type === 'number' ? 'type="number"' : ''} ${extra} data-pid="${esc(p.id)}" data-pkey="${key}" value="${esc(v)}">`;
}

function renderPlayers() {
  els.title.textContent = 'Players';
  els.subtitle.textContent = 'Spreadsheet-style player editing built for fast desktop data entry.';
  els.actions.innerHTML = '<button class="btn" id="importPlayers" type="button">Import player JSON</button><button class="btn" id="add20" type="button">＋ 20 rows</button><button class="btn primary" id="addPlayer" type="button">＋ Add player</button>';
  renderPlayerGrid(playerSearchList(), { club: null, structureMode: false });
}

function playerSortHeader(key, label) {
  const active = state.playerSort?.key === key;
  const arrow = !active ? '↕' : state.playerSort.dir > 0 ? '↑' : '↓';
  return `<button type="button" class="sort-header ${active ? 'active' : ''}" data-player-sort="${esc(key)}"><span>${esc(label)}</span><em>${arrow}</em></button>`;
}

function renderPlayerGrid(list, options) {
  const club = options.club || null;
  const q = state.search.toLowerCase();
  const filtered = club ? list.filter(p => !q || [p.firstName, p.lastName, p.name, p.nation, nationDisplayName(nationByInternalName(p.nation) || p.nation), p.position].join(' ').toLowerCase().includes(q)) : list;
  const sorted = sortPlayerRows(filtered);
  const { rows, pages, start, pageSize } = paginate(sorted, PLAYER_PAGE_SIZE);
  const selectedAll = Boolean(sorted.length) && sorted.every(p => state.selected.has(String(p.id)));
  const selectedSome = sorted.some(p => state.selected.has(String(p.id)));
  const cols = `<colgroup><col class="col-check">${playerColumns.map(([key]) => `<col class="col-${esc(key)}">`).join('')}<col class="col-playerImage"><col class="col-details"></colgroup>`;
  const teamFilter = club ? '' : `<div class="search player-team-search"><input id="playerTeamSearchInput" placeholder="Filter by team…" value="${esc(state.playerTeamSearch)}" autocomplete="off"></div>`;
  els.content.innerHTML = `<div class="toolbar player-search-toolbar"><div class="search"><input id="searchInput" placeholder="${esc(club ? `Search ${club.name} squad…` : 'Search players…')}" value="${esc(state.search)}"></div>${teamFilter}<span class="grid-note">Paste tab-separated Excel rows directly · click a column title to sort.</span></div>` + `<div class="table-wrap player-grid"><table>${cols}<thead><tr><th class="sticky-check"><input type="checkbox" id="selectAllPlayers" ${selectedAll ? 'checked' : ''} aria-label="Select all filtered players"></th>${playerColumns.map(([key, label]) => `<th class="player-col-${esc(key)}">${playerSortHeader(key, label)}</th>`).join('')}<th class="player-image-head player-col-faceMode">${playerSortHeader('faceMode', 'Image')}</th><th class="details-head"><span class="sr-only">Details</span></th></tr></thead><tbody id="playerBody">${rows.map(p => { const selected = state.selected.has(String(p.id)); return `<tr class="${selected ? 'selected' : ''}" data-player-row="${esc(p.id)}"><td class="sticky-check"><input type="checkbox" data-select-player="${esc(p.id)}" ${selected ? 'checked' : ''}></td>${playerColumns.map(([k, , t, c]) => `<td class="player-col-${esc(k)}">${playerCell(p, k, t, c)}</td>`).join('')}<td class="player-image-cell player-col-faceMode">${playerFaceCell(p)}</td><td class="details-cell"><button class="details-button" data-player-details="${esc(p.id)}" type="button" title="Open player details" aria-label="Open player details"><span aria-hidden="true">✎</span></button></td></tr>`; }).join('')}</tbody></table></div>${pager(sorted.length, pages, start, pageSize)}`;
  bindSearch();
  const teamSearchInput = $('#playerTeamSearchInput');
  teamSearchInput?.addEventListener('input', () => {
    state.playerTeamSearch = teamSearchInput.value;
    state.page = 1;
    const selectionStart = teamSearchInput.selectionStart;
    const selectionEnd = teamSearchInput.selectionEnd;
    if (state.searchTimer) clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      state.searchTimer = null;
      rerenderKeepingInputFocus(teamSearchInput, 'playerTeamSearchInput', selectionStart, selectionEnd);
    }, 90);
  });
  const selectAll = $('#selectAllPlayers');
  if (selectAll) selectAll.indeterminate = selectedSome && !selectedAll;
  $('#addPlayer')?.addEventListener('click', () => { const p=newPlayer(club?.id || ''); state.db.data.players.unshift(p); markPlayerAdded(p); dirty(); refreshAutomaticClubRatingsForPlayers(p,{markDirty:true}); render(); });
  $('#add20')?.addEventListener('click', () => { const added=[]; for (let i = 0; i < 20; i++) { const p=newPlayer(club?.id || ''); state.db.data.players.unshift(p); added.push(p); markPlayerAdded(p); } dirty(); refreshAutomaticClubRatingsForPlayers(added,{markDirty:true}); render(); });
  $('#importPlayers')?.addEventListener('click', () => { $('#jsonInput').dataset.mode = 'players'; $('#jsonInput').click(); });
  $$('[data-player-sort]').forEach(button => button.addEventListener('click', () => {
    const key = button.dataset.playerSort;
    if (state.playerSort.key === key) state.playerSort.dir *= -1;
    else state.playerSort = { key, dir: 1 };
    state.page = 1;
    render();
  }));
  const playerBody = $('#playerBody');
  playerBody?.addEventListener('focusin', event => {
    const select = event.target.closest('select[data-nation-lazy]');
    if (select) hydrateNationSelect(select);
    const clubInput = event.target.closest('[data-club-query]');
    if (clubInput?.value) showClubSuggestions(clubInput);
  });
  playerBody?.addEventListener('input', event => {
    const clubInput = event.target.closest('[data-club-query]');
    if (clubInput) showClubSuggestions(clubInput);
  });
  playerBody?.addEventListener('focusout', event => {
    if (event.target.closest('[data-club-query]')) setTimeout(() => $('.autocomplete')?.remove(), 150);
  });
  playerBody?.addEventListener('pointerdown', event => {
    const select = event.target.closest('select[data-nation-lazy]');
    if (select) hydrateNationSelect(select);
  });
  playerBody?.addEventListener('click', event => {
    const positionButton = event.target.closest('[data-open-positions]');
    if (positionButton) {
      event.preventDefault(); event.stopPropagation(); showPositionPicker(positionButton); return;
    }
    const detailsButton = event.target.closest('[data-player-details]');
    if (detailsButton) { openPlayerDrawer(detailsButton.dataset.playerDetails); return; }
    const button = event.target.closest('[data-player-face-upload],[data-player-face-generated],[data-player-face-placeholder]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const uploadId = button.dataset.playerFaceUpload;
    if (uploadId) {
      state.imageTarget = { type: 'player', id: uploadId, fromGrid: true };
      $('#imageInput').click();
      return;
    }
    const id = button.dataset.playerFaceGenerated || button.dataset.playerFacePlaceholder;
    const p = dbIndexes().playerById.get(String(id));
    if (!p) return;
    setPlayerFaceMode(p, button.dataset.playerFaceGenerated ? 'generated' : 'placeholder');
    render();
  });
  playerBody?.addEventListener('change', event => {
    const input = event.target.closest('[data-pid][data-pkey]');
    if (!input) return;
    const p = dbIndexes().playerById.get(String(input.dataset.pid));
    if (!p) return;
    let v = input.value;
    const key = input.dataset.pkey;
    const oldClubId = String(p.clubId || '');
    if (['overall', 'talent', 'age', 'height_cm', 'weight_kg'].includes(key)) v = Number(v) || 0;
    if (key === 'extraPositions') {
      v = [...new Set(v.split(',').map(x => x.trim().toUpperCase()).map(normalizeOptionalPositionCode).filter(x => POSITIONS.includes(x) && x !== String(p.position || '').toUpperCase()))];
      p.secondaryPositions = [...v];
      input.value = v.join(', ');
    }
    if (key === 'position') {
      const filteredPositions = (p.extraPositions || p.secondaryPositions || []).map(x => String(x).toUpperCase()).map(normalizeOptionalPositionCode).filter(x => x !== String(v).toUpperCase());
      p.extraPositions = [...new Set(filteredPositions)];
      p.secondaryPositions = [...p.extraPositions];
      const extraInput = input.closest('tr')?.querySelector('[data-pkey="extraPositions"]');
      if (extraInput) extraInput.value = p.extraPositions.join(', ');
      const wrap = input.closest('.position-select-wrap');
      if (wrap) wrap.className = `position-select-wrap ${positionClass(v)}`;
    }
    if (key === 'nation') {
      const nation = nationByInternalName(v);
      const holder = input.closest('.grid-nation-cell')?.querySelector('.grid-nation-flag');
      if (holder) holder.innerHTML = flagHtml(nation);
      input.title = nationDisplayName(nation || v);
    }
    if (key === 'clubId') {
      const raw=String(v).trim();const ix=dbIndexes();const found=ix.clubById.get(raw)||ix.clubByLowerName.get(raw.toLowerCase());
      v = found?.id || ''; p.clubName = found?.name || '';
      const holder = input.closest('.grid-club-cell')?.querySelector('.club-logo-box');
      if (holder) holder.outerHTML = found ? clubLogoHtml(found, true) : '<span class="club-logo-box compact empty">—</span>';
      input.value = found?.name || '';
      input.title = found?.name || '';
    }
    p[key] = v; p.name = [p.firstName, p.lastName].filter(Boolean).join(' '); markPlayerTouched(p); dirty();
    if (key === 'overall' || key === 'clubId') refreshAutomaticClubRatings(new Set([oldClubId,String(p.clubId||'')].filter(Boolean)),{markDirty:true});
  });
  $$('[data-select-player]').forEach(check => {
    check.addEventListener('click', event => event.stopPropagation());
    check.addEventListener('change', () => {
      const id = String(check.dataset.selectPlayer);
      check.checked ? state.selected.add(id) : state.selected.delete(id);
      check.closest('tr')?.classList.toggle('selected', check.checked);
      updateSelectionBar('player');
      const all = sorted.length && sorted.every(p => state.selected.has(String(p.id)));
      const some = sorted.some(p => state.selected.has(String(p.id)));
      if (selectAll) { selectAll.checked = Boolean(all); selectAll.indeterminate = some && !all; }
    });
  });
  selectAll?.addEventListener('change', event => {
    for (const p of sorted) event.target.checked ? state.selected.add(String(p.id)) : state.selected.delete(String(p.id));
    render();
  });
  playerBody?.addEventListener('paste', handlePlayerPaste);
  playerBody?.addEventListener('keydown', event => {
    const el = event.target.closest('[data-pid]');
    if (!el || event.key !== 'Enter') return;
    event.preventDefault();
    const cells = $$('[data-pid]', playerBody);
    const i = cells.indexOf(el);
    cells[Math.min(cells.length - 1, i + 1)]?.focus();
  });
  updateSelectionBar('player');
}

function bindClubAutocomplete() {
  $$('[data-club-query]').forEach(input => {
    input.addEventListener('input', () => showClubSuggestions(input));
    input.addEventListener('focus', () => { if (input.value) showClubSuggestions(input); });
    input.addEventListener('blur', () => setTimeout(() => $('.autocomplete')?.remove(), 150));
  });
}

function showClubSuggestions(input) {
  $('.autocomplete')?.remove();
  const q = input.value.trim().toLowerCase();
  if (!q) return;
  const hits = [];
  for (const item of dbIndexes().clubSearch) { if (item.key.includes(q)) { hits.push(item.club); if (hits.length >= 12) break; } }
  if (!hits.length) return;
  const r = input.getBoundingClientRect();
  const box = document.createElement('div');
  box.className = 'autocomplete';
  box.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 360))}px`;
  box.style.top = `${Math.max(8, Math.min(window.innerHeight - 300, r.bottom + 4))}px`;
  box.style.width = `${Math.max(260, Math.min(350, r.width + 80))}px`;
  box.innerHTML = hits.map(c => `<button type="button" data-club-pick="${esc(c.id)}"><span class="autocomplete-club-main">${clubLogoHtml(c, true)}<b>${esc(c.name)}</b></span><span>${esc(c.league || c.id || '')}</span></button>`).join('');
  document.body.append(box);
  $$('[data-club-pick]', box).forEach(button => button.addEventListener('mousedown', event => {
    event.preventDefault();
    const c = dbIndexes().clubById.get(String(button.dataset.clubPick));
    if (!c) return;
    input.value = c.name;
    const p = dbIndexes().playerById.get(String(input.dataset.pid));
    if (p) { const oldClubId=String(p.clubId||''); p.clubId = c.id; p.clubName = c.name; markPlayerTouched(p); dirty(); refreshAutomaticClubRatings(new Set([oldClubId,String(c.id)].filter(Boolean)),{markDirty:true}); }
    const holder = input.closest('.grid-club-cell')?.querySelector('.club-logo-box');
    if (holder) holder.outerHTML = clubLogoHtml(c, true);
    box.remove();
  }));
}

function bindPositionPickers() {
  $$('[data-open-positions]').forEach(button => button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    showPositionPicker(button);
  }));
}

function showPositionPicker(button) {
  $('.position-popover')?.remove();
  const p = dbIndexes().playerById.get(String(button.dataset.openPositions));
  if (!p) return;
  const main = normalizePositionCode(p.position || 'CM');
  const selected = new Set((p.extraPositions || p.secondaryPositions || []).map(x => String(x).toUpperCase()).filter(x => POSITIONS.includes(x) && x !== main));
  const r = button.getBoundingClientRect();
  const box = document.createElement('div');
  box.className = 'position-popover';
  box.style.left = `${Math.max(8, Math.min(r.right - 330, window.innerWidth - 338))}px`;
  box.style.top = `${Math.max(8, Math.min(r.bottom + 5, window.innerHeight - 420))}px`;
  const formation = [
    ['LW','ST','RW'],
    ['', 'CF', ''],
    ['LM','CAM','RM'],
    ['', 'CM', ''],
    ['', 'CDM', ''],
    ['LB','CB','RB'],
    ['', 'GK', '']
  ];
  const formationHtml = formation.flatMap((row, rowIndex) => row.map((pos, colIndex) => {
    if (!pos) return `<span class="position-slot empty" style="grid-row:${rowIndex + 1};grid-column:${colIndex + 1}"></span>`;
    const isMain = pos === main;
    return `<label class="position-option ${positionClass(pos)} ${isMain ? 'main-position' : ''}" style="grid-row:${rowIndex + 1};grid-column:${colIndex + 1}" title="${isMain ? `${esc(pos)} is the main position` : esc(pos)}"><input type="checkbox" value="${esc(pos)}" ${selected.has(pos) ? 'checked' : ''} ${isMain ? 'disabled' : ''}><span>${esc(pos)}</span></label>`;
  })).join('');
  box.innerHTML = `<div class="position-popover-head"><b>Additional positions</b><button type="button" data-position-close aria-label="Close">×</button></div><div class="position-popover-pitch">${formationHtml}</div><div class="position-popover-foot"><button class="btn small" type="button" data-clear-positions>Clear</button><span>Main: ${esc(main || '—')}</span></div>`;
  document.body.append(box);
  const sync = () => {
    const values = $$('input[type="checkbox"]', box).filter(x => x.checked && !x.disabled).map(x => x.value);
    p.extraPositions = [...values]; p.secondaryPositions = [...values];
    const input = button.closest('.grid-multi-cell')?.querySelector('[data-pkey="extraPositions"]');
    if (input) input.value = values.join(', ');
    markPlayerTouched(p); dirty();
  };
  $$('input[type="checkbox"]', box).forEach(input => input.addEventListener('change', sync));
  $('[data-clear-positions]', box).addEventListener('click', () => { $$('input[type="checkbox"]', box).forEach(x => { if (!x.disabled) x.checked = false; }); sync(); });
  $('[data-position-close]', box).addEventListener('click', () => box.remove());
  const outside = event => { if (!box.contains(event.target) && event.target !== button) { box.remove(); document.removeEventListener('mousedown', outside, true); } };
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
}

function bindPlayerKeyboard() {
  $$('[data-pid]').forEach(el => el.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const cells = $$('[data-pid]'); const i = cells.indexOf(el); cells[Math.min(cells.length - 1, i + 1)]?.focus();
  }));
}

function handlePlayerPaste(event) {
  const text = event.clipboardData?.getData('text/plain');
  if (!text || (!text.includes('\t') && !text.includes('\n'))) return;
  event.preventDefault();
  const matrix = text.replace(/\r/g, '').split('\n').filter(row => row.length).map(row => row.split('\t'));
  const active = document.activeElement;
  const visibleIds = $$('#playerBody tr[data-player-row]').map(row => row.dataset.playerRow);
  let visibleStart = Math.max(0, visibleIds.findIndex(id => String(id) === String(active?.dataset?.pid)));
  const colStart = Math.max(0, playerColumns.findIndex(c => c[0] === active?.dataset?.pkey));
  const clubId = state.structure.clubId || '';
  for (let r = 0; r < matrix.length; r++) {
    let p;
    const existingId = visibleIds[visibleStart + r];
    if (existingId) p = state.db.data.players.find(x => String(x.id) === String(existingId));
    if (!p) {
      p = newPlayer(clubId);
      state.db.data.players.push(p);
      markPlayerAdded(p);
      visibleIds.push(p.id);
    }
    for (let c = 0; c < matrix[r].length && colStart + c < playerColumns.length; c++) {
      const key = playerColumns[colStart + c][0]; let v = matrix[r][c].trim();
      if (['overall', 'talent', 'age', 'height_cm', 'weight_kg'].includes(key)) v = Number(v) || 0;
      if (key === 'position') v = normalizePositionCode(v || 'CM');
      if (key === 'extraPositions') {
        v = [...new Set(v.split(',').map(x => x.trim().toUpperCase()).map(normalizeOptionalPositionCode).filter(x => POSITIONS.includes(x) && x !== normalizePositionCode(p.position || 'CM')))];
        p.secondaryPositions = [...v];
      }
      if (key === 'nation') {
        const nation = state.db.data.nations.find(n => String(n.name).toLowerCase() === String(v).toLowerCase() || nationDisplayName(n).toLowerCase() === String(v).toLowerCase());
        if (nation) v = nation.name;
      }
      if (key === 'foot') {
        const foot = String(v).trim().toLowerCase();
        if (foot === 'right') v = 'rechts'; else if (foot === 'left') v = 'links'; else if (foot === 'both' || foot === 'both feet') v = 'beidfüßig';
      }
      if (key === 'clubId') {
        const raw=String(v).trim();const ix=dbIndexes();const club=ix.clubById.get(raw)||ix.clubByLowerName.get(raw.toLowerCase());
        v = club?.id || ''; p.clubName = club?.name || '';
      }
      p[key] = v;
    }
    p.name = [p.firstName, p.lastName].filter(Boolean).join(' ');
    markPlayerTouched(p);
  }
  dirty(); refreshAutomaticClubRatings(null,{markDirty:true}); toast(`${matrix.length} pasted row${matrix.length === 1 ? '' : 's'}.`); render();
}

function entityAssetPaths(entity) {
  const out = new Set();
  for (const key of ['logoAsset', 'flagAsset', 'faceAsset', 'imageAsset', 'customFacePath']) {
    const path = String(entity?.[key] || '').trim().replace(/^\/+/, '');
    if (path.startsWith('assets/') && !path.includes('..')) out.add(path);
  }
  return out;
}

function pruneDeletedEntityAssets(deletedEntities = []) {
  const assets = state.db?.assets;
  if (!assets?.size || !deletedEntities.length) return 0;
  const candidates = new Set();
  for (const entity of deletedEntities) for (const path of entityAssetPaths(entity)) candidates.add(path);
  if (!candidates.size) return 0;
  const referenced = new Set();
  for (const key of ['confederations', 'nations', 'leagues', 'clubs', 'players', 'competitions']) {
    for (const entity of state.db.data[key] || []) for (const path of entityAssetPaths(entity)) referenced.add(path);
  }
  let removed = 0;
  for (const path of candidates) {
    if (referenced.has(path) || !assets.has(path)) continue;
    assets.delete(path);
    const url = state.objectUrls.get(path);
    if (url) { URL.revokeObjectURL(url); state.objectUrls.delete(path); }
    removed++;
  }
  return removed;
}

function scrubDeletedLeaguesFromFlows(deletedLeagues = []) {
  if (!deletedLeagues.length || !Array.isArray(state.db.data.leagueFlows)) return 0;
  const names = new Set(deletedLeagues.map(l => String(l?.name || '').trim()).filter(Boolean));
  if (!names.size) return 0;
  let refs = 0;
  for (const flow of state.db.data.leagueFlows) {
    for (const [key, value] of Object.entries(flow || {})) {
      if (!names.has(String(value || '').trim())) continue;
      flow[key] = '0';
      if (/^\d+$/.test(String(key)) && Object.prototype.hasOwnProperty.call(flow, `ANZ_${key}`)) flow[`ANZ_${key}`] = '0';
      refs++;
    }
  }
  return refs;
}

function cascadeImpactForLeagueIds(leagueIds) {
  const ids = leagueIds instanceof Set ? leagueIds : new Set([...leagueIds || []].map(String));
  const clubs = state.db.data.clubs.filter(c => ids.has(String(c.leagueId || '')));
  const clubIds = new Set(clubs.map(c => String(c.id)));
  const players = state.db.data.players.filter(p => clubIds.has(String(p.clubId || '')));
  return { leagues: state.db.data.leagues.filter(l => ids.has(String(l.id))).length, clubs: clubs.length, players: players.length };
}

function cascadeDeleteLeagueIds(leagueIds) {
  const ids = leagueIds instanceof Set ? new Set([...leagueIds].map(String)) : new Set([...leagueIds || []].map(String));
  if (!ids.size) return { leagues: 0, clubs: 0, players: 0, assets: 0, flowRefs: 0 };
  const deletedLeagues = state.db.data.leagues.filter(l => ids.has(String(l.id)));
  const deletedClubs = state.db.data.clubs.filter(c => ids.has(String(c.leagueId || '')));
  const clubIds = new Set(deletedClubs.map(c => String(c.id)));
  const deletedPlayers = state.db.data.players.filter(p => clubIds.has(String(p.clubId || '')));
  for (const p of deletedPlayers) markPlayerRemoved(p);
  state.db.data.players = state.db.data.players.filter(p => !clubIds.has(String(p.clubId || '')));
  state.db.data.clubs = state.db.data.clubs.filter(c => !ids.has(String(c.leagueId || '')));
  state.db.data.leagues = state.db.data.leagues.filter(l => !ids.has(String(l.id)));
  const flowRefs = scrubDeletedLeaguesFromFlows(deletedLeagues);
  const assets = pruneDeletedEntityAssets([...deletedLeagues, ...deletedClubs, ...deletedPlayers]);
  return { leagues: deletedLeagues.length, clubs: deletedClubs.length, players: deletedPlayers.length, assets, flowRefs };
}

function cascadeDeleteMessage(result) {
  return `Deleted ${result.leagues.toLocaleString()} league${result.leagues === 1 ? '' : 's'}, ${result.clubs.toLocaleString()} club${result.clubs === 1 ? '' : 's'} and ${result.players.toLocaleString()} player${result.players === 1 ? '' : 's'}${result.assets ? ` · ${result.assets.toLocaleString()} unused embedded asset${result.assets === 1 ? '' : 's'} removed` : ''}.`;
}

function orphanClubsWithNoLeague() {
  const leagueIds = new Set(state.db.data.leagues.map(l => String(l.id)));
  const leagueNames = new Set(state.db.data.leagues.map(l => String(l.name || '').trim()).filter(Boolean));
  return state.db.data.clubs.filter(c => {
    const leagueId = String(c.leagueId || '').trim();
    if (leagueId) return !leagueIds.has(leagueId);
    const leagueName = String(c.league || '').trim();
    return !leagueName || !leagueNames.has(leagueName);
  });
}

function orphanPlayersWithMissingClub() {
  const clubIds = new Set(state.db.data.clubs.map(c => String(c.id)));
  return state.db.data.players.filter(p => {
    const clubId = String(p.clubId || '').trim();
    return Boolean(clubId) && !clubIds.has(clubId);
  });
}

function removeOrphanClubsAndPlayers() {
  const clubs = orphanClubsWithNoLeague();
  const clubIds = new Set(clubs.map(c => String(c.id)));
  const linkedPlayers = state.db.data.players.filter(p => clubIds.has(String(p.clubId || '')));
  const playerIds = new Set(linkedPlayers.map(p => String(p.id)));
  for (const p of linkedPlayers) markPlayerRemoved(p);
  state.db.data.players = state.db.data.players.filter(p => !playerIds.has(String(p.id)));
  state.db.data.clubs = state.db.data.clubs.filter(c => !clubIds.has(String(c.id)));
  const assets = pruneDeletedEntityAssets([...clubs, ...linkedPlayers]);
  return { clubs: clubs.length, players: playerIds.size, assets };
}

function removeOrphanPlayersOnly() {
  const players = orphanPlayersWithMissingClub();
  const ids = new Set(players.map(p => String(p.id)));
  for (const p of players) markPlayerRemoved(p);
  state.db.data.players = state.db.data.players.filter(p => !ids.has(String(p.id)));
  const assets = pruneDeletedEntityAssets(players);
  return { players: players.length, assets };
}

function bindEntitySelection(allItems, type) {
  const header = $('#selectAllEntities');
  const ids = allItems.map(item => String(item.id)).filter(Boolean);
  const all = Boolean(ids.length) && ids.every(id => state.selected.has(id));
  const some = ids.some(id => state.selected.has(id));
  if (header) { header.checked = all; header.indeterminate = some && !all; }
  $$('[data-select-entity]').forEach(check => {
    check.addEventListener('click', event => event.stopPropagation());
    check.addEventListener('change', () => {
      const id = String(check.dataset.selectEntity);
      check.checked ? state.selected.add(id) : state.selected.delete(id);
      check.closest('tr')?.classList.toggle('selected', check.checked);
      updateSelectionBar(type);
      if (header) {
        const nowAll = Boolean(ids.length) && ids.every(x => state.selected.has(x));
        const nowSome = ids.some(x => state.selected.has(x));
        header.checked = nowAll; header.indeterminate = nowSome && !nowAll;
      }
    });
  });
  header?.addEventListener('change', event => {
    for (const id of ids) event.target.checked ? state.selected.add(id) : state.selected.delete(id);
    render();
  });
}

function updateSelectionBar(type = 'player') {
  removeSelectionBar();
  if (!state.selected.size) return;
  const bar = document.createElement('div');
  bar.id = 'selectionBar'; bar.className = 'selection-bar';
  const canCopy = ['league','club','player'].includes(type);
  const canMove = ['nation','league','club','player'].includes(type);
  bar.innerHTML = `<div class="selection-count"><strong>${state.selected.size}</strong><span>selected</span></div><div class="selection-actions">${canMove ? '<button class="btn small" id="moveSelected" type="button">↗ Move</button>' : ''}${canCopy ? '<button class="btn small" id="copySelected" type="button">⧉ Copy</button><button class="btn small" id="dupSelected" type="button">＋ Duplicate</button>' : ''}<button class="btn small danger" id="deleteSelected" type="button">Delete</button><button class="btn small" id="clearSelected" type="button" title="Clear selection">×</button></div>`;
  document.body.append(bar);
  $('#clearSelected')?.addEventListener('click', () => { state.selected.clear(); removeSelectionBar(); render(); });
  $('#moveSelected')?.addEventListener('click', () => openBulkTargetPicker('move', type));
  $('#copySelected')?.addEventListener('click', () => openBulkTargetPicker('copy', type));
  $('#dupSelected')?.addEventListener('click', () => duplicateSelected(type));
  $('#deleteSelected')?.addEventListener('click', () => deleteSelected(type));
}
function removeSelectionBar() { $('#selectionBar')?.remove(); }

function targetSearchBody(type) {
  return `<div class="field full"><label>Destination ${type === 'club' ? 'club' : 'league'}</label><input id="bulkTargetSearch" type="search" placeholder="Search ${type === 'club' ? 'club' : 'league'}…" autocomplete="off"><input id="bulkTargetId" type="hidden"><div class="bulk-target-list" id="bulkTargetList"></div></div>`;
}

function bindBulkTargetSearch(items, type) {
  const input = $('#bulkTargetSearch', els.modal), list = $('#bulkTargetList', els.modal), hidden = $('#bulkTargetId', els.modal);
  if (!input || !list || !hidden) return;
  const renderList = () => {
    const q = input.value.trim().toLowerCase();
    const hits = [];
    for (const item of items) {
      const label = String(item.name || item.displayName || item.id || '');
      const sub = type === 'club' ? String(item.league || '') : `${leagueNation(item)} · Level ${item.level || 1}`;
      if (!q || `${label} ${sub} ${item.id}`.toLowerCase().includes(q)) { hits.push(item); if (hits.length >= 60) break; }
    }
    list.innerHTML = hits.map(item => {
      const sub = type === 'club' ? String(item.league || '') : `${nationDisplayName(nationForLeague(item) || leagueNation(item))} · Level ${item.level || 1}`;
      const visual = type === 'club' ? clubLogoHtml(item, true) : '<span class="entity-mark league">L</span>';
      return `<button type="button" class="bulk-target-option ${String(hidden.value) === String(item.id) ? 'active' : ''}" data-bulk-target="${esc(item.id)}">${visual}<span><b>${esc(item.name || item.id)}</b><small>${esc(sub)}</small></span></button>`;
    }).join('') || '<div class="table-empty">No matching destination.</div>';
    $$('[data-bulk-target]', list).forEach(button => button.addEventListener('click', () => {
      hidden.value = button.dataset.bulkTarget;
      $$('.bulk-target-option', list).forEach(x => x.classList.toggle('active', x === button));
    }));
  };
  input.addEventListener('input', renderList);
  renderList();
  setTimeout(() => input.focus(), 0);
}

function openBulkTargetPicker(mode, type) {
  if (!state.selected.size) return;
  let body = '', bind = null;
  if (type === 'nation') {
    body = `<div class="form-grid"><div class="field full"><label>Destination confederation</label><select id="bulkTargetId">${state.db.data.confederations.map(c => { const code = confederationCode(c); return `<option value="${esc(code)}">${esc(c.displayName || c.name || code)}</option>`; }).join('')}</select></div></div>`;
  } else if (type === 'league') {
    body = `<div class="form-grid"><div class="field full"><label>Destination nation</label><select id="bulkTargetId">${state.db.data.nations.slice().sort((a,b)=>nationDisplayName(a).localeCompare(nationDisplayName(b),'en')).map(n => `<option value="${esc(n.id)}">${esc(nationDisplayName(n))}</option>`).join('')}</select></div><div class="field"><label>League level</label><input id="bulkTargetLevel" type="number" min="1" value="${esc(state.structure.level || 1)}"></div></div>`;
  } else if (type === 'club') {
    body = `<div class="form-grid">${targetSearchBody('league')}</div>`;
    bind = () => bindBulkTargetSearch(state.db.data.leagues, 'league');
  } else if (type === 'player') {
    body = `<div class="form-grid">${targetSearchBody('club')}</div>`;
    bind = () => bindBulkTargetSearch(state.db.data.clubs, 'club');
  }
  modal(`${mode === 'move' ? 'Move' : 'Copy'} ${state.selected.size} ${type}${state.selected.size === 1 ? '' : 's'}`, body, `<button class="btn" data-cancel type="button">Cancel</button><button class="btn primary" id="applyBulkTarget" type="button">${mode === 'move' ? 'Move' : 'Copy'}</button>`, 'bulk-modal');
  $('[data-cancel]', els.modal).addEventListener('click', closeModal);
  bind?.();
  $('#applyBulkTarget').addEventListener('click', () => {
    const target = $('#bulkTargetId', els.modal)?.value;
    if (!target) return toast('Choose a destination first.', 'error');
    const level = Number($('#bulkTargetLevel', els.modal)?.value || state.structure.level || 1);
    performBulkOperation(mode, type, target, level);
  });
}

function clonePlayerTo(player, clubId) {
  const x = structuredClone(player);
  x.id = x.playerId = makeId('PLAYER');
  x.clubId = clubId || '';
  const club = state.db.data.clubs.find(c => String(c.id) === String(clubId));
  x.clubName = club?.name || '';
  return x;
}

function performBulkOperation(mode, type, targetId, level = 1) {
  const ids = new Set([...state.selected].map(String));
  try {
    if (type === 'nation') {
      const conf = state.db.data.confederations.find(c => confederationCode(c) === String(targetId).toUpperCase());
      if (!conf) throw new Error('Destination confederation not found.');
      for (const n of state.db.data.nations) if (ids.has(String(n.id))) { n.confederation = confederationCode(conf); n.confederationId = conf.id || conf.ruleId; }
    } else if (type === 'league') {
      const nation = state.db.data.nations.find(n => String(n.id) === String(targetId));
      if (!nation) throw new Error('Destination nation not found.');
      const source = state.db.data.leagues.filter(l => ids.has(String(l.id)));
      if (mode === 'move') {
        for (const l of source) {
          const oldNation = leagueNation(l);
          l.nationId = nation.id; l.country = nation.name; l.databaseNation = nation.name; l.level = Math.max(1, level);
          if (!l.association || l.association === oldNation) l.association = nation.name;
          if (!l.region || l.region === oldNation) l.region = nation.name;
          for (const c of state.db.data.clubs) if (String(c.leagueId) === String(l.id)) { c.level = l.level; c.databaseNation = nation.name; }
        }
      } else {
        for (const l of source) {
          const x = structuredClone(l); x.id = x.leagueId = makeId('LEAGUE'); x.name = `${l.name} Copy`; x.nationId = nation.id; x.country = nation.name; x.databaseNation = nation.name; x.level = Math.max(1, level); x.teams = 0; state.db.data.leagues.push(x);
        }
      }
    } else if (type === 'club') {
      const league = state.db.data.leagues.find(l => String(l.id) === String(targetId));
      if (!league) throw new Error('Destination league not found.');
      const source = state.db.data.clubs.filter(c => ids.has(String(c.id)));
      if (mode === 'move') {
        for (const c of source) { c.leagueId = league.id; c.league = league.name; c.level = Number(league.level || 1); c.databaseNation = leagueNation(league); }
      } else {
        const playerCopies = [];
        for (const c of source) {
          const x = structuredClone(c); const oldId = c.id; x.id = x.clubId = makeId('CLUB'); x.name = `${c.name} Copy`; x.leagueId = league.id; x.league = league.name; x.level = Number(league.level || 1); x.databaseNation = leagueNation(league); state.db.data.clubs.push(x);
          for (const p of state.db.data.players) if (String(p.clubId) === String(oldId)) playerCopies.push(clonePlayerTo(p, x.id));
        }
        state.db.data.players.push(...playerCopies);
      }
    } else if (type === 'player') {
      const club = state.db.data.clubs.find(c => String(c.id) === String(targetId));
      if (!club) throw new Error('Destination club not found.');
      const source = state.db.data.players.filter(p => ids.has(String(p.id)));
      if (mode === 'move') for (const p of source) { p.clubId = club.id; p.clubName = club.name; }
      else state.db.data.players.push(...source.map(p => clonePlayerTo(p, club.id)));
    }
    ensureIds(state.db.data, state.db.manifest.databaseId);
    state.selected.clear(); dirty(); refreshAutomaticClubRatings(null,{markDirty:true}); closeModal(); render();
    toast(`${mode === 'move' ? 'Moved' : 'Copied'} successfully.`);
  } catch (error) { toast(error.message || String(error), 'error'); }
}

function duplicateSelected(type) {
  const ids = new Set([...state.selected].map(String));
  if (!ids.size) return;
  if (type === 'player') {
    const copies = state.db.data.players.filter(p => ids.has(String(p.id))).map(p => clonePlayerTo(p, p.clubId));
    for (const x of copies) { x.lastName = `${x.lastName || ''} Copy`.trim(); x.name = [x.firstName, x.lastName].filter(Boolean).join(' '); }
    state.db.data.players.push(...copies);
    for (const p of copies) markPlayerAdded(p);
  } else if (type === 'club') {
    const copies = [];
    for (const c of state.db.data.clubs.filter(c => ids.has(String(c.id)))) {
      const x = structuredClone(c), oldId = c.id; x.id = x.clubId = makeId('CLUB'); x.name = `${c.name} Copy`; state.db.data.clubs.push(x);
      for (const p of state.db.data.players) if (String(p.clubId) === String(oldId)) copies.push(clonePlayerTo(p, x.id));
    }
    state.db.data.players.push(...copies);
  } else if (type === 'league') {
    for (const l of state.db.data.leagues.filter(l => ids.has(String(l.id)))) { const x = structuredClone(l); x.id = x.leagueId = makeId('LEAGUE'); x.name = `${l.name} Copy`; x.teams = 0; state.db.data.leagues.push(x); }
  }
  state.selected.clear(); dirty(); refreshAutomaticClubRatings(null,{markDirty:true}); render(); toast('Selection duplicated.');
}

function deleteSelected(type) {
  const count = state.selected.size;
  if (!count) return;
  const ids = new Set([...state.selected].map(String));

  if (type === 'level') {
    const nation = state.db.data.nations.find(n => String(n.id) === String(state.structure.nationId));
    if (!nation) return;
    const levels = new Set([...ids].map(id => Number(String(id).split(':').pop())).filter(Number.isFinite));
    const leagueIds = new Set(leaguesForNation(nation).filter(l => levels.has(Number(l.level || 1))).map(l => String(l.id)));
    const impact = cascadeImpactForLeagueIds(leagueIds);
    if (!impact.leagues) { state.selected.clear(); render(); return; }
    if (!confirm(`Delete ${levels.size} selected league level${levels.size === 1 ? '' : 's'}?\n\nThis permanently removes ${impact.leagues.toLocaleString()} league${impact.leagues === 1 ? '' : 's'}, ${impact.clubs.toLocaleString()} club${impact.clubs === 1 ? '' : 's'} and ${impact.players.toLocaleString()} player${impact.players === 1 ? '' : 's'}.`)) return;
    const removed = cascadeDeleteLeagueIds(leagueIds);
    state.selected.clear(); dirty(); render(); toast(cascadeDeleteMessage(removed));
    return;
  }

  if (type === 'league') {
    const impact = cascadeImpactForLeagueIds(ids);
    if (!confirm(`Delete ${count} selected league${count === 1 ? '' : 's'}?\n\nThis permanently removes their ${impact.clubs.toLocaleString()} club${impact.clubs === 1 ? '' : 's'} and ${impact.players.toLocaleString()} player${impact.players === 1 ? '' : 's'} as well.`)) return;
    const removed = cascadeDeleteLeagueIds(ids);
    state.selected.clear(); dirty(); render(); toast(cascadeDeleteMessage(removed));
    return;
  }

  if (!confirm(`Delete ${count} selected ${type}${count === 1 ? '' : 's'}?`)) return;
  if (type === 'player') { for (const p of state.db.data.players) if (ids.has(String(p.id))) markPlayerRemoved(p); const deleted = state.db.data.players.filter(p => ids.has(String(p.id))); state.db.data.players = state.db.data.players.filter(p => !ids.has(String(p.id))); pruneDeletedEntityAssets(deleted); }
  else if (type === 'club') {
    state.db.data.clubs = state.db.data.clubs.filter(c => !ids.has(String(c.id)));
    for (const p of state.db.data.players) if (ids.has(String(p.clubId))) { p.clubId = ''; p.clubName = ''; }
  } else if (type === 'nation') state.db.data.nations = state.db.data.nations.filter(n => !ids.has(String(n.id)));
  state.selected.clear(); dirty(); refreshAutomaticClubRatings(null,{markDirty:true}); render(); toast(`${count} deleted.`);
}

function openPlayerDrawer(id) {
  $('.details-drawer')?.remove();
  const p = state.db.data.players.find(x => String(x.id) === String(id));
  if (!p) return;

  p.position = normalizePositionCode(p.position || 'CM');
  const selectedTraits = new Set(Array.isArray(p.traits) ? p.traits : []);
  const attrGroups = [
    ['TEM', 'SCH', 'PAS'],
    ['DRI', 'DEF', 'PHY'],
    ['TACT', 'DISC'],
    ['HEC', 'BSI', 'ABS'],
    ['REF', 'TMP', 'POS_GK']
  ];
  const traitGroups = [
    ['Mentality', ['teamplayer','frohnatur','ehrgeizig','ruhiger_profi','hitzkopf','eigensinnig','trainingsfaul','unbestaendig']],
    ['Dressing room', ['feierbiest','serien_zu_spaet','lokaler_star','vereinsikone','kabinenclown','stiller_aussenseiter']],
    ['Body', ['robust','verletzungsanfaellig','leicht_verletzungsanfaellig','glasknochen']],
    ['Playing style', ['risiko_passer','sicherheitspasser','taktisch_diszipliniert','freiheitsliebend']]
  ];
  const traitInfo = traitId => {
    const row = TRAITS.find(([key]) => key === traitId);
    return row ? { id: row[0], label: row[1], icon: row[2] } : { id: traitId, label: String(traitId).replace(/_/g, ' '), icon: '✨' };
  };
  const attrField = key => {
    const value = p[key] ?? p.attributes?.[key] ?? '';
    return `<label class="drawer-attr-field"><span>${esc(ATTR_LABELS[key] || key)}<small>${esc(key.replace('POS_GK', 'POS GK'))}</small></span><input name="attr:${esc(key)}" type="number" min="1" max="99" value="${esc(value)}" placeholder="—"></label>`;
  };

  const drawer = document.createElement('aside');
  drawer.className = 'details-drawer';
  drawer.innerHTML = `
    <div class="drawer-head">
      <div><div class="eyebrow">Player details</div><h2 id="drawerPlayerName">${esc(p.name || 'Unnamed player')}</h2></div>
      <button class="btn icon" id="closeDrawer" type="button">×</button>
    </div>
    <div class="form-section">Identity & football</div>
    <div class="drawer-form-grid">
      ${field('First name', 'firstName', p.firstName || '')}
      ${field('Last name', 'lastName', p.lastName || '')}
      <div class="field"><label>Nation</label><select name="nation">${nationOptions(p.nation || '')}</select></div>
      <div class="field"><label>Main position</label><div class="drawer-position-wrap ${positionClass(p.position)}"><select name="position">${optionList(POSITIONS, p.position)}</select></div></div>
      ${field('Age', 'age', p.age ?? '', 'number', 'min="14" max="60"')}
      ${field('Height (cm)', 'height_cm', p.height_cm ?? p.height ?? '', 'number', 'min="130" max="230"')}
      ${field('Weight (kg)', 'weight_kg', p.weight_kg ?? p.weight ?? '', 'number', 'min="35" max="180"')}
      <div class="field drawer-overall"><label>OVR</label><input name="overall" type="number" min="1" max="99" value="${esc(p.overall ?? 60)}"></div>
      <div class="field"><label>Preferred foot</label><select name="foot"><option value="rechts" ${p.foot === 'rechts' || p.foot === 'Right' ? 'selected' : ''}>Right</option><option value="links" ${p.foot === 'links' || p.foot === 'Left' ? 'selected' : ''}>Left</option><option value="beidfüßig" ${p.foot === 'beidfüßig' || p.foot === 'Both' ? 'selected' : ''}>Both</option></select></div>
    </div>

    <div class="form-section">Traits</div>
    <div class="trait-editor">
      <div class="selected-traits" id="selectedTraits"></div>
      <button class="btn small trait-add-btn" id="addTraitBtn" type="button">＋ Add trait</button>
      <div class="trait-picker-panel" id="traitPicker" hidden>
        ${traitGroups.map(([group, ids]) => `<div class="trait-group"><b>${esc(group)}</b><div class="trait-options">${ids.map(traitId => { const meta = traitInfo(traitId); return `<button type="button" data-add-trait="${esc(traitId)}"><span>${meta.icon}</span>${esc(meta.label)}</button>`; }).join('')}</div></div>`).join('')}
      </div>
    </div>

    <div class="form-section">Attributes</div>
    <div class="drawer-attributes">
      ${attrGroups.map(group => `<div class="attribute-row cols-${group.length}">${group.map(attrField).join('')}</div>`).join('')}
    </div>

    <div class="form-section">Player image</div>
    <div class="drawer-image-actions"><button class="btn" id="uploadFace" type="button">Upload image</button><button class="btn" id="generatedFace" type="button">AI-generated</button><button class="btn" id="clearFace" type="button">Use placeholder</button></div>`;
  document.body.append(drawer);

  const renderTraits = () => {
    const holder = $('#selectedTraits', drawer);
    const values = [...selectedTraits];
    holder.innerHTML = values.length
      ? values.map(traitId => { const meta = traitInfo(traitId); return `<span class="trait-chip"><span>${meta.icon}</span>${esc(meta.label)}<button type="button" data-remove-trait="${esc(traitId)}" aria-label="Remove ${esc(meta.label)}">×</button></span>`; }).join('')
      : '<span class="traits-empty">No traits selected.</span>';
    $$('[data-remove-trait]', holder).forEach(button => button.addEventListener('click', () => {
      selectedTraits.delete(button.dataset.removeTrait);
      p.traits = [...selectedTraits];
      markPlayerTouched(p); dirty(); renderTraits(); syncTraitPicker();
    }));
  };
  const syncTraitPicker = () => {
    $$('[data-add-trait]', drawer).forEach(button => {
      const active = selectedTraits.has(button.dataset.addTrait);
      button.disabled = active;
      button.classList.toggle('selected', active);
    });
  };
  renderTraits();
  syncTraitPicker();

  $('#closeDrawer', drawer).addEventListener('click', () => { drawer.remove(); render(); });
  $('#addTraitBtn', drawer).addEventListener('click', () => {
    const picker = $('#traitPicker', drawer);
    picker.hidden = !picker.hidden;
  });
  $$('[data-add-trait]', drawer).forEach(button => button.addEventListener('click', () => {
    selectedTraits.add(button.dataset.addTrait);
    p.traits = [...selectedTraits];
    markPlayerTouched(p); dirty(); renderTraits(); syncTraitPicker();
  }));

  $$('input[name], select[name]', drawer).forEach(input => input.addEventListener('change', () => {
    if (input.name.startsWith('attr:')) {
      const key = input.name.slice(5);
      const raw = input.value.trim();
      p.attributes ||= {};
      if (raw === '') { delete p[key]; delete p.attributes[key]; }
      else {
        const value = Math.max(1, Math.min(99, Math.round(Number(raw) || 1)));
        p[key] = value; p.attributes[key] = value; input.value = value;
      }
    } else {
      const numeric = ['age', 'height_cm', 'weight_kg', 'overall'].includes(input.name);
      let value = numeric ? Number(input.value || 0) : input.value;
      if (input.name === 'overall') { value = Math.max(1, Math.min(99, Math.round(value || 1))); input.value = value; }
      if (input.name === 'position') {
        value = normalizePositionCode(value);
        const extras = (p.extraPositions || p.secondaryPositions || []).map(normalizeOptionalPositionCode).filter(pos => pos !== value && POSITIONS.includes(pos));
        p.extraPositions = [...new Set(extras)]; p.secondaryPositions = [...p.extraPositions];
        const wrap = input.closest('.drawer-position-wrap');
        if (wrap) wrap.className = `drawer-position-wrap ${positionClass(value)}`;
      }
      p[input.name] = value;
      if (input.name === 'height_cm') p.height = value;
      if (input.name === 'weight_kg') p.weight = value;
      p.name = [p.firstName, p.lastName].filter(Boolean).join(' ');
      const title = $('#drawerPlayerName', drawer);
      if (title) title.textContent = p.name || 'Unnamed player';
    }
    markPlayerTouched(p); dirty();
    if (input.name === 'overall') refreshAutomaticClubRatingsForPlayers(p,{markDirty:true});
  }));

  $('#uploadFace', drawer).addEventListener('click', () => { state.imageTarget = { type: 'player', id: p.id }; $('#imageInput').click(); });
  $('#generatedFace', drawer).addEventListener('click', () => { setPlayerFaceMode(p, 'generated'); toast('Player will use the game generated face system.'); drawer.remove(); render(); });
  $('#clearFace', drawer).addEventListener('click', () => { setPlayerFaceMode(p, 'placeholder'); toast('Player will use the game placeholder.'); drawer.remove(); render(); });
}

function renderCompetitions() {
  const sortScope = 'competitions';
  els.title.textContent = 'Competitions';
  els.subtitle.textContent = 'Edit supported competition definitions and rule metadata.';
  els.actions.innerHTML = '<button class="btn primary" id="addCompetition" type="button">＋ Add competition</button>';
  const q = state.search.toLowerCase();
  let list = state.db.data.competitions.filter(x => !q || [x.name, x.code, x.ruleId, x.scope, x.confederation].join(' ').toLowerCase().includes(q));
  list = sortTableRows(sortScope, list, (x, key) => ({ name: x.name || x.displayName || '', scope: x.scope || '', confederation: x.confederation || '', ruleId: x.ruleId || x.code || '', active: x.active !== false })[key]);
  const { rows, pages, start } = paginate(list);
  els.content.innerHTML = searchToolbar('Search competition, rule code, scope or confederation…') + `<div class="table-wrap"><table class="competition-table"><thead><tr><th>${tableSortHeader(sortScope, 'name', 'Name')}</th><th>${tableSortHeader(sortScope, 'scope', 'Scope')}</th><th>${tableSortHeader(sortScope, 'confederation', 'Confederation')}</th><th class="rule-col">${tableSortHeader(sortScope, 'ruleId', 'Rule code')}</th><th>${tableSortHeader(sortScope, 'active', 'Active')}</th><th>Actions</th></tr></thead><tbody>${rows.map(x => `<tr><td><input class="cell-input" data-xid="${esc(x.id)}" data-key="name" value="${esc(x.name || x.displayName || '')}"></td><td><input class="cell-input" data-xid="${esc(x.id)}" data-key="scope" value="${esc(x.scope || '')}"></td><td><input class="cell-input" data-xid="${esc(x.id)}" data-key="confederation" value="${esc(x.confederation || '')}"></td><td class="rule-col"><input class="cell-input" data-xid="${esc(x.id)}" data-key="ruleId" value="${esc(x.ruleId || x.code || '')}"></td><td><select class="cell-select" data-xid="${esc(x.id)}" data-key="active"><option value="true" ${x.active !== false ? 'selected' : ''}>Yes</option><option value="false" ${x.active === false ? 'selected' : ''}>No</option></select></td><td><button class="btn small danger" data-delete-comp="${esc(x.id)}" type="button">Delete</button></td></tr>`).join('')}</tbody></table></div>${pager(list.length, pages, start)}`;
  bindSearch();
  bindTableSort(sortScope);
  $('#addCompetition').addEventListener('click', () => { const id = makeId('COMP'); state.db.data.competitions.unshift({ id, code: id.split(':').pop().slice(0, 8), ruleId: 'CUSTOM', name: 'New Competition', displayName: 'New Competition', scope: 'club-international', confederation: 'UEFA', active: true, databaseId: state.db.manifest.databaseId }); dirty(); render(); });
  $$('[data-xid]').forEach(input => input.addEventListener('change', () => { const x = state.db.data.competitions.find(v => String(v.id) === String(input.dataset.xid)); x[input.dataset.key] = input.dataset.key === 'active' ? input.value === 'true' : input.value; if (input.dataset.key === 'name') x.displayName = input.value; dirty(); }));
  $$('[data-delete-comp]').forEach(button => button.addEventListener('click', () => { if (confirm('Delete this competition definition?')) { state.db.data.competitions = state.db.data.competitions.filter(x => String(x.id) !== String(button.dataset.deleteComp)); dirty(); render(); } }));
}

function renderValidator() {
  els.title.textContent = 'Validator';
  els.subtitle.textContent = 'Inspect broken references, duplicate IDs and structural warnings. Cleanup actions delete orphaned records permanently.';
  const issues = validate(state.db.data); const errors = issues.filter(x => x.severity === 'error').length; const warns = issues.length - errors;
  const visibleIssues = issues.slice(0, 1000);
  const hiddenIssueCount = Math.max(0, issues.length - visibleIssues.length);
  const orphanClubs = orphanClubsWithNoLeague();
  const orphanClubIds = new Set(orphanClubs.map(c => String(c.id)));
  const playersInOrphanClubs = state.db.data.players.filter(p => orphanClubIds.has(String(p.clubId || '')));
  const orphanPlayers = orphanPlayersWithMissingClub().filter(p => !orphanClubIds.has(String(p.clubId || '')));
  els.actions.innerHTML = '<button class="btn" id="rerun" type="button">Run again</button>';
  const cleanup = (orphanClubs.length || orphanPlayers.length) ? `<div class="card validator-cleanup"><div><h3>Cleanup broken references</h3><p class="muted">Useful after deleting old leagues with an earlier editor version. Removing a team with no valid league also removes every player still assigned to that team.</p></div><div class="validator-cleanup-actions">${orphanClubs.length ? `<button class="btn danger" id="removeNoLeagueTeams" type="button">Remove ${orphanClubs.length.toLocaleString()} Teams with no League</button><span class="muted">+ ${playersInOrphanClubs.length.toLocaleString()} linked players</span>` : ''}${orphanPlayers.length ? `<button class="btn danger" id="removeOrphanPlayers" type="button">Remove ${orphanPlayers.length.toLocaleString()} Players with missing Club</button>` : ''}</div></div>` : '';
  els.content.innerHTML = `<div class="validator-summary"><div class="validator-badge"><b>${errors}</b> Errors</div><div class="validator-badge"><b>${warns}</b> Warnings</div><div class="validator-badge"><b>${issues.length}</b> Total issues</div></div>${cleanup}<div class="card">${issues.length ? `${hiddenIssueCount ? `<div class="validator-limit-note">Showing the first ${visibleIssues.length.toLocaleString()} issues for performance. ${hiddenIssueCount.toLocaleString()} more issue${hiddenIssueCount === 1 ? '' : 's'} are still included in the totals above.</div>` : ''}${visibleIssues.map(i => `<div class="issue ${esc(i.severity)}"><b class="sev">${esc(i.severity.toUpperCase())}</b><span>${esc(i.type)}</span><span>${esc(i.message)}</span><span></span></div>`).join('')}` : '<div class="empty-state validator-empty"><div><div class="symbol">✓</div><h2>No structural issues found</h2><p>The database passed the web editor reference and identity checks.</p></div></div>'}</div>`;
  $('#rerun').addEventListener('click', render);
  $('#removeNoLeagueTeams')?.addEventListener('click', () => {
    const clubs = orphanClubsWithNoLeague();
    const clubIds = new Set(clubs.map(c => String(c.id)));
    const linked = state.db.data.players.filter(p => clubIds.has(String(p.clubId || ''))).length;
    if (!confirm(`Remove ${clubs.length.toLocaleString()} team${clubs.length === 1 ? '' : 's'} with no valid league?\n\nThis also permanently removes ${linked.toLocaleString()} player${linked === 1 ? '' : 's'} assigned to those teams.`)) return;
    const removed = removeOrphanClubsAndPlayers();
    dirty(); render();
    toast(`Removed ${removed.clubs.toLocaleString()} orphaned club${removed.clubs === 1 ? '' : 's'} and ${removed.players.toLocaleString()} player${removed.players === 1 ? '' : 's'}${removed.assets ? ` · ${removed.assets.toLocaleString()} unused embedded asset${removed.assets === 1 ? '' : 's'} removed` : ''}.`);
  });
  $('#removeOrphanPlayers')?.addEventListener('click', () => {
    const players = orphanPlayersWithMissingClub();
    if (!players.length || !confirm(`Remove ${players.length.toLocaleString()} player${players.length === 1 ? '' : 's'} that point to clubs which no longer exist?`)) return;
    const removed = removeOrphanPlayersOnly();
    dirty(); render();
    toast(`Removed ${removed.players.toLocaleString()} orphaned player${removed.players === 1 ? '' : 's'}${removed.assets ? ` · ${removed.assets.toLocaleString()} unused embedded asset${removed.assets === 1 ? '' : 's'} removed` : ''}.`);
  });
}


function renderDatabaseSettings(){
  els.title.textContent='Database Settings';els.subtitle.textContent='Era, finance and globalization settings stored in data/metadata.json and shared with the mobile editor.';
  const settings=ensureDatabaseSettings(state.db.data);const inherited=(key)=>settings[key]==null?'':settings[key];
  const row=(label,key,value,min,max,step,help)=>`<div class="setting-row"><div><b>${esc(label)}</b><span class="setting-note">${esc(help)}</span></div><input class="inline-input" type="number" data-db-setting="${esc(key)}" value="${esc(value)}" min="${min}" max="${max}" step="${step}"></div>`;
  els.actions.innerHTML='<button class="btn primary" id="saveDbSettings" type="button">Apply settings</button>';
  els.content.innerHTML=`<div class="settings-grid"><div class="card settings-card"><h3>Era & economy</h3><p>Defaults reproduce the modern database. Inflation is applied by the game over career years; it does not rewrite stored player/club data.</p>${row('Era year','eraYear',settings.eraYear,1850,2200,1,'Reference year of this database.')}${row('Finance scale','financeScale',settings.financeScale,0.01,4,0.01,'1.00 = modern baseline; 0.10 ≈ 10% of modern monetary values.')}${row('Annual inflation','annualInflation',settings.annualInflation,-0.05,0.15,0.001,'0.04 = 4% per career year. Deterministic and capped in-game.')}${row('Attendance scale','attendanceScale',settings.attendanceScale,0.1,3,0.05,'Scales matchday attendance/revenue capacity without changing stadium records.')}${row('Transfer market activity','transferMarketActivity',settings.transferMarketActivity,0.1,2,0.05,'Global intensity for AI market movement.')}</div><div class="card settings-card"><h3>Player movement</h3><p>These affect future simulation decisions and generated players only. Existing historical players are never rewritten.</p>${row('Globalization factor','globalizationFactor',settings.globalizationFactor,0,2,0.05,'1.00 = modern baseline; lower values favor domestic movement.')}${row('Youth internationalization','youthInternationalization',settings.youthInternationalization,0,2,0.05,'Controls foreign diversity for future youth/newgens.')}</div><div class="card settings-card"><h3>Advanced finance overrides</h3><p>Leave blank to inherit Finance Scale.</p>${row('Transfer value scale','transferValueScale',inherited('transferValueScale'),0.01,4,0.01,'Blank = inherit Finance Scale.')}${row('Wage scale','wageScale',inherited('wageScale'),0.01,4,0.01,'Blank = inherit Finance Scale.')}${row('Club revenue scale','clubRevenueScale',inherited('clubRevenueScale'),0.01,4,0.01,'Blank = inherit Finance Scale.')}${row('Prize money scale','prizeMoneyScale',inherited('prizeMoneyScale'),0.01,4,0.01,'Blank = inherit Finance Scale.')}</div></div>`;
  $('#saveDbSettings').onclick=()=>{const raw={...settings};$$('[data-db-setting]').forEach(input=>{raw[input.dataset.dbSetting]=input.value===''?null:Number(input.value)});state.db.data.metadata.databaseSettings=normalizeDatabaseSettings(raw,state.db.data.metadata.startYear);dirty();toast('Database settings updated.');renderDatabaseSettings()};
}

async function chooseOfficialForContribution(type){
  const list=await listOfficial();modal(type==='league'?'Start League Contribution':'Start Player Contribution',`<div class="source-options">${list.map(x=>`<div class="source-card"><div><strong>${esc(x.label)}</strong><span>${esc(x.startDate||'')} · Official read-only base</span></div><button class="btn primary" data-contrib-season="${esc(x.id)}" type="button">Use official base</button></div>`).join('')}</div>`);
  $$('[data-contrib-season]',els.modal).forEach(btn=>btn.onclick=async()=>{const entry=list.find(x=>String(x.id)===String(btn.dataset.contribSeason));btn.disabled=true;btn.textContent='Loading…';try{const db=await loadOfficialContributionBase(entry,type);setDb(db);state.contribution=createContributionWorkspace(db,type);state.contribution._cachedRevision=state.dataRevision;state.contribution._cachedChanges=[];closeModal();state.view=type==='league'?'structure':'players';resetTransient();render();toast(`${entry.label} opened in isolated contribution workspace.`)}catch(error){btn.disabled=false;btn.textContent='Use official base';toast(error.message,'error')}});
}
function renderContributionLanding(type){
  const isLeague=type==='league';els.title.textContent=isLeague?'Contribute Leagues':'Contribute Players';els.subtitle.textContent='Community contribution mode always starts from an official, read-only database snapshot.';els.actions.innerHTML=`<button class="btn primary" id="startContribution" type="button">Choose official database</button>`;
  els.content.innerHTML=`<div class="card contrib-hero"><div><h2>${isLeague?'Add missing leagues and clubs':'Create real player lists'}</h2><p class="contrib-muted">The official database is never overwritten. Edits live in a temporary workspace and export as a small .kfmcontrib patch for manual sharing and later review.</p></div><div class="contrib-steps"><div class="contrib-step"><b>1 · Official base</b><span>Select season</span></div><div class="contrib-step"><b>2 · Edit</b><span>Reuse ${isLeague?'Structure + Club Batch Editor':'Player Grid + TSV/Excel paste'}</span></div><div class="contrib-step"><b>3 · Validate</b><span>IDs, references, plausibility</span></div><div class="contrib-step"><b>4 · Export</b><span>Small .kfmcontrib file</span></div></div></div>`;$('#startContribution').onclick=()=>chooseOfficialForContribution(type);
}
function showContributionCoverage(){
  if(!state.contribution||state.contribution.type!=="league"||!state.db)return;
  const data=state.db.data;const leagues=data.leagues||[],clubs=data.clubs||[];
  const clubCountByLeague=new Map();for(const club of clubs){const keys=[club.leagueId,club.league].filter(Boolean).map(String);for(const key of keys)clubCountByLeague.set(key,(clubCountByLeague.get(key)||0)+1)}
  const rows=(data.nations||[]).map(nation=>{const name=nationDisplayName(nation);const nationLeagues=leagues.filter(l=>{const ln=leagueNation(l);return String(l.nationId||'')===String(nation.id)||String(ln)===String(nation.name)||String(ln)===String(name)});const levels=[...new Set(nationLeagues.map(l=>Number(l.level)).filter(Number.isFinite))].sort((a,b)=>a-b);const max=levels.length?Math.max(...levels):0;const missing=[];if(max)for(let i=1;i<=max;i++)if(!levels.includes(i))missing.push(i);const empty=nationLeagues.filter(l=>!clubCountByLeague.get(String(l.id))&&!clubCountByLeague.get(String(l.name))).length;const sparse=nationLeagues.filter(l=>{const c=clubCountByLeague.get(String(l.id))||clubCountByLeague.get(String(l.name))||0;return c>0&&c<8}).length;return{id:String(nation.id||''),name,leagueCount:nationLeagues.length,levels,max,missing,empty,sparse}}).sort((a,b)=>a.name.localeCompare(b.name));
  const noLeagues=rows.filter(r=>!r.leagueCount).length,missingLower=rows.filter(r=>r.missing.length||r.max===1).length,empty=rows.reduce((a,r)=>a+r.empty,0),sparse=rows.reduce((a,r)=>a+r.sparse,0);
  modal('League coverage',`<div class="review-summary"><div class="review-stat"><strong>${noLeagues}</strong><span>Countries without leagues</span></div><div class="review-stat"><strong>${missingLower}</strong><span>Missing lower divisions / gaps</span></div><div class="review-stat"><strong>${empty}</strong><span>Empty leagues</span></div><div class="review-stat"><strong>${sparse}</strong><span>Leagues with &lt; 8 clubs</span></div></div><div class="coverage-grid">${rows.map(r=>`<div class="coverage-card"><strong>${esc(r.name)}</strong><span class="contrib-muted">${r.leagueCount?`${r.leagueCount} league(s) · Levels ${r.levels.join(', ')||'—'}`:'No leagues'}</span><div class="coverage-tags">${!r.leagueCount?'<span class="coverage-tag">No leagues</span>':''}${r.max===1?'<span class="coverage-tag">Only Level 1</span>':''}${r.missing.length?`<span class="coverage-tag">Missing L${r.missing.join(', L')}</span>`:''}${r.empty?`<span class="coverage-tag">${r.empty} empty</span>`:''}${r.sparse?`<span class="coverage-tag">${r.sparse} sparse</span>`:''}</div><button class="btn small" data-coverage-nation="${esc(r.id)}" type="button">Open nation</button></div>`).join('')}</div>`,'<button class="btn" data-close2 type="button">Close</button>','wide');$('[data-close2]',els.modal).onclick=closeModal;$$('[data-coverage-nation]',els.modal).forEach(btn=>btn.onclick=()=>{const id=btn.dataset.coverageNation;closeModal();structureGo('nationId',id)});
}

function openContributionMetadata(){
  const w=state.contribution;if(!w)return;const m=w.metadata||{};modal('Contribution metadata',`<div class="form-grid">${field('Contributor display name','contributorName',m.contributorName||'')}${field('Discord name (optional)','discordName',m.discordName||'')}<div class="field full"><label>Sources (one URL per line)</label><textarea name="sources">${esc((m.sources||[]).join('\n'))}</textarea></div><div class="field full"><label>Notes</label><textarea name="notes">${esc(m.notes||'')}</textarea></div></div>`,'<button class="btn" data-cancel type="button">Cancel</button><button class="btn primary" id="saveContribMeta" type="button">Save</button>');$('[data-cancel]',els.modal).onclick=closeModal;$('#saveContribMeta').onclick=()=>{const root=$('.modal',els.modal);w.metadata={contributorName:$('[name=contributorName]',root).value,discordName:$('[name=discordName]',root).value,sources:$('[name=sources]',root).value.split(/\n+/).map(x=>x.trim()).filter(Boolean),notes:$('[name=notes]',root).value};closeModal();toast('Contribution metadata saved.')};
}
function contributionEntityLabel(change){
  const entity=change?.after||change?.before||{};
  const fullName=[entity?.firstName,entity?.lastName].filter(Boolean).join(' ').trim();
  return String(entity?.name||fullName||entity?.displayName||entity?.Region||entity?.region||entity?.id||change?.entityId||'Unknown entity');
}
function contributionPreview(){
  const w=state.contribution;if(!w)return;
  const v=validateContribution(w,state.db.data);
  const changes=v.changes;
  w._cachedChanges=changes;w._cachedRevision=state.dataRevision;
  const s=contributionChangeSummary(w,state.db.data,changes);
  const zeroNote=!changes.length?'<div class="card contribution-recovery-note"><b>No contribution changes detected</b><p>KFM will not export an empty contribution. If you just created a player, close this preview and add/edit the player again; the fixed tracker records new player IDs explicitly as well as by snapshot diff.</p></div>':'';
  modal('Contribution preview',`${zeroNote}<div class="review-summary"><div class="review-stat"><strong>${s.total}</strong><span>Changes</span></div><div class="review-stat"><strong>${s.added}</strong><span>Added</span></div><div class="review-stat"><strong>${s.updated}</strong><span>Updated</span></div><div class="review-stat"><strong>${s.removed}</strong><span>Removed</span></div><div class="review-stat"><strong>${v.errors}</strong><span>Errors</span></div><div class="review-stat"><strong>${v.warnings}</strong><span>Warnings</span></div></div><div class="card contrib-diagnostic"><small>Tracked base rows: ${s.baseCount.toLocaleString()} · Current rows: ${s.currentCount.toLocaleString()}</small></div><div class="card">${changes.slice(0,200).map(c=>`<div class="issue ${c.operation==='add'?'ok':'warning'}"><b>${esc(c.operation.toUpperCase())}</b><span>${esc(c.entityType)}</span><span>${esc(contributionEntityLabel(c))}</span><span>${c.recoveredFromJournal?'tracker recovery':''}</span></div>`).join('')||'<div class="empty-state validator-empty">No changes yet.</div>'}</div>`);
}

async function doContributionExport(){const w=state.contribution;if(!w)return;const v=validateContribution(w,state.db.data);if(!v.changes.length){contributionPreview();toast('Nothing was exported because this contribution contains 0 changes.','error');return}if(v.errors&&!confirm(`Validator reports ${v.errors} error(s). Export anyway?`))return;try{const out=await exportContribution(w,state.db);if(!out.changes.length)throw new Error('Safety check failed: export produced 0 changes.');const base=(state.db.manifest.displayName||'contribution').replace(/[^a-z0-9._-]+/gi,'-');download(out.blob,`${base}-${w.type}.kfmcontrib`);toast(`Contribution exported with ${out.changes.length} change(s).`)}catch(error){toast(`Contribution export failed: ${error.message}`,'error')}}
function renderContributionBanner(){
  if(!state.contribution||!state.db||!['structure','players','overview','competitions','validator','settings'].includes(state.view))return;const changes=contributionChangesCached().length;const node=document.createElement('div');node.className='contrib-banner';node.innerHTML=`<div><strong>${state.contribution.type==='league'?'League':'Player'} Contribution Workspace · ${changes} change(s)</strong><small>Base ${esc(state.contribution.base.databaseId)} · official source remains read-only</small></div><div class="contrib-actions">${state.contribution.type==='league'?'<button class="btn small" data-contrib-coverage>Coverage</button>':''}<button class="btn small" data-contrib-meta>Metadata</button><button class="btn small" data-contrib-preview>Preview</button><button class="btn small primary" data-contrib-export>Export .kfmcontrib</button><button class="btn small" data-contrib-exit>Exit</button></div>`;els.content.prepend(node);$('[data-contrib-coverage]',node)?.addEventListener('click',showContributionCoverage);$('[data-contrib-meta]',node).onclick=openContributionMetadata;$('[data-contrib-preview]',node).onclick=contributionPreview;$('[data-contrib-export]',node).onclick=doContributionExport;$('[data-contrib-exit]',node).onclick=()=>{if(!changes||confirm('Exit contribution mode? The current editable copy remains loaded, but contribution tracking ends.')){state.contribution=null;render()}};
}

async function loadContributionForReview(file){
  try {
    // Render feedback before JSZip starts parsing. Large legacy/broken packages can
    // otherwise make it look as if clicking the file did nothing.
    state.page=1;state.reviewPackage={manifest:{contributionType:'Reading…',changeCount:0,seasonId:'—'}};
    state.reviewModel={loading:true,results:[],summary:{safe:0,review:0,conflicts:0},hashMatches:null};state.reviewBaseDb=null;state.reviewEntry=null;state.reviewInspect=false;state.view='reviewContrib';render();
    await new Promise(resolve=>setTimeout(resolve,0));
    const pkg = await importContribution(file);
    state.reviewPackage=pkg;render();
    await new Promise(resolve=>setTimeout(resolve,0));
    const list = await listOfficial();
    const season = String(pkg.manifest.seasonId || String(pkg.manifest.baseDatabaseId || '').replace('official:', ''));
    const entry = list.find(x => String(x.id) === season);
    if (!entry) throw new Error(`Official base season ${season} is not available on this site.`);
    const expectedBaseId = `official:${entry.id}`;
    if (String(pkg.manifest.baseDatabaseId || '') !== expectedBaseId) throw new Error(`Contribution references ${pkg.manifest.baseDatabaseId}, but season ${season} resolves to ${expectedBaseId}.`);
    state.reviewEntry=entry;

    // New packages contain a hash of only the entity collections they are allowed
    // to modify. That lets Review open without loading competitions/player packs or
    // constructing a complete working copy first. Older packages retain the full
    // loader fallback for compatibility.
    let baseDb,model;
    if(pkg.manifest.baseTrackedHash){
      baseDb=await loadOfficialReviewBase(entry,pkg.manifest.contributionType);
      const tracked=trackedContributionHash(pkg.manifest.contributionType,baseDb.baseData);
      model=reviewContribution(pkg,baseDb.baseData,null,tracked);
    }else{
      baseDb=await loadOfficial(entry);
      model=reviewContribution(pkg,baseDb.baseData,baseDb.baseContentHash,null);
    }
    state.reviewBaseDb=baseDb;state.reviewModel=model;render();
  } catch (error) {
    state.reviewModel=null;state.reviewBaseDb=null;state.reviewEntry=null;
    toast(`Could not open contribution: ${error.message}`, 'error');render();
  }
}

async function ensureFullReviewBase(){
  if(state.reviewBaseDb&&!state.reviewBaseDb.lightweight)return state.reviewBaseDb;
  const entry=state.reviewEntry;if(!entry)throw new Error('Official review base is not available.');
  const button=$('#inspectContribution')||$('#mergeAccepted');if(button)button.disabled=true;
  toast('Loading complete official database for working-copy preview…');
  await new Promise(resolve=>setTimeout(resolve,0));
  const full=await loadOfficial(entry);state.reviewBaseDb=full;return full;
}

async function openReviewInspector(){
  const pkg=state.reviewPackage, model=state.reviewModel;if(!pkg||!model||model.loading)return;
  try{
    const base=await ensureFullReviewBase();
    const previewRows=model.results.map(row=>({...row,accepted:true}));
    const data=applyReviewedChanges(base.baseData,previewRows);
    const id=`user:review-preview-${crypto.randomUUID?.()||Date.now()}`;
    data.metadata={...(data.metadata||{}),databaseId:id,templateDatabaseId:pkg.manifest.baseDatabaseId,templateRevisionId:pkg.manifest.baseRevisionId||null,reviewPreviewContributionId:pkg.manifest.contributionId};
    ensureIds(data,id);
    const assets=new Map(base.assets||[]);for(const [path,blob] of pkg.assets||[])assets.set(path,blob);
    state.reviewInspect=true;state.view=pkg.manifest.contributionType==='player'?'players':'structure';
    setDb({manifest:{databaseId:id,displayName:`${base.manifest.displayName.replace(/ — Web Copy$/,'')} — Contribution Preview`,version:'preview',author:pkg.manifest.contributorName||'',description:'Temporary review preview. Changes here are not applied to the official database.',startDate:base.manifest.startDate,databaseSeasonId:pkg.manifest.seasonId,templateDatabaseId:pkg.manifest.baseDatabaseId,templateRevisionId:pkg.manifest.baseRevisionId,tags:['Contribution','Preview']},data,assets,source:'review-preview'});
    els.exportBtn.disabled=true;els.metadataBtn.disabled=true;
  }catch(error){toast(`Could not open inspector: ${error.message}`,'error');}
}

function renderReviewInspectBanner(){
  if(!state.reviewInspect||!state.reviewPackage||!state.reviewModel||!state.db||!['structure','players'].includes(state.view))return;
  const rows=state.reviewModel.results;
  for(const row of rows){
    if(row.operation==='remove')continue;
    let node=null;
    if(row.entityType==='league')node=$(`[data-open-league="${CSS.escape(String(row.entityId))}"]`);
    else if(row.entityType==='club')node=$(`[data-open-club="${CSS.escape(String(row.entityId))}"]`);
    else if(row.entityType==='player')node=$(`[data-player-row="${CSS.escape(String(row.entityId))}"]`);
    if(node){node.classList.add('review-proposed',`review-op-${row.operation}`,`review-status-${row.reviewStatus}`);node.title=`Contribution ${row.operation} · ${row.reviewStatus}${row.reviewReason?` · ${row.reviewReason}`:''}`;}
  }
  const removed=rows.filter(r=>r.operation==='remove').length;
  const node=document.createElement('div');node.className='contrib-banner review-inspect-banner';node.innerHTML=`<div><strong>Contribution Inspector Preview</strong><small>Proposed data is shown through the normal ${state.view==='players'?'Player Grid':'Structure'} view. Official database remains read-only.${removed?` ${removed} removal(s) are listed in Review and cannot be highlighted after removal.`:''}</small></div><div class="contrib-actions"><button class="btn small primary" id="backToContributionReview" type="button">Back to Review</button></div>`;
  els.content.prepend(node);
  $('#backToContributionReview',node).onclick=()=>{state.reviewInspect=false;state.view='reviewContrib';render()};
}

function reviewValueText(value){
  if(value==null||value==='')return '—';
  if(Array.isArray(value))return value.join(', ')||'—';
  if(typeof value==='object'){try{return JSON.stringify(value)}catch(_){return String(value)}}
  return String(value);
}
function reviewChangedFields(row){
  const before=row?.before&&typeof row.before==='object'?row.before:{};
  const after=row?.after&&typeof row.after==='object'?row.after:{};
  const keys=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(k=>!['databaseId'].includes(k)).sort();
  if(row?.operation==='add')return keys.map(key=>({key,before:null,after:after[key]}));
  if(row?.operation==='remove')return keys.map(key=>({key,before:before[key],after:null}));
  return keys.filter(key=>{try{return JSON.stringify(before[key])!==JSON.stringify(after[key])}catch(_){return String(before[key])!==String(after[key])}}).map(key=>({key,before:before[key],after:after[key]}));
}
function openReviewChangeDetails(row){
  if(!row)return;
  const fields=reviewChangedFields(row);
  const rowsHtml=fields.slice(0,120).map(item=>`<tr><td><code>${esc(item.key)}</code></td><td>${esc(reviewValueText(item.before))}</td><td>${esc(reviewValueText(item.after))}</td></tr>`).join('');
  modal(`Change details · ${contributionEntityLabel(row)}`,`<div class="review-detail-summary"><span class="review-chip status-${esc(row.reviewStatus)}">${esc(row.reviewStatus)}</span><span class="review-chip op-${esc(row.operation)}">${esc(row.operation)}</span><span class="review-chip">${esc(row.entityType)}</span><code>${esc(row.entityId||'')}</code></div><p class="contrib-muted">${esc(row.reviewReason||'Can be applied automatically')}</p><div class="review-detail-table"><table><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>${rowsHtml||'<tr><td colspan="3">No field-level differences to display.</td></tr>'}</tbody></table></div>${fields.length>120?`<p class="contrib-muted">Showing the first 120 changed fields.</p>`:''}`,`<button class="btn" data-close2 type="button">Close</button>`,'wide');
  $('[data-close2]',els.modal).onclick=closeModal;
}

function renderReviewContributions(){
  els.title.textContent='Review Contributions';
  els.subtitle.textContent='Open .kfmcontrib, compare it with the referenced official base, then merge only accepted changes into a new working copy.';
  els.actions.innerHTML='<button class="btn primary" id="openContributionFile" type="button">Open .kfmcontrib</button>';
  $('#openContributionFile').onclick=()=>$('#contribInput').click();
  const pkg=state.reviewPackage,model=state.reviewModel;
  if(!pkg||!model){els.content.innerHTML='<div class="empty-state"><div><div class="symbol">✓</div><h2>No contribution opened</h2><p>Select a .kfmcontrib file. The Studio will locate its official base and classify safe changes, review items and conflicts.</p></div></div>';return}
  const m=pkg.manifest;
  if(model.loading){
    els.content.innerHTML=`<div class="card contribution-loading"><h2>Reading contribution…</h2><p>The package is already open. KFM is loading only the referenced official data needed for conflict checks.</p><div class="review-summary"><div class="review-stat"><strong>${esc(m.contributionType||'—')}</strong><span>Type</span></div><div class="review-stat"><strong>${Number(m.changeCount||0)}</strong><span>Changes</span></div><div class="review-stat"><strong>${esc(m.seasonId||'—')}</strong><span>Season</span></div></div><p class="contrib-muted">This no longer builds a complete working copy just to open the review. Full data is loaded only when you choose Inspector or Merge.</p></div>`;
    return;
  }
  const rows=model.results||[];
  const reviewPage=paginate(rows);
  const visibleRows=reviewPage.rows;
  const sourceHtml=(m.sources||[]).length?(m.sources||[]).map(x=>`<div>${esc(x)}</div>`).join(''):'—';
  const hashNotice=model.hashMatches===true?'Relevant base hash matches.':model.hashMatches===false?'Contribution was created against an older or different database revision. Entity-level fingerprints are being checked.':'Base hash could not be checked yet; entity fingerprints are used.';
  const hashMark=model.hashMatches===true?'✓':model.hashMatches===false?'⚠':'…';
  const ignoredLegacy=Number(pkg.ignoredChanges?.length||m.legacyIgnoredChangeCount||0);
  const legacyNotice=ignoredLegacy?`<div class="card contribution-recovery-note"><b>Recovered old player contribution</b><p>${ignoredLegacy} invalid non-player change${ignoredLegacy===1?' was':'s were'} ignored. These were generated by the earlier contribution prototype and are not part of the player submission.</p></div>`:'';
  const changeRowsHtml=visibleRows.map((r,i)=>{const absoluteIndex=reviewPage.start+i;const label=contributionEntityLabel(r);const reason=r.reviewReason||'Can be applied automatically';return `<div class="review-change-row diff-${esc(r.reviewStatus)}" data-review-row="${absoluteIndex}"><label class="review-change-accept" title="Accept this change"><input type="checkbox" data-review-accept="${absoluteIndex}" ${r.accepted?'checked':''}><span>Accept</span></label><div class="review-change-main"><div class="review-change-title"><strong>${esc(label)}</strong><span class="review-chip status-${esc(r.reviewStatus)}">${esc(r.reviewStatus)}</span><span class="review-chip op-${esc(r.operation)}">${esc(r.operation)}</span><span class="review-chip">${esc(r.entityType)}</span></div><div class="review-change-reason">${esc(reason)}</div><div class="review-change-id">ID: ${esc(r.entityId||'—')}</div></div><button class="btn small" type="button" data-review-details="${absoluteIndex}">Details</button></div>`}).join('');
  els.content.innerHTML=`${legacyNotice}<div class="review-summary"><div class="review-stat"><strong>${esc(m.contributionType)}</strong><span>Type</span></div><div class="review-stat"><strong>${rows.length}</strong><span>Changes</span></div><div class="review-stat"><strong>${model.summary.safe}</strong><span>Safe</span></div><div class="review-stat"><strong>${model.summary.review}</strong><span>Review</span></div><div class="review-stat"><strong>${model.summary.conflicts}</strong><span>Conflicts</span></div></div><div class="card"><dl class="meta-list"><dt>Base</dt><dd>${esc(m.baseDatabaseId)}</dd><dt>Base revision</dt><dd>${esc(m.baseRevisionId||'—')}</dd><dt>Base hash</dt><dd>${esc(m.baseTrackedHash||m.baseContentHash||'—')} ${hashMark}</dd><dt>Base status</dt><dd>${esc(hashNotice)}</dd><dt>Contributor</dt><dd>${esc(m.contributorName||'—')}</dd><dt>Discord</dt><dd>${esc(m.discordName||'—')}</dd><dt>Sources</dt><dd>${sourceHtml}</dd><dt>Notes</dt><dd>${esc(m.notes||'—')}</dd></dl></div><div class="contrib-actions review-toolbar"><button class="btn" id="inspectContribution" type="button">Inspect in normal editor</button><button class="btn" id="reviewAcceptSafe" type="button">Accept all safe</button><button class="btn" id="reviewAcceptNonConflicts" type="button">Accept all non-conflicts</button><button class="btn" id="reviewRejectAll" type="button">Reject all</button><button class="btn primary" id="mergeAccepted" type="button">Merge accepted into Working Copy</button></div><div class="card review-change-card"><div class="review-change-head"><span>Accept</span><span>Change</span><span>Inspect</span></div><div class="review-change-list">${changeRowsHtml||'<div class="table-empty">No usable changes in this contribution.</div>'}</div>${pager(rows.length,reviewPage.pages,reviewPage.start)}</div>`;
  $$('[data-review-accept]').forEach(x=>x.onchange=()=>{const row=rows[Number(x.dataset.reviewAccept)];if(row)row.accepted=x.checked});
  $$('[data-review-details]').forEach(button=>button.onclick=()=>openReviewChangeDetails(rows[Number(button.dataset.reviewDetails)]));
  $$('[data-page]').forEach(button=>button.addEventListener('click',()=>{state.page+=button.dataset.page==='next'?1:-1;renderReviewContributions()}));
  $('#inspectContribution').onclick=openReviewInspector;
  $('#reviewAcceptSafe').onclick=()=>{for(const r of rows)r.accepted=r.reviewStatus==='safe';renderReviewContributions()};
  $('#reviewAcceptNonConflicts').onclick=()=>{for(const r of rows)r.accepted=r.reviewStatus!=='conflict';renderReviewContributions()};
  $('#reviewRejectAll').onclick=()=>{for(const r of rows)r.accepted=false;renderReviewContributions()};
  $('#mergeAccepted').onclick=async()=>{
    const accepted=rows.filter(x=>x.accepted);if(!accepted.length){toast('No accepted changes selected.','error');return}
    const button=$('#mergeAccepted');if(button){button.disabled=true;button.textContent='Loading base…'}
    try{
      const base=await ensureFullReviewBase();
      const data=applyReviewedChanges(base.baseData,rows);const id=`user:review-${crypto.randomUUID?.()||Date.now()}`;
      data.metadata={...(data.metadata||{}),databaseId:id,templateDatabaseId:m.baseDatabaseId,templateRevisionId:m.baseRevisionId||null,mergedContributionId:m.contributionId};ensureIds(data,id);
      const assets=new Map(base.assets||[]);for(const [path,blob] of pkg.assets||[])assets.set(path,blob);
      state.reviewInspect=false;state.view='overview';
      setDb({manifest:{databaseId:id,displayName:`${base.manifest.displayName.replace(/ — Web Copy$/,'')} — Reviewed Contribution`,version:'1.0.0',author:m.contributorName||'',description:`Working copy merged from ${m.contributionId}`,startDate:base.manifest.startDate,databaseSeasonId:m.seasonId,templateDatabaseId:m.baseDatabaseId,templateRevisionId:m.baseRevisionId,tags:['Custom','Contribution Review']},data,assets,source:'review-working-copy'});
      state.reviewPackage=null;state.reviewModel=null;state.reviewBaseDb=null;state.reviewEntry=null;render();toast(`${accepted.length} accepted change(s) merged into a new working copy. Official database unchanged.`);
    }catch(error){toast(`Merge failed: ${error.message}`,'error');if(button){button.disabled=false;button.textContent='Merge accepted into Working Copy'}}
  };
}


function showPlayerPackResolveError(error,entry){
  const result=error?.playerPackResult;
  if(error?.code!=='PLAYER_PACK_PARTIAL_FAILURE'||!result){toast(`Could not load official data: ${error.message}`,'error');return}
  const failed=result.failures||[];const loaded=result.packs||[];
  const first=failed[0]||{};const attempts=first.attempts||[];
  const pages=attempts.filter(a=>a.source==='Pages');
  const pagesMissing=pages.length&&pages.every(a=>a.status===404);
  const sourceAttempt=attempts.find(a=>String(a.source||'').startsWith('GitHub source'));const remoteAttempt=attempts.find(a=>String(a.source||'').startsWith('GitHub release'))||attempts.find(a=>String(a.source||'').startsWith('GitHub browser'))||attempts.find(a=>String(a.source||'').startsWith('GitHub API'));
  const environmentFailure=Boolean(result.environmentFailure);
  const statusText=environmentFailure
    ? 'The browser could not resolve even the first compatible pack, so KFM stopped immediately instead of launching dozens of doomed requests.'
    : `${loaded.length}/${loaded.length+failed.length} compatible packs loaded; ${failed.length} failed.`;
  const detail=pagesMissing
    ? `Same-origin pack files are missing from <code>/assets/player-packs/</code>.${sourceAttempt?` GitHub repository source: ${esc(sourceAttempt.status||sourceAttempt.error||'not available')}.`:''}${remoteAttempt?` Legacy release fallback: ${esc(remoteAttempt.status||remoteAttempt.error||'fetch failed')}.`:''}`
    : esc(first.message||'One or more player packs could not be loaded.');
  const sample=environmentFailure
    ? `<tr><td>${esc(first.pack?.name||first.pack?.id||'First pack')}</td><td>${detail}</td></tr>`
    : failed.slice(0,12).map(f=>{const a=f.attempts||[];const p=a.find(x=>x.source==='Pages');return `<tr><td>${esc(f.pack?.name||f.pack?.id||'Pack')}</td><td>${p?.status===404?'Missing from /assets/player-packs/':esc((p?.error||f.message||'Failed').slice(0,120))}</td></tr>`}).join('');
  modal('Player pack resolve failed',`<div class="card"><p><b>${statusText}</b></p><p>KFM v20 first tries same-origin <code>/assets/player-packs/</code>. If those files are not deployed, it checks the GitHub release-tag source and then the repository's current default branch. Only after that does it try legacy release-download URLs. If Android fallback was selected while creating the copy, KFM can still create the database and resolve locally installed packs during Android import.</p><p class="contrib-muted">If the repository tag does not contain the pack JSON itself, a static page cannot read the release asset directly when GitHub omits CORS. In that case the included sync script / Pages build step remains the reliable same-origin deployment fallback.</p></div><div class="card table-wrap"><table><thead><tr><th>Pack</th><th>Problem</th></tr></thead><tbody>${sample}</tbody></table>${!environmentFailure&&failed.length>12?`<p class="contrib-muted">…and ${failed.length-12} more. No partial custom database was created.</p>`:''}</div>`,`<button class="btn" data-close2 type="button">Close</button>`,'wide');
  $('[data-close2]',els.modal).onclick=closeModal;
}

async function openOfficial() {
  try {
    const list = await listOfficial();
    const compatiblePacksBySeason = new Map();
    await Promise.all(list.map(async entry => {
      try { compatiblePacksBySeason.set(String(entry.id), await compatiblePlayerPacks(entry.id, entry.revisionId || null)); }
      catch (_) { compatiblePacksBySeason.set(String(entry.id), []); }
    }));
    modal('Create from official database', `<div class="source-options">${list.map(x => {
      const compatiblePacks = compatiblePacksBySeason.get(String(x.id)) || [];
      const packCount = compatiblePacks.length;
      return `<div class="source-card source-card-rich">
        <div class="source-card-copy"><strong>${esc(x.label)}</strong><span>${esc(x.startDate || '')} · creates an editable standalone copy</span></div>
        <label class="pack-resolve-option ${packCount ? '' : 'disabled'}">
          <input type="checkbox" data-resolve-packs="${esc(x.id)}" ${packCount ? '' : 'disabled'}>
          <span><b>Try to resolve compatible player packs in the browser</b><small>${packCount ? `${packCount} compatible pack${packCount === 1 ? '' : 's'} available. KFM tries same-origin, release-tag source and the current GitHub default branch.` : 'No compatible player packs are available for this database season.'}</small></span>
        </label>
        <label class="pack-resolve-option ${packCount ? '' : 'disabled'}">
          <input type="checkbox" data-defer-packs="${esc(x.id)}" ${packCount ? 'checked' : 'disabled'}>
          <span><b>Fallback: resolve installed packs when this .kfmdb is installed on Android</b><small>${packCount ? 'If the browser cannot read the pack files, the exported database remembers this request. On Android, KFM copies any locally installed compatible packs into the database during installation.' : 'No compatible packs exist for this season.'}</small></span>
        </label>
        <div class="source-card-actions"><button class="btn primary" data-load-season="${esc(x.id)}" type="button">Create editable copy</button></div>
      </div>`;
    }).join('')}</div>`);
    $$('[data-load-season]', els.modal).forEach(button => button.addEventListener('click', async () => {
      const entry = list.find(x => String(x.id) === String(button.dataset.loadSeason));
      if (!entry) return;
      const resolvePacks = Boolean($(`[data-resolve-packs="${CSS.escape(String(entry.id))}"]`, els.modal)?.checked);
      const deferPacks = Boolean($(`[data-defer-packs="${CSS.escape(String(entry.id))}"]`, els.modal)?.checked);
      const deferredPackIds = (compatiblePacksBySeason.get(String(entry.id)) || []).map(pack => String(pack.id || '')).filter(Boolean);
      button.disabled = true;
      button.textContent = resolvePacks ? 'Resolving player packs…' : 'Loading…';
      toast(resolvePacks ? `Loading ${entry.label} and resolving compatible player packs…` : `Loading ${entry.label}…`);
      try {
        const db = await loadOfficial(entry, {
          resolvePlayerPacks: resolvePacks,
          deferPlayerPacksToAndroid: deferPacks,
          deferredPlayerPackIds: deferredPackIds,
          onPackProgress: info => {
            if (!resolvePacks || !info?.pack) return;
            const current = Math.max(1, Number(info.index || 0) + (info.stage === 'resolved' ? 0 : 1));
            button.textContent = `Pack ${Math.min(current, info.total || current)}/${info.total || '?'} · ${info.pack.name}`;
          }
        });
        closeModal();
        setDb(db);
        const count = Number(db.data?.metadata?.resolvedPlayerPackPlayerCount || 0);
        const packs = Number(db.data?.metadata?.resolvedPlayerPackIds?.length || 0);
        const deferred = db.data?.metadata?.deferredPlayerPackResolution?.requested === true;
        toast(count > 0 ? `${entry.label} copied with ${count.toLocaleString()} players from ${packs} compatible player packs.` : deferred ? `${entry.label} copied. Player packs will be resolved from installed compatible packs when the .kfmdb is installed on Android.` : `${entry.label} loaded as an editable copy.`);
      } catch (error) {
        button.disabled = false;
        button.textContent = 'Create editable copy';
        showPlayerPackResolveError(error,entry);
      }
    }));
  } catch (error) { toast(`Official database catalog not found. Copy the game JSON files into assets/data. ${error.message}`, 'error'); }
}

function newDatabase() {
  modal('New database', `<div class="form-grid">${field('Database name', 'name', 'My Database')}${field('Author', 'author', '')}${field('Version', 'version', '1.0.0')}${field('Start date', 'startDate', '2026-07-01', 'date')}<div class="field full"><label>Description</label><textarea name="description"></textarea></div><div class="field full"><small class="field-help">The new database starts with the standard confederations, nations, built-in competitions and a virtual League Level 1 for every nation. Leagues, clubs and players remain empty until you add them.</small></div></div>`, '<button class="btn" data-close2 type="button">Cancel</button><button class="btn primary" id="createDb" type="button">Create database</button>');
  $('[data-close2]', els.modal).addEventListener('click', closeModal);
  $('#createDb').addEventListener('click', async event => {
    const button = event.currentTarget;
    const root = $('.modal', els.modal); const fd = Object.fromEntries($$('[name]', root).map(i => [i.name, i.value]));
    const id = `user:${crypto.randomUUID?.() || Date.now()}`;
    button.disabled = true; button.textContent = 'Preparing workbase…';
    try {
      const data = await loadReferenceScaffold();
      data.metadata = { databaseId: id, schemaVersion: 1, startDate: fd.startDate || '2026-07-01', startYear: Number((fd.startDate || '2026-07-01').slice(0, 4)) }; ensureDatabaseSettings(data, data.metadata.startYear);
      ensureIds(data, id);
      setDb({ manifest: { databaseId: id, displayName: fd.name || 'My Database', author: fd.author || '', version: fd.version || '1.0.0', description: fd.description || '', startDate: fd.startDate || '2026-07-01', tags: ['Custom'] }, data, assets: new Map(), source: 'new' });
      closeModal();
      go('structure');
      toast(`Workbase created with ${data.confederations.length} confederations and ${data.nations.length} nations.`);
    } catch (error) {
      button.disabled = false; button.textContent = 'Create database';
      toast(`Could not prepare the reference workbase: ${error.message}`, 'error');
    }
  });
}

function editMetadata() {
  if (!requireDb()) return;
  const m = state.db.manifest;
  modal('Database information', `<div class="form-grid">${field('Name', 'displayName', m.displayName)}${field('Author', 'author', m.author || '')}${field('Version', 'version', m.version || '1.0.0')}${field('Start date', 'startDate', m.startDate || '2026-07-01', 'date')}<div class="field full"><label>Description</label><textarea name="description">${esc(m.description || '')}</textarea></div><div class="field full"><label>Tags (comma separated)</label><input name="tags" value="${esc((m.tags || []).join(', '))}"></div></div>`, '<button class="btn" data-cancel type="button">Cancel</button><button class="btn primary" id="saveMeta" type="button">Save</button>');
  $('[data-cancel]', els.modal).addEventListener('click', closeModal);
  $('#saveMeta').addEventListener('click', () => { $$('[name]', els.modal).forEach(i => { m[i.name] = i.name === 'tags' ? i.value.split(',').map(x => x.trim()).filter(Boolean) : i.value; }); state.db.data.metadata.startDate = m.startDate; state.db.data.metadata.startYear = Number(m.startDate.slice(0, 4)); dirty(); closeModal(); setDb(state.db); toast('Database information updated.'); });
}

async function doExport() {
  if (!requireDb()) return;
  const issues = validate(state.db.data); const errors = issues.filter(x => x.severity === 'error').length;
  if (errors && !confirm(`The validator reports ${errors} error${errors === 1 ? '' : 's'}. Export anyway?`)) return;
  try {
    toast('Building .kfmdb…');
    const { blob, manifest, data } = await exportKfmdb(state.db);
    state.db.data = data; state.db.manifest.revisionId = manifest.revisionId; state.db.manifest.contentHash = manifest.contentHash;
    const name = (state.db.manifest.displayName || 'database').replace(/[^a-z0-9._-]+/gi, '-') + '.kfmdb';
    download(blob, name); state.db.dirty = false;
    els.dbMeta.textContent = `Exported · ${state.db.data.clubs.length.toLocaleString()} clubs · ${state.db.data.players.length.toLocaleString()} players`;
    toast(`${name} exported.`);
  } catch (error) { toast(`Export failed: ${error.message}`, 'error'); }
}


$('#contribInput').addEventListener('change', async e => { const file=e.target.files?.[0]; e.target.value=''; if(file) await loadContributionForReview(file); });
$('#newDbBtn').addEventListener('click', newDatabase);
$('#openOfficialBtn').addEventListener('click', openOfficial);
$('#importBtn').addEventListener('click', () => $('#kfmdbInput').click());
$('#metadataBtn').addEventListener('click', editMetadata);
$('#exportBtn').addEventListener('click', doExport);
$('#nav').addEventListener('click', event => { const button = event.target.closest('[data-view]'); if (button) go(button.dataset.view); });

$('#kfmdbInput').addEventListener('change', async event => {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
  try { toast('Reading .kfmdb…'); const imported = await importKfmdb(file); setDb({ ...imported, source: 'kfmdb' }); toast(`${imported.manifest.displayName} imported.`); }
  catch (error) { toast(`Import failed: ${error.message}`, 'error'); }
});

$('#jsonInput').addEventListener('change', async event => {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file || !requireDb()) return;
  try {
    const json = JSON.parse(await file.text()); if (!Array.isArray(json)) throw new Error('Expected a JSON array');
    if (event.target.dataset.mode === 'players') {
      const lookup = importLookupMaps();
      const usedPlayerIds = new Set((state.db.data.players || []).map(p => String(p.id || p.playerId || '')).filter(Boolean));
      let nationsResolved = 0, clubsResolved = 0, nationCandidates = 0, clubCandidates = 0;
      const items = json.map(raw => {
        const hasNation = [raw?.nation, raw?.nationality, raw?.country, raw?.nationName, raw?.countryName, raw?.nationId, raw?.countryId, raw?.nationalityId]
          .some(v => String(v && typeof v === 'object' ? (v.name || v.id || '') : (v || '')).trim());
        const hasClub = [raw?.clubId, raw?.teamId, raw?.sourceClubId, raw?.clubName, raw?.teamName, raw?.club, raw?.team]
          .some(v => String(v && typeof v === 'object' ? (v.name || v.id || '') : (v || '')).trim());
        if (hasNation) nationCandidates += 1;
        if (hasClub) clubCandidates += 1;
        const normalized = normalizeImportedPlayer(raw, lookup, usedPlayerIds);
        if (normalized.nationResolved) nationsResolved += 1;
        if (normalized.clubResolved) clubsResolved += 1;
        return normalized.player;
      });
      state.db.data.players.push(...items);
      for (const p of items) markPlayerAdded(p);
      dirty();
      refreshAutomaticClubRatingsForPlayers(items,{markDirty:true});
      const unresolvedNation = Math.max(0, nationCandidates - nationsResolved);
      const unresolvedClub = Math.max(0, clubCandidates - clubsResolved);
      const details = unresolvedNation || unresolvedClub
        ? ` · ${unresolvedNation} nation / ${unresolvedClub} club reference(s) could not be matched automatically.`
        : ' · Nation flags and club logos linked automatically.';
      toast(`${items.length} players imported${details}`, unresolvedNation || unresolvedClub ? 'error' : 'ok');
      render();
    }
  } catch (error) { toast(`JSON import failed: ${error.message}`, 'error'); }
});


$('#imageInput').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file || !state.imageTarget || !requireDb()) return;
  const target = { ...state.imageTarget };
  try {
    if (target.type === 'club-row') {
      const editor = findClubEditor(target.id);
      if (!editor) { state.imageTarget = null; return; }
      const optimized = await optimizeImageFile(file, 'club', file.name);
      if (editor.pendingLogoUrl) { try { URL.revokeObjectURL(editor.pendingLogoUrl); } catch (_) {} }
      editor.pendingLogoFile = optimized.file;
      editor.pendingLogoUrl = URL.createObjectURL(optimized.file);
      const editorRow = $$('[data-club-editor-row]').find(node => String(node.dataset.clubEditorRow) === String(editor.id));
      const holder = $('.club-grid-logo-editor .club-logo-box', editorRow || document);
      if (holder) {
        const initials = String(editor.draft.shortName || editor.draft.name || '?').replace(/[^A-Za-z0-9ÄÖÜäöü]/g, '').slice(0, 2).toUpperCase() || '?';
        holder.outerHTML = `<span class="club-logo-box club-grid-logo-preview"><span class="club-logo-initials">${esc(initials)}</span><img src="${esc(editor.pendingLogoUrl)}" alt="" decoding="async"></span>`;
      }
      state.imageTarget = null;
      toast(`${optimizationToast(optimized)} Save the row to embed it.`);
      return;
    }
    if (target.type === 'player') {
      const p = state.db.data.players.find(x => String(x.id) === String(target.id));
      if (!p) { state.imageTarget = null; return; }
      const optimized = await optimizeImageFile(file, 'player', file.name);
      const previousAsset = String(p.faceAsset || p.imageAsset || '').trim();
      if (previousAsset && state.db.assets.has(previousAsset)) state.db.assets.delete(previousAsset);
      if (previousAsset && state.objectUrls.has(previousAsset)) {
        try { URL.revokeObjectURL(state.objectUrls.get(previousAsset)); } catch (_) {}
        state.objectUrls.delete(previousAsset);
      }
      const path = `assets/player-faces/${String(p.id).replace(/[^a-z0-9_-]/gi, '_')}.${optimized.ext}`;
      state.db.assets.set(path, optimized.file);
      p.faceAsset = path;
      delete p.imageAsset;
      delete p.customFaceDataUrl;
      delete p.customFacePath;
      delete p.customFace;
      delete p.player_image_url;
      delete p.imageUrl;
      delete p.image;
      p.faceMode = 'upload'; p.usePlaceholderFace = false;
      const rerenderGrid = Boolean(target.fromGrid);
      markPlayerTouched(p); dirty(); toast(optimizationToast(optimized));
      state.imageTarget = null;
      if (rerenderGrid) render();
      return;
    }
  } catch (error) {
    state.imageTarget = null;
    toast(`Image optimization failed: ${error.message}`, 'error');
    return;
  }
  state.imageTarget = null;
});

$('#flagInput').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file || !requireDb()) return;
  try {
    const optimized = await optimizeImageFile(file, 'flag', file.name);
    state.pendingNationFlag = { type: 'upload', file: optimized.file, optimized };
    const preview = $('#nationFlagPreview');
    if (preview) {
      const url = URL.createObjectURL(optimized.file);
      preview.innerHTML = `<img class="nation-flag large" src="${esc(url)}" alt="">`;
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    const select = $('#flagSelect'); if (select) select.value = '';
    toast(`${optimizationToast(optimized)} It will be embedded when you save the nation.`);
  } catch (error) {
    toast(`Flag optimization failed: ${error.message}`, 'error');
  }
  state.flagTarget = null;
});


document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); doExport(); }
  if (event.key === 'Escape') { closeModal(); $('.details-drawer')?.remove(); }
});
window.addEventListener('beforeunload', event => { if (state.db?.dirty) { event.preventDefault(); event.returnValue = ''; } });

await loadFlags();
render();
