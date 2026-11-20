# Method

## The quantity being forecast

A trophy's Exophase rate is `holders / players tracked`, printed to two
decimals. The page is not live: the house's own account says it sat
unchanged (638 players, every rate fixed) from the first probe on launch
night until a refresh between 04:00Z and 04:30Z on 2026-11-19, which took
it to 3,868 players and 4,276 trophies earned. A read is therefore a
snapshot as of the last refresh before it, and the answer is a snapshot as
of the last refresh before the target. Two forces move a rate between
snapshots, in opposite directions:

- **Dilution.** A refresh adds newly tracked players, who hold almost no
  trophies yet. In the first refresh, players grew x6.06 while the 54
  non-100% trophies gained only 103 holders between them (4,276 total
  trophies earned, minus 3,868 for the trophy at 100%, minus the 305 those
  54 trophies held before). Dilution drags every rate down hard.
- **Progression.** The players already tracked keep playing and earning.
  Over days this pushes holders up, fastest for early story trophies,
  slowest for the platinum and late-game trophies.

Modelling the rate directly confuses the two. The program models the two
counts separately and divides at the target.

## The model

For each case, in order:

1. **Collapse the history to distinct states.** Consecutive identical
   reads are one state, stamped with the first time it was seen. A flat
   stretch carries no information about growth; keeping every copy would
   only fake confidence in the fits.
2. **Players at the target.** Least squares of log players on
   `ln(1 + hours since release)` over the last 24 hours of distinct
   states. The slope is clamped to [0, 1.5] (players never shrink, and
   growth decelerates in log time). Extrapolated to the target, capped at
   40x the last count.
3. **Holders at the target, per trophy.** Least squares of
   `ln(holders + 0.5)` on the same log-time axis, per trophy, over the
   same window. Each slope is shrunk toward the median slope across
   trophies (weight `n / (n + 3)` on the trophy's own fit) so a trophy
   with four holders does not get a wild slope of its own, then clamped
   to [-0.2, 2.5]. Holders are extrapolated from the last read and capped
   at the target player count.
4. **Median rate** = holders / players at the target, in percent.
5. **The no-jump prior.** If the history shows no movement at all (one
   distinct state, as in both practice cases), the fits have nothing to
   chew on. The program then assumes the published launch-night refresh
   repeats before the target: players x6.06, holders x1.338 (the
   +103-on-305 derived above), with later jumps smaller (x1.5 players,
   x1.25 holders each) if the horizon spans several refresh intervals.
   The issued median is tilted 10% below that prior's centre, because the
   pinball score punishes an overestimate at the 5% quantile about
   nineteen times harder than an underestimate of the same size.
6. **Spread.** Logit-scale sigma =
   `sqrt(0.30^2 + (0.5 * sqrt(horizon_days))^2 + fit_rms^2)`, where 0.30
   is a jump term that never shrinks to zero (one refresh's worth of
   surprise, even over a 90-minute horizon) and `fit_rms` is the mean
   residual of the holder fits. Quantiles are the median's logit plus
   `z_tau * sigma`, with z = (-1.645, -0.674, 0, 0.674, 1.645). For the
   final (4.5-day horizon) sigma is about 1.1, in line with the house
   baseline's own final spread.
7. **The 100% trophy.** One trophy (`Just Like Paradise`) sits at 100%
   in every read, and the published account says it stayed at 100%
   across the sixfold influx. It is forecast as
   [99.5, 99.9, 99.98, 99.99, 99.99]: near-certain to stay, with only a
   thin lower tail.

Everything is closed-form arithmetic on the case file: no randomness, no
network, no fitted constants beyond the ones above. Output is rounded to
four decimals, rows are forced non-decreasing, and two runs on the same
case write identical bytes.

## Why the fits use only the last 24 hours

Launch growth is not stationary: a trophy's holder curve saturates, so a
slope fitted over the whole launch overshoots the future. On synthetic
final-like cases (two days of history, 5.5-day horizon, saturating
progression curves), fitting the last 24 hours scored 0.26 mean pinball
loss against 0.31 for the full history, and beat the persistence baseline
(0.39-0.52) in every variant. Damping the slopes or blending toward
persistence both scored worse, so neither is used.

## Validation

The kit publishes no practice answers (the server grades them), so the
practice check below is against answers reconstructed from the totals the
rules themselves publish: 3,868 players, 4,276 trophies earned at the
refresh, the 100% trophy unchanged, every other rate lower. The only
unknown in that reconstruction is how the 103 new holders split across
the 54 trophies, so eleven allocations were scored (proportional to old
holders, concentrated in the highest-rate trophies, uniform, pure
dilution, top-five only, inverse, and five lumpy random draws).

| check | this entry | persistence baseline |
|---|---|---|
| practice, mean over 11 reconstructed answers | **0.13** | 1.47 |
| practice, worst of the 11 | **0.17** | 1.69 |
| practice, typical miss (pp) | 0.02-0.07 | 0.68 |
| practice, 90% coverage | 0.87-0.98 | 0.00 |
| synthetic final, 3 variants (mean) | **0.25-0.27** | 0.37-0.52 |

For reference, the rules state the baseline's true practice loss is 1.51;
the reconstruction gives it 1.47, so the reconstructed answers are close
to the real ones and the ~0.13 figure should be read as approximate, not
exact. Either way the entry beats the baseline by an order of magnitude
on the practice and by a clear margin on every synthetic final.

## Biggest uncertainty in extrapolating to the final

The final's horizon (5.5 days) is 88x the practice horizon, and the
practice says nothing about how fast players keep joining Exophase after
day two, nor how quickly the player base progresses through the story.
The model extrapolates both counts as power laws in log time, which is
the right shape early but can overshoot if player growth collapses (e.g.
if most sales happened in the first 48 hours) or undershoot if a weekend
surge arrives. The wide final spread (~1.1 logit) is the honest price of
that: the medians are the model's best guess, the tails admit it could be
wrong by a factor of several either way. A second risk is refresh
staleness: the answer is the page as of the last refresh before the
target, which could lag the true state by hours, and no program can see
that lag coming.
