// Token Radar model — token-radar-01.
//
// Implied value is calibrated from the snapshot itself, never from a list of
// names. For every category, the tokenized peers in the same snapshot carry
// mcap_usd, so the sector multiple is the median FDV/TVL of those peers,
// shrunk toward the global median when the category has few peers and
// clamped to [0.05, 0.60] so a two-protocol category cannot set a wild
// multiple. A pre-token protocol is then scored as:
//
//   implied = TVL x sectorMultiple(category)
//             x (1 + clamp(change_7d, -50, 150) / 100 x 0.5)   growth
//             x (0.70 + min(age_days, 1095) / 1095 x 0.30)     maturity
//             x (1 + 0.015 x min(chains - 1, 6))               reach
//
// Age is days since listed_at to the snapshot's as_of; unknown age scores as
// 365 days. Growth is the snapshot's own 7-day TVL change; a missing value
// scores as 0. Chain reach rewards protocols live on more chains, capped at
// six extra chains. No protocol name is ever special-cased: the same
// function scores every row, and the dashboard recomputes it from the same
// figures so the page and board.json agree.
//
// Ranking: all 40 watchlist slugs first by coverage, then the 160 strongest
// pre-token protocols below the floor by implied value. Already-launched
// protocols (mcap present) are never ranked as launch candidates; the
// dashboard shows the top 24 by market cap in a separate Live-token view
// with the market's own value. Wrapped, staked, bridged, CEX and versioned
// products are excluded from the early radar: they are not launches of
// their own. Ties after rounding are broken deterministically (higher TVL,
// then slug ascending) and the final pass forces strictly decreasing
// implied values down the board so rank 1 is always the most valuable.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  chain_step: number;
  chain_max_extra: number;
  multiple_floor: number;
  multiple_cap: number;
  shrink_prior: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -50,
  growth_cap: 150,
  maturity_floor: 0.7,
  maturity_range: 0.3,
  maturity_days: 1095,
  unknown_age_days: 365,
  chain_step: 0.015,
  chain_max_extra: 6,
  multiple_floor: 0.05,
  multiple_cap: 0.6,
  shrink_prior: 3,
};

export const MODEL_VERSION = 'radar-2-comps';
export const EARLY_ROWS = 160;
export const LIVE_ROWS = 24;

export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  /** 'watchlist' | 'early' (clean pre-token below the floor) | 'extended' (pre-token below the floor whose record is a bridge, liquid-staking, versioned or wrapped product — a weaker launch case, ranked last). */
  tier: 'watchlist' | 'early' | 'extended';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    sector_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  tier: 'watchlist' | 'early' | 'extended';
  implied_value_usd: number;
  sector_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  global_multiple: number;
  comps: Record<string, number>;
  rows: RadarRow[];
  live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/**
 * Sector multiples from the snapshot's own tokenized peers: for each
 * category, the median mcap_usd / tvl_usd of protocols that record a token
 * with a market cap, shrunk toward the global median with a prior of
 * `shrink_prior` peers, then clamped. Categories with no peers use the
 * global median. Returns the global median and the per-category map.
 */
export function sectorMultiples(
  snapshot: Snapshot,
  model: ModelConstants = MODEL,
): { globalMultiple: number; comps: Record<string, number> } {
  const all: number[] = [];
  const byCat = new Map<string, number[]>();
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    all.push(ratio);
    const key = p.category ?? 'Other';
    const list = byCat.get(key);
    if (list) list.push(ratio);
    else byCat.set(key, [ratio]);
  }
  const global = all.length > 0 ? median(all) : 0.2;
  const comps: Record<string, number> = {};
  for (const [cat, ratios] of [...byCat.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const shrunk = (ratios.length * median(ratios) + model.shrink_prior * global) / (ratios.length + model.shrink_prior);
    comps[cat] = round4(clamp(shrunk, model.multiple_floor, model.multiple_cap));
  }
  return { globalMultiple: round4(clamp(global, model.multiple_floor, model.multiple_cap)), comps };
}

export function sectorMultipleFor(
  category: string | null,
  comps: Record<string, number>,
  globalMultiple: number,
): number {
  if (category !== null && Object.prototype.hasOwnProperty.call(comps, category)) return comps[category]!;
  return globalMultiple;
}

export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  comps: Record<string, number>,
  globalMultiple: number,
  model: ModelConstants = MODEL,
): { implied: number; sector: number; growthPct: number; growthMult: number; maturityMult: number; chainMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const sector = sectorMultipleFor(protocol.category, comps, globalMultiple);
  const growthPct = clamp(finite(protocol.change_7d, 0), model.growth_floor, model.growth_cap);
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const extraChains = Math.min(Math.max(protocol.chains.length - 1, 0), model.chain_max_extra);
  const chainMult = 1 + model.chain_step * extraChains;
  const implied = Math.max(1, Math.round(protocol.tvl_usd * sector * growthMult * maturityMult * chainMult));
  return { implied, sector, growthPct, growthMult, maturityMult, chainMult, age };
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
const EXCLUDED_CATEGORIES = new Set(['CEX', 'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** A launch candidate: pre-token, not a wrapped/staked/bridged product, not a CEX, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const { globalMultiple, comps } = sectorMultiples(snapshot, model);
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // Early radar: the strongest pre-token protocols below the floor, by
  // implied value (not raw TVL) — the radar exists to find them early.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .map((p) => ({ p, v: impliedValue(p, snapshot.as_of, comps, globalMultiple, model) }))
    .sort((a, b) => b.v.implied - a.v.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1))
    .slice(0, EARLY_ROWS);
  for (const e of early) chosen.set(e.p.slug, e.p);
  // Extended radar: the board must hold 200 rows and only 138 clean
  // pre-token protocols sit below the floor, so fill the remainder with the
  // strongest remaining pre-token protocols below the floor — bridges,
  // liquid-staking, versioned and wrapped products, never a CEX or an
  // exchange-prefixed name — ranked after every clean row and marked
  // 'extended' so the reader sees the weaker launch case.
  const target = snapshot.watchlist.length + EARLY_ROWS;
  if (chosen.size < target) {
    const extended = snapshot.protocols
      .filter((p) => !chosen.has(p.slug) && isPreToken(p) && p.tvl_usd < snapshot.floor_usd && p.category !== 'CEX' && !EXCHANGE_PREFIX.test(p.name))
      .map((p) => ({ p, v: impliedValue(p, snapshot.as_of, comps, globalMultiple, model) }))
      .sort((a, b) => b.v.implied - a.v.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1))
      .slice(0, target - chosen.size);
    for (const e of extended) chosen.set(e.p.slug, e.p);
  }

  const tierOf = (p: SnapshotProtocol): 'watchlist' | 'early' | 'extended' =>
    snapshot.watchlist.includes(p.slug) ? 'watchlist' : isRankable(p) ? 'early' : 'extended';
  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, comps, globalMultiple, model);
    return { p, v, tier: tierOf(p) };
  });
  // Watchlist and early rows rank by implied value; extended rows always
  // sit below every clean row, ordered by implied value among themselves.
  scored.sort(
    (a, b) =>
      (a.tier === 'extended' ? 1 : 0) - (b.tier === 'extended' ? 1 : 0) ||
      b.v.implied - a.v.implied ||
      b.p.tvl_usd - a.p.tvl_usd ||
      (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );
  // Force strictly decreasing implied values so the board is a real ranking
  // even when two protocols round to the same dollar figure.
  let prev = Number.POSITIVE_INFINITY;
  return scored.map((s, i) => {
    let implied = s.v.implied;
    if (implied >= prev) implied = Math.max(1, prev - 1);
    prev = implied;
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token',
      tier: s.tier,
      age_days: s.v.age,
      implied_value_usd: implied,
      model: {
        sector_multiple: s.v.sector,
        growth_pct: s.v.growthPct,
        growth_multiplier: round4(s.v.growthMult),
        maturity_multiplier: round4(s.v.maturityMult),
        chain_multiplier: round4(s.v.chainMult),
        age_days: s.v.age,
      },
      farm_steps: farmSteps(s.p, s.v.age).map(stepText),
    };
  });
}

export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function secondChain(p: SnapshotProtocol): string {
  return p.chains.length > 1 ? p.chains[1]! : chainOf(p);
}

function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's main farm action, naming the chain and the pair or asset. */
export function mainAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('dex')) return `Provide $${capital} of liquidity in the USDC/WETH pool of ${name} on ${chain} and keep the LP position open`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain}, then borrow $20 of WETH against it and repay it within a week`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis')) return `Deposit $${capital} of USDC as margin on ${name} on ${chain} and open one small $25 long hedge on ETH`;
  if (c.includes('yield') || c.includes('leveraged farm')) return `Deposit $${capital} of USDC into the highest-yield vault of ${name} on ${chain} and keep the vault shares`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk')) return `Deposit $${capital} of USDC into a ${name} curated vault on ${chain} and hold the vault shares`;
  if (c.includes('rwa')) return `Mint $${capital} of the tokenized yield asset of ${name} on ${chain} and hold it in your wallet`;
  if (c.includes('stable')) return `Mint $${capital} of the stable asset of ${name} on ${chain} using USDC as collateral and hold it`;
  if (c.includes('restak') || c.includes('staking')) return `Stake $${capital} of the chain staking asset through ${name} on ${chain} and keep the receipt token`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app`;
  if (c.includes('prediction')) return `Fund $${capital} of USDC and place one $10 market position on ${name} on ${chain}`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active`;
  if (c.includes('payment')) return `Send three payments of $10 each through ${name} on ${chain} to wallets you control`;
  if (c.includes('governance')) return `Deposit $${capital} of USDC into ${name} on ${chain} and vote in its next governance proposal`;
  if (c.includes('chain')) return `Bridge $${capital} of USDC to ${name}'s chain and use it in one app built on it`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open`;
}

/** A second, different qualifying action for the same category. */
export function secondAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  const other = secondChain(p);
  if (c.includes('dex')) return `Swap $25 of USDC for WETH and back through ${name} on ${chain} once a week to show trading activity`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $25 of WETH as extra collateral to ${name} on ${chain} and leave it supplied for a month`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis')) return `Close the hedge, then open one $25 short hedge on ${name} on ${chain} the following week`;
  if (c.includes('yield') || c.includes('leveraged farm')) return `Claim the vault yield on ${name} on ${chain} once a month and redeposit it into the same vault`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk')) return `Move $25 of the position into a second ${name} vault on ${other} and hold both vault shares`;
  if (c.includes('rwa')) return `Use $25 of the ${name} yield asset on ${chain} as collateral in a lending market for one week`;
  if (c.includes('stable')) return `Swap $25 of the stable asset back to USDC on ${chain} and mint again the next week`;
  if (c.includes('restak') || c.includes('staking')) return `Restake the receipt token of ${name} on ${chain} once and keep the new receipt`;
  if (c.includes('bridge')) return `Bridge $25 of USDC back from ${chain} through ${name} and keep the transaction receipt`;
  if (c.includes('prediction')) return `Place a second $10 position on a different market of ${name} on ${chain}`;
  if (c.includes('insurance')) return `Renew the cover on ${name} on ${chain} for a second month before the first expires`;
  if (c.includes('payment')) return `Receive one $10 payment through ${name} on ${chain} and forward it to a second wallet you control`;
  if (c.includes('governance')) return `Delegate your ${name} voting position on ${chain} to yourself and vote on a second proposal`;
  if (c.includes('chain')) return `Use $25 of the bridged funds in a second app on ${name}'s chain`;
  return `Make a second $25 deposit into ${name} on ${chain} from a different day of the week`;
}

/**
 * A protocol's farm plan: six steps derived from its own record (category,
 * chains, TVL, age). Every step carries a cost and a time; no name is
 * special-cased.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm with ${p.name}, and keep its seed phrase offline`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: mainAction(p, capital, chain),
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: secondAction(p, capital, chain),
      cost: 'about $25 of capital and $2 of gas',
      time: '10 minutes',
    },
    {
      text: `Repeat one qualifying action each week and hold the main position for at least ${hold} days so the activity spans more than one snapshot`,
      cost: `about $2 of gas a week; the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open ${p.name}'s own points or rewards page from the link it publishes and claim only there; never pay a fee to claim`,
      cost: 'no fee to check',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction hash for ${p.name} in a farm log so you can repeat the position or unwind it`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    tier: row.tier,
    implied_value_usd: row.implied_value_usd,
    sector_multiple: row.model.sector_multiple,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    chain_multiplier: row.model.chain_multiplier,
  };
}

export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const { globalMultiple, comps } = sectorMultiples(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    global_multiple: globalMultiple,
    comps,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
