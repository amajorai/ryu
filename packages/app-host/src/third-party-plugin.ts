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
//   - The host applies a restrictive default CSP unless Core explicitly reports
//     that the user disabled it for a custom app without a declared CSP.
//   - The plugin CAN observe the transferred port (it arrives as a window message
//     any listener sees). We do NOT hide it. Holding the port grants NOTHING:
//     every method is default-DENY on the HOST side (`dispatchRpc`), gated against
//     the Gateway-approved grant set. The default CSP also denies direct network
//     egress; a user can opt out of that default for custom apps with no trusted CSP.
//   - BASE64, not string concatenation, carries the bundle: a plugin body
//     containing `</script>` cannot break out of the tag. This is defense in
//     depth, NOT the load-bearing boundary (the null-origin sandbox is).
//
// FILE LAYOUT: this module keeps the Path A entry point and its `makePlugin`
// contract; the document scaffolding, `installWindowRyu`, the Path B builder, CSP
// and theme helpers live in sibling modules and are re-exported here, so
// `@ryu/app-host/third-party-plugin` stays the one public import path.

import type { z } from "zod";
import { I18N_BRIDGE } from "./companion-i18n-bridge.ts";
import {
	type CompanionLocale,
	companionHtmlLocaleAttributes,
} from "./companion-locale.ts";
import {
	type companionScriptLiteralSchema,
	indentGeneratedScript,
	scriptSafe,
} from "./companion-script-fragments.ts";
import {
	buildCompanionThemeLayoutCss,
	buildThemeTokenStyle,
} from "./companion-theme-style.ts";
import {
	pluginActivationScript,
	pluginBridgePrelude,
	pluginDocumentHead,
} from "./plugin-srcdoc-document.ts";
import { installWindowRyuScript } from "./plugin-window-ryu-script.ts";

export {
	buildHtmlCompanionCsp,
	type CompanionCsp,
	sanitizeCspOrigin,
} from "./companion-csp.ts";
export {
	companionScriptLiteralSchema,
	RPC_ARGS_SCRIPT,
} from "./companion-script-fragments.ts";
export {
	buildCompanionThemeLayoutCss,
	buildThemeTokenStyle,
} from "./companion-theme-style.ts";
export { htmlCompanionSrcdoc } from "./html-companion-srcdoc.ts";

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
 *                      that forges a different path is rejected regardless.
 *  @param themeTokens  Optional complete host appearance snapshot for first paint.
 *  @param scaleInParent  Whether the containing Ryu root already applies the UI
 *                        scale; prevents nested iframe zoom from doubling it.
 *  @param options  Whether to inject the default network-restricting CSP. Core keeps
 *                  this on for trusted apps and defaults it on for custom apps
 *                  unless the user opts out. */
export function thirdPartyPluginSrcdoc(
	nonce: string,
	uiCodeBase64: string,
	pluginId: string,
	// Optional host-supplied mount context (e.g. `{ spaceId, docId }` when the app is
	// opened as a Space document). Baked in as `window.ryu.context` so the app knows
	// which document to load/save via `spaces.getDoc`/`spaces.updateDoc`. Host-
	// controlled, JSON-serialized (never plugin input).
	mountContext?: z.input<typeof companionScriptLiteralSchema>,
	/** Optional resolved host appearance for a no-flash first paint. */
	themeTokens?: Record<string, string>,
	/** True when the containing Ryu root already applies `--ryu-ui-scale`. */
	scaleInParent = false,
	options?: {
		enforceDefaultCsp?: boolean;
		closeOnEscape?: boolean;
		/** The host UI language: seeds `<html lang dir>`, then follows changes. */
		locale?: CompanionLocale;
	}
): string {
	const enforceDefaultCsp = options?.enforceDefaultCsp ?? true;
	// JSON.stringify does NOT escape `</script>` or the JS line separators U+2028/9,
	// so a value baked into the inline <script> could break out of the tag or the
	// string literal. Escape the HTML/JS-sensitive chars for every interpolated
	// literal (defense in depth — mount context is host-controlled, but a manifest
	// `id` and future context values may not be).
	const nonceLiteral = scriptSafe(nonce);
	const codeLiteral = scriptSafe(uiCodeBase64);
	const pluginIdLiteral = scriptSafe(pluginId);
	const mountContextLiteral = scriptSafe(mountContext);
	const themeTokensLiteral = scriptSafe(themeTokens);
	const themeStyle = buildThemeTokenStyle(themeTokens);
	const themeLayoutStyle = themeTokens
		? `<style>${buildCompanionThemeLayoutCss(scaleInParent)}</style>`
		: "";
	const defaultCspMeta = enforceDefaultCsp
		? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; connect-src 'none'; webrtc 'block'; frame-src 'none'; base-uri 'none'; form-action 'none'" />`
		: "";
	return [
		pluginDocumentHead(
			companionHtmlLocaleAttributes(options?.locale),
			defaultCspMeta,
			themeTokens ? `${themeStyle}\n${themeLayoutStyle}` : ""
		),
		pluginBridgePrelude(
			{
				codeLiteral,
				mountContextLiteral,
				nonceLiteral,
				pluginIdLiteral,
				themeTokensLiteral,
			},
			options?.closeOnEscape === true
		),
		"",
		makePluginScript(),
		"",
		installWindowRyuScript(),
		"",
		pluginActivationScript(),
	].join("\n");
}

/** The Path A `makePlugin(pluginId)` declaration: builds the `RyuPlugin` context the
 *  bundle's `activate(context)` receives. Every capability is a grant-gated RPC. */
function makePluginScript(): string {
	return `    // The RyuPlugin contract the plugin's activate() receives. Every capability
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
          capabilities: function () { return call("host.capabilities", []); },
${indentGeneratedScript(I18N_BRIDGE, "          ")},
          node: {
            shareOrigins: function () { return call("node.shareOrigins", []); }
          },
          native: {
            haptics: function (a) { return call("native.haptics", [a || {}]); },
            notifications: {
              create: function (a) { return call("native.notifications.create", [a || {}]); }
            },
            liveActivities: {
              update: function (a) { return call("native.liveActivities.update", [a || {}]); }
            }
          },
          ui: {
            toast: {
              show: function (a) { return call("ui.toast.show", [a || {}]); },
              update: function (a) { return call("ui.toast.update", [a || {}]); },
              dismiss: function (a) { return call("ui.toast.dismiss", [a || {}]); }
            }
          },
          // Projected {id,name}[] — the host never returns a secret (invariant #5).
          listAgents: function () { return call("core.listAgents", []); },
          // Secret-free provider/model/agent/app/hook metadata for shared Ryu pickers.
          catalog: {
            snapshot: function () { return call("catalog.snapshot", []); },
            models: function (a) { return call("catalog.models", [a || {}]); }
          },
          // Saved subscription accounts + usage (needs grant subscriptions:read; Core
          // also requires the node owner/admin). Labels may be emails: never persist them.
          subscriptions: {
            list: function (a) { return call("subscriptions.list", [a || {}]); },
            usage: function (a) { return call("subscriptions.usage", [a || {}]); }
          },
          // Cross-chat broadcast (needs grant chat.sendFollowUp). The host returns
          // only redacted summaries and accepts one explicitly targeted message;
          // it never exposes a node token or transcript to the frame.
          chat: {
            list: function () { return call("chat.list", []); },
            send: function (a) { return call("chat.send", [a || {}]); }
          },
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
          // Shared background-process registry (needs background:control). Stop
          // is a cooperative request delivered to the process owner.
          background: {
            list: function (args) { return call("background.list", [args || {}]); },
            stop: function (args) { return call("background.stop", [args || {}]); }
          },
          // Durable per-app KV (needs storage:kv). Values are strings.
          backups: {
            destinations: function (args) { return call("backups.destinations", [args || {}]); },
            create: function (args) { return call("backups.create", [args || {}]); },
            list: function (args) { return call("backups.list", [args || {}]); },
            get: function (args) { return call("backups.get", [args || {}]); },
            restore: function (args) { return call("backups.restore", [args || {}]); },
          },
          storage: {
            get: function (args) { return call("storage.get", [args || {}]); },
            set: function (args) { return call("storage.set", [args || {}]); },
            delete: function (args) { return call("storage.delete", [args || {}]); },
            keys: function (args) { return call("storage.keys", [args || {}]); },
            compareAndSet: function (args) { return call("storage.compareAndSet", [args || {}]); }
          },
          // Seal/open under this app's own key (needs crypto:seal). The key is
          // derived by Core per app and never enters the frame, so sealing is a
          // host call rather than a local crypto routine.
          crypto: {
            seal: function (args) { return call("crypto.seal", [args || {}]); },
            open: function (args) { return call("crypto.open", [args || {}]); },
            status: function () { return call("crypto.status", []); }
          },
          // Spaces documents (needs spaces:docs) — the app owns docs of kind
          // app:<pluginId>; persisted, search-embedded, backlinked, Space-routed.
          spaces: {
            ensureSpace: function (args) { return call("spaces.ensureSpace", [args || {}]); },
            search: function (args) { return call("spaces.search", [args || {}]); },
            createDoc: function (args) { return call("spaces.createDoc", [args || {}]); },
            getDoc: function (args) { return call("spaces.getDoc", [args || {}]); },
            updateDoc: function (args) { return call("spaces.updateDoc", [args || {}]); },
            listDocs: function (args) { return call("spaces.listDocs", [args || {}]); },
            deleteDoc: function (args) { return call("spaces.deleteDoc", [args || {}]); },
            createDatabase: function (args) { return call("spaces.createDatabase", [args || {}]); },
            listDatabases: function (args) { return call("spaces.listDatabases", [args || {}]); },
            getDatabase: function (args) { return call("spaces.getDatabase", [args || {}]); },
            updateDatabase: function (args) { return call("spaces.updateDatabase", [args || {}]); },
            queryDatabase: function (args) { return call("spaces.queryDatabase", [args || {}]); },
            deleteDatabase: function (args) { return call("spaces.deleteDatabase", [args || {}]); }
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
    }`;
}
