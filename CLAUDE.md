# Rigsmith

Start with `docs/rebuild/DESIGN.md` (how it is built), `docs/motion-plan.md` (the Motion step: source time, the track
timeline, events, gear tracks) and `docs/rigging.md` (rigging, weights and naturalization).

## Running
- Dev server: `npm run dev` (port 5180, the workspace in `workspace/`). Characters are schema 3; an older file is migrated
  on first read (its `character.v1.json` / `character.v2.json` kept; a v2 Attack's clips are measured on the rig first, and
  a failed measure leaves the file at v2 to retry); `node tools/migrate.ts --check` migrates and checks the whole workspace.
- Prefer targeted tests (`npx vitest run <files>`); the full suite takes a few minutes.
- Type checks: `npm run check` (the app and the tools).
- Blender jobs run as usual (`blender` on PATH); Codex texture jobs use the owner's Codex quota, so run them only
  when needed.
