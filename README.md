# GTA VI trophy rarity forecast

Entry for make.fun's `gta6-trophy-rarity-forecast-01` ($250, 20 places).
Forecasts, for each of the 55 GTA VI PS5 trophies, the Exophase earn rate
at 2026-11-26 00:00 UTC as five quantiles (5/25/50/75/95%), from the
house's recorded reads up to the case checkpoint.

## Run

Node 22, standard library only, offline:

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads every `*.in` in the input directory and writes `/output/<id>.out`
for each. Deterministic: two runs on the same case write identical bytes.
Runs in ~0.2 s per case.

## Model (one paragraph)

Exophase republishes a game's counts in jumps, hours apart, so a trophy's
rate is really `holders / players tracked` at the last jump. This program
models those two counts separately and divides them at the target: log
players and log holders per trophy are fitted against log time since
release over the last 24 hours of reads, with per-trophy slopes shrunk
toward the cross-trophy median. When the history has never jumped, a prior
from the launch-night refresh published in the rules is used instead
(players x6.06, holders +34%, median tilted 10% down). Spread is a
logit-scale random walk growing with the horizon, floored by a jump term.
See `METHOD.md` for the full reasoning and the validation numbers.
