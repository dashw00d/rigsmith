# Incoming deliveries

The gear tool publishes complete deliveries to `incomingDir` in workspace `settings.json` (default `<workspace>/incoming`). Write a folder named `.<id>.partial`, write its files and `manifest.json` last, then rename the folder to `<id>`. Rigsmith ignores dot folders and folders without a readable manifest and never writes into the delivery folder. Package and part IDs use letters, digits, `_` or `-` and start with a letter or digit.

```json
{
  "schema": 1, "id": "norse_a-20261107-1", "at": "2026-11-07T12:00:00Z", "tool": "gear-tool 1.0", "space": "v6",
  "parts": [{ "id": "Outfit_norse_a_torso", "type": "piece", "file": "parts/torso.glb", "sha256": "<64 hex digits>", "name": "Norse torso", "from": "emberhold:gear/Outfit_norse_a_torso", "preview": "previews/torso.png", "set": "norse_a", "policy": "upper", "hideBody": true, "tags": ["covers-hair"] }],
  "sets": [{ "id": "norse_a", "name": "Norse A", "pieces": ["Outfit_norse_a_torso"], "tags": ["culture:norse"] }]
}
```

Types `piece`, `hair`, and `beard` require GLB files; `clothes` and `skin` require RGBA PNGs on the body UVs. `space: v6` means v6 metres. `from` is the source identity used to recognize updates. Optional part metadata includes `role` (`hair` or `beard`), `swapSet`, `hair`, and `slots`. Policies are `upper`, `lower`, or `head`. Unknown fields are ignored. Each path is relative to the package, with no `..`, backslashes, or symlinks; files must exist, be at most 200 MiB and match their SHA-256. Invalid parts are listed with `damaged` and a reason.

Run `node tools/incoming.ts validate /path/to/.<id>.partial` before publishing. It also accepts a published `<id>` folder, prints `OK` on success and exits nonzero on errors.

`GET /api/incoming?character=<id>` lists packages, parts, status and effect plus a pending count. `POST /api/incoming/reject` and `/restore` take `{ "package": "id", "parts": ["part-id"] }`; mutations need the `x-rigsmith: 1` header. State is saved in `<workspace>/incoming-state.json`; a changed SHA is pending again. `/files/incoming/<package>/<path>` is read-only. The event stream emits `incoming` with `{pending}` after changes. Accepting deliveries and the drawer are added in subsequent waves.
