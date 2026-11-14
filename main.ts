// SPDX-License-Identifier: MIT
//
// Washout dip-buyer for agent-fun/bars-replay/v1 (cbBTC, 1-minute bars, long only, one position).
//
// Why this shape: a full-size round trip costs about 26 bps in fees, slippage and pool impact,
// and BTC spends most of a day chopping inside a band a few percent wide. Chasing every trend
// wiggle pays that toll again and again and bleeds out (the kit's own trend and momentum
// baselines all finish the dev window under water). This bot instead trades the one pattern a
// choppy tape keeps paying for: a real washout followed by a stretched dip that starts to turn.
//
// Rules:
//   - Arming: once the last 360 closes contain a fall of 2.2% or more from their high to their
//     low, the tape has shown it can wash out, and dip entries are armed for the rest of the
//     window. Before that the bot holds cash: there is no dip worth buying yet.
//   - Entry, when flat and armed: the close sits at least 1.3% under its 360-bar mean, within
//     1.0% of the lowest close of the last 90 bars (buying the low, not the middle of the air),
//     and the close is above the previous bar's close (the fall has actually paused). Full size:
//     the stake is the whole account, capped by the harness's max weight and the cash on hand.
//   - Exit, the whole position, first reason that fires: the close is back at or above its
//     360-bar mean (the dip has mean-reverted), the position is worth 1.8% over its cost (take
//     profit), it is worth 1.6% under its cost (hard stop), or it has been held 300 bars
//     (time stop: a dip that has not reverted in five hours is not a dip, it is a downtrend).
//   - After an exit the bot waits 45 bars before the next entry, so one washout is not bought
//     three times on the way down.
//
// All decisions read only the bars and the account the harness sends, in float64 and integer
// arithmetic, so two runs over the same window send the same orders byte for byte.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** Bars in the reference mean, and in the arming window. */
const REF_BARS = 360;
/** A fall of this size inside the arming window arms dip entries (2.2%). */
const ARM_FALL = 0.022;
/** Enter only this far under the reference mean (1.3%). */
const DIP_UNDER_MEAN = 0.013;
/** Enter only within this of the last 90 bars' lowest close (1.0% above it at most). */
const NEAR_LOW_BARS = 90;
const NEAR_LOW = 0.01;
/** Leave a position held longer than this many bars (5 hours). */
const MAX_HOLD_BARS = 300;
/** Bars flat after an exit before the next entry. */
const COOLDOWN_BARS = 45;
const BUY_SLIPPAGE_BPS = 150;
const SELL_SLIPPAGE_BPS = 250;

interface Series {
  /** Every close seen for this symbol, warm-up included, oldest first. */
  closes: number[];
  /** True once the arming window has held a fall of ARM_FALL from high to low. */
  armed: boolean;
  /** The bars counter at the last exit this bot decided on the symbol. */
  lastExitBar: number;
}

const series = new Map<string, Series>();
/** Batches each open position has been present for, per symbol. */
const heldBars = new Map<string, number>();

function push(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = { closes: [], armed: false, lastExitBar: -1_000_000 };
    series.set(bar.symbol, s);
  }
  s.closes.push(Number(bar.c));
  if (!s.armed && s.closes.length >= REF_BARS) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = s.closes.length - REF_BARS; i < s.closes.length; i++) {
      const c = s.closes[i]!;
      if (c > hi) hi = c;
      if (c < lo) lo = c;
    }
    if (hi > 0 && lo / hi - 1 <= -ARM_FALL) s.armed = true;
  }
  return s;
}

/** Mean of the last `n` closes, or null while fewer than `n` were seen. */
function meanOf(s: Series, n: number): number | null {
  if (s.closes.length < n) return null;
  let sum = 0;
  for (let i = s.closes.length - n; i < s.closes.length; i++) sum += s.closes[i]!;
  return sum / n;
}

await runBars({
  onBatch(state, batch) {
    const fresh = new Map<string, Series>();
    for (const bar of batch.bars) fresh.set(bar.symbol, push(bar));
    if (state.warmingUp) return [];

    const { caps, fees } = state.hello;
    const orders: (SellInput | BuyInput)[] = [];
    let cash = state.cash;

    for (const { symbol } of state.hello.symbols) {
      const s = fresh.get(symbol);
      if (s === undefined) continue; // no bar this minute: nothing to decide on
      const held = state.positions.get(symbol);
      const close = s.closes[s.closes.length - 1]!;
      const barIndex = s.closes.length;

      if (held !== undefined) {
        const bars = (heldBars.get(symbol) ?? 0) + 1;
        heldBars.set(symbol, bars);
        const value = state.value(symbol, held.qty);
        const mean = meanOf(s, REF_BARS);
        let exit = false;
        if (mean !== null && close >= mean) exit = true; // the dip reverted to its mean
        if (value * 1000n >= held.cost * 1018n) exit = true; // take profit: worth 1.8% over cost
        if (value * 1000n <= held.cost * 984n) exit = true; // hard stop: worth 1.6% under cost
        if (bars > MAX_HOLD_BARS) exit = true; // time stop
        if (exit && orders.length < caps.max_orders_per_bar) {
          orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: SELL_SLIPPAGE_BPS });
          s.lastExitBar = barIndex;
        }
        continue;
      }

      heldBars.delete(symbol);
      if (!s.armed) continue;
      if (barIndex - s.lastExitBar < COOLDOWN_BARS) continue;
      const mean = meanOf(s, REF_BARS);
      if (mean === null || !(close / mean - 1 < -DIP_UNDER_MEAN)) continue;
      let lo = Infinity;
      for (let i = s.closes.length - NEAR_LOW_BARS; i < s.closes.length; i++) {
        const c = s.closes[i]!;
        if (c < lo) lo = c;
      }
      if (!(close / lo - 1 <= NEAR_LOW)) continue; // not at the low: mid-air is not a dip
      const prev = s.closes[s.closes.length - 2];
      if (prev === undefined || !(close > prev)) continue; // the fall has not paused yet

      const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
      let notional = state.equity;
      if (notional > byWeight) notional = byWeight;
      if (notional > cash) notional = cash;
      if (notional === 0n || notional < BigInt(fees.min_notional_quote_units)) continue;
      if (orders.length >= caps.max_orders_per_bar) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: BUY_SLIPPAGE_BPS });
      cash -= notional;
    }
    return orders;
  },
});
