// Request forwarders and shell primitives of the Path B `window.ryu` bridge
// (`html-companion-srcdoc.ts`): social, subtitles, reasoning, safe actions, rlm,
// tuition, news, blueprint, skills, apps, shell, and the mount context that closes
// the object. Kept in step with the Path A bridge by hand.

/** Object-literal members that close the synchronous `var ryu = { ... };` object. */
export const HTML_COMPANION_WINDOW_RYU_SHELL_SCRIPT = `      // Outpost (needs grant social:crud). The @ryu/social companion renders the
      // compose, calendar, queue and inbox surface. ONE generic request forwarder
      // rather than a verb per endpoint: the host re-issues { method, path, body }
      // against Core's /api/social public mount, which already answers any client
      // holding the node token — so the forwarder widens nothing, and the gates stay the
      // social:crud grant plus Core's ext-proxy route allowlist. The host validates the
      // path (leading slash, no dot-dot segment, no host) before building the URL.
      // open/openList stay named because opening a shell tab is the one thing the frame
      // cannot do for itself.
      social: {
        request: function (a) { return call("social.request", [a || {}]); },
        open: function (a) { return call("social.open", [a || {}]); },
        openList: function () { return call("social.openList", []); }
      },
      // Subtitles (needs grant subtitles:crud). The @ryu/subtitles companion picks a
      // video, queues a local transcription + translation job, and reads the cue list
      // back. ONE generic request forwarder rather than a verb per endpoint: the host
      // re-issues { method, path, body } against Core's /api/subtitles public mount,
      // which already answers any client holding the node token — so the forwarder
      // widens nothing, and the gates stay the subtitles:crud grant plus Core's
      // ext-proxy route allowlist. The host validates the path (leading slash, resolving
      // under the mount, no host) before building the URL. No navigation verb: the
      // companion never opens a shell tab.
      subtitles: {
        request: function (a) { return call("subtitles.request", [a || {}]); }
      },
      // Automated Reasoning (needs grant reasoning:check). The @ryu/reasoning companion
      // authors formal policies and runs the solver playground. ONE generic request
      // forwarder rather than a verb per endpoint: the host re-issues { method, path,
      // body } against Core's /api/reasoning public mount, which already answers any
      // client holding the node token — so the forwarder widens nothing, and the gates
      // stay the reasoning:check grant plus Core's ext-proxy route allowlist. The host
      // validates the path (leading slash, resolving under the mount, no host) before
      // building the URL. No navigation verb: the companion never opens a shell tab.
      reasoning: {
        request: function (a) { return call("reasoning.request", [a || {}]); }
      },
      safeActions: {
        request: function (a) { return call("safeActions.request", [a || {}]); }
      },
      // Deep Read (needs grant rlm:query). The same ONE-forwarder shape as reasoning
      // directly above: the frame supplies { method, path, body } and the host
      // re-issues it against Core's /api/rlm public mount, which already answers any
      // client holding the node token. The gates stay the rlm:query grant plus Core's
      // ext-proxy route allowlist. Kept in step with the sibling bridge above BY HAND.
      rlm: {
        request: function (a) { return call("rlm.request", [a || {}]); }
      },
      // Tuition (needs grant tuition:crud) and Wire (needs grant news:crud). The same
      // ONE-forwarder shape as reasoning directly above: the frame supplies
      // { method, path, body } and the host re-issues it against that app's public
      // mount, which already answers any client holding the node token. The gates stay
      // the app's own grant plus Core's ext-proxy route allowlist. Kept in step with
      // the sibling bridge above BY HAND — nothing tests that the two agree, so a verb
      // added to only one gives a companion whose bridge depends on how it was
      // packaged.
      tuition: {
        request: function (a) { return call("tuition.request", [a || {}]); }
      },
      news: {
        request: function (a) { return call("news.request", [a || {}]); }
      },
      // Visual plan review (needs grant blueprint:review). The @ryu/blueprint companion
      // renders a plan an agent published and records the reviewer's annotations and
      // verdict. ONE generic request forwarder rather than a verb per endpoint: the host
      // re-issues { method, path, body } against Core's /api/blueprint public mount,
      // which already answers any client holding the node token — so the forwarder widens
      // nothing, and the gates stay the blueprint:review grant plus Core's ext-proxy
      // route allowlist. The host validates the path (leading slash, resolving under the
      // mount, no host) before building the URL, which is what keeps an agent-supplied
      // plan id from steering the request off the mount. No navigation verb: the review
      // surface IS the companion.
      blueprint: {
        request: function (a) { return call("blueprint.request", [a || {}]); }
      },
      // Skill authoring (needs grant skills:crud). The @ryu/skill-editor companion
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
        distribute: function (a) { return call("skills.distribute", [a || {}]); },
        setTitle: function (a) { return call("skills.setTitle", [a || {}]); }
      },
      // App installation (needs grant plugins:install). The @ryu/app-studio companion
      // installs the companion-only app it built; the host validates the bundle
      // (app-bundle.ts) and Core leaves it disabled until the user enables it.
      apps: {
        installBundle: function (b) { return call("apps.installBundle", [b]); }
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
              try {
                var tokens = JSON.parse(d);
                applyThemeTokens(tokens);
                if (opts.onChange) opts.onChange(tokens);
              } catch (e) {}
            });
          h.promise.catch(function () {});
          return { dispose: h.cancel };
        },
        // Host display preferences — see the sibling bridge above. Kept in step with
        // it deliberately: the two builders serve the two companion mount paths
        // (Path A ESM module, Path B self-contained HTML bundle), and a verb present
        // in only one is a verb whose availability depends on how the app was built.
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
      context: MOUNT_CONTEXT
    };`;
