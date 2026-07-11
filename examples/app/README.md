# Reference Ryu App (full-page companion)

The copy-template for a **Ryu App** — a full-page app that gets its own sidebar
entry and uses the platform from inside a sandboxed iframe. It exercises the whole
**app host-bridge** in ~150 lines of dependency-free JS:

| Capability | Grant | `host.*` call |
|---|---|---|
| Durable per-app KV | `storage:kv` | `host.storage.get/set/delete/keys` |
| Tool-less completion | `hook:side-model` | `host.sideModel({ prompt, system? })` |
| Full tool-using sub-agent | `hook:run-agent` | `host.runAgent({ task, wall_time_secs? })` |

See [`docs/ryu-apps-extensibility.md`](../../docs/ryu-apps-extensibility.md) for the
full contract (endpoint, security model, `window.ryu` SDK alias, Phase-2 backlog).

## How it works

- `ui.js` exports `activate(context)`. The desktop host evaluates it in a
  **null-origin sandboxed iframe** (`sandbox="allow-scripts"`, CSP
  `connect-src 'none'`) and hands it `context.plugin.host` — the capability surface.
- Every `host.*` call is an RPC over a capability-gated `MessagePort`. The trusted
  host holds the node token, grant-gates the call against this app's
  **Gateway-approved** grants, and forwards it to Core
  `POST /api/plugins/com.ryu.reference-app/host`. The app never sees a token and
  cannot fetch directly.
- `plugin.json` declares one `kind: "companion"` runnable whose `config.ui_entry`
  points at `ui.js`. `ryu pack` bundles that entry into the manifest's `ui_code`.

## Install (needs a running Core node)

```bash
# 1. Pack: produce a bundle = { ...manifest, ui_code: <ui.js source> }
bunx @ryuhq/sdk pack examples/app            # or: ryu pack examples/app

# 2. Install the bundle onto your node, then enable it (grants are Gateway-validated)
curl -X POST "$RYU_URL/api/plugins/install-bundle" \
  -H "Authorization: Bearer $RYU_TOKEN" -H "Content-Type: application/json" \
  --data @bundle.json
curl -X POST "$RYU_URL/api/plugins/com.ryu.reference-app/enable" \
  -H "Authorization: Bearer $RYU_TOKEN"
```

Once enabled, the app appears in the desktop sidebar's **Apps** section; opening it
runs `activate` and you see the visit counter, a model greeting, an agent reply, and
a 👍/👎 control whose votes persist in the app's own KV (the inbox/news "learns what
you find important" pattern — no extra capability needed in v1).

## Porting an existing feature (e.g. the whiteboard) to an app — the FULL port

A full port keeps the feature's **Spaces integration** (it stays a Space document —
persisted, search-embedded, backlinked, versioned, Space-routed) while rendering with
the app's own UI. Use the `spaces:docs` capability, not just `storage:kv`:

1. Declare a `kind: "companion"` runnable with `config.ui_entry`; request grants
   `spaces:docs` (+ `hook:side-model` for AI-generate, `hook:run-agent` for a
   tool-using agent).
2. Replace the plain DOM in `ui.js` with your UI (React/Excalidraw/Remotion). Keep the
   `context.plugin.host.*` calls (or the `window.ryu.*` alias).
3. **Persist to a Space document, not KV.** The app owns documents of kind
   `app:<your-plugin-id>`:
   - `const { spaceId, docId } = window.ryu.context ?? {}` — when the app is opened as
     a Space document, the host bakes this in.
   - Load: `const doc = await window.ryu.spaces.getDoc({ doc_id: docId })` →
     `JSON.parse(doc.source)` into your scene.
   - Save (debounced): `await window.ryu.spaces.updateDoc({ doc_id: docId, source:
     JSON.stringify(scene) })` — Core re-embeds it for search and re-resolves
     `[[backlinks]]`, exactly like the built-in whiteboard.
   - New/list: `spaces.createDoc({ space_id, title })` / `spaces.listDocs({ space_id })`.
4. Opening an `app:<plugin>` Space document routes to your companion at
   `/spaces/:spaceId/app/:docId` (the host mounts your app with the mount context).

Result: one implementation (the app), full Spaces membership preserved — so the old
`SpaceWhiteboardEditorPage` can be replaced by a thin mount of the app with **no
duplication and no lost integration**.
