use super::*;

fn policy_with(ids: &[&str], require: bool) -> TrustPolicy {
    TrustPolicy {
        trusted_ids: ids.iter().map(|s| (*s).to_owned()).collect(),
        require_trust_for_host_access: require,
        revoked: BTreeSet::new(),
    }
}

#[test]
fn standalone_carriage_hashes_do_not_change_compiled_trust_identity() {
    let mut manifest: PluginManifest = serde_json::from_value(serde_json::json!({
        "id": "@ryu/test-app",
        "name": "Test App",
        "version": "1.0.0",
        "runnables": []
    }))
    .expect("minimal manifest");
    let exact = manifest_sha256_for_trust(&manifest);
    let exact_bytes = manifest_sha256(&manifest);

    manifest.ui_code_sha256 = Some("ui-hash".to_owned());
    manifest.backend_sha256 = Some("backend-hash".to_owned());

    assert_eq!(manifest_sha256_for_trust(&manifest), exact);
    assert_ne!(manifest_sha256(&manifest), exact_bytes);
}

fn official(org_verified: bool) -> PluginProvenance {
    PluginProvenance {
        source_id: Some(OFFICIAL_MARKETPLACE_SOURCE_ID.to_owned()),
        publisher_org: Some("org_acme".to_owned()),
        org_verified,
        signature_verified: true,
        ..PluginProvenance::default()
    }
}

#[test]
fn official_source_without_a_verified_signature_is_untrusted() {
    let policy = TrustPolicy::default();
    assert_eq!(
        policy.resolve_trust(
            "com.acme.app",
            Some(&PluginProvenance {
                source_id: Some(OFFICIAL_MARKETPLACE_SOURCE_ID.to_owned()),
                ..PluginProvenance::default()
            }),
        ),
        TrustBasis::Untrusted
    );
}

fn sideloaded() -> PluginProvenance {
    PluginProvenance {
        source_id: Some("github-topic".to_owned()),
        ..PluginProvenance::default()
    }
}

// ── The two fail-closed cases this whole feature turns on ────────────────

#[test]
fn allowlisting_a_sideloaded_id_does_not_trust_it() {
    // The discriminating case: the user (or anything able to write one
    // preference key) names a sideloaded plugin. Provenance does not vouch for
    // it, so the allowlist must not promote it.
    let policy = policy_with(&["com.example.evil"], false);
    let trust = policy.resolve_trust("com.example.evil", Some(&sideloaded()));
    assert_eq!(trust, TrustBasis::Untrusted);
    assert!(!trust.vouches());
}

#[test]
fn absent_provenance_is_untrusted_not_trusted() {
    // Every record installed before the provenance column existed deserializes
    // as `None`. That must read as "nothing is known", never as a free pass.
    let policy = policy_with(&["com.example.legacy"], false);
    assert_eq!(
        policy.resolve_trust("com.example.legacy", None),
        TrustBasis::Untrusted
    );
}

// ── Trust resolution ─────────────────────────────────────────────────────

#[test]
fn verified_org_on_the_official_marketplace_vouches() {
    let policy = TrustPolicy::default();
    let trust = policy.resolve_trust("com.acme.app", Some(&official(true)));
    assert!(matches!(trust, TrustBasis::VerifiedPublisher { .. }));
    assert!(trust.vouches());
}

#[test]
fn official_marketplace_without_a_verified_org_still_vouches_but_says_so() {
    let policy = TrustPolicy::default();
    assert_eq!(
        policy.resolve_trust("com.acme.app", Some(&official(false))),
        TrustBasis::OfficialMarketplace
    );
}

#[test]
fn a_third_party_source_claiming_org_verified_is_ignored() {
    // `orgVerified` is an admin decision in Ryu's control plane. Any other
    // source asserting it is just publisher-controlled JSON.
    let liar = PluginProvenance {
        source_id: Some("github-topic".to_owned()),
        org_verified: true,
        org_verified_tier: Some("gold".to_owned()),
        ..PluginProvenance::default()
    };
    let policy = TrustPolicy::default();
    assert_eq!(
        policy.resolve_trust("com.example.liar", Some(&liar)),
        TrustBasis::Untrusted
    );
}

#[test]
fn allowlisting_a_marketplace_plugin_relabels_it() {
    let policy = policy_with(&["com.acme.app"], false);
    assert_eq!(
        policy.resolve_trust("com.acme.app", Some(&official(false))),
        TrustBasis::UserAllowlisted
    );
}

#[test]
fn builtin_provenance_reads_as_a_system_plugin() {
    let policy = TrustPolicy::default();
    assert_eq!(
        policy.resolve_trust("com.example.compiled", Some(&PluginProvenance::builtin())),
        TrustBasis::OfficialMarketplace
    );
}

// ── Enforcement vs exemption must not collapse ───────────────────────────

#[test]
fn sandboxed_and_unenforceable_lanes_are_distinct() {
    assert_eq!(LaneKind::TurnHook.enforcement(), Enforcement::Sandboxed);
    assert_eq!(
        LaneKind::CapabilityAdapter.enforcement(),
        Enforcement::Sandboxed
    );
    assert_eq!(LaneKind::UiBundle.enforcement(), Enforcement::Sandboxed);
    assert_eq!(LaneKind::Sidecar.enforcement(), Enforcement::Unenforceable);
    assert_eq!(
        LaneKind::McpServer.enforcement(),
        Enforcement::Unenforceable
    );
}

#[test]
fn refusal_requires_the_user_to_have_opted_in() {
    let report = PluginIsolation {
        id: "com.example.evil".to_owned(),
        name: "Evil".to_owned(),
        lanes: vec![],
        fully_sandboxed: false,
        unenforceable_lanes: vec![LaneReport {
            kind: LaneKind::Sidecar,
            enforcement: Enforcement::Unenforceable,
            detail: "back (binary)".to_owned(),
        }],
        trust: TrustBasis::Untrusted,
        host_access: HostAccess::Unvetted,
        manifest_drifted: false,
    };
    // Default policy reports, never breaks a working install.
    assert!(!report.should_refuse_host_access(&policy_with(&[], false)));
    // Only an explicit opt-in refuses.
    assert!(report.should_refuse_host_access(&policy_with(&[], true)));
}

#[test]
fn a_vouched_plugin_is_never_refused() {
    let report = PluginIsolation {
        id: "com.acme.app".to_owned(),
        name: "Acme".to_owned(),
        lanes: vec![],
        fully_sandboxed: false,
        unenforceable_lanes: vec![LaneReport {
            kind: LaneKind::Sidecar,
            enforcement: Enforcement::Unenforceable,
            detail: "back (python)".to_owned(),
        }],
        trust: TrustBasis::OfficialMarketplace,
        host_access: HostAccess::Permitted {
            basis: TrustBasis::OfficialMarketplace,
        },
        manifest_drifted: false,
    };
    assert!(!report.should_refuse_host_access(&policy_with(&[], true)));
}

// ── Manifest binding and revocation ──────────────────────────────────────

fn sidecar_manifest(id: &str) -> PluginManifest {
    serde_json::from_value(serde_json::json!({
        "id": id,
        "name": "Drift",
        "version": "1.0.0",
        "runnables": [],
        "mcp_servers": { "srv": { "command": "srv-bin" } }
    }))
    .expect("manifest with an MCP server")
}

fn bound_official(manifest: &PluginManifest) -> PluginProvenance {
    PluginProvenance {
        manifest_sha256: Some(manifest_sha256(manifest)),
        ..official(true)
    }
}

#[test]
fn a_manifest_matching_its_recorded_digest_keeps_its_trust() {
    let manifest = sidecar_manifest("com.acme.bound");
    let provenance = bound_official(&manifest);
    let report = resolve(&manifest, Some(&provenance), &TrustPolicy::default());
    assert!(!report.manifest_drifted);
    assert!(matches!(report.trust, TrustBasis::VerifiedPublisher { .. }));
}

#[test]
fn a_replaced_on_disk_manifest_is_downgraded_to_untrusted() {
    let installed = sidecar_manifest("com.acme.bound");
    let provenance = bound_official(&installed);
    let mut replaced = installed.clone();
    replaced.name = "Swapped after install".to_owned();
    let policy = policy_with(&["com.acme.bound"], true);
    let report = resolve(&replaced, Some(&provenance), &policy);
    assert!(report.manifest_drifted);
    assert_eq!(report.trust, TrustBasis::Untrusted);
    assert_eq!(report.host_access, HostAccess::Unvetted);
    assert_eq!(
        policy.host_access_refusal(&replaced, "1.0.0", Some(&provenance)),
        Some(HostAccessRefusal::UntrustedHostAccess)
    );
    // The unchanged manifest is still vouched for under the same policy.
    assert_eq!(
        policy.host_access_refusal(&installed, "1.0.0", Some(&provenance)),
        None
    );
}

#[test]
fn compiled_provenance_does_not_vouch_for_a_non_compiled_manifest() {
    let manifest = sidecar_manifest("com.example.not-compiled");
    assert!(manifest_drifted(
        &manifest,
        Some(&PluginProvenance::builtin())
    ));
    assert_eq!(
        TrustPolicy::default()
            .resolve_trust_for_manifest(&manifest, Some(&PluginProvenance::builtin())),
        TrustBasis::Untrusted
    );
}

#[test]
fn untrusted_host_access_is_only_refused_when_required() {
    let manifest = sidecar_manifest("com.example.sideload");
    let provenance = sideloaded();
    assert_eq!(
        policy_with(&[], false).host_access_refusal(&manifest, "1.0.0", Some(&provenance)),
        None
    );
    assert_eq!(
        policy_with(&[], true).host_access_refusal(&manifest, "1.0.0", Some(&provenance)),
        Some(HostAccessRefusal::UntrustedHostAccess)
    );
}

#[test]
fn a_fully_sandboxed_plugin_is_not_refused_for_missing_trust() {
    let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
        "id": "com.example.sandboxed",
        "name": "Sandboxed",
        "version": "1.0.0",
        "runnables": []
    }))
    .expect("minimal manifest");
    assert_eq!(
        policy_with(&[], true).host_access_refusal(&manifest, "1.0.0", None),
        None
    );
}

#[test]
fn revocation_entries_match_an_id_or_one_installed_version() {
    assert!(revocation_matches("com.acme.app", "com.acme.app", "1.0.0"));
    assert!(revocation_matches(
        "com.acme.app@1.0.0",
        "com.acme.app",
        "1.0.0"
    ));
    assert!(!revocation_matches(
        "com.acme.app@1.0.1",
        "com.acme.app",
        "1.0.0"
    ));
    assert!(!revocation_matches(
        "com.acme.app2",
        "com.acme.app",
        "1.0.0"
    ));
    assert!(!revocation_matches("com.acme", "com.acme.app", "1.0.0"));
    // Scoped ids carry a leading `@`; only the suffix after the id pins a version.
    assert!(revocation_matches("@ryu/app@2.0.0", "@ryu/app", "2.0.0"));
    assert!(revocation_matches("@ryu/app", "@ryu/app", "2.0.0"));
}

#[test]
fn revocation_refuses_even_a_vouched_plugin_without_the_trust_requirement() {
    let manifest = sidecar_manifest("com.acme.bound");
    let provenance = bound_official(&manifest);
    let mut policy = TrustPolicy::default();
    policy.revoked.insert("com.acme.bound@1.0.0".to_owned());
    assert_eq!(
        policy.host_access_refusal(&manifest, "1.0.0", Some(&provenance)),
        Some(HostAccessRefusal::Revoked {
            entry: "com.acme.bound@1.0.0".to_owned()
        })
    );
    assert_eq!(
        policy.host_access_refusal(&manifest, "1.1.0", Some(&provenance)),
        None
    );
}

#[test]
fn pi_extensions_and_lsp_servers_are_unenforceable_lanes() {
    let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
        "id": "com.example.pi",
        "name": "Pi",
        "version": "1.0.0",
        "runnables": [],
        "contributes": {
            "pi_extensions": [{ "id": "shell", "file": "pi-extensions/shell.ts" }],
            "lsp_servers": { "gopls": { "command": "gopls", "extensionToLanguage": { ".go": "go" } } }
        }
    }))
    .expect("manifest with pi extension and lsp server");
    let kinds: Vec<LaneKind> = resolve(&manifest, None, &TrustPolicy::default())
        .unenforceable_lanes
        .iter()
        .map(|lane| lane.kind)
        .collect();
    assert!(kinds.contains(&LaneKind::PiExtension));
    assert!(kinds.contains(&LaneKind::LspServer));
}

fn runtime_manifest(id: &str) -> PluginManifest {
    serde_json::from_value(serde_json::json!({
        "id": id,
        "name": "Runtime",
        "version": "1.0.0",
        "runnables": [],
        "runtime": { "kind": "python", "entry": "evil_mod", "requirements": ["evil-pkg"] }
    }))
    .expect("manifest with an external runtime")
}

#[test]
fn an_external_runtime_is_an_unenforceable_lane() {
    let manifest = runtime_manifest("com.example.runtime");
    let report = resolve(&manifest, Some(&sideloaded()), &TrustPolicy::default());
    assert!(!report.fully_sandboxed);
    assert_eq!(report.host_access, HostAccess::Unvetted);
    assert_eq!(report.unenforceable_lanes.len(), 1);
    assert_eq!(
        report.unenforceable_lanes[0].kind,
        LaneKind::ExternalRuntime
    );
    assert_eq!(report.unenforceable_lanes[0].detail, "evil_mod (python)");
}

#[test]
fn an_untrusted_external_runtime_is_refused_only_when_required() {
    let manifest = runtime_manifest("com.example.runtime");
    let provenance = sideloaded();
    assert_eq!(
        policy_with(&[], false).host_access_refusal(&manifest, "1.0.0", Some(&provenance)),
        None
    );
    assert_eq!(
        policy_with(&[], true).host_access_refusal(&manifest, "1.0.0", Some(&provenance)),
        Some(HostAccessRefusal::UntrustedHostAccess)
    );
    // A vouched publisher's runtime is still permitted.
    let provenance = bound_official(&manifest);
    assert_eq!(
        policy_with(&[], true).host_access_refusal(&manifest, "1.0.0", Some(&provenance)),
        None
    );
}
