export const DATABASE_SETTINGS_VERSION = 1;
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
  prizeMoneyScale: null
});

const numberOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const inheritedScale = (value) => value === '' || value == null ? null : clamp(numberOr(value, 1), 0.01, 4);

export function normalizeDatabaseSettings(value = null, fallbackYear = 2026) {
  const raw = value && typeof value === 'object' ? value : {};
  return {
    version: DATABASE_SETTINGS_VERSION,
    eraYear: Math.round(clamp(numberOr(raw.eraYear, fallbackYear || 2026), 1850, 2200)),
    financeScale: clamp(numberOr(raw.financeScale, 1), 0.01, 4),
    annualInflation: clamp(numberOr(raw.annualInflation, 0), -0.05, 0.15),
    globalizationFactor: clamp(numberOr(raw.globalizationFactor, 1), 0, 2),
    transferMarketActivity: clamp(numberOr(raw.transferMarketActivity, 1), 0.1, 2),
    attendanceScale: clamp(numberOr(raw.attendanceScale, 1), 0.1, 3),
    youthInternationalization: clamp(numberOr(raw.youthInternationalization, 1), 0, 2),
    transferValueScale: inheritedScale(raw.transferValueScale),
    wageScale: inheritedScale(raw.wageScale),
    clubRevenueScale: inheritedScale(raw.clubRevenueScale),
    prizeMoneyScale: inheritedScale(raw.prizeMoneyScale)
  };
}

export function ensureDatabaseSettings(data, fallbackYear = 2026) {
  if (!data || typeof data !== 'object') return normalizeDatabaseSettings(null, fallbackYear);
  data.metadata = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
  const year = Number(data.metadata.startYear || String(data.metadata.startDate || '').slice(0, 4) || fallbackYear || 2026);
  data.metadata.databaseSettings = normalizeDatabaseSettings(data.metadata.databaseSettings, year);
  return data.metadata.databaseSettings;
}
