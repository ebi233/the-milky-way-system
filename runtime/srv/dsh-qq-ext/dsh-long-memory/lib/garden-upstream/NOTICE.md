# Upstream attribution

Source: https://github.com/CyanCat22/plants-vs-zombies
Pinned commit: b13a3808f45a0e784ab507fd388c1b876d9cfbe6
Copyright (c) 2026 CyanCat22. MIT license, reproduced in LICENSE.

`js/config.js` and `js/game.js` are vendored source, unchanged except final newline normalization. The original `tests/engine-check.mjs` is retained as provenance for adapted mechanism tests; it is not needed by the server runtime.

The adjacent `fusion-garden-engine.mjs` is an adaptation layer: it runs the original engine without rendering, makes the random stream serializable, restores grid references, adds fifteen fusion recipes including multi-tier upgrades, auto-collects sun, and exposes bounded actions and snapshots. Combat, original plants and zombies, projectile motion, card cooldowns, ten waves, lawn mowers and end conditions remain upstream logic.

This is an independent fan-game extension, not a full port of the official or Blue Fly PvZ Fusion game. No original game binaries or assets are included.
