# Reference auth bridge

A working example of an **auth bridge**: a Ryu plugin that turns a provider
subscription into an OpenAI-compatible endpoint the rest of Ryu can use as a normal
model provider. This is the opencode/openclaw pattern - anyone can ship one, for any
provider, without changing Core.

This example bridges a **ChatGPT (Codex) subscription**. Copy it and replace three
seams to target something else.

Design rationale and the full codebase trace live in
[`docs/auth-bridge-plugins-spec.md`](../../docs/auth-bridge-plugins-spec.md).

## How it works

```
Pi (inference)  ->  http://127.0.0.1:7997/v1/chat/completions   (this bridge)
                        -> translate chat/completions -> Responses API
                        -> https://chatgpt.com/backend-api/codex/responses
                           Authorization: Bearer <your subscription token>
```

The bridge runs as a `kind: "node"` sidecar. Core spawns its own bootstrap under
`bun` or `node`, verifies the bundle against `backend_sha256`, loads `backend.js`,
and calls its exported `activate(ctx)`. The plugin registers one HTTP handler and
Core supervises the rest (health, lazy start, idle stop).

## Two postures, and which one this is

**This bridge rides an existing credential.** The user runs `codex login` (or the
in-app ChatGPT login), the vendor CLI writes `~/.codex/auth.json`, and the bridge
reuses that result, refreshing it with the standard `refresh_token` grant. Nothing
here impersonates a login.

**The other posture is in-plugin login**, where the bridge runs its own authorize
flow. That is a per-provider question, not an architectural one:

- A provider offering a **device-code grant**, or accepting a **dynamic `localhost`
  redirect**, can be logged into entirely from a bridge. Add an `/login/start` route,
  do the exchange, store the result. No impersonation involved.
- ChatGPT and Claude **pin their CLI client's redirect URI**, so an in-plugin login
  means reproducing that vendor client. That is a product decision with real
  fragility and ToS exposure, so this reference does not do it.

Swap `loadCredential()` to change posture. The rest of the file is unaffected.

## The three seams

Everything provider-specific is isolated. To target a different provider, change
these and nothing else:

| Seam | Function | What to change |
| --- | --- | --- |
| 1 | `loadCredential()` | Where the credential comes from (file, own OAuth flow, host storage) |
| 2 | `refresh()` | How it is renewed. Standard `refresh_token` grant here |
| 3 | `translateRequest()` / `translateResponse()` | Wire format mapping |

If your upstream already speaks OpenAI chat/completions, **delete seam 3 entirely**
and forward the body unchanged.

## Configuration

Every value is env-overridable; nothing is hardcoded.

| Variable | Default |
| --- | --- |
| `RYU_BRIDGE_AUTH_PATH` | `~/.codex/auth.json` |
| `RYU_BRIDGE_TOKEN_URL` | `https://auth.openai.com/oauth/token` |
| `RYU_BRIDGE_CLIENT_ID` | `app_EMoamEEZ73f0CkXaXp7hrann` |
| `RYU_BRIDGE_UPSTREAM` | `https://chatgpt.com/backend-api/codex` |
| `RYU_BRIDGE_REFRESH_SKEW_SECS` | `300` |
| `RYU_BRIDGE_MODELS` | `gpt-5,gpt-5-codex` |

## Build

`plugin.json` is generated. The manifest carries `backend.js` inline as
`backend_code` plus its `backend_sha256`, and Core refuses a mismatch at the install
door, so the two must be produced together.

```bash
bun examples/auth-bridge/build.mjs
```

Never hand-edit `plugin.json`.

## Install and run

1. **Enable the extension host.** `kind: "node"` sidecars are gated and default OFF.
   Toggle `ryu:experimental-plugin-runtime`, or set
   `RYU_EXPERIMENTAL_PLUGIN_RUNTIME=1` for a headless Core.

2. **Install the plugin** from the generated `plugin.json`.

3. **Register it as a provider.** Core cannot yet do this for you (see Limitations),
   so register it once by hand:

   ```bash
   curl -X POST http://127.0.0.1:7980/api/pi-config/providers \
     -H 'content-type: application/json' \
     -H "authorization: Bearer $RYU_TOKEN" \
     -d '{"provider":"chatgpt-bridge",
          "baseUrl":"http://127.0.0.1:7997/v1",
          "api":"openai-completions"}'
   ```

   The desktop provider settings UI does the same thing.

4. **Select it** as the active provider and send a message.

Check the bridge itself at any time:

```bash
curl http://127.0.0.1:7997/status
```

## Limitations

These are real and worth understanding before building on this.

- **No incremental streaming.** The extension-host bootstrap buffers a handler's
  response (`res.end`), so it cannot emit tokens progressively. A `stream: true`
  request is answered with a protocol-valid SSE body delivered in one shot: clients
  parse it correctly, but text arrives all at once rather than token by token.
  Fixing this properly means teaching the bootstrap to accept a stream from the
  handler, which is a Core change.
- **No self-registration.** A sidecar receives `RYU_EXT_TOKEN`, which is scoped to
  the ext-proxy hop and `/api/host/*`. It is not given `RYU_TOKEN`, and the host RPC
  vocabulary has no provider-registration capability, so a bridge cannot register
  itself. Hence the manual step above.
- **No lifecycle cleanup.** Disabling or uninstalling the plugin leaves the provider
  entry in `models.json` pointing at a dead port. Remove it manually.
- **Translation is minimal.** Seam 3 handles text in and text out. Tool calls,
  images, and structured output are not mapped.

## Trust

An auth bridge runs as an **unsandboxed** process with **full host access** and
**custody of your live subscription token**. Declared sidecar permissions are
recorded but not OS-enforced.

Core does gate the supply chain: unsigned plugins have their inline `backend_code`
stripped at install, because a self-referential hash attests nothing. So a bridge
comes from an identifiable publisher. But signing is provenance, not sandboxing -
a signed bridge still sees every request you route through it.

Installing a third-party auth bridge means trusting that author with your
subscription and your machine. This is the same trust model opencode and openclaw
operate under. Treat it accordingly.
