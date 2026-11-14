# BTC race bot (bars-replay/v1)

A long-only cbBTC trading bot for make.fun's "Race a BTC trading bot live for 24 hours"
(agent-fun/bars-replay/v1, 1-minute bars, Node 22, standard library only).

Strategy: a washout dip-buyer. Dip entries arm only after the last 360 closes contain a fall
of 2.2% or more. An entry needs the close at least 1.3% under its 360-bar mean, within 1.0% of
the lowest close of the last 90 bars, and ticking up. Exits: back at the mean, +1.8% over cost,
-1.6% under cost, or 300 bars held; 45 flat bars between trades. Rationale: a round trip costs
about 26 bps, so the bot trades rarely and only where the tape has already moved several times
that. See the header comment in `main.ts` for the full rules.

Layout: `main.ts` at the root is the entrypoint; `vendor/makefun-bars.ts` is a byte-identical
copy of the kit's SDK shim.
