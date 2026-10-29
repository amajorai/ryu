# Companion native proof fixture (not executed)

Run only under the main thread's resource schedule. This fixture serves the
compiled desktop host's actual development URL `http://localhost:5173`.

Suggested server command from `apps/desktop`:

```sh
rtk proxy bunx vite --config e2e/harness/companion-native-proof/vite.config.ts
```

The real native `Ctrl+Shift+Space` handler creates label `companion` at 400×80.
That window loads the production `App` standalone branch and production sizing
hook. Native Tauri window/event APIs, injected bridge, compiled ACL and
`@tauri-apps/plugin-store` are untouched. A primary fixture host only displays
instructions; it does not initialize the unrelated MainApp. CUA performs every
click, checkbox, typing, drag and shortcut; this entry contains no UI automation.

Controlled boundaries are node identity, entitlement and local HTTP data. Six
explicit HTTP contracts are supported:

- `GET /api/agents`: `{agents}` (agents.ts `fetchAgents`).
- `GET /api/shadow/context/current`: direct ShadowContext.
- `GET /api/shadow/proactive`: `{suggestions: []}`.
- `POST /api/shadow/capture/control`: validates partial update, stores and returns
  resulting direct CaptureControl (shadow.ts `setCaptureControl`).
- `POST /api/chat/stream`: validates Companion flags, transient ID, one user
  message, everyday/developer response mode; emits Core's UI-message SSE
  `text-delta` framing (read by useAskScreen.ts). Answer/model/provider execution is controlled.
- `POST /api/mcp/tools/call`: exact agent-native-proof and focus Finder,
  screenshot, or click Documents payload (mcp.ts `callMcpTool`/ghostActionToCall).
  Ghost computer use is controlled; it does not focus/click/capture this machine.

Shadow routes require no node bearer, compute routes require
`Bearer companion-native-proof-token`. Unknown method/path/query contracts return
501, while invalid auth/payloads return 400 and remain in contractErrors. No
successful generic API fallback exists.

Read-only `GET /__companion-proof/state` returns server state, call log, unknown
contracts, contract errors and passive native observations. The private isolated
server additionally accepts typed observations from the entry. Geometry snapshots
call actual outerPosition/innerSize/scaleFactor/currentMonitor at initial mount
(before production resize) and native move/resize events. NDJSON is appended under
`docs/proof/test-coverage-sweep-20260924/parallel/coordinator-companion-page/native/`.
Retained NDJSON may include earlier server lifetimes; timestamps distinguish them.

Before proof completion, inspect screenshots of the actual overlay and logs for
initial400×80, settings expansion, answer/Ghost content, collapse, dragged-position
preservation, monitor fit, zero geometry errors/page errors/unknown contracts.
Closing/reopening and native app restart must read back consent/allowlist through
the real plugin store. This preparation is not execution evidence.

## Store isolation boundary

Use only the separately compiled identifier
`ai.amajor.ryu.desktop.dev.coverage` and isolated Core/headless data roots selected
by the main thread. Production ConsentSettings still loads relative
`companion.bin` using real plugin-store; Tauri resolves relative stores under the
identifier's app-data directory, not this fixture's localStorage. Do not read or
write the normal app's companion.bin.

There is a separate startup caveat: lib.rs calls
identifier_migration::migrate_app_data before creating the Tauri builder.
identifier_migration.rs current_identifier() selects hardcoded normal release/dev
identifiers, independently of the coverage TAURI_CONFIG override. Therefore this
fixture and identifier alone do not isolate that legacy migration's possible
startup filesystem effects. The main thread must resolve/account for that
boundary before launching; no production Rust changes are owned by this fixture.
