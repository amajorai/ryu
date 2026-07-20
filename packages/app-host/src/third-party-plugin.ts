// Builds the sandboxed document for a THIRD-PARTY plugin (the vertical-slice
// extension of `example-plugin.ts`, which bakes in one fixed built-in demo).
//
// `thirdPartyPluginSrcdoc(nonce, uiCodeBase64)` produces the TRUSTED,
// host-authored bootstrap — the same nonce constant, ready-handshake,
// port-accept-by-nonce, and `call()` RPC helper the example plugin uses — and
// then decodes the plugin's bundled module from BASE64 and evaluates it. The
// bootstrap constructs a minimal `RyuPlugin` (whose `host.listAgents` and
// `registerRoute` close over `call()`), then invokes the plugin module's
// `activate(context)`.
//
// SECURITY MODEL (do not "improve" this — it is deliberate):
//   - The document runs in a NULL-ORIGIN sandboxed iframe (`sandbox="allow-scripts"`,
//     no `allow-same-origin`). It has no Tauri IPC, no parent DOM, no cookies.
//   - The plugin CAN observe the transferred port (it arrives as a window message
//     any listener sees). We do NOT hide it. Holding the port grants NOTHING:
//     every method is default-DENY on the HOST side (`dispatchRpc`), gated against
//     the Gateway-approved grant set. So the isolation rests on (a) the host-side
//     capability gate and (b) NO capability ever returning a secret or doing
//     ungoverned egress (invariant #5).
//   - BASE64, not string concatenation, carries the bundle: a plugin body
//     containing `</script>` cannot break out of the tag. This is defense in
//     depth, NOT the load-bearing boundary (the null-origin sandbox is).

import { HOST_API_VERSION } from "./rpc.ts";

/** Build a third-party plugin's sandboxed document.
 *
 *  @param nonce        Host-generated per-mount nonce (e.g. `crypto.randomUUID()`),
 *                      never plugin- or user-controlled. Echoed in the handshake.
 *  @param uiCodeBase64 The plugin's bundled ESM module (a self-contained string,
 *                      the SDK `ryu pack` output) encoded as BASE64. It must export
 *                      `activate(context)` (and optionally `deactivate()`) — the
 *                      `RyuPluginModule` shape — or be a script that calls
 *                      `activate` on the injected global.
 *  @param pluginId     The owning plugin/companion id, baked into the trusted
 *                      bootstrap (not secret) so the plugin's route claim can be
 *                      scoped to its own `/plugin/<id>` surface. The HOST still
 *                      re-validates every claim against this same id, so a plugin
 *                      that forges a different path is rejected regardless. */
export function thirdPartyPluginSrcdoc(
	nonce: string,
	uiCodeBase64: string,
	pluginId: string,
	// Optional host-supplied mount context (e.g. `{ spaceId, docId }` when the app is
	// opened as a Space document). Baked in as `window.ryu.context` so the app knows
	// which document to load/save via `spaces.getDoc`/`spaces.updateDoc`. Host-
	// controlled, JSON-serialized (never plugin input).
	mountContext?: unknown
): string {
	// JSON.stringify does NOT escape `</script>` or the JS line separators U+2028/9,
	// so a value baked into the inline <script> could break out of the tag or the
	// string literal. Escape the HTML/JS-sensitive chars for every interpolated
	// literal (defense in depth — mount context is host-controlled, but a manifest
	// `id` and future context values may not be).
	const scriptSafe = (value: unknown): string =>
		JSON.stringify(value ?? null)
			.replace(/</g, "\\u003c")
			.replace(/>/g, "\\u003e")
			.replace(/&/g, "\\u0026")
			.replace(/\u2028/g, "\\u2028")
			.replace(/\u2029/g, "\\u2029");
	const nonceLiteral = scriptSafe(nonce);
	const codeLiteral = scriptSafe(uiCodeBase64);
	const pluginIdLiteral = scriptSafe(pluginId);
	const mountContextLiteral = scriptSafe(mountContext);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<!-- Ungoverned egress is invariant #5: a null-origin sandbox isolates the DOM
     but does NOT block network. This per-document CSP denies all network
     (connect-src 'none') and remote code (default-src 'none' + inline-only
     script-src), so a benign-looking bundle cannot fetch/beacon out capability
     results or eval() a remote payload at runtime. Only the trusted inline
     bootstrap + inline styles + data: images run. Any future "network"
     capability MUST route through a host RPC that goes via the Gateway.
     NOTE: script-src includes 'unsafe-eval' because the bootstrap executes the
     plugin bundle via new Function (CSP gates that under 'unsafe-eval', NOT
     'unsafe-inline'); without it the bundle throws a CSP violation and never
     runs. This does NOT re-open egress: connect-src 'none' still blocks fetching
     any remote payload to eval, so the plugin can only run its own
     already-present, review-visible bundle. -->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'" />
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; height: 100%; }
  body {
    padding: 0;
    font: 13px/1.5 system-ui, sans-serif;
    color: #e7e7e7; background: #18181b;
  }
  #ryu-plugin-error {
    display: none; margin: 16px;
    padding: 10px 12px; border: 1px solid #7f1d1d; border-radius: 6px;
    background: #27272a; color: #f87171; font-size: 12px; white-space: pre-wrap;
  }
</style>
</head>
<body>
  <div id="ryu-plugin-error"></div>
  <div id="ryu-plugin-root"></div>
<script>
  (function () {
    var NONCE = ${nonceLiteral};
    var UI_CODE_B64 = ${codeLiteral};
    var PLUGIN_ID = ${pluginIdLiteral};
    var MOUNT_CONTEXT = ${mountContextLiteral};
    var port = null;
    var nextId = 1;
    var pending = {};
    var errEl = document.getElementById("ryu-plugin-error");

    function fail(text) {
      if (errEl) {
        errEl.textContent = String(text);
        errEl.style.display = "block";
      }
    }

    // RPC over the transferred MessageChannel port. Resolves/rejects by id.
    function call(method, args) {
      return new Promise(function (resolve, reject) {
        if (!port) { reject(new Error("bridge not ready")); return; }
        var id = nextId++;
        pending[id] = { resolve: resolve, reject: reject };
        port.postMessage({ kind: "ryu-plugin-rpc", id: id, method: method, args: args || [] });
      });
    }

    // Streaming RPC: the host pushes many "ryu-plugin-rpc-chunk" frames (delivered
    // to onChunk) then one terminal result. Returns { promise, cancel } — cancel
    // sends an "agent.cancel" carrying the stream's id so the host aborts it.
    function callStream(method, args, onChunk) {
      var id = nextId++;
      var resolve, reject;
      var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
      pending[id] = { resolve: resolve, reject: reject, onChunk: onChunk };
      if (port) port.postMessage({ kind: "ryu-plugin-rpc", id: id, method: method, args: args || [] });
      else reject(new Error("bridge not ready"));
      function cancel() {
        if (!port) return;
        port.postMessage({ kind: "ryu-plugin-rpc", id: nextId++, method: "agent.cancel", args: [id] });
      }
      return { promise: promise, cancel: cancel };
    }

    function onPortMessage(ev) {
      var msg = ev.data;
      if (!msg) return;
      if (msg.kind === "ryu-plugin-rpc-chunk") {
        var pc = pending[msg.id];
        if (pc && typeof pc.onChunk === "function") pc.onChunk(msg.delta);
        return;
      }
      if (msg.kind !== "ryu-plugin-rpc-result") return;
      var p = pending[msg.id];
      if (!p) return;
      delete pending[msg.id];
      // Reject on ANY error (string legacy OR structured { code, message }).
      if (msg.error) {
        var em = typeof msg.error === "string" ? msg.error : (msg.error.message || "error");
        p.reject(new Error(em));
      } else {
        p.resolve(msg.result);
      }
    }

    // The RyuPlugin contract the plugin's activate() receives. Every capability
    // is an RPC over the host bridge; the host grant-gates each one. Nothing here
    // holds a token or reaches the network directly.
    function makePlugin(pluginId) {
      var subscriptions = [];
      function disposable(teardown) {
        var done = false;
        return { dispose: function () { if (!done) { done = true; teardown && teardown(); } } };
      }
      var plugin = {
        host: {
          // Projected {id,name}[] — the host never returns a secret (invariant #5).
          listAgents: function () { return call("core.listAgents", []); },
          // App host-bridge capabilities. Each is an RPC over the gated port; the host
          // grant-gates it against the plugin's Gateway-approved grants and forwards to
          // the Core bridge (POST /api/plugins/:id/host). This is the NATIVE full-page
          // companion contract — a companion app reaches these via context.plugin.host.*
          // (window.ryu is the parallel SDK/inline-widget alias, installed separately).
          // Tool-less one-shot completion (needs grant hook:side-model).
          sideModel: function (args) { return call("model.complete", [args || {}]); },
          // Full tool-using sub-agent, clean context, final text (needs hook:run-agent).
          runAgent: function (args) { return call("agent.run", [args || {}]); },
          // Streaming variant: runAgentStream(args, onChunk, signal?) → Promise<void>;
          // reply text arrives token-by-token via onChunk (needs hook:run-agent).
          runAgentStream: function (args, onChunk, signal) {
            var h = callStream("agent.run.stream", [args || {}], onChunk);
            if (signal) {
              if (signal.aborted) h.cancel();
              else signal.addEventListener("abort", function () { h.cancel(); });
            }
            return h.promise;
          },
          // Durable per-app KV (needs storage:kv). Values are strings.
          storage: {
            get: function (args) { return call("storage.get", [args || {}]); },
            set: function (args) { return call("storage.set", [args || {}]); },
            delete: function (args) { return call("storage.delete", [args || {}]); },
            keys: function (args) { return call("storage.keys", [args || {}]); }
          },
          // Spaces documents (needs spaces:docs) — the app owns docs of kind
          // app:<pluginId>; persisted, search-embedded, backlinked, Space-routed.
          spaces: {
            createDoc: function (args) { return call("spaces.createDoc", [args || {}]); },
            getDoc: function (args) { return call("spaces.getDoc", [args || {}]); },
            updateDoc: function (args) { return call("spaces.updateDoc", [args || {}]); },
            listDocs: function (args) { return call("spaces.listDocs", [args || {}]); },
            deleteDoc: function (args) { return call("spaces.deleteDoc", [args || {}]); }
          }
        },
        // The plugin claims ITS OWN surface. The host service rejects any path
        // that is not /plugin/<pluginId> (anti-phishing, invariant #6).
        registerRoute: function (contribution) {
          call("ui.registerRoute", [{
            path: contribution && contribution.path,
            title: contribution && contribution.title
          }]).catch(function (e) { fail("registerRoute rejected: " + (e && e.message ? e.message : e)); });
          return disposable(null);
        }
      };
      var context = { plugin: plugin, pluginId: pluginId, subscriptions: subscriptions, mount: MOUNT_CONTEXT };
      return context;
    }

    // Install window.ryu — the app host-bridge surface a full-page Companion app
    // (and the @ryu/apps SDK) reads. Every method is an RPC over the SAME capability-
    // gated port; the host grant-gates each against the plugin's Gateway-approved
    // grants (model.complete←hook:side-model, agent.run←hook:run-agent, storage.*←
    // storage:kv). Nothing here holds a token or reaches the network directly
    // (connect-src 'none'). Setting __ryuHostBridge lets the SDK's installRyuBridge
    // ADOPT this host-installed bridge instead of stranding calls in a port-less outbox.
    function installWindowRyu() {
      var ryu = {
        listAgents: function () { return call("core.listAgents", []); },
        model: {
          complete: function (args) { return call("model.complete", [args || {}]); }
        },
        agent: {
          run: function (args) { return call("agent.run", [args || {}]); },
          // Streaming run: opts = { onChunk(delta), signal? }. Returns a Promise that
          // resolves at turn end; deltas arrive via onChunk; signal aborts the stream.
          runStream: function (args, opts) {
            opts = opts || {};
            var h = callStream("agent.run.stream", [args || {}], opts.onChunk);
            if (opts.signal) {
              if (opts.signal.aborted) h.cancel();
              else opts.signal.addEventListener("abort", function () { h.cancel(); });
            }
            return h.promise;
          }
        },
        storage: {
          get: function (args) { return call("storage.get", [args || {}]); },
          set: function (args) { return call("storage.set", [args || {}]); },
          delete: function (args) { return call("storage.delete", [args || {}]); },
          keys: function (args) { return call("storage.keys", [args || {}]); }
        },
        // Spaces documents (needs grant spaces:docs). The app owns docs of kind
        // app:<pluginId>; source is a string (JSON.stringify your scene).
        spaces: {
          createDoc: function (args) { return call("spaces.createDoc", [args || {}]); },
          getDoc: function (args) { return call("spaces.getDoc", [args || {}]); },
          updateDoc: function (args) { return call("spaces.updateDoc", [args || {}]); },
          listDocs: function (args) { return call("spaces.listDocs", [args || {}]); },
          deleteDoc: function (args) { return call("spaces.deleteDoc", [args || {}]); }
        },
        // Media generation (needs grant media:generate) + speech-to-text
        // (media:transcribe). Results are always data: URLs (the host inlines remote
        // provider URLs) so the CSP-locked frame can render them.
        media: {
          image: function (args) { return call("media.image", [args || {}]); },
          video: function (args) { return call("media.video", [args || {}]); },
          tts: function (args) { return call("media.tts", [args || {}]); },
          transcribe: function (args) { return call("media.transcribe", [args || {}]); }
        },
        // Read-only catalog reads (needs grant core:list_agents) — chat models + TTS engines.
        registry: {
          engineModels: function () { return call("registry.engineModels", []); },
          ttsEngines: function () { return call("registry.ttsEngines", []); },
          agents: function () { return call("registry.agents", []); }
        },
        // Asset picker: GIFs via the host (Core proxy needs the node token). Icons/
        // logos are fetched directly by the app under its per-app CSP allowlist.
        assets: {
          searchGifs: function (a) { return call("assets.searchGifs", [a || {}]); }
        },
        // Fine-tune runs (needs grant finetune:runs). The com.ryu.finetune app drives
        // training runs; Core owns the orchestration + durable job store. Live progress
        // arrives via finetune.stream(args, { onFrame, signal }).
        finetune: {
          capability: function () { return call("finetune.capability", []); },
          start: function (args) { return call("finetune.start", [args || {}]); },
          list: function () { return call("finetune.list", []); },
          get: function (args) { return call("finetune.get", [args || {}]); },
          cancel: function (args) { return call("finetune.cancel", [args || {}]); },
          adapters: function () { return call("finetune.adapters", []); },
          merge: function (args) { return call("finetune.merge", [args || {}]); },
          stream: function (args, opts) {
            opts = opts || {};
            var h = callStream("finetune.stream", [args || {}], opts.onFrame || opts.onChunk);
            if (opts.signal) {
              if (opts.signal.aborted) h.cancel();
              else opts.signal.addEventListener("abort", function () { h.cancel(); });
            }
            return h.promise;
          }
        },
        // Website monitors (needs grant monitors:crud). The com.ryu.monitors app
        // drives Core's /api/monitors/* orchestration; the host calls that API
        // directly (it is already gated on the same enabled bit).
        monitors: {
          list: function () { return call("monitors.list", []); },
          get: function (a) { return call("monitors.get", [a || {}]); },
          create: function (a) { return call("monitors.create", [a || {}]); },
          update: function (a) { return call("monitors.update", [a || {}]); },
          delete: function (a) { return call("monitors.delete", [a || {}]); },
          run: function (a) { return call("monitors.run", [a || {}]); },
          snapshots: function (a) { return call("monitors.snapshots", [a || {}]); },
          alerts: function (a) { return call("monitors.alerts", [a || {}]); }
        },
        // Workflows (needs grants workflows:crud/runstate/catalogs). The
        // com.ryu.workflows companion drives Core's DAG workflow engine; the host
        // calls the existing /workflows* + /api/workflows/catalog* API directly.
        workflows: {
          list: function () { return call("workflows.list", []); },
          get: function (a) { return call("workflows.get", [a || {}]); },
          save: function (a) { return call("workflows.save", [a || {}]); },
          delete: function (a) { return call("workflows.delete", [a || {}]); },
          versionsList: function (a) { return call("workflows.versionsList", [a || {}]); },
          versionGet: function (a) { return call("workflows.versionGet", [a || {}]); },
          versionCreate: function (a) { return call("workflows.versionCreate", [a || {}]); },
          versionRestore: function (a) { return call("workflows.versionRestore", [a || {}]); },
          templatesList: function () { return call("workflows.templatesList", []); },
          templateGet: function (a) { return call("workflows.templateGet", [a || {}]); },
          templateInstall: function (a) { return call("workflows.templateInstall", [a || {}]); },
          webhook: function (a) { return call("workflows.webhook", [a || {}]); },
          run: function (a) { return call("workflows.run", [a || {}]); },
          runGet: function (a) { return call("workflows.runGet", [a || {}]); },
          resume: function (a) { return call("workflows.resume", [a || {}]); },
          agents: function () { return call("workflows.agents", []); },
          apps: function () { return call("workflows.apps", []); },
          mcp: function () { return call("workflows.mcp", []); },
          skills: function () { return call("workflows.skills", []); },
          schedules: function () { return call("workflows.schedules", []); },
          composio: function (a) { return call("workflows.composio", [a || {}]); }
        },
        // Ghost record→replay (needs grant ghost:record). RecordToWorkflow records a
        // native-desktop action sequence into a recipe; the recipe-node picker lists them.
        ghost: {
          recipes: function () { return call("ghost.recipes", []); },
          recordStart: function (a) { return call("ghost.recordStart", [a || {}]); },
          recordStatus: function () { return call("ghost.recordStatus", []); },
          recordStop: function () { return call("ghost.recordStop", []); }
        },
        // Shell primitives (needs grant shell:integrate). The generic shell-integration
        // lane a DECOUPLED companion uses: open an allowlisted shell tab, and subscribe
        // to the live theme / palette commands / node event stream. openTab is unary; the
        // subscribe/register verbs stream host→frame and return { dispose } (cancel on
        // unmount is automatic via the host's activeStreams, dispose is for early release).
        shell: {
          openTab: function (a) { return call("shell.openTab", [a || {}]); },
          subscribeTheme: function (opts) {
            opts = opts || {};
            var h = callStream("shell.themeSubscribe", [{}], function (d) {
              if (opts.onChange) { try { opts.onChange(JSON.parse(d)); } catch (e) {} }
            });
            h.promise.catch(function () {});
            return { dispose: h.cancel };
          },
          registerCommand: function (commands, opts) {
            opts = opts || {};
            var h = callStream("shell.registerCommand", [{ commands: commands || [] }], function (d) {
              if (opts.onInvoke) { try { opts.onInvoke(JSON.parse(d)); } catch (e) {} }
            });
            h.promise.catch(function () {});
            return { dispose: h.cancel };
          },
          subscribeEvents: function (opts) {
            opts = opts || {};
            var h = callStream("shell.eventsSubscribe", [{ channels: opts.channels || [] }], function (d) {
              if (opts.onEvent) { try { opts.onEvent(JSON.parse(d)); } catch (e) {} }
            });
            h.promise.catch(function () {});
            return { dispose: h.cancel };
          }
        },
        // Mount context: { spaceId, docId } when opened as a Space document, else null.
        context: MOUNT_CONTEXT
      };
      try {
        window.ryu = ryu;
        // window.openai alias for OpenAI-Apps-SDK compatibility (parity with the
        // inline-widget bridge); apps may read either name.
        if (!window.openai) window.openai = ryu;
        window.__ryuHostBridge = true;
      } catch (e) { /* frame globals are writable in the sandbox; ignore if not */ }
    }

    var connectedContext = null;

    // The host posts the channel port after verifying our handshake. Accept ONLY
    // a message carrying our nonce and a port.
    window.addEventListener("message", function (ev) {
      var msg = ev.data;
      if (!msg || msg.kind !== "ryu-plugin-host-port" || msg.nonce !== NONCE) return;
      var p = ev.ports && ev.ports[0];
      if (!p || port) return;
      port = p;
      port.onmessage = onPortMessage;

      // Install window.ryu BEFORE the bundle runs so an app's top-level code (and the
      // SDK bridge adoption) sees a live host bridge.
      installWindowRyu();

      // Decode + evaluate the plugin bundle once the bridge is live. The plugin's
      // id is baked into this trusted bootstrap (not secret); the host re-validates
      // every route claim against the same id, so scoping is enforced host-side.
      var pluginId = PLUGIN_ID;
      try {
        var source = atobUtf8(UI_CODE_B64);
        var moduleExports = {};
        // Evaluate the bundle with activate/deactivate collectable via the
        // module object. The SDK packs an ESM-less IIFE that assigns to
        // globalThis.__ryuPlugin, OR a body that defines a top-level activate().
        var factory = new Function("exports", "module", "context", source + "\\n;return (typeof activate === 'function') ? { activate: activate, deactivate: (typeof deactivate === 'function' ? deactivate : undefined) } : (module.exports || exports);");
        var mod = factory(moduleExports, { exports: moduleExports }, null);
        var resolved = (mod && typeof mod.activate === "function")
          ? mod
          : (globalThis.__ryuPlugin || null);
        if (!resolved || typeof resolved.activate !== "function") {
          fail("plugin bundle does not export activate(context)");
          return;
        }
        connectedContext = makePlugin(pluginId);
        Promise.resolve(resolved.activate(connectedContext)).catch(function (e) {
          fail("activate() threw: " + (e && e.message ? e.message : e));
        });
      } catch (e) {
        fail("failed to run plugin bundle: " + (e && e.message ? e.message : e));
      }
    });

    // Minimal base64 → UTF-8 decode (atob yields Latin-1; re-decode as UTF-8 so
    // non-ASCII plugin source survives).
    function atobUtf8(b64) {
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder("utf-8").decode(bytes);
    }

    // Announce readiness (host verifies event.source + this nonce).
    window.parent.postMessage({ kind: "ryu-plugin-ready", nonce: NONCE, hostApiVersion: ${JSON.stringify(HOST_API_VERSION)} }, "*");
  })();
</script>
</body>
</html>`;
}

// ── Path B: full-HTML companion (ui_format: "html") ─────────────────────────────
//
// A heavy app (React + Excalidraw + Mermaid, …) is impractical to ship as a single
// `new Function`-eval'd ESM module: the CSS is dropped, `process.env` is undefined,
// and fonts fight the CSP. Instead it is built to ONE self-contained HTML document
// via `vite-plugin-singlefile` (the same pipeline the inline widget apps use), and
// mounted DIRECTLY as the iframe `srcdoc` — no bundle eval. This builder wraps that
// app HTML by injecting, as the FIRST children of <head> (so both run before the
// app's own deferred module scripts):
//   1. A per-document CSP that keeps the egress lock (`connect-src 'none'`) but
//      widens `font-src`/`img-src`/`worker-src` to `data:`/`blob:` so Excalidraw's
//      inlined fonts, blob-URL images, and workers load. The frame still cannot
//      fetch/beacon/eval-remote — its only channel out is the host port.
//   2. The SAME `window.ryu` bridge `installWindowRyu` provides (model/agent/storage/
//      spaces + mount context), but installed SYNCHRONOUSLY with an OUTBOX: the app's
//      module scripts run on parse, before the host transfers the port, so a
//      `spaces.getDoc` in the app's first effect must QUEUE and flush on connect
//      rather than reject with "bridge not ready" (the Path A eval avoids this by
//      only running the bundle after the port arrives; Path B cannot).
// The RPC envelope, method names, handshake nonce, and port protocol are byte-for-
// byte identical to Path A, so `ExtensionHost`'s host side is unchanged.

/** A per-app CSP allowlist (the OpenAI-Apps-SDK `_meta.ui.csp` model, scoped). Only
 *  a TRUSTED/approved manifest's allowlist should ever reach here — the caller
 *  (PluginHostPanel) passes it straight from `companion.csp`, which Core emits only
 *  for built-in/moderated manifests. */
export interface CompanionCsp {
	/** Hosts added to `connect-src` (the frame may `fetch()`/XHR these directly). */
	connectDomains?: string[];
	/** Hosts added to `img-src`/`media-src` (remote asset/image loads). */
	resourceDomains?: string[];
}

/** Normalize an allowlist entry to a bare `https://host[:port]` origin, or null if
 *  it is not a safe https host. Rejects anything carrying CSP-delimiter characters
 *  (space, `;`, quotes, `'`) so a malicious entry cannot inject extra directives.
 *
 *  Exported so the widget path (`widget-bootstrap.ts`) shares ONE public-https
 *  allowlist sanitizer for a widget's declared `resource_domains` — the two paths
 *  must not diverge (advisor point 4). The widget path additionally needs a
 *  loopback-tolerant check for the Core PROXY origin (`http://127.0.0.1:*`), which
 *  this deliberately rejects; that is a separate, documented concern there. */
export function sanitizeCspOrigin(entry: string): string | null {
	if (typeof entry !== "string" || /[\s;'"]/.test(entry)) {
		return null;
	}
	let candidate = entry.trim();
	if (!candidate) {
		return null;
	}
	// Bare host → assume https. Reject any non-https scheme (no http:, ws:, data:).
	if (!candidate.includes("://")) {
		candidate = `https://${candidate}`;
	}
	try {
		const url = new URL(candidate);
		if (url.protocol !== "https:") {
			return null;
		}
		const host = url.hostname;
		// Pin to an EXACT, dotted public host. Reject wildcards (`*.evil.com`), bare
		// single-label hosts (a bare TLD like `com`, or an internal name like
		// `localhost`), and any leftover delimiter. This keeps a per-app allowlist
		// entry from broadening to a whole TLD or an internal target.
		if (host.includes("*") || !host.includes(".") || /[\s;'"/]/.test(host)) {
			return null;
		}
		return url.port ? `https://${host}:${url.port}` : `https://${host}`;
	} catch {
		return null;
	}
}

/** Build the full-HTML companion CSP. The egress lock (`connect-src 'none'`) and the
 *  `data:`/`blob:` asset widening are ALWAYS present. A per-app `csp` allowlist (only
 *  ever a trusted manifest's) additionally appends sanitized https origins to
 *  `connect-src` (fetch targets) and `img-src`/`media-src` (remote assets). */
export function buildHtmlCompanionCsp(csp?: CompanionCsp): string {
	const connect = (csp?.connectDomains ?? [])
		.map(sanitizeCspOrigin)
		.filter((o): o is string => o !== null);
	const resource = (csp?.resourceDomains ?? [])
		.map(sanitizeCspOrigin)
		.filter((o): o is string => o !== null);
	const connectSrc =
		connect.length > 0
			? `connect-src ${connect.join(" ")}`
			: "connect-src 'none'";
	const imgSrc = ["img-src", "data:", "blob:", ...resource].join(" ");
	const mediaSrc = ["media-src", "data:", "blob:", ...resource].join(" ");
	return [
		"default-src 'none'",
		"script-src 'unsafe-inline' 'unsafe-eval'",
		"style-src 'unsafe-inline'",
		imgSrc,
		mediaSrc,
		"font-src data:",
		connectSrc,
		"worker-src blob:",
		"child-src blob:",
		"frame-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
	].join("; ");
}

/** Build the injected `<head>` fragment: the CSP meta + the synchronous, outbox-
 *  backed `window.ryu` bridge bootstrap. `*Literal` args are already script-safe
 *  JSON literals (escaped by the caller). */
function htmlCompanionHeadFragment(
	nonceLiteral: string,
	pluginIdLiteral: string,
	mountContextLiteral: string,
	cspString: string
): string {
	return `<meta http-equiv="Content-Security-Policy" content="${cspString}" />
<script>
  (function () {
    var NONCE = ${nonceLiteral};
    var PLUGIN_ID = ${pluginIdLiteral};
    var MOUNT_CONTEXT = ${mountContextLiteral};
    var port = null;
    var nextId = 1;
    var pending = {};
    // Envelopes queued before the port arrived; flushed on connect. This is the
    // difference from Path A: the app runs before the port is transferred.
    var outbox = [];

    function call(method, args) {
      return new Promise(function (resolve, reject) {
        var id = nextId++;
        pending[id] = { resolve: resolve, reject: reject };
        var env = { kind: "ryu-plugin-rpc", id: id, method: method, args: args || [] };
        if (port) port.postMessage(env); else outbox.push(env);
      });
    }

    function callStream(method, args, onChunk) {
      var id = nextId++;
      var resolve, reject;
      var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
      pending[id] = { resolve: resolve, reject: reject, onChunk: onChunk };
      var env = { kind: "ryu-plugin-rpc", id: id, method: method, args: args || [] };
      if (port) port.postMessage(env); else outbox.push(env);
      function cancel() {
        var c = { kind: "ryu-plugin-rpc", id: nextId++, method: "agent.cancel", args: [id] };
        if (port) port.postMessage(c); else outbox.push(c);
      }
      return { promise: promise, cancel: cancel };
    }

    function onPortMessage(ev) {
      var msg = ev.data;
      if (!msg) return;
      if (msg.kind === "ryu-plugin-rpc-chunk") {
        var pc = pending[msg.id];
        if (pc && typeof pc.onChunk === "function") pc.onChunk(msg.delta);
        return;
      }
      if (msg.kind !== "ryu-plugin-rpc-result") return;
      var p = pending[msg.id];
      if (!p) return;
      delete pending[msg.id];
      if (msg.error) {
        var em = typeof msg.error === "string" ? msg.error : (msg.error.message || "error");
        p.reject(new Error(em));
      } else {
        p.resolve(msg.result);
      }
    }

    // Install window.ryu SYNCHRONOUSLY so an app effect that calls spaces.getDoc
    // during first render queues into the outbox instead of throwing. Identical
    // surface to the Path A installWindowRyu().
    var ryu = {
      listAgents: function () { return call("core.listAgents", []); },
      model: { complete: function (a) { return call("model.complete", [a || {}]); } },
      agent: {
        run: function (a) { return call("agent.run", [a || {}]); },
        runStream: function (a, opts) {
          opts = opts || {};
          var h = callStream("agent.run.stream", [a || {}], opts.onChunk);
          if (opts.signal) {
            if (opts.signal.aborted) h.cancel();
            else opts.signal.addEventListener("abort", function () { h.cancel(); });
          }
          return h.promise;
        }
      },
      storage: {
        get: function (a) { return call("storage.get", [a || {}]); },
        set: function (a) { return call("storage.set", [a || {}]); },
        delete: function (a) { return call("storage.delete", [a || {}]); },
        keys: function (a) { return call("storage.keys", [a || {}]); }
      },
      spaces: {
        createDoc: function (a) { return call("spaces.createDoc", [a || {}]); },
        getDoc: function (a) { return call("spaces.getDoc", [a || {}]); },
        updateDoc: function (a) { return call("spaces.updateDoc", [a || {}]); },
        listDocs: function (a) { return call("spaces.listDocs", [a || {}]); },
        deleteDoc: function (a) { return call("spaces.deleteDoc", [a || {}]); }
      },
      media: {
        image: function (a) { return call("media.image", [a || {}]); },
        video: function (a) { return call("media.video", [a || {}]); },
        tts: function (a) { return call("media.tts", [a || {}]); },
        transcribe: function (a) { return call("media.transcribe", [a || {}]); }
      },
      registry: {
        engineModels: function () { return call("registry.engineModels", []); },
        ttsEngines: function () { return call("registry.ttsEngines", []); },
        agents: function () { return call("registry.agents", []); }
      },
      // Asset picker: GIFs go through the host (Core proxy needs the node token).
      // Icons/logos are fetched DIRECTLY by the app under its per-app CSP allowlist
      // (csp.connectDomains), so they are NOT bridge methods.
      assets: {
        searchGifs: function (a) { return call("assets.searchGifs", [a || {}]); }
      },
      finetune: {
        capability: function () { return call("finetune.capability", []); },
        start: function (a) { return call("finetune.start", [a || {}]); },
        list: function () { return call("finetune.list", []); },
        get: function (a) { return call("finetune.get", [a || {}]); },
        cancel: function (a) { return call("finetune.cancel", [a || {}]); },
        adapters: function () { return call("finetune.adapters", []); },
        merge: function (a) { return call("finetune.merge", [a || {}]); },
        stream: function (a, opts) {
          opts = opts || {};
          var h = callStream("finetune.stream", [a || {}], opts.onFrame || opts.onChunk);
          if (opts.signal) {
            if (opts.signal.aborted) h.cancel();
            else opts.signal.addEventListener("abort", function () { h.cancel(); });
          }
          return h.promise;
        }
      },
      // Website monitors (needs grant monitors:crud). The com.ryu.monitors companion
      // drives Core's /api/monitors/* orchestration through these RPCs.
      monitors: {
        list: function () { return call("monitors.list", []); },
        get: function (a) { return call("monitors.get", [a || {}]); },
        create: function (a) { return call("monitors.create", [a || {}]); },
        update: function (a) { return call("monitors.update", [a || {}]); },
        delete: function (a) { return call("monitors.delete", [a || {}]); },
        run: function (a) { return call("monitors.run", [a || {}]); },
        snapshots: function (a) { return call("monitors.snapshots", [a || {}]); },
        alerts: function (a) { return call("monitors.alerts", [a || {}]); }
      },
      // Workflows (needs grants workflows:crud/runstate/catalogs). The
      // com.ryu.workflows companion drives Core's DAG workflow engine through these RPCs.
      workflows: {
        list: function () { return call("workflows.list", []); },
        get: function (a) { return call("workflows.get", [a || {}]); },
        save: function (a) { return call("workflows.save", [a || {}]); },
        delete: function (a) { return call("workflows.delete", [a || {}]); },
        versionsList: function (a) { return call("workflows.versionsList", [a || {}]); },
        versionGet: function (a) { return call("workflows.versionGet", [a || {}]); },
        versionCreate: function (a) { return call("workflows.versionCreate", [a || {}]); },
        versionRestore: function (a) { return call("workflows.versionRestore", [a || {}]); },
        templatesList: function () { return call("workflows.templatesList", []); },
        templateGet: function (a) { return call("workflows.templateGet", [a || {}]); },
        templateInstall: function (a) { return call("workflows.templateInstall", [a || {}]); },
        webhook: function (a) { return call("workflows.webhook", [a || {}]); },
        run: function (a) { return call("workflows.run", [a || {}]); },
        runGet: function (a) { return call("workflows.runGet", [a || {}]); },
        resume: function (a) { return call("workflows.resume", [a || {}]); },
        agents: function () { return call("workflows.agents", []); },
        apps: function () { return call("workflows.apps", []); },
        mcp: function () { return call("workflows.mcp", []); },
        skills: function () { return call("workflows.skills", []); },
        schedules: function () { return call("workflows.schedules", []); },
        composio: function (a) { return call("workflows.composio", [a || {}]); }
      },
      // Ghost record→replay (needs grant ghost:record).
      ghost: {
        recipes: function () { return call("ghost.recipes", []); },
        recordStart: function (a) { return call("ghost.recordStart", [a || {}]); },
        recordStatus: function () { return call("ghost.recordStatus", []); },
        recordStop: function () { return call("ghost.recordStop", []); }
      },
      // Inbound webhook registry (needs grant webhooks:crud). The com.ryu.webhooks
      // companion renders Core's read-only /api/webhooks + /api/webhook-ingress/status.
      webhooks: {
        list: function () { return call("webhooks.list", []); },
        ingressStatus: function () { return call("webhooks.ingressStatus", []); }
      },
      // Quests (needs grant quests:crud). The com.ryu.quests companion drives Core's
      // /api/quests/* auto-detecting-todo orchestration; the host calls that API
      // directly (the monitors pattern). openDetectionSettings is a shell-navigation
      // verb (opens Settings at the Quests tab).
      quests: {
        list: function () { return call("quests.list", []); },
        create: function (a) { return call("quests.create", [a || {}]); },
        update: function (a) { return call("quests.update", [a || {}]); },
        delete: function (a) { return call("quests.delete", [a || {}]); },
        complete: function (a) { return call("quests.complete", [a || {}]); },
        dismiss: function (a) { return call("quests.dismiss", [a || {}]); },
        acceptSuggestion: function (a) { return call("quests.acceptSuggestion", [a || {}]); },
        dismissSuggestion: function (a) { return call("quests.dismissSuggestion", [a || {}]); },
        judge: function (a) { return call("quests.judge", [a || {}]); },
        openDetectionSettings: function () { return call("quests.openDetectionSettings", []); }
      },
      // Activity feed (needs grant activity:read). The com.ryu.activity companion
      // renders Core's read-only unified feed; the host calls /api/activity directly
      // (the monitors pattern). openSession is a shell-navigation verb (opens the chat
      // tab for an item's session id).
      activity: {
        list: function (a) { return call("activity.list", [a || {}]); },
        openSession: function (a) { return call("activity.openSession", [a || {}]); }
      },
      // Timeline (needs grant timeline:read). The com.ryu.timeline companion renders
      // the activity replay scrubber; the host calls Shadow's device-local /timeline
      // + /journal + /frame directly (the monitors pattern, but WITHOUT a node token —
      // Shadow is machine-pinned). frame returns a data: URL (CSP img-src data: blob:);
      // openReview/openSettings are shell-navigation verbs.
      timeline: {
        list: function (a) { return call("timeline.list", [a || {}]); },
        journal: function (a) { return call("timeline.journal", [a || {}]); },
        frame: function (a) { return call("timeline.frame", [a || {}]); },
        openReview: function () { return call("timeline.openReview", []); },
        openSettings: function () { return call("timeline.openSettings", []); }
      },
      // Calendar (needs grant calendar:crud). The com.ryu.calendar companion renders
      // the scheduled-runs calendar and schedules an agent; the host calls Core's
      // /heartbeat/jobs + /workflows + /api/agents directly (the monitors pattern),
      // plus the createScheduledAgentWorkflow composite.
      calendar: {
        jobs: function () { return call("calendar.jobs", []); },
        workflows: function () { return call("calendar.workflows", []); },
        agents: function () { return call("calendar.agents", []); },
        createAutomation: function (a) { return call("calendar.createAutomation", [a || {}]); }
      },
      // Learning (needs grant learning:crud). The com.ryu.learning companion renders
      // the read-only continual-learning surface; the host calls Core's
      // /api/learn/config + /api/experience/list + /api/healing/status directly (the
      // monitors pattern). All READ-ONLY.
      learning: {
        config: function () { return call("learning.config", []); },
        experience: function () { return call("learning.experience", []); },
        healing: function () { return call("learning.healing", []); }
      },
      // Inbox / Approvals (needs grant approvals:crud). The com.ryu.approvals companion
      // renders the unified inbox; the host calls Core's /api/approvals/* +
      // /api/notifications/* (host-resolved user id) + Shadow's /proactive + /api/feedback
      // directly (the monitors pattern). openInChat is a shell-navigation verb (opens the
      // chat tab prefilled with a suggestion). The inbox's quest task check-off reuses the
      // quests.* verbs above (the app also holds quests:crud).
      approvals: {
        list: function () { return call("approvals.list", []); },
        approve: function (a) { return call("approvals.approve", [a || {}]); },
        reject: function (a) { return call("approvals.reject", [a || {}]); }
      },
      notifications: {
        list: function () { return call("notifications.list", []); },
        markRead: function (a) { return call("notifications.markRead", [a || {}]); },
        ack: function (a) { return call("notifications.ack", [a || {}]); }
      },
      suggestions: {
        list: function () { return call("suggestions.list", []); },
        feedback: function (a) { return call("suggestions.feedback", [a || {}]); },
        openInChat: function (a) { return call("suggestions.openInChat", [a || {}]); }
      },
      // Meetings (needs grant meetings:crud). The com.ryu.meetings companion renders
      // the record → live-transcript → AI-notes surface; the host calls Core's
      // /api/meetings/* directly (the monitors pattern). import is host-owned (the host
      // opens the OS file dialog + POSTs the multipart upload); open/openNotes/openList
      // are shell-navigation verbs.
      meetings: {
        list: function () { return call("meetings.list", []); },
        transcript: function (a) { return call("meetings.transcript", [a || {}]); },
        start: function (a) { return call("meetings.start", [a || {}]); },
        finalize: function (a) { return call("meetings.finalize", [a || {}]); },
        remove: function (a) { return call("meetings.delete", [a || {}]); },
        rename: function (a) { return call("meetings.rename", [a || {}]); },
        import: function () { return call("meetings.import", []); },
        open: function (a) { return call("meetings.open", [a || {}]); },
        openNotes: function (a) { return call("meetings.openNotes", [a || {}]); },
        openList: function () { return call("meetings.openList", []); }
      },
      // Skill authoring (needs grant skills:crud). The com.ryu.skill-editor companion
      // authors a user-owned Agent Skill (SKILL.md); the host calls Core's /api/skills
      // authoring endpoints directly (the monitors pattern). setTitle is a shell-navigation
      // verb (renames the companion's own tab). The edit target rides context.skillId.
      skills: {
        getSource: function (a) { return call("skills.getSource", [a || {}]); },
        create: function (a) { return call("skills.create", [a || {}]); },
        update: function (a) { return call("skills.update", [a || {}]); },
        listVersions: function (a) { return call("skills.listVersions", [a || {}]); },
        versionSource: function (a) { return call("skills.versionSource", [a || {}]); },
        snapshot: function (a) { return call("skills.snapshot", [a || {}]); },
        restore: function (a) { return call("skills.restore", [a || {}]); },
        setTitle: function (a) { return call("skills.setTitle", [a || {}]); }
      },
      // Shell primitives (needs grant shell:integrate). The generic shell-integration
      // lane a DECOUPLED companion uses: open an allowlisted shell tab, and subscribe to
      // the live theme / palette commands / node event stream. openTab is unary; the
      // subscribe/register verbs stream host→frame and return { dispose } (cancel on
      // unmount is automatic via the host's activeStreams; dispose is for early release).
      shell: {
        openTab: function (a) { return call("shell.openTab", [a || {}]); },
        subscribeTheme: function (opts) {
          opts = opts || {};
          var h = callStream("shell.themeSubscribe", [{}], function (d) {
            if (opts.onChange) { try { opts.onChange(JSON.parse(d)); } catch (e) {} }
          });
          h.promise.catch(function () {});
          return { dispose: h.cancel };
        },
        registerCommand: function (commands, opts) {
          opts = opts || {};
          var h = callStream("shell.registerCommand", [{ commands: commands || [] }], function (d) {
            if (opts.onInvoke) { try { opts.onInvoke(JSON.parse(d)); } catch (e) {} }
          });
          h.promise.catch(function () {});
          return { dispose: h.cancel };
        },
        subscribeEvents: function (opts) {
          opts = opts || {};
          var h = callStream("shell.eventsSubscribe", [{ channels: opts.channels || [] }], function (d) {
            if (opts.onEvent) { try { opts.onEvent(JSON.parse(d)); } catch (e) {} }
          });
          h.promise.catch(function () {});
          return { dispose: h.cancel };
        }
      },
      context: MOUNT_CONTEXT
    };
    try {
      window.ryu = ryu;
      if (!window.openai) window.openai = ryu;
      window.__ryuHostBridge = true;
    } catch (e) { /* frame globals writable in sandbox; ignore if not */ }

    // Accept the port ONLY from the host message carrying our nonce, once.
    window.addEventListener("message", function (ev) {
      var msg = ev.data;
      if (!msg || msg.kind !== "ryu-plugin-host-port" || msg.nonce !== NONCE) return;
      var p = ev.ports && ev.ports[0];
      if (!p || port) return;
      port = p;
      port.onmessage = onPortMessage;
      // Flush anything the app queued before connect.
      for (var i = 0; i < outbox.length; i++) port.postMessage(outbox[i]);
      outbox = [];
    });

    // Announce readiness (host verifies event.source + this nonce, then transfers
    // the port). Posted synchronously during head parse — the parent's ExtensionHost
    // message listener is already attached (its effect ran before the frame loaded).
    window.parent.postMessage({ kind: "ryu-plugin-ready", nonce: NONCE, hostApiVersion: ${JSON.stringify(HOST_API_VERSION)} }, "*");
  })();
</script>`;
}

/** A CSS custom-property name is safe to emit only if it is exactly `--<kebab>`;
 *  everything else is dropped so the theme-token bridge can never inject a stray
 *  selector/declaration. */
const THEME_TOKEN_NAME_RE = /^--[a-z0-9-]+$/;

/** A token VALUE may contain the characters real design-system values use —
 *  `oklch(… / …%)`, `0.625rem`, `#fff` — but NEVER a CSS-structural char that could
 *  break out of the `:root{…}` block or the `<style>` element. A value with any of
 *  `{ } ; < >` is rejected (the whole entry dropped, fail-safe). */
const THEME_TOKEN_VALUE_UNSAFE_RE = /[{}<>;]/;

/**
 * Build the theme-token bridge `<style>` block from the host's resolved CSS custom
 * properties (the W7 theme-token bridge). The desktop host reads its live token
 * values (light/dark/custom) at mount and passes them here; emitting them as an
 * `html:root{…}` override makes the sandboxed companion render in the host's ACTIVE
 * resolved theme, on top of the companion's own hardcoded token defaults (which
 * remain the offline/parity fallback). Returns "" when there is nothing safe to
 * inject.
 *
 * The selector is `html:root` (specificity 0,1,1), not `:root` (0,1,0), so it wins
 * over the companion's own `:root{…}` token block REGARDLESS of source order — the
 * host injects the already-resolved values for the active theme, so the companion
 * needs no `.dark` class of its own.
 *
 * Sanitized hard: only `--kebab` names, only values free of CSS-structural chars,
 * so a (host-controlled, already-trusted) token map can never inject extra
 * declarations or escape the `<style>` element. Under the companion CSP
 * `style-src 'unsafe-inline'`, the inline `<style>` needs no nonce.
 */
export function buildThemeTokenStyle(
	themeTokens?: Record<string, string>
): string {
	if (!themeTokens) {
		return "";
	}
	const decls: string[] = [];
	for (const [name, value] of Object.entries(themeTokens)) {
		if (
			typeof value === "string" &&
			THEME_TOKEN_NAME_RE.test(name) &&
			value.length > 0 &&
			!THEME_TOKEN_VALUE_UNSAFE_RE.test(value)
		) {
			decls.push(`${name}: ${value.trim()};`);
		}
	}
	if (decls.length === 0) {
		return "";
	}
	return `<style>html:root{${decls.join("")}}</style>`;
}

/**
 * Build a full-HTML companion's sandboxed document (Path B, `ui_format: "html"`).
 *
 * @param nonce       Host-generated per-mount nonce, echoed in the handshake.
 * @param appHtml     The app's self-contained HTML (a `vite-plugin-singlefile`
 *                    build). Mounted directly as `srcdoc`; NOT eval'd.
 * @param pluginId    The owning plugin id (baked into the bridge; not secret — the
 *                    host re-validates every claim against the same id).
 * @param mountContext Optional `{ spaceId, docId }` baked as `window.ryu.context`.
 * @param csp         Optional per-app CSP allowlist (only ever a TRUSTED manifest's).
 *                    Widens `connect-src` (fetch targets) + `img-src`/`media-src`
 *                    (remote assets) for the declared hosts; the egress lock is the
 *                    default when omitted.
 */
export function htmlCompanionSrcdoc(
	nonce: string,
	appHtml: string,
	pluginId: string,
	mountContext?: unknown,
	csp?: CompanionCsp,
	themeTokens?: Record<string, string>
): string {
	const scriptSafe = (value: unknown): string =>
		JSON.stringify(value ?? null)
			.replace(/</g, "\\u003c")
			.replace(/>/g, "\\u003e")
			.replace(/&/g, "\\u0026")
			.replace(/\u2028/g, "\\u2028")
			.replace(/\u2029/g, "\\u2029");
	const fragment = htmlCompanionHeadFragment(
		scriptSafe(nonce),
		scriptSafe(pluginId),
		scriptSafe(mountContext),
		buildHtmlCompanionCsp(csp)
	);
	// The theme-token bridge goes AFTER the bridge script but still inside <head>.
	// It uses an `html:root` selector (higher specificity than the companion's own
	// `:root{…}`), so its resolved host values win regardless of where the app's own
	// inlined <style> sits relative to it.
	const themeStyle = buildThemeTokenStyle(themeTokens);
	const head = themeStyle ? `${fragment}\n${themeStyle}` : fragment;
	// Inject the CSP + bridge as the FIRST children of <head> so both precede the
	// app's own deferred module scripts. If the app HTML somehow lacks a <head>
	// (never true for a singlefile build), prepend the fragment as a last resort.
	const headOpen = /<head[^>]*>/i;
	if (headOpen.test(appHtml)) {
		return appHtml.replace(headOpen, (match) => `${match}\n${head}`);
	}
	return `${head}\n${appHtml}`;
}
