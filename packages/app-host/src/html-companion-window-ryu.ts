// The core namespaces of the Path B `window.ryu` bridge (`htmlCompanionSrcdoc` in
// `html-companion-srcdoc.ts`): host, node, i18n, mail, files, catalog, chat, model,
// agent, storage, spaces, media, assistant, background, assets, fine-tune, monitors,
// workflows, ghost and webhooks. Every verb is an RPC over the capability-gated port.
// Kept in step with the Path A bridge (`plugin-window-ryu-script.ts`) by hand.

import { I18N_BRIDGE } from "./companion-i18n-bridge.ts";
import { indentGeneratedScript } from "./companion-script-fragments.ts";

/** Object-literal members that open the synchronous `var ryu = {` object. */
export function htmlCompanionWindowRyuCoreScript(): string {
	return `      host: {
${indentGeneratedScript(I18N_BRIDGE, "        ")}
      },
      node: {
        shareOrigins: function () { return call("node.shareOrigins", []); }
      },
${indentGeneratedScript(I18N_BRIDGE, "      ")},
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
      backups: {
        destinations: function (args) { return call("backups.destinations", [args || {}]); },
        create: function (args) { return call("backups.create", [args || {}]); },
        list: function (args) { return call("backups.list", [args || {}]); },
        get: function (args) { return call("backups.get", [args || {}]); },
        restore: function (args) { return call("backups.restore", [args || {}]); },
      },
      storage: {
        get: function (a) { return call("storage.get", [a || {}]); },
        set: function (a) { return call("storage.set", [a || {}]); },
        delete: function (a) { return call("storage.delete", [a || {}]); },
        keys: function (a) { return call("storage.keys", [a || {}]); },
        compareAndSet: function (a) { return call("storage.compareAndSet", [a || {}]); }
      },
      // Seal/open under this app's own key (needs crypto:seal). The key is
      // derived by Core per app and never enters the frame, so sealing is a
      // host call rather than a local crypto routine.
      crypto: {
        seal: function (a) { return call("crypto.seal", [a || {}]); },
        open: function (a) { return call("crypto.open", [a || {}]); },
        status: function () { return call("crypto.status", []); }
      },
      spaces: {
        ensureSpace: function (a) { return call("spaces.ensureSpace", [a || {}]); },
        search: function (a) { return call("spaces.search", [a || {}]); },
        createDoc: function (a) { return call("spaces.createDoc", [a || {}]); },
        getDoc: function (a) { return call("spaces.getDoc", [a || {}]); },
        updateDoc: function (a) { return call("spaces.updateDoc", [a || {}]); },
        listDocs: function (a) { return call("spaces.listDocs", [a || {}]); },
        deleteDoc: function (a) { return call("spaces.deleteDoc", [a || {}]); },
        createDatabase: function (a) { return call("spaces.createDatabase", [a || {}]); },
        listDatabases: function (a) { return call("spaces.listDatabases", [a || {}]); },
        getDatabase: function (a) { return call("spaces.getDatabase", [a || {}]); },
        updateDatabase: function (a) { return call("spaces.updateDatabase", [a || {}]); },
        queryDatabase: function (a) { return call("spaces.queryDatabase", [a || {}]); },
        deleteDatabase: function (a) { return call("spaces.deleteDatabase", [a || {}]); }
      },
      media: {
        image: function (a) { return call("media.image", [a || {}]); },
        video: function (a) { return call("media.video", [a || {}]); },
        audio: function (a) { return call("media.audio", [a || {}]); },
        tts: function (a) { return call("media.tts", [a || {}]); },
        ttsEngines: function () { return call("media.ttsEngines", []); },
        ttsEngineInstall: function (a) { return call("media.ttsEngineInstall", [a || {}]); },
        recording: function (a) { return call("media.recording", [a || {}]); },
        transcribe: function (a) { return call("media.transcribe", [a || {}]); }
      },
      // Assistant bridge — see the sibling bridge above. Kept in step with it
      // deliberately: a verb present in only one builder is a verb whose
      // availability depends on how the app happened to be built.
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
      // Asset picker: GIFs go through the host (Core proxy needs the node token).
      // Icons/logos are fetched DIRECTLY by the app under its per-app CSP allowlist
      // (csp.connectDomains), so they are NOT bridge methods.
      assets: {
        searchGifs: function (a) { return call("assets.searchGifs", [a || {}]); },
        searchImages: function (a) { return call("assets.searchImages", [a || {}]); }
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
      // Website monitors (needs grant monitors:crud). The @ryu/monitors companion
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
      // @ryu/workflows companion drives Core's DAG workflow engine through these RPCs.
      workflows: {
        connectBindings: function (a) { return call("workflows.connectBindings", [a || {}]); },
        bindConnectTrigger: function (a) { return call("workflows.bindConnectTrigger", [a || {}]); },
        removeConnectBinding: function (a) { return call("workflows.removeConnectBinding", [a || {}]); },
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
        notifyTargets: function () { return call("workflows.notifyTargets", []); },
        hookEvents: function () { return call("workflows.hookEvents", []); },
        composio: function (a) { return call("workflows.composio", [a || {}]); }
      },
      // Ghost record→replay (needs grant ghost:record).
      ghost: {
        recipes: function () { return call("ghost.recipes", []); },
        recordStart: function (a) { return call("ghost.recordStart", [a || {}]); },
        recordStatus: function () { return call("ghost.recordStatus", []); },
        recordStop: function () { return call("ghost.recordStop", []); }
      },
      // Inbound webhook registry + protected secret management (needs grant
      // webhooks:crud). Secret values are explicit get/set calls, not part of the
      // metadata list response.
      webhooks: {
        list: function () { return call("webhooks.list", []); },
        ingressStatus: function () { return call("webhooks.ingressStatus", []); },
        getSecret: function (id) { return call("webhooks.secretGet", [{ id: id }]); },
        setSecret: function (input) { return call("webhooks.secretSet", [input]); }
      },`;
}
