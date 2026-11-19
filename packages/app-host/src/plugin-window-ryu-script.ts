// Path A `installWindowRyu()` for `thirdPartyPluginSrcdoc` (`third-party-plugin.ts`):
// installs `window.ryu` (and the `window.openai` alias) over the same capability-
// gated port before the plugin bundle runs. The middle service namespaces live in
// `plugin-window-ryu-services.ts` so each file stays under the size limits.

import { I18N_BRIDGE } from "./companion-i18n-bridge.ts";
import { indentGeneratedScript } from "./companion-script-fragments.ts";
import { PLUGIN_WINDOW_RYU_SERVICES_SCRIPT } from "./plugin-window-ryu-services.ts";

/** The `installWindowRyu` function declaration spliced into the Path A bootstrap. */
export function installWindowRyuScript(): string {
	return `    // Install window.ryu — the app host-bridge surface a full-page Companion app
    // (and the @ryu/apps SDK) reads. Every method is an RPC over the SAME capability-
    // gated port; the host grant-gates each against the plugin's Gateway-approved
    // grants (model.complete←hook:side-model, agent.run←hook:run-agent, storage.*←
    // storage:kv). Nothing here holds a token or reaches the network directly
    // (connect-src 'none'). Setting __ryuHostBridge lets the SDK's installRyuBridge
    // ADOPT this host-installed bridge instead of stranding calls in a port-less outbox.
    function installWindowRyu() {
      var ryu = {
        host: {
          capabilities: function () { return call("host.capabilities", []); },
${indentGeneratedScript(I18N_BRIDGE, "          ")},
          native: {
            haptics: function (a) { return call("native.haptics", [a || {}]); },
            notifications: {
              create: function (a) { return call("native.notifications.create", [a || {}]); }
            },
            liveActivities: {
              update: function (a) { return call("native.liveActivities.update", [a || {}]); }
            }
          }
        },
${indentGeneratedScript(I18N_BRIDGE, "        ")},
        listAgents: function () { return call("core.listAgents", []); },
        // Agent Mail routes are host-authenticated; the frame receives no node
        // token and the host validates the relative path before fetching.
        mail: {
          list: function () { return call("mail.list", []); },
          messages: function (a) { return call("mail.messages", [a || {}]); },
          create: function (a) { return call("mail.create", [a || {}]); },
          delete: function (a) { return call("mail.delete", [a || {}]); },
          rotateSecret: function (a) { return call("mail.rotateSecret", [a || {}]); },
          send: function (a) { return call("mail.send", [a || {}]); },
          inboundUrl: function (a) { return call("mail.inboundUrl", [a || {}]); },
          request: function (a) { return call("mail.request", [a || {}]); }
        },
        // Secret-free provider/model/agent/app/hook metadata for shared Ryu pickers.
        files: {
          read: function (a) { return call("files.read", [a || {}]); },
          write: function (a) { return call("files.write", [a || {}]); }
        },
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
        // only redacted summaries and accepts one explicitly targeted message.
        chat: {
          list: function () { return call("chat.list", []); },
          send: function (a) { return call("chat.send", [a || {}]); }
        },
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
        // Spaces documents (needs grant spaces:docs). The app owns docs of kind
        // app:<pluginId>; source is a string (JSON.stringify your scene).
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
        },
        // Media generation (needs grant media:generate) + speech-to-text
        // (media:transcribe). Results are always data: URLs (the host inlines remote
        // provider URLs) so the CSP-locked frame can render them.
        media: {
          image: function (args) { return call("media.image", [args || {}]); },
          video: function (args) { return call("media.video", [args || {}]); },
          audio: function (args) { return call("media.audio", [args || {}]); },
          tts: function (args) { return call("media.tts", [args || {}]); },
          ttsEngines: function () { return call("media.ttsEngines", []); },
          ttsEngineInstall: function (args) { return call("media.ttsEngineInstall", [args || {}]); },
          recording: function (args) { return call("media.recording", [args || {}]); },
          transcribe: function (args) { return call("media.transcribe", [args || {}]); }
        },
        // Read-only catalog reads (needs grant core:list_agents) — chat models + TTS engines.
        // Assistant bridge (needs grant assistant:context). Tell the ONE global Ask
        // Ryu panel what THIS app's page is showing, lend it this page's own
        // instructions while the app is open, and open/ask it. Write-only: an app
        // steers the assistant about itself and never reads the conversation back.
        assistant: {
          updateModelContext: function (input) { return call("ui.updateModelContext", [input || {}]); },
          publishContext: function (items) { return call("assistant.publishContext", [{ items: items || [] }]); },
          clearContext: function () { return call("assistant.clearContext", []); },
          registerSurface: function (s) { return call("assistant.registerSurface", [s || {}]); },
          clearSurface: function () { return call("assistant.clearSurface", []); },
          open: function (a) { return call("assistant.open", [a || {}]); }
        },
        registry: {
          engineModels: function () { return call("registry.engineModels", []); },
          ttsEngines: function () { return call("registry.ttsEngines", []); },
          agents: function () { return call("registry.agents", []); }
        },
        // Background processes (needs grant background:control). Stop is a
        // cooperative request delivered to the process owner.
        background: {
          list: function (a) { return call("background.list", [a || {}]); },
          stop: function (a) { return call("background.stop", [a || {}]); }
        },
        // Asset picker: GIFs via the host (Core proxy needs the node token). Icons/
        // logos are fetched directly by the app under its per-app CSP allowlist.
        assets: {
          searchGifs: function (a) { return call("assets.searchGifs", [a || {}]); },
          searchImages: function (a) { return call("assets.searchImages", [a || {}]); }
        },
${PLUGIN_WINDOW_RYU_SERVICES_SCRIPT}
        // App installation (needs grant plugins:install). A builder app installs the
        // companion-only app it made; the host checks the bundle against the caller's
        // own com.local.<app>.* namespace. Kept in manual lockstep with Path B below.
        apps: {
          installBundle: function (b) { return call("apps.installBundle", [b]); }
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
	              try {
	                var tokens = JSON.parse(d);
	                applyThemeTokens(tokens);
	                if (opts.onChange) opts.onChange(tokens);
	              } catch (e) {}
	            });
            h.promise.catch(function () {});
            return { dispose: h.cancel };
          },
          // The host's display preferences, streamed like the theme. onChange gets
          // { friendly: boolean } now and on every change. friendly is the app-wide
          // "Friendly names" toggle: true means the shell is showing plain language,
          // so a companion should say "Connected search", not "Graph". The frame is
          // null-origin and cannot read the host's storage, so this is the only route.
          // Also mirrored onto <html data-ryu-friendly> so a companion can branch in
          // CSS alone, the same way it already themes off the injected tokens.
          subscribePrefs: function (opts) {
            opts = opts || {};
            var h = callStream("shell.prefsSubscribe", [{}], function (d) {
              var prefs;
              try { prefs = JSON.parse(d); } catch (e) { return; }
              try {
                document.documentElement.setAttribute(
                  "data-ryu-friendly", prefs && prefs.friendly === false ? "false" : "true"
                );
              } catch (e) {}
              if (opts.onChange) { try { opts.onChange(prefs); } catch (e) {} }
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
          registerTabIcon: function (icons) {
            var h = callStream("shell.registerTabIcon", [{ icons: icons || [] }], function () {});
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
	  // Compatibility for the original first adopter. New apps use the generic
	  // namespace; both names reference the same credential-free bridge object.
	  ryu.tokenTable = ryu.realtime;
      try {
        window.ryu = ryu;
        // window.openai alias for OpenAI-Apps-SDK compatibility (parity with the
        // inline-widget bridge); apps may read either name.
        if (!window.openai) window.openai = ryu;
        window.__ryuHostBridge = true;
      } catch (e) { /* frame globals are writable in the sandbox; ignore if not */ }
    }`;
}
