// First-party app namespaces of the Path B `window.ryu` bridge
// (`html-companion-srcdoc.ts`): quests, activity, timeline, calendar, warmup,
// learning, approvals, notifications, suggestions, meetings, app HTTP, realtime and
// ui. Every verb is an RPC over the capability-gated port; the host grant-gates it.

/** Object-literal members spliced after `htmlCompanionWindowRyuCoreScript()`. */
export const HTML_COMPANION_WINDOW_RYU_APPS_SCRIPT = `      // Quests (needs grant quests:crud). The @ryu/quests companion drives Core's
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
        capture: function (a) { return call("quests.capture", [a || {}]); },
        use: function (a) { return call("quests.use", [a || {}]); },
        pin: function (a) { return call("quests.pin", [a || {}]); },
        scratchpad: function () { return call("quests.scratchpad", []); },
        setScratchpad: function (a) { return call("quests.setScratchpad", [a || {}]); },
        openDetectionSettings: function () { return call("quests.openDetectionSettings", []); }
      },
      // Activity feed (needs grant activity:read). The @ryu/activity companion
      // renders Core's read-only unified feed; the host calls /api/activity directly
      // (the monitors pattern). openSession is a shell-navigation verb (opens the chat
      // tab for an item's session id).
      activity: {
        list: function (a) { return call("activity.list", [a || {}]); },
        audit: function (a) { return call("activity.audit", [a || {}]); },
        prune: function () { return call("activity.prune", []); },
        score: function (a) { return call("activity.score", [a || {}]); },
        trace: function (a) { return call("activity.trace", [a || {}]); },
        redteam: function (a) { return call("activity.redteam", [a || {}]); },
        eval: function (a) { return call("activity.eval", [a || {}]); },
        importTrace: function (a) { return call("activity.importTrace", [a || {}]); },
        openSession: function (a) { return call("activity.openSession", [a || {}]); }
      },
      // Timeline (needs grant timeline:read). The @ryu/timeline companion renders
      // the activity replay scrubber; the host calls Shadow's device-local /timeline
      // + /journal + /frame directly (the monitors pattern, but WITHOUT a node token —
      // Shadow is machine-pinned). frame returns a data: URL (CSP img-src data: blob:);
      // openReview/openSettings are shell-navigation verbs.
      timeline: {
        transcripts: function (a) { return call("timeline.transcripts", [a || {}]); },
        list: function (a) { return call("timeline.list", [a || {}]); },
        journal: function (a) { return call("timeline.journal", [a || {}]); },
        frame: function (a) { return call("timeline.frame", [a || {}]); },
        openReview: function () { return call("timeline.openReview", []); },
        openSettings: function () { return call("timeline.openSettings", []); }
      },
      // Calendar (needs grant calendar:crud). The @ryu/calendar companion renders
      // the scheduled-runs calendar and schedules an agent routine; the host calls Core's
      // /heartbeat/jobs + /workflows + /api/agents directly (the monitors pattern),
      // plus the createScheduledAgentWorkflow routine composite.
      calendar: {
        jobs: function () { return call("calendar.jobs", []); },
        workflows: function () { return call("calendar.workflows", []); },
        agents: function () { return call("calendar.agents", []); },
        createAutomation: function (a) { return call("calendar.createAutomation", [a || {}]); }
      },
      // Warmup (needs grant warmup:crud). The @ryu/warmup companion schedules a
      // keep-alive ping to each subscription agent so its rolling usage window is
      // already open; the host calls Core's /api/agents (+ /usage, /acp-config) and
      // /heartbeat/jobs directly (the monitors pattern).
      warmup: {
        detect: function () { return call("warmup.detect", []); },
        list: function () { return call("warmup.list", []); },
        apply: function (a) { return call("warmup.apply", [a || []]); },
        runNow: function (a) { return call("warmup.runNow", [a || {}]); }
      },
      // Learning (needs grant learning:crud). The @ryu/learning companion renders
      // the read-only continual-learning surface; the host calls Core's
      // /api/learn/config + /api/experience/list + /api/healing/status directly (the
      // monitors pattern). All READ-ONLY.
      learning: {
        config: function () { return call("learning.config", []); },
        experience: function () { return call("learning.experience", []); },
        healing: function () { return call("learning.healing", []); }
      },
      // Inbox / Approvals (needs grant approvals:crud). The @ryu/approvals companion
      // renders the unified inbox; the host calls Core's /api/approvals/* +
      // /api/notifications/* (host-resolved user id) + Shadow's /proactive + /api/feedback
      // directly (the monitors pattern). Sender icon, archive, and restore operations
      // use the same notifications capability. Suggestions open chat through the generic
      // shell-navigation verb. The inbox's quest task check-off reuses the
      // quests.* verbs above (the app also holds quests:crud).
      approvals: {
        list: function () { return call("approvals.list", []); },
        approve: function (a) { return call("approvals.approve", [a || {}]); },
        reject: function (a) { return call("approvals.reject", [a || {}]); }
      },
      notifications: {
        list: function () { return call("notifications.list", []); },
        appIcons: function (a) { return call("notifications.appIcons", [a || {}]); },
        markRead: function (a) { return call("notifications.markRead", [a || {}]); },
        ack: function (a) { return call("notifications.ack", [a || {}]); },
        archive: function (a) { return call("notifications.archive", [a || {}]); },
        unarchive: function (a) { return call("notifications.unarchive", [a || {}]); }
      },
      suggestions: {
        list: function () { return call("suggestions.list", []); },
        feedback: function (a) { return call("suggestions.feedback", [a || {}]); },
        openInChat: function (a) { return call("suggestions.openInChat", [a || {}]); }
      },
      // Meetings (needs grant meetings:crud). The @ryu/meetings companion renders
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
          setIcon: function (a) { return call("meetings.setIcon", [a || {}]); },
          import: function () { return call("meetings.import", []); },
        open: function (a) { return call("meetings.open", [a || {}]); },
        openNotes: function (a) { return call("meetings.openNotes", [a || {}]); },
        openList: function () { return call("meetings.openList", []); }
      },
      // Generic own-sidecar HTTP (grant app:http). Kept in step with the Path A
      // bridge above; Core's ext-proxy applies the manifest route allowlist.
      app: {
        request: function (a) { return call("app.request", [a || {}]); }
      },
      // Generic application-room realtime (grant app:realtime). Kept in sync
      // with the Path A bridge; credentials remain in the trusted host.
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
      // Host-vetted browser navigation. Kept in step with the Path A bridge.
      ui: {
        openExternal: function (a) { return call("ui.openExternal", [a || {}]); },
        toast: {
          show: function (a) { return call("ui.toast.show", [a || {}]); },
          update: function (a) { return call("ui.toast.update", [a || {}]); },
          dismiss: function (a) { return call("ui.toast.dismiss", [a || {}]); }
        }
      },`;
