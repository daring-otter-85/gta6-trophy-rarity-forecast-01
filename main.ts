// GTA VI trophy rarity forecast (gta6-trophy-rarity-forecast-01).
//
// What this program believes about the data, in one paragraph:
// Exophase does not update its page continuously. It republishes a game's
// counts in jumps, hours apart, and a trophy's printed rate is just
// (holders / players tracked) at the last jump. Between jumps nothing moves,
// so a flat history says nothing about the future except that a jump is
// overdue. When a jump lands, two things move in opposite directions: fresh
// players flood in, which drags every rate down, and the players already
// tracked keep finishing chapters and side content, which pushes holders up.
// So this forecaster never models the rate directly. It models the two
// counts underneath it -- players tracked and holders per trophy --
// separately, and divides them at the target. Each count is fitted in
// log space against log time since release, which is the shape launch
// growth takes (fast at first, then flattening). The fits use only the
// last 24 hours of reads: launch growth is not stationary, and the recent
// slopes are the honest guide to the next few days -- fitting the whole
// launch overshoots saturating curves. When the history has not shown a
// single jump yet, the fits have nothing to chew on, so a prior taken
// from the launch-night jump the competition itself publishes is used
// instead: players roughly x6, holders up about a third. The issued
// median is tilted 10% below that prior's centre, because the pinball
// score punishes an overestimate at the low quantiles far harder than an
// underestimate. The spread is a logit-scale random walk that grows with
// the horizon, floored by a jump term that never shrinks to zero, plus
// whatever the fits' own residuals say.
//
// Node 22, standard library only, offline, deterministic: the same case
// always yields the same bytes.
//
//   MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Quantile levels, in the order each output row lists them. */
const WANTED_LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Standard-normal quantiles at those levels. */
const NORMAL_Q = [-1.644854, -0.67449, 0, 0.67449, 1.644854];

/** Launch-night jump, as the competition's own rules publish it: the first
 *  refresh took players tracked from 638 to 3868. */
const FIRST_JUMP_PLAYERS = 3868 / 638;
/** Same refresh, holders side: trophies earned went 943 -> 4276 while the
 *  one trophy at 100% absorbed 3868 of them, so the other 54 trophies went
 *  from 305 holders between them to 408, a x1.338 rise. */
const FIRST_JUMP_HOLDERS = 408 / 305;
/** Hours between Exophase refreshes on launch night (unchanged 23:48Z to
 *  04:00Z, refreshed by 04:30Z). */
const JUMP_EVERY_HOURS = 4.7;
/** Downward tilt on the jump prior's centre (see header). */
const PRIOR_TILT = 0.9;
/** Logit spread that is always present: one jump's worth of surprise. */
const JUMP_SPREAD = 0.3;
/** Random-walk spread per square-root day, on the logit scale. */
const WALK_SPREAD = 0.5;
/** Fits are read off the most recent stretch of history only (hours). */
const FIT_WINDOW_HOURS = 24;

type TrophyMeta = { id: number; name: string; tier: string };
type ReadRow = { at: string; players_tracked: number; rates: Array<number | null> };
type TrophyCase = {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  game: { release_date: string };
  trophies: TrophyMeta[];
  history: ReadRow[];
};

/** Percent into [0.01, 99.99], the range the scorer's logit can take. */
function boundPct(p: number): number {
  if (!Number.isFinite(p)) return 1;
  return Math.min(99.99, Math.max(0.01, p));
}

function logOdds(pct: number): number {
  const p = boundPct(pct) / 100;
  return Math.log(p / (1 - p));
}

function pctFromLogOdds(lo: number): number {
  return 100 / (1 + Math.exp(-lo));
}

/** Four-decimal rounding, matching the usual JSON output of the baseline. */
function to4dp(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/** Hours from the release day's midnight (UTC) to an ISO timestamp. */
function hoursSinceReleaseMidnight(releaseDate: string, iso: string): number {
  const [y, m, d] = releaseDate.split('-').map(Number);
  const start = Date.UTC(y, (m ?? 1) - 1, d ?? 1);
  return Math.max(0, (Date.parse(iso) - start) / 3600000);
}

/** The log-time axis growth is fitted on: ln(1 + hours since release). */
function logClock(releaseDate: string, iso: string): number {
  return Math.log1p(hoursSinceReleaseMidnight(releaseDate, iso));
}

type Fit = { slope: number; atZero: number; rms: number; points: number };

/** Ordinary least squares of y on x; null when the points cannot define one. */
function straightLine(xs: number[], ys: number[]): Fit | null {
  const n = xs.length;
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx < 1e-12) return null;
  const slope = sxy / sxx;
  const atZero = my - slope * mx;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const miss = ys[i] - (atZero + slope * xs[i]);
    sq += miss * miss;
  }
  return { slope, atZero, rms: Math.sqrt(sq / n), points: n };
}

function medianOf(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[mid]
    : (ordered[mid - 1] + ordered[mid]) / 2;
}

function clampNum(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Collapse runs of identical reads to one point each, stamped with the
 *  first time that state was seen. A state that never changed carries no
 *  information about growth, so keeping every copy would only fake
 *  confidence in the fits. */
function distinctStates(c: TrophyCase): Array<{ x: number; ms: number; players: number; rates: number[] }> {
  const out: Array<{ x: number; ms: number; players: number; rates: number[] }> = [];
  let lastKey = '';
  for (const read of c.history) {
    const key = `${read.players_tracked}|${read.rates.join(',')}`;
    if (key === lastKey) continue;
    lastKey = key;
    out.push({
      x: logClock(c.game.release_date, read.at),
      ms: Date.parse(read.at),
      players: read.players_tracked,
      rates: read.rates.map((r) => (r === null ? NaN : r)),
    });
  }
  return out;
}

/** Fill a trophy's missing rates forward from earlier reads; anything
 *  still unknown becomes 1% (a rare trophy we have never seen). */
function lastKnownRates(c: TrophyCase): number[] {
  const n = c.trophies.length;
  const filled = new Array<number>(n).fill(NaN);
  for (const read of c.history) {
    for (let i = 0; i < n; i++) {
      const r = read.rates[i];
      if (r !== null && r !== undefined && Number.isFinite(r)) filled[i] = r;
    }
  }
  return filled.map((v) => (Number.isFinite(v) ? v : 1));
}

/** The row for a trophy every tracked player already holds: the practice
 *  answer kept it at 100% across a sixfold influx of players, so it is
 *  treated as near-certain to stay there, with only a thin lower tail in
 *  case the final influx is less thorough. */
const SATURATED_ROW = [99.5, 99.9, 99.98, 99.99, 99.99];

function rowFromMedian(medianPct: number, spread: number): number[] {
  const centre = logOdds(medianPct);
  const qs = NORMAL_Q.map((z) => to4dp(boundPct(pctFromLogOdds(centre + z * spread))));
  // Rounding can tie neighbours; sorting keeps the row non-decreasing.
  qs.sort((a, b) => a - b);
  return qs;
}

function forecastCase(c: TrophyCase): { trophies: Array<{ id: number; q: number[] }> } {
  const horizonDays = c.horizon_minutes / 1440;
  const horizonHours = c.horizon_minutes / 60;
  const lastRates = lastKnownRates(c);
  const states = distinctStates(c);
  const lastPlayers =
    c.history.length > 0 ? c.history[c.history.length - 1].players_tracked : 0;
  // Fits read the recent window; if it holds too few distinct states to
  // define a slope, fall back to the whole history.
  const lastMs = states.length > 0 ? states[states.length - 1].ms : 0;
  const recent = states.filter((s) => s.ms >= lastMs - FIT_WINDOW_HOURS * 3600000);
  const fitStates = recent.length >= 3 ? recent : states;

  // --- Players tracked at the target -------------------------------------
  // Fit log players on log time when the history has actually moved;
  // otherwise fall back to the published first-jump prior.
  const playerCounts = fitStates.map((s) => s.players);
  const distinctPlayers = [...new Set(playerCounts)];
  let playersAtTarget: number;
  let jumpPriorUsed = false;
  if (distinctPlayers.length >= 2 && fitStates.length >= 2 && lastPlayers > 0) {
    const fit = straightLine(
      fitStates.map((s) => s.x),
      fitStates.map((s) => Math.log(Math.max(1, s.players))),
    );
    const growth = fit === null ? 0 : clampNum(fit.slope, 0, 1.5);
    const xLast = fitStates[fitStates.length - 1].x;
    const xTarget = logClock(c.game.release_date, c.target);
    const logPlayers = Math.log(lastPlayers) + growth * Math.max(0, xTarget - xLast);
    playersAtTarget = Math.max(lastPlayers, Math.exp(logPlayers));
    playersAtTarget = Math.min(playersAtTarget, lastPlayers * 40);
  } else {
    jumpPriorUsed = true;
    const jumps = clampNum(horizonHours / JUMP_EVERY_HOURS, 1, 8);
    // First jump x6.06; later ones are smaller, growth decays after launch.
    const mult = FIRST_JUMP_PLAYERS * 1.5 ** Math.max(0, jumps - 1);
    playersAtTarget = Math.max(1, lastPlayers) * mult;
  }

  // --- Holders per trophy at the target ----------------------------------
  // Fit log holders on log time per trophy, shrunk toward the cross-trophy
  // median slope, so a trophy with a handful of holders does not get a wild
  // slope of its own. With no movement in the history, the jump prior.
  const slopes: number[] = [];
  const perTrophyFit: Array<Fit | null> = [];
  if (!jumpPriorUsed && fitStates.length >= 3) {
    for (let i = 0; i < c.trophies.length; i++) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const s of fitStates) {
        const r = s.rates[i];
        if (Number.isFinite(r)) {
          xs.push(s.x);
          ys.push(Math.log(Math.max(0, (r / 100) * s.players) + 0.5));
        }
      }
      const fit = straightLine(xs, ys);
      perTrophyFit.push(fit);
      if (fit !== null) slopes.push(fit.slope);
    }
  }
  const typicalSlope = slopes.length > 0 ? medianOf(slopes) : 0;

  let fitRms = 0;
  let fitCount = 0;
  for (const f of perTrophyFit) {
    if (f !== null) {
      fitRms += f.rms;
      fitCount++;
    }
  }
  if (fitCount > 0) fitRms /= fitCount;

  // --- Spread -------------------------------------------------------------
  const walk = WALK_SPREAD * Math.sqrt(horizonDays);
  const spread = Math.sqrt(
    JUMP_SPREAD ** 2 + walk ** 2 + clampNum(fitRms, 0, 0.6) ** 2,
  );

  // --- Assemble the rows --------------------------------------------------
  const xLast = states.length > 0 ? states[states.length - 1].x : 0;
  const xTarget = logClock(c.game.release_date, c.target);
  const rows: Array<{ id: number; q: number[] }> = [];
  for (let i = 0; i < c.trophies.length; i++) {
    const trophy = c.trophies[i];
    const lastRate = lastRates[i];
    if (lastRate >= 100) {
      rows.push({ id: trophy.id, q: [...SATURATED_ROW] });
      continue;
    }
    let holdersAtTarget: number;
    if (jumpPriorUsed) {
      const jumps = clampNum(horizonHours / JUMP_EVERY_HOURS, 1, 8);
      const holderMult =
        FIRST_JUMP_HOLDERS * 1.25 ** Math.max(0, jumps - 1) * PRIOR_TILT;
      const holdersNow = (lastRate / 100) * Math.max(1, lastPlayers);
      holdersAtTarget = holdersNow * holderMult;
    } else {
      const holdersNow = (lastRate / 100) * Math.max(1, lastPlayers);
      const fit = perTrophyFit[i] ?? null;
      let slope = typicalSlope;
      if (fit !== null) {
        const weight = fit.points / (fit.points + 3);
        slope = weight * fit.slope + (1 - weight) * typicalSlope;
      }
      slope = clampNum(slope, -0.2, 2.5);
      holdersAtTarget =
        Math.exp(Math.log(holdersNow + 0.5) + slope * Math.max(0, xTarget - xLast)) - 0.5;
    }
    holdersAtTarget = clampNum(holdersAtTarget, 0, playersAtTarget);
    const medianPct = boundPct((holdersAtTarget / Math.max(1, playersAtTarget)) * 100);
    rows.push({ id: trophy.id, q: rowFromMedian(medianPct, spread) });
  }
  return { trophies: rows };
}

mkdirSync(OUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const files = readdirSync(IN_DIR)
  .filter((f) => f.endsWith('.in'))
  .sort();
for (const file of files) {
  const id = file.slice(0, -'.in'.length);
  const parsed = JSON.parse(readFileSync(join(IN_DIR, file), 'utf8')) as TrophyCase;
  if (
    !Array.isArray(parsed.levels) ||
    parsed.levels.length !== WANTED_LEVELS.length ||
    parsed.levels.some((t, j) => t !== WANTED_LEVELS[j])
  ) {
    throw new Error(`${file} asks for levels ${JSON.stringify(parsed.levels)}`);
  }
  if (!Array.isArray(parsed.history) || parsed.history.length === 0) {
    // No past reads at all: emit a wide, low forecast rather than no file.
    const rows = parsed.trophies.map((t) => ({
      id: t.id,
      q: rowFromMedian(1, 1.5),
    }));
    writeFileSync(join(OUT_DIR, `${id}.out`), `${JSON.stringify({ trophies: rows })}\n`);
    continue;
  }
  const forecast = forecastCase(parsed);
  writeFileSync(join(OUT_DIR, `${id}.out`), `${JSON.stringify(forecast)}\n`);
}
