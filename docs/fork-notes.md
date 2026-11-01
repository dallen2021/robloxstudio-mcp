# dallen fork notes

This is Daniel's fork of [Chrrxs/robloxstudio-mcp](https://github.com/Chrrxs/robloxstudio-mcp) (MIT), branched from upstream `main` at v3.2.1 (`90e49b9`) and last synced with v3.4.2 (`3efee60`, 2026-11-01). Work lives on the `daniel/main` branch of [dallen2021/robloxstudio-mcp](https://github.com/dallen2021/robloxstudio-mcp/tree/daniel/main). Fork versions carry a suffix: **`3.4.2-dallen.1`**. The server and the Studio plugin must be the same build (the plugin's `/ready` handshake rejects a version mismatch), so both are built from this checkout and nothing is ever fetched from npm or GitHub releases.

Why the fork exists: several AI agents (Claude Code, Codex) share one Mac and one Studio install. Each agent runs its own stdio server; upstream lets any of them address any open place by `instance_id`. The evaluation that led here is `docs/handoffs/robloxstudio-mcp-evaluation-2026-10-18.md` in the RobloxDev workspace.

## What changed

| Change | Where | Why |
|---|---|---|
| **Per-agent place pin** (`ROBLOX_STUDIO_PLACE`, `ROBLOX_STUDIO_REQUIRE_PIN`, `pin_place` tool) | `packages/core/src/place-pin.ts`, the `invoke` choke point in `server.ts` | An agent's stdio process can only reach its own places. Other ids get a `pin_violation` error. `get_connected_instances` lists only pinned places. |
| **Token-gated `/health` detail** | `http-server.ts` | Tokenless callers get liveness only (status, version, counts); place names, instance ids and peers need `X-MCP-Auth`. `ROBLOX_STUDIO_PUBLIC_HEALTH=1` restores upstream output (upstream's native e2e tests read it). `scripts/studio-lifecycle.mjs` now sends the token. |
| **macOS `manage_instance close` refuses cleanly** | `studio-instance-manager.ts` (`MacStudioCloseUnsupportedError`) | Studio on macOS ignores SIGTERM; upstream timed out after 10 s and left the process running. Now it fails at once, signals nothing, and says to use `tools/studio-background/studio.sh close <place>` (or `discard` for a QA copy). Launch and status still work. |
| **Read-only DataStore tools** `read_datastore`, `list_datastore_keys` | `opencloud-client.ts`, `tools/index.ts` | Ported from roblox-studio-mcp 0.3. Need `ROBLOX_OPEN_CLOUD_API_KEY` (DataStore read scope). No write/delete tools by design. |
| **Version-pinned, local-only plugin install** | root and package `package.json` versions, `plugin-installer.ts`, `studio-plugin/src/modules/Communication.ts` | `--install-plugin` no longer downloads from `chrrxs/robloxstudio-mcp` releases; a missing local build is an error with the build command. The plugin's npm "update available" check is removed (upstream's `latest` always looks newer than a `-dallen` build and would not match the server). |

Upstream tests changed only where the fork changes behaviour (catalog size/budget counts for the three new tools, the removed download path, the skipped macOS SIGTERM-close tests). New tests: `packages/core/src/__tests__/place-pin.test.ts`.

## Pin semantics

Keys, comma-separated (the same as roblox-studio-mcp 0.3 `placePin.ts`):

- `MyGame.rbxl`: exact place file name;
- `MyGame*`: file-name prefix (matches `MyGame.rbxl`, `MyGame-QA.rbxl`); a bare `*` matches nothing;
- `75957892832285`: numeric place id (a place opened from Roblox reports its id).

| Setting | Effect |
|---|---|
| neither variable | Upstream behaviour: every open place is reachable. |
| `ROBLOX_STUDIO_PLACE=<keys>` | Pinned at start. |
| `ROBLOX_STUDIO_REQUIRE_PIN=1` (no keys) | Every Studio-routed tool is refused until `pin_place`. Docs, Creator Store search and other non-Studio tools still work. |
| `pin_place {"places": ["MyGame*", "123"]}` | Replaces the pin at runtime; returns the pin and the matching places. |

Enforcement, per tool call (every tool whose schema has `instance_id` or `multiplayer_group_id`):

- with no `instance_id`, the single pinned place is injected; if none is open, or several pinned places are open, the call is refused and says which;
- an `instance_id` must resolve to a pinned place, its solo-Play peers (`server`, `client-1`, same instance), or a runtime instance of a multiplayer group whose controller is pinned; `multiplayer_group_id` and `cursor_by_instance` are checked the same way;
- `manage_instance`: `status` and `list_place_versions` are always allowed; `launch` only for a pinned file name or place id; `close` only for a pinned instance.

This is advisory isolation between cooperating agents. They share one machine-wide auth token, and the HTTP `/mcp` endpoint (token-only) is not pinned. It matches the guarantee of our old bridge.

## Build and install

Node 22+ (we use `/opt/homebrew/opt/node@24/bin/node`).

```sh
cd /Users/daniel/Desktop/RobloxDev/robloxstudio-mcp-fork
npm ci --ignore-scripts                      # root workspaces
npm --prefix studio-plugin ci --ignore-scripts
npm run build                                # server: packages/*/dist
npm run build:plugin:artifact                # plugin: studio-plugin/MCPPlugin.rbxmx (3.4.2-dallen.1), no install
npm test -w packages/core                    # unit tests
mkdir -p ~/Documents/Roblox/plugin-backups && cp -Rp ~/Documents/Roblox/Plugins ~/Documents/Roblox/plugin-backups/Plugins-$(date -u +%Y%m%dT%H%M%SZ)   # back up first
node packages/robloxstudio-mcp/dist/index.js --install-bundled-plugin   # -> ~/Documents/Roblox/Plugins/MCPPlugin.rbxmx
```

The plugin file is `MCPPlugin.rbxmx`; our old bridge's plugin is `MCPPlugin.rbxm`. Studio loads both (verified 2026-10-18); the installer only ever removes `MCPInspectorPlugin.rbxmx`. Restart Studio processes to load a new plugin build. Never use `--auto-install-plugin`, `npx @chrrxs/robloxstudio-mcp@latest`, or an upstream release asset with this server.

Run one stdio server per agent session, e.g. for an MCP client entry:

```sh
ROBLOX_STUDIO_REQUIRE_PIN=1 /opt/homebrew/opt/node@24/bin/node \
  /Users/daniel/Desktop/RobloxDev/robloxstudio-mcp-fork/packages/robloxstudio-mcp/dist/index.js
```

The first process binds `127.0.0.1:58741` (primary); later ones run in proxy mode and forward to it. The pin is enforced in each agent's own process, so it holds in both modes.

## Bumping the fork version

Change `"version"` in `package.json`, `packages/core/package.json`, `packages/robloxstudio-mcp/package.json`, `packages/robloxstudio-mcp-inspector/package.json` and the matching `package-lock.json` entries (e.g. `3.4.2-dallen.2`), rebuild both server and plugin, reinstall the plugin, and restart Studio processes and agent sessions. A server and plugin from different builds will refuse to connect.

## Syncing with upstream

Upstream is [Chrrxs/robloxstudio-mcp](https://github.com/Chrrxs/robloxstudio-mcp), remote `upstream` (push disabled). Never push to it.

```sh
npm run sync-upstream -- --check     # how far behind daniel/main is, and the upstream commits
npm run sync-upstream                # merge the latest release tag (or pass one: -- v3.5.0)
```

`scripts/sync-upstream.sh` works in its own worktree (`/tmp/rsmcp-sync-<tag>`, branch `sync/upstream-<tag>` from `origin/daniel/main`), so the live checkout and its `dist/` are never touched. It merges, resolves version-only conflicts to `<tag>-dallen.1`, commits, then runs `npm run verify-fork`: `npm ci`, build, typecheck, the full `npm test`, `scripts/mcp-smoke.mjs` (initialize and tools/list on a private port with a throwaway token and a required pin, so no Studio attaches) and the plugin artifact build. Any other conflict stops it with the file list; resolve by keeping the edits marked `dallen fork`, commit, and run `npm run verify-fork` in the worktree.

After it passes:

1. Check the patch list below by hand, then `git diff upstream/<tag>` should show only our patch (about 25 files).
2. `git push -u origin sync/upstream-<tag>`, then fast-forward `daniel/main` to it and push.
3. Deploying is separate, and changes the server every agent runs: in the live checkout, `git pull`, `npm ci --ignore-scripts`, `npm run build`, `npm run build:plugin:artifact`, back up and reinstall the plugin (see [Build and install](#build-and-install)), then restart Studio processes and agent sessions together. A server and plugin from different builds refuse to connect.

Patch checklist after each merge: `invoke` in `server.ts` still calls `pinGuard.check`; any new Studio tool has `instance_id` in its schema (the `tool-schema` test enforces this, and `place-pin.test.ts` then covers it); `plugin-installer.ts` still has no download path; `Communication.ts` `checkForUpdates` is still a no-op; `/health` still redacts; the catalog budgets in `mcp-runtime.test.ts` stay upstream's plus about 2,000 characters for our three tools.

Known conflict spots: the four `package.json` versions and `package-lock.json` (handled by the script), the catalog counts and budgets in `mcp-runtime.test.ts`, and the imports in `mcp-runtime.ts`.
