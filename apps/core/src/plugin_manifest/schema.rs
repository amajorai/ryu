//! Per-kind configuration structs for [`crate::runnable::RunnableKind`], plus the
//! managed-sidecar/external-runtime specs, capability labels, and the pure
//! [`validate_runnable`] / [`validate_sidecar_spec`] functions.
//!
//! **The definitions now live in the `ryu-kernel-contracts` crate** — this module
//! re-exports them verbatim so every existing `crate::plugin_manifest::schema::*`
//! call site keeps resolving unchanged, while the SDK shares the one definition
//! (no more drift). The tests below stay here and exercise the re-exported items,
//! proving the re-export surface is intact.

pub use ryu_kernel_contracts::schema::*;

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runnable::RunnableKind;
    use serde_json::json;

    fn entry(id: &str, kind: RunnableKind, config: Option<serde_json::Value>) -> RunnableEntry {
        RunnableEntry {
            id: id.to_string(),
            name: id.to_string(),
            kind,
            config,
        }
    }

    // ── capability labels ─────────────────────────────────────────────────────

    #[test]
    fn capability_label_maps_known_grants() {
        assert_eq!(capability_label("chat.sendFollowUp"), "Interactive");
        assert_eq!(capability_label("mcp:web_scrape"), "Web scraping");
        assert_eq!(capability_label("mcp:web_search"), "Web search");
        assert_eq!(capability_label("hook:side-model"), "Second-model review");
    }

    #[test]
    fn capability_label_humanizes_unknown_grants() {
        // Unknown grant: take the action segment, de-separate, capitalize.
        assert_eq!(capability_label("mcp:image_gen"), "Image gen");
        assert_eq!(capability_label("custom:do-thing"), "Do thing");
        assert_eq!(capability_label("plainlabel"), "Plainlabel");
    }

    #[test]
    fn capabilities_from_grants_dedupes_and_preserves_order() {
        let grants = vec![
            "chat.sendFollowUp".to_string(),
            "mcp:web_scrape".to_string(),
            "chat.sendFollowUp".to_string(), // duplicate label
        ];
        assert_eq!(
            capabilities_from_grants(&grants),
            vec!["Interactive".to_string(), "Web scraping".to_string()]
        );
    }

    // ── agent ─────────────────────────────────────────────────────────────────

    #[test]
    fn agent_without_config_is_valid() {
        assert!(validate_runnable(&entry("a", RunnableKind::Agent, None)).is_ok());
    }

    #[test]
    fn agent_with_full_config_is_valid() {
        let cfg = json!({ "system_prompt": "You are helpful.", "model": "gemma4", "tools": ["web_search"] });
        assert!(validate_runnable(&entry("a", RunnableKind::Agent, Some(cfg))).is_ok());
    }

    #[test]
    fn agent_with_invalid_config_shape_errors() {
        // `tools` must be an array, not a string.
        let cfg = json!({ "tools": "not-an-array" });
        let err = validate_runnable(&entry("a", RunnableKind::Agent, Some(cfg))).unwrap_err();
        assert!(err.contains("kind=agent"), "error: {err}");
    }

    // ── workflow ──────────────────────────────────────────────────────────────

    #[test]
    fn workflow_requires_config() {
        let err = validate_runnable(&entry("w", RunnableKind::Workflow, None)).unwrap_err();
        assert!(err.contains("kind=workflow"), "error: {err}");
        assert!(err.contains("entry"), "error: {err}");
    }

    #[test]
    fn workflow_with_entry_is_valid() {
        let cfg = json!({ "entry": "step-start" });
        assert!(validate_runnable(&entry("w", RunnableKind::Workflow, Some(cfg))).is_ok());
    }

    #[test]
    fn workflow_with_empty_entry_errors() {
        let cfg = json!({ "entry": "  " });
        let err = validate_runnable(&entry("w", RunnableKind::Workflow, Some(cfg))).unwrap_err();
        assert!(err.contains("'entry' must not be empty"), "error: {err}");
    }

    // ── tool ──────────────────────────────────────────────────────────────────

    #[test]
    fn tool_requires_config() {
        let err = validate_runnable(&entry("t", RunnableKind::Tool, None)).unwrap_err();
        assert!(err.contains("kind=tool"), "error: {err}");
    }

    #[test]
    fn tool_with_slug_is_valid() {
        let cfg = json!({ "slug": "web_search" });
        assert!(validate_runnable(&entry("t", RunnableKind::Tool, Some(cfg))).is_ok());
    }

    #[test]
    fn tool_backend_defaults_to_alias() {
        // A bare `slug` config (the legacy shape, and what `defineApp` emits) must
        // resolve to an Alias so existing plugins keep working unchanged.
        let cfg: ToolConfig = serde_json::from_value(json!({ "slug": "web_search" })).unwrap();
        assert_eq!(
            cfg.resolve_backend().unwrap(),
            ToolBackend::Alias {
                target: "web_search".to_owned()
            }
        );
    }

    #[test]
    fn tool_backend_resolves_inline_deno_and_http() {
        let deno: ToolConfig = serde_json::from_value(json!({
            "slug": "weather",
            "backend": "inline_deno",
            "code": "return await ((input, host) => ({ ok: true }))(input, host);",
        }))
        .unwrap();
        assert!(matches!(
            deno.resolve_backend().unwrap(),
            ToolBackend::InlineDeno { .. }
        ));

        let http: ToolConfig = serde_json::from_value(json!({
            "slug": "quote",
            "backend": "http",
            "url": "https://api.example.com/quote",
        }))
        .unwrap();
        // Method defaults to POST when unset.
        assert_eq!(
            http.resolve_backend().unwrap(),
            ToolBackend::Http {
                url: "https://api.example.com/quote".to_owned(),
                method: "POST".to_owned(),
                header_params: vec![],
                secret_headers: Default::default(),
                fail_open: false,
                unwrap_body: false,
                body_defaults: serde_json::Value::Null,
            }
        );
    }

    #[test]
    fn tool_backend_rejects_missing_code_or_url() {
        let no_code = json!({ "slug": "x", "backend": "inline_deno" });
        assert!(validate_runnable(&entry("t", RunnableKind::Tool, Some(no_code))).is_err());
        let no_url = json!({ "slug": "x", "backend": "http" });
        assert!(validate_runnable(&entry("t", RunnableKind::Tool, Some(no_url))).is_err());
        let bad_kind = json!({ "slug": "x", "backend": "carrier-pigeon" });
        assert!(validate_runnable(&entry("t", RunnableKind::Tool, Some(bad_kind))).is_err());
    }

    // ── skill ─────────────────────────────────────────────────────────────────

    #[test]
    fn skill_requires_skill_id() {
        let err = validate_runnable(&entry("s", RunnableKind::Skill, None)).unwrap_err();
        assert!(err.contains("kind=skill"), "error: {err}");
    }

    #[test]
    fn skill_with_skill_id_is_valid() {
        let cfg = json!({ "skill_id": "ryu:research/v1" });
        assert!(validate_runnable(&entry("s", RunnableKind::Skill, Some(cfg))).is_ok());
    }

    // ── companion ─────────────────────────────────────────────────────────────

    #[test]
    fn companion_requires_label() {
        let err = validate_runnable(&entry("c", RunnableKind::Companion, None)).unwrap_err();
        assert!(err.contains("kind=companion"), "error: {err}");
    }

    #[test]
    fn companion_with_label_is_valid() {
        let cfg = json!({ "label": "Research Panel", "icon": "magnifying-glass" });
        assert!(validate_runnable(&entry("c", RunnableKind::Companion, Some(cfg))).is_ok());
    }

    #[test]
    fn companion_label_impersonating_system_chrome_errors() {
        for bad in ["Ryu Settings", "system tools", "RYU", "My System Panel"] {
            let cfg = json!({ "label": bad });
            let err =
                validate_runnable(&entry("c", RunnableKind::Companion, Some(cfg))).unwrap_err();
            assert!(
                err.contains("impersonate system chrome"),
                "label '{bad}' should be rejected, got: {err}"
            );
        }
    }

    #[test]
    fn label_impersonates_system_chrome_matches_route_title_rule() {
        assert!(label_impersonates_system_chrome("Ryu"));
        assert!(label_impersonates_system_chrome("system"));
        assert!(label_impersonates_system_chrome("A RYU Panel"));
        assert!(!label_impersonates_system_chrome("Research Assistant"));
        assert!(!label_impersonates_system_chrome("Advisor"));
    }

    // ── channel ───────────────────────────────────────────────────────────────

    #[test]
    fn channel_requires_platform() {
        let err = validate_runnable(&entry("ch", RunnableKind::Channel, None)).unwrap_err();
        assert!(err.contains("kind=channel"), "error: {err}");
    }

    #[test]
    fn channel_with_platform_is_valid() {
        let cfg = json!({ "platform": "telegram" });
        assert!(validate_runnable(&entry("ch", RunnableKind::Channel, Some(cfg))).is_ok());
    }

    // ── engine ────────────────────────────────────────────────────────────────

    #[test]
    fn engine_requires_engine_type() {
        let err = validate_runnable(&entry("e", RunnableKind::Engine, None)).unwrap_err();
        assert!(err.contains("kind=engine"), "error: {err}");
    }

    #[test]
    fn engine_with_type_is_valid() {
        let cfg = json!({ "engine_type": "llamacpp", "base_url": "http://localhost:8080" });
        assert!(validate_runnable(&entry("e", RunnableKind::Engine, Some(cfg))).is_ok());
    }

    // ── policy ────────────────────────────────────────────────────────────────

    #[test]
    fn policy_requires_config() {
        let err = validate_runnable(&entry("p", RunnableKind::Policy, None)).unwrap_err();
        assert!(err.contains("kind=policy"), "error: {err}");
    }

    #[test]
    fn policy_with_type_and_definition_is_valid() {
        let cfg = json!({
            "policy_type": "pii_dlp",
            "definition": { "block_patterns": ["\\b\\d{16}\\b"] }
        });
        assert!(validate_runnable(&entry("p", RunnableKind::Policy, Some(cfg))).is_ok());
    }

    #[test]
    fn policy_with_empty_type_errors() {
        let cfg = json!({ "policy_type": "", "definition": {} });
        let err = validate_runnable(&entry("p", RunnableKind::Policy, Some(cfg))).unwrap_err();
        assert!(
            err.contains("'policy_type' must not be empty"),
            "error: {err}"
        );
    }

    // ── managed sidecar spec ──────────────────────────────────────────────────

    fn binary_sidecar(name: &str, url: &str, version: &str) -> SidecarSpec {
        SidecarSpec {
            name: name.to_owned(),
            process: SidecarProcess::Binary(BinarySpec {
                url: url.to_owned(),
                sha256: None,
                version: version.to_owned(),
                archive: None,
                binary_name: None,
                args: vec![],
                env: std::collections::BTreeMap::new(),
            }),
            port: 9099,
            health_path: "/health".to_owned(),
            http: None,
            host_api: None,
            lazy: false,
            idle_stop_secs: None,
            provides_provider: None,
        }
    }

    fn set_archive(spec: &mut SidecarSpec, fmt: Option<&str>, binary_name: Option<&str>) {
        if let SidecarProcess::Binary(b) = &mut spec.process {
            b.archive = fmt.map(str::to_owned);
            b.binary_name = binary_name.map(str::to_owned);
        }
    }

    #[test]
    fn sidecar_spec_roundtrips_and_defaults_health_path() {
        // `health_path` defaults to /health when omitted.
        let json = r#"{
            "name": "engine",
            "process": { "kind": "binary", "url": "https://example.com/e", "version": "1.0.0" },
            "port": 9099
        }"#;
        let spec: SidecarSpec = serde_json::from_str(json).expect("deserialise");
        assert_eq!(spec.health_path, "/health");
        assert_eq!(spec.port, 9099);
        // Round-trips.
        let back: SidecarSpec =
            serde_json::from_str(&serde_json::to_string(&spec).unwrap()).unwrap();
        assert_eq!(spec, back);
    }

    #[test]
    fn valid_binary_sidecar_passes() {
        let spec = binary_sidecar("engine", "https://example.com/dl/engine", "1.0.0");
        assert!(validate_sidecar_spec(&spec).is_ok());
    }

    #[test]
    fn sidecar_rejects_unsafe_name() {
        for bad in ["a/b", "..", "", "  x", "x\\y"] {
            let spec = binary_sidecar(bad, "https://example.com/e", "1.0.0");
            assert!(
                validate_sidecar_spec(&spec).is_err(),
                "name '{bad}' should be rejected"
            );
        }
    }

    #[test]
    fn sidecar_rejects_non_https_binary_and_zero_port() {
        let mut spec = binary_sidecar("engine", "http://example.com/e", "1.0.0");
        assert!(validate_sidecar_spec(&spec).unwrap_err().contains("https"));
        spec = binary_sidecar("engine", "https://example.com/e", "1.0.0");
        spec.port = 0;
        assert!(validate_sidecar_spec(&spec).unwrap_err().contains("port"));
    }

    #[test]
    fn sidecar_rejects_bad_health_path_and_empty_version() {
        let mut spec = binary_sidecar("engine", "https://example.com/e", "1.0.0");
        spec.health_path = "health".to_owned(); // missing leading slash
        assert!(validate_sidecar_spec(&spec)
            .unwrap_err()
            .contains("health_path"));
        spec = binary_sidecar("engine", "https://example.com/e", "  ");
        assert!(validate_sidecar_spec(&spec)
            .unwrap_err()
            .contains("version"));
    }

    #[test]
    fn archive_sidecar_valid_with_binary_name() {
        let mut spec = binary_sidecar("engine", "https://example.com/e.tar.gz", "1.0.0");
        set_archive(&mut spec, Some("tar.gz"), Some("bin/my-engine"));
        assert!(validate_sidecar_spec(&spec).is_ok());
    }

    #[test]
    fn archive_sidecar_rejects_unknown_format() {
        let mut spec = binary_sidecar("engine", "https://example.com/e.rar", "1.0.0");
        set_archive(&mut spec, Some("rar"), Some("my-engine"));
        assert!(validate_sidecar_spec(&spec)
            .unwrap_err()
            .contains("unsupported archive format"));
    }

    #[test]
    fn archive_sidecar_requires_binary_name() {
        let mut spec = binary_sidecar("engine", "https://example.com/e.zip", "1.0.0");
        set_archive(&mut spec, Some("zip"), None);
        assert!(validate_sidecar_spec(&spec)
            .unwrap_err()
            .contains("binary_name"));
    }

    #[test]
    fn archive_sidecar_rejects_traversing_binary_name() {
        let mut spec = binary_sidecar("engine", "https://example.com/e.zip", "1.0.0");
        set_archive(&mut spec, Some("zip"), Some("../../etc/passwd"));
        assert!(validate_sidecar_spec(&spec)
            .unwrap_err()
            .contains("traversal-safe"));
    }

    #[test]
    fn python_sidecar_requires_entry() {
        let spec = SidecarSpec {
            name: "tts".to_owned(),
            process: SidecarProcess::Python(ExternalRuntimeConfig {
                kind: "python".to_owned(),
                entry: "  ".to_owned(),
                ..Default::default()
            }),
            port: 8085,
            health_path: "/health".to_owned(),
            http: None,
            host_api: None,
            lazy: false,
            idle_stop_secs: None,
            provides_provider: None,
        };
        assert!(validate_sidecar_spec(&spec).unwrap_err().contains("entry"));
    }
}
