# Rigsmith rebuild sandbox

This checkout (`/home/ryan/dev/games/rigsmith-rebuild`, branch `rebuild`) is a sandbox for reworking Rigsmith while
the owner keeps using the real tool. Start with `docs/rebuild/PLAN.md` (the plan) and the seven inventories beside it.

## Boundaries
- Never write to `/home/ryan/dev/games/rigsmith` (the owner's live tool and workspace) or to
  `/home/ryan/dev/games/emberhold` (the game). Reading them is fine.
- `workspace/` here is a private copy (characters, library, game spec, settings) made on 2026-10-28. Change it
  freely; it is not backed up and can be recopied. Settings point the game repo at `workspace/game-sandbox` (a copy
  of the game's `tools/rigsmith` only), so game exports land there and its `build.sh` will not find the game's assets.
- Work on the `rebuild` branch. Do not push, merge into `main`, or rewrite `main`.

## Running
- Dev server: `npx vite --port 5190` (the owner's tool uses 5180). It uses this checkout's `workspace/`.
- Prefer targeted tests (`npx vitest run <files>`); the full suite takes ~80 s.
- Type checks: `npx svelte-check --threshold error`, `npx tsc -p tools --noEmit`.
- Blender jobs run as usual (`blender` on PATH); Codex texture jobs use the owner's Codex quota, so run them only
  when needed.
