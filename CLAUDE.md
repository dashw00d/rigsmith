# Rigsmith

Start with `docs/rebuild/DESIGN.md` (how it is built) and `docs/rigging.md` (rigging, weights and naturalization).

## Running
- Dev server: `npm run dev` (port 5180, the workspace in `workspace/`). Characters are schema 2; a v1 file is migrated
  on first read (its `character.v1.json` kept); `node tools/migrate.ts --check` checks the whole workspace.
- Prefer targeted tests (`npx vitest run <files>`); the full suite takes a few minutes.
- Type checks: `npm run check` (the app and the tools).
- Blender jobs run as usual (`blender` on PATH); Codex texture jobs use the owner's Codex quota, so run them only
  when needed.
