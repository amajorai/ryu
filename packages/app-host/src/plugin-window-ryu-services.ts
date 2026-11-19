// The service namespaces of the Path A `window.ryu` bridge (`installWindowRyu` in
// `plugin-window-ryu-script.ts`): fine-tune, monitors, workflows, ghost, app HTTP,
// realtime, ui, and the per-app request forwarders through skills. Every verb is an
// RPC over the capability-gated port; the host grant-gates each one. Kept in step
// with the Path B bridge (`html-companion-window-ryu*.ts`) by hand.

/** Object-literal members spliced into `installWindowRyu()`; indentation is output. */
export const PLUGIN_WINDOW_RYU_SERVICES_SCRIPT = `        // Fine-tune runs (needs grant finetune:runs). The @ryu/finetune app drives
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
        // Website monitors (needs grant monitors:crud). The @ryu/monitors app
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
        // @ryu/workflows companion drives Core's DAG workflow engine; the host
        // calls the existing /workflows* + /api/workflows/catalog* API directly.
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
        // Ghost record→replay (needs grant ghost:record). RecordToWorkflow records a
        // native-desktop action sequence into a recipe; the recipe-node picker lists them.
        ghost: {
          recipes: function () { return call("ghost.recipes", []); },
          recordStart: function (a) { return call("ghost.recordStart", [a || {}]); },
          recordStatus: function () { return call("ghost.recordStatus", []); },
          recordStop: function () { return call("ghost.recordStop", []); }
        },
        // Generic own-sidecar HTTP (grant app:http). The host derives the target
        // from this companion's owning plugin id; the frame supplies no host/id.
        app: {
          request: function (a) { return call("app.request", [a || {}]); }
        },
        // Generic application-room realtime (grant app:realtime). The trusted
        // host owns the node target/token and returns only opaque connection
        // metadata; this namespace never receives a URL or credential.
        realtime: {
          connect: function (a, opts) {
            a = a || {}; opts = opts || {};
            return call("realtime.connect", [{ room_id: a.roomId }]).then(function (info) {
              var stream = callStream("realtime.subscribe", [{ connection_id: info.connection_id }], function (raw) {
                var push;
                try { push = JSON.parse(raw); } catch (_) { return; }
                if (push && push.type === "event" && typeof opts.onEvent === "function") {
                  opts.onEvent({ name: push.name, data: push.data });
                } else if (push && push.type === "presence" && typeof opts.onPresence === "function") {
                  opts.onPresence({ data: push.data });
                } else if (push && push.type === "resync_required" && typeof opts.onResyncRequired === "function") {
                  opts.onResyncRequired({ dropped: push.dropped, reason: push.reason });
                } else if (push && push.type === "close" && typeof opts.onClose === "function") {
                  opts.onClose({ code: push.code, reason: push.reason });
                }
              });
              stream.promise.catch(function (error) {
                if (typeof opts.onError === "function") opts.onError(error);
              });
              var closed = false;
              return {
                access: info.access,
                memberId: info.member_id,
                presence: info.presence,
                roomId: info.room_id,
                publish: function (name, data) {
                  return call("realtime.publish", [{ connection_id: info.connection_id, event: name, data: data }]);
                },
                publishPresence: function (data) {
                  return call("realtime.presence", [{ connection_id: info.connection_id, data: data }]);
                },
                close: function () {
                  if (closed) return Promise.resolve();
                  closed = true;
                  stream.cancel();
                  return call("realtime.close", [{ connection_id: info.connection_id }]);
                }
              };
            });
          }
        },
        // Host-vetted browser navigation. ui.openExternal accepts only http(s)
        // and is a local host capability, so the sandbox never opens URLs itself.
        ui: {
          openExternal: function (a) { return call("ui.openExternal", [a || {}]); },
          // Stable ephemeral notification contract (grant ui:toast). The host owns
          // namespacing/rate limits/rendering; the frame only receives an opaque id.
          toast: {
            show: function (a) { return call("ui.toast.show", [a || {}]); },
            update: function (a) { return call("ui.toast.update", [a || {}]); },
            dismiss: function (a) { return call("ui.toast.dismiss", [a || {}]); }
          }
        },
        // Outpost (needs grant social:crud). ONE generic forwarder plus two navigation
        // verbs — see the sibling bridge below for why the app's 33 sidecar routes do
        // not each get a verb here. Kept in step with that builder deliberately: the two
        // serve the two companion mount paths (Path A ESM module, Path B self-contained
        // HTML bundle), and a verb present in only one is a verb whose availability
        // depends on how the app happened to be built.
        social: {
          request: function (a) { return call("social.request", [a || {}]); },
          open: function (a) { return call("social.open", [a || {}]); },
          openList: function () { return call("social.openList", []); }
        },
        // Subtitles (needs grant subtitles:crud). ONE forwarder and no navigation verb —
        // the companion IS the whole surface. Kept in step with the sibling bridge below
        // for the same reason Outpost is.
        subtitles: {
          request: function (a) { return call("subtitles.request", [a || {}]); }
        },
        // Automated Reasoning (needs grant reasoning:check). ONE forwarder and no
        // navigation verb — the companion IS the whole surface, so it never opens a
        // shell tab. Kept in step with the sibling bridge below for the same reason
        // Outpost is: the two serve the two companion mount paths, and a verb present
        // in only one is a verb whose availability depends on how the app was built.
        reasoning: {
          request: function (a) { return call("reasoning.request", [a || {}]); }
        },
        safeActions: {
          request: function (a) { return call("safeActions.request", [a || {}]); }
        },
        // Deep Read (needs grant rlm:query). Same ONE-forwarder shape as reasoning
        // directly above, and kept in step with the sibling bridge below by hand.
        rlm: {
          request: function (a) { return call("rlm.request", [a || {}]); }
        },
        // Tuition (needs grant tuition:crud) and Wire (needs grant news:crud). Same
        // ONE-forwarder shape as reasoning directly above.
        tuition: {
          request: function (a) { return call("tuition.request", [a || {}]); }
        },
        news: {
          request: function (a) { return call("news.request", [a || {}]); }
        },
        // Visual plan review (needs grant blueprint:review). Same ONE-forwarder,
        // no-navigation-verb shape as Reasoning directly above, and kept in step with
        // the sibling bridge below for the same reason.
        blueprint: {
          request: function (a) { return call("blueprint.request", [a || {}]); }
        },
        // Skill authoring + shared agent distribution (needs grant skills:crud).
        // The host keeps its node token and owns the target picker; the frame sends
        // only the installed skill id. Kept in manual lockstep with Path B below.
        skills: {
          getSource: function (a) { return call("skills.getSource", [a || {}]); },
          create: function (a) { return call("skills.create", [a || {}]); },
          update: function (a) { return call("skills.update", [a || {}]); },
          listVersions: function (a) { return call("skills.listVersions", [a || {}]); },
          versionSource: function (a) { return call("skills.versionSource", [a || {}]); },
          snapshot: function (a) { return call("skills.snapshot", [a || {}]); },
          restore: function (a) { return call("skills.restore", [a || {}]); },
          distribute: function (a) { return call("skills.distribute", [a || {}]); },
          setTitle: function (a) { return call("skills.setTitle", [a || {}]); }
        },`;
