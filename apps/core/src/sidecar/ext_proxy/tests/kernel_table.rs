use super::*;

// ── Kernel capabilities (the retired per-app /api/host/<app>/* rows) ─────────

/// Parse one built-in fixture. Compiled in with `include_str!` so a fixture that
/// stops declaring the grant its kernel capability needs is a BUILD-time link to
/// the real file, not a path this test can silently fail to find.
fn fixture(raw: &str) -> crate::plugin_manifest::PluginManifest {
    serde_json::from_str(raw).expect("built-in fixture parses")
}

/// A scoped id spans two router segments; a legacy id must be untouched.
///
/// This is the whole reason the migration needs no `%2F` anywhere: the slash in
/// `@ryu/meetings` is a real path separator, so the id round-trips through a URL
/// as itself.
#[test]
fn scoped_plugin_ids_are_reunited_from_two_path_segments() {
    // `/api/ext/@ryu/meetings/health`
    assert_eq!(
        split_scoped_plugin_path("@ryu".into(), "meetings/health".into()),
        ("@ryu/meetings".to_owned(), "health".to_owned())
    );
    // Deeper tails keep their shape.
    assert_eq!(
        split_scoped_plugin_path("@ryu".into(), "meetings/a/b/c".into()),
        ("@ryu/meetings".to_owned(), "a/b/c".to_owned())
    );
    // `/api/ext/@ryu/meetings` — the plugin root, empty tail.
    assert_eq!(
        split_scoped_plugin_path("@ryu".into(), "meetings".into()),
        ("@ryu/meetings".to_owned(), String::new())
    );
    // A legacy flat id routes exactly as before — no `@`, no rejoin. Uses a
    // SYNTHETIC third-party id on purpose: every first-party legacy id now
    // canonicalizes to a scoped one, and this branch is about the ids that never
    // will (an un-migrated third-party plugin).
    assert_eq!(
        split_scoped_plugin_path("com.acme.app".into(), "health".into()),
        ("com.acme.app".to_owned(), "health".to_owned())
    );
    assert_eq!(
        split_scoped_plugin_path("legacy-plugin".into(), "a/b".into()),
        ("legacy-plugin".to_owned(), "a/b".to_owned())
    );
}

/// Every kernel capability resolves from the table, and an app-provided name does
/// NOT — it must fall through to the binding-registry half of the broker.
#[test]
fn kernel_capability_table_lookup_is_exact() {
    for k in KERNEL_CAPABILITIES {
        assert_eq!(
            kernel_capability(k.cap).map(|r| r.cap),
            Some(k.cap),
            "'{}' must resolve from its own table",
            k.cap
        );
    }
    // An app-provided capability (the `rag` case the broker was built for) and a
    // near-miss must not be captured by the kernel branch.
    assert!(kernel_capability("rag").is_none());
    assert!(kernel_capability("ghost.record").is_none());
    assert!(kernel_capability("").is_none());
    // User-aware operations are app host-bridge methods only: a sidecar
    // carries no signed-in user to check or record as the reviewer.
    for user_aware in [
        "webhooks.secretGet",
        "webhooks.secretSet",
        "safeActions.request",
    ] {
        assert!(kernel_capability(user_aware).is_none(), "{user_aware}");
    }
}

/// Pin the exact contents of the kernel-capability table.
///
/// `dispatch_kernel_capability` implements the same names in a `match`, and the two
/// can drift: a row added here with no arm falls to the fail-closed `_ => 501`, which
/// is safe but silently dead. Pinning the list forces whoever adds a row to touch
/// this test, which points at the match.
///
/// The first seven are the capabilities that replaced the seven retired
/// `/api/host/<app>/*` routes. `events.emit` is the first row that is NOT a
/// retired callback but a new host primitive — the app-event emit seam. That it
/// arrived as a table row rather than a route is the point of the table.
///
/// `chat.startTurn` + `node.readings` are the app-send pair: post a turn on the
/// user's behalf, and read the live node facts needed to decide whether to. They
/// are the first rows that let an out-of-process app ACT on the user's account
/// rather than only fetch or record, which is why `chat.startTurn` carries a
/// firewall scan and an enabled-by-default approval gate on top of its grant.
#[test]
fn kernel_capability_table_is_pinned() {
    let names: Vec<&str> = KERNEL_CAPABILITIES.iter().map(|k| k.cap).collect();
    assert_eq!(
        names,
        vec![
            "mcp.callTool",
            "notify.fanout",
            "notify.deliver",
            "email.send",
            "email.status",
            "egress.fetch",
            "billing.recordToolCharge",
            "providers.status",
            "providers.call",
            "providers.authorize",
            "tools.call",
            "plugins.installBundle",
            "spaces.fileNotes",
            "chat.startTurn",
            "threads.ensureMainThread",
            "threads.placeInProject",
            "scopeDefaults.set",
            "scopeGuidance.set",
            "node.readings",
            "ghost.replay",
            "ghost.recordStart",
            "ghost.recordStatus",
            "ghost.recordStop",
            "events.emit",
            "realtime.publish",
            "webhooks.list",
            "webhooks.ingressStatus",
            "warmup.detect",
            "warmup.list",
            "warmup.apply",
            "warmup.runNow",
            "approvals.request",
            "runs.rerunAgent",
            "workflows.rerun",
            "vault.credentialFill",
            "vault.totpEnroll",
            "securityKey.request",
        ],
        "KERNEL_CAPABILITIES changed — add the matching arm to \
         `dispatch_kernel_capability` (a missing arm 501s) and update this list"
    );
}

/// The rows whose handler ALSO pins its calling app keep exactly the grant they
/// were reviewed with. On these rows the grant is necessary but not sufficient
/// (or absent), and the app pin is the remaining gate, so changing the grant must
/// be a deliberate edit made next to the pin rationale (`server::app_mcp_call`,
/// `server::app_notify`, `server::app_file_notes`), never a drive-by cleanup.
#[test]
fn kernel_capability_grants_are_pinned() {
    for (cap, grant) in [
        ("mcp.callTool", Some("tools.invoke")),
        ("notify.fanout", None),
        ("spaces.fileNotes", Some("spaces:docs")),
    ] {
        let row = kernel_capability(cap)
            .unwrap_or_else(|| panic!("'{cap}' is not in KERNEL_CAPABILITIES"));
        assert_eq!(
            row.grant, grant,
            "'{cap}' changed its grant; its handler pins the calling app because no \
             existing grant covers it (see docs/app-boundary-extraction-plan.md)"
        );
    }
}

/// The naming invariant that IS the point of this table: a kernel capability is
/// named for the host primitive it exposes, never for the app that happens to call
/// it. A row called `monitors.spider` would just be the retired per-app route with
/// extra steps.
#[test]
fn kernel_capability_names_carry_no_app_name() {
    for k in KERNEL_CAPABILITIES {
        for app in ["monitors", "meetings", "recipes", "com.ryu"] {
            assert!(
                !k.cap.contains(app),
                "kernel capability '{}' names the app '{app}' — name the primitive instead",
                k.cap
            );
        }
    }
}

/// The gate is the declared∩approved intersection, and BOTH halves are load-bearing:
/// a manifest cannot widen itself past what the Gateway approved, and an approval the
/// sidecar never declared in `host_api.grants` is not a licence to use it.
#[test]
fn host_api_grant_needs_both_declaration_and_approval() {
    let manifest = fixture(include_str!(
        "../../../../../../generated/ryu-runtime/apps-store/recipes/manifest.json"
    ));
    let approved: HashSet<String> = ["ghost:record".to_owned()].into_iter().collect();
    assert!(host_api_grant_usable(&manifest, &approved, "ghost:record"));

    // Approved but NOT declared by the sidecar ⇒ denied.
    let over_approved: HashSet<String> = ["ghost:record".to_owned(), "spaces:docs".to_owned()]
        .into_iter()
        .collect();
    assert!(!host_api_grant_usable(
        &manifest,
        &over_approved,
        "spaces:docs"
    ));

    // Declared but NOT approved (revoked, or never validated) ⇒ denied.
    assert!(!host_api_grant_usable(
        &manifest,
        &HashSet::new(),
        "ghost:record"
    ));
}

/// Drift guard: each sidecar that calls a grant-bearing kernel capability must
/// DECLARE that grant in `sidecars[].host_api.grants`, or every call 403s at
/// runtime. Fails if a fixture drops the declaration (or a table row changes its
/// grant without the manifests following).
#[test]
fn callers_declare_the_grant_their_kernel_capability_requires() {
    let healing = fixture(include_str!(
        "../../../../../../generated/ryu-runtime/apps-store/healing/manifest.json"
    ));
    let browser = fixture(include_str!(
        "../../../../../../generated/ryu-runtime/apps-store/browser/manifest.json"
    ));
    let cases: [(&str, &str, &crate::plugin_manifest::PluginManifest); 10] = [
        ("securityKey.request", "browser", &browser),
        ("approvals.request", "healing", &healing),
        ("runs.rerunAgent", "healing", &healing),
        ("workflows.rerun", "healing", &healing),
        (
            "mcp.callTool",
            "monitors",
            &fixture(include_str!(
                "../../../../../../generated/ryu-runtime/apps-store/monitors/manifest.json"
            )),
        ),
        (
            "spaces.fileNotes",
            "meetings",
            &fixture(include_str!(
                "../../../../../../generated/ryu-runtime/apps-store/meetings/manifest.json"
            )),
        ),
        (
            "ghost.recordStart",
            "recipes",
            &fixture(include_str!(
                "../../../../../../generated/ryu-runtime/apps-store/recipes/manifest.json"
            )),
        ),
        (
            "email.send",
            "mail",
            &fixture(include_str!(
                "../../../../../../generated/ryu-runtime/apps-store/mail/manifest.json"
            )),
        ),
        (
            "email.status",
            "mail",
            &fixture(include_str!(
                "../../../../../../generated/ryu-runtime/apps-store/mail/manifest.json"
            )),
        ),
        (
            "egress.fetch",
            "mpp",
            &fixture(include_str!(
                "../../../../../../generated/ryu-runtime/apps-store/mpp/manifest.json"
            )),
        ),
    ];
    for (cap, app, manifest) in cases {
        let grant = kernel_capability(cap)
            .unwrap_or_else(|| panic!("'{cap}' is not in KERNEL_CAPABILITIES"))
            .grant
            .unwrap_or_else(|| panic!("'{cap}' unexpectedly needs no grant"));
        let approved: HashSet<String> = [grant.to_owned()].into_iter().collect();
        assert!(
            host_api_grant_usable(manifest, &approved, grant),
            "the '{app}' sidecar must declare host_api.grants = [\"{grant}\"] for '{cap}'"
        );
        // ...and the app must be able to HOLD it: the Gateway only approves a
        // grant the manifest also lists in `permission_grants`.
        assert!(
            manifest.declares_permission_grant(grant),
            "'{app}' declares '{grant}' on its sidecar but not in permission_grants, \
             so the Gateway can never approve it"
        );
    }
}

/// A **pre-installed** caller never goes through `enable_app` on a fresh install —
/// `plugins::seed` writes its record directly with a hardcoded grant list. So if a
/// pre-installed app's sidecar declares a `host_api` grant, the SEED table must carry
/// that same grant, or the app ships broken out of the box: 403 on every call to
/// its kernel capability, with no user-visible cause and nothing pointing at the
/// seed as the reason.
///
/// Derived over `CORE_PREINSTALLED` rather than naming an app. It used to name
/// `recipes`, which was the only pre-installed caller — and when recipes left the
/// default set this test failed on its `expect`, reporting a premise that had
/// simply expired rather than a defect. The property is about the pre-installed SET,
/// so it is now computed from it: today no pre-installed app declares a `host_api`
/// grant and the loop body runs zero times, which is correct and stays correct.
/// Promote any grant-declaring app back into `CORE_PREINSTALLED` without adding its
/// grants to `seed_overrides` and this turns red immediately.
#[test]
fn preinstalled_callers_are_seeded_with_their_kernel_capability_grant() {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    for spec in crate::plugins::seed::preinstalled_specs() {
        let Some(manifest) = manifests.iter().find(|m| m.id == spec.id) else {
            continue;
        };
        for needed in manifest
            .sidecars
            .iter()
            .flat_map(|s| s.host_api.iter())
            .flat_map(|h| h.grants.iter())
        {
            assert!(
                spec.grants.contains(&needed.as_str()),
                "'{}' is pre-installed and its sidecar declares host_api grant \
                 '{needed}', but the seed writes {:?}. A pre-installed record is written \
                 directly by `plugins::seed` and never passes through `enable_app`, so \
                 the grant must be in `seed_overrides` — otherwise a fresh install 403s \
                 on every call to that capability",
                spec.id,
                spec.grants
            );
        }
    }
}

/// The other half of the same rule, and the one that made the test above stop
/// naming `recipes`: an OPT-IN app must NOT depend on the seed for its grants. It
/// is enabled through `enable_app`, which validates against the Gateway and
/// persists the approved set, so what it needs is the grant in its manifest's
/// `permission_grants` — a seed row would be inert (`preinstalled_specs` never looks
/// up an id outside `CORE_PREINSTALLED`) and is not a substitute.
#[test]
fn an_opt_in_caller_carries_its_grant_in_the_manifest_not_the_seed() {
    let id = crate::plugins::builtins::RECIPES_PLUGIN_ID;
    assert!(
        !crate::plugins::builtins::CORE_PREINSTALLED.contains(&id),
        "'{id}' is opt-in — if it is pre-installed again, this test is testing nothing \
         and the sibling above is the one that must cover it"
    );
    let grant = kernel_capability("ghost.replay")
        .expect("ghost.replay is a kernel capability")
        .grant
        .expect("ghost.replay is grant-gated");
    let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
    let manifest = manifests
        .iter()
        .find(|m| m.id == id)
        .expect("recipes is a compiled-in built-in");
    assert!(
        manifest.permission_grants.iter().any(|g| g == grant),
        "'{id}' must declare '{grant}' in permission_grants — that is the ONLY thing \
         `enable_app` can approve from, and every replay/record call 403s without it"
    );
}
