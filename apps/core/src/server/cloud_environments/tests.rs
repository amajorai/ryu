use super::*;
#[test]
fn openapi_documents_every_route_and_write_only_values() {
    let spec = serde_json::to_value(openapi()).unwrap();
    for path in [
        "/api/cloud-tasks/{conversation_id}/stop",
        "/api/cloud-tasks/{conversation_id}",
        "/api/cloud-tasks/{conversation_id}/prompt",
        "/api/cloud-tasks/{conversation_id}/diff",
        "/api/cloud-tasks/{conversation_id}/finish",
        "/api/cloud-environments",
        "/api/cloud-environments/import",
        "/api/cloud-environments/shared",
        "/api/cloud-environments/shared/{id}/import",
        "/api/cloud-environments/{id}/launch",
    ] {
        assert!(spec["paths"].get(path).is_some(), "{path}");
    }
    assert_eq!(
        spec["components"]["schemas"]["CloudVaultEntry"]["properties"]["value"]["writeOnly"],
        true
    );
    for schema in [
        "CloudEnvironmentRuntime",
        "CloudTaskStatus",
        "CloudTaskFinish",
        "CloudTaskDiff",
    ] {
        assert!(
            spec["components"]["schemas"].get(schema).is_some(),
            "{schema}"
        );
    }
}
#[test]
fn wire_fixture_is_compatible() {
    let state: Snapshot = serde_json::from_str(include_str!(
        "../../../../../packages/protocol/src/fixtures/cloud-environments.json"
    ))
    .unwrap();
    validate(&state).unwrap();
    // The fixture predates `runtime`; it reads as the default and is then
    // written explicitly.
    let mut expected = serde_json::from_str::<Value>(include_str!(
        "../../../../../packages/protocol/src/fixtures/cloud-environments.json"
    ))
    .unwrap();
    for environment in expected["environments"].as_array_mut().unwrap() {
        environment["runtime"] = json!({"backend":"auto","executor":"ryu","lifetimeMinutes":30});
    }
    assert_eq!(serde_json::to_value(&state).unwrap(), expected);
}
fn box_environment() -> Snapshot {
    let mut state: Snapshot = serde_json::from_str(include_str!(
        "../../../../../packages/protocol/src/fixtures/cloud-environments.json"
    ))
    .unwrap();
    state.vault[0].kind = "variable".into();
    state.vault[0].domains.clear();
    let environment = &mut state.environments[0];
    environment.internet.domain_policy = "all".into();
    environment.runtime = Runtime {
        backend: "box".into(),
        executor: "codex".into(),
        lifetime_minutes: 60,
    };
    state
}
#[test]
fn cloud_environment_runtime_defaults_when_absent() {
    let state: Snapshot = serde_json::from_str(include_str!(
        "../../../../../packages/protocol/src/fixtures/cloud-environments.json"
    ))
    .unwrap();
    assert_eq!(state.environments[0].runtime, Runtime::default());
    let state: Snapshot = serde_json::from_value(json!({
        "schemaVersion":1,"revision":0,"vault":[],
        "environments":[{"id":"e","name":"E","repositories":[],"installScript":"","startInstructions":"",
            "internet":{"enabled":true,"domainPolicy":"all","allowedDomains":[]},"privacy":"private",
            "vaultKeys":[],"tailscaleVaultKey":null,"published":true,
            "runtime":{"backend":"box","executor":"claude-code","lifetimeMinutes":120}}]
    }))
    .unwrap();
    assert_eq!(state.environments[0].runtime.executor, "claude-code");
    validate(&state).unwrap();
    assert!(serde_json::from_value::<Runtime>(
        json!({"backend":"box","executor":"ryu","lifetimeMinutes":30,"extra":1})
    )
    .is_err());
}
#[test]
fn cloud_environment_runtime_rules_are_enforced_on_save() {
    let code = |state: &Snapshot| {
        validate(state)
            .err()
            .map(|(status, body)| (status, body.0["error"]["code"].clone()))
    };
    validation::validate(&box_environment()).unwrap();

    let mut state = box_environment();
    state.environments[0].runtime.backend = "auto".into();
    assert_eq!(
        code(&state),
        Some((
            StatusCode::UNPROCESSABLE_ENTITY,
            json!("cloud_environment_policy_unavailable")
        ))
    );

    let mut state = box_environment();
    state.environments[0].internet.enabled = false;
    assert!(code(&state).is_some());

    let mut state = box_environment();
    state.environments[0].runtime.executor = "ryu".into();
    state.environments[0].vault_keys.clear();
    state.environments[0].tailscale_vault_key = Some("API_TOKEN".into());
    assert_eq!(
        code(&state),
        Some((
            StatusCode::UNPROCESSABLE_ENTITY,
            json!("cloud_environment_policy_unavailable")
        ))
    );

    // A box substitutes network secrets in its egress proxy...
    let mut state = box_environment();
    state.vault[0].kind = "networkSecret".into();
    state.vault[0].domains = vec!["api.example.com".into()];
    assert_eq!(code(&state), None);
    // ...but only for DNS names its egress may reach.
    state.vault[0].domains = vec!["10.0.0.7".into()];
    assert_eq!(
        code(&state),
        Some((
            StatusCode::UNPROCESSABLE_ENTITY,
            json!("cloud_environment_policy_unavailable")
        ))
    );

    for lifetime in [4, 241] {
        let mut state = box_environment();
        state.environments[0].runtime.lifetime_minutes = lifetime;
        assert_eq!(
            code(&state),
            Some((StatusCode::BAD_REQUEST, json!("cloud_environment_invalid")))
        );
    }
    let mut state = box_environment();
    state.environments[0].runtime.executor = "unknown".into();
    assert!(code(&state).is_some());
}
#[test]
fn cloud_environment_box_rejects_box_reserved_and_excess_variables() {
    let mut environment = box_environment().environments.remove(0);
    environment.vault_keys = vec!["API_KEY".into(), "USER".into(), "DOCKER_HOST".into()];
    let (status, body) = runtime_issue(&environment, &[]).unwrap();
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let message = body.0["error"]["message"].as_str().unwrap().to_owned();
    assert!(message.contains("USER, DOCKER_HOST"), "{message}");
    assert!(!message.contains("API_KEY"), "{message}");

    environment.vault_keys = (0..=MAX_BOX_ENV_ENTRIES).map(|i| format!("K{i}")).collect();
    assert!(runtime_issue(&environment, &[]).is_some());
    environment.vault_keys.pop();
    assert!(runtime_issue(&environment, &[]).is_none());

    environment.runtime.backend = "auto".into();
    environment.runtime.executor = "ryu".into();
    environment.vault_keys = vec!["USER".into()];
    assert!(runtime_issue(&environment, &[]).is_none());
}
#[test]
fn cloud_environment_box_allowlist_requires_base_and_provider_hosts() {
    let mut state = box_environment();
    let internet = &mut state.environments[0].internet;
    internet.domain_policy = "custom".into();
    internet.allowed_domains = vec!["archive.ubuntu.com".into()];
    let (status, body) = validate(&state).unwrap_err();
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let message = body.0["error"]["message"].as_str().unwrap().to_owned();
    for host in [
        "security.ubuntu.com",
        "api.openai.com",
        "registry.npmjs.org",
    ] {
        assert!(message.contains(host), "{message}");
    }
    assert!(!message.contains("archive.ubuntu.com"), "{message}");
    let internet = &mut state.environments[0].internet;
    internet.domain_policy = "packageManagers".into();
    internet.allowed_domains = vec!["*.ubuntu.com".into(), "api.openai.com".into()];
    validate(&state).unwrap();
    assert_eq!(
        box_network(&state.environments[0].internet),
        ryu_sandbox::box_session::BoxNetwork::Allowlist(
            match governed_spec(&state.environments[0].internet, vec![]).egress {
                ryu_sandbox::governed::EgressPolicy::AllowedHosts(hosts) => hosts,
                _ => unreachable!(),
            }
        )
    );
}
#[test]
fn cloud_environment_box_script_carries_no_secret_values() {
    let repositories = vec!["acme/app".to_owned()];
    let exports = vec![
        ("GITHUB_TOKEN".to_owned(), "ghp_org_token_value".to_owned()),
        ("API_KEY".to_owned(), "sk-vault-value".to_owned()),
    ];
    let parts = script::build_task_script(ScriptPlan {
        root: ryu_sandbox::box_session::BOX_WORKSPACE_ROOT,
        is_box: true,
        exports: exports.clone(),
        repositories: &repositories,
        install_script: "bun install",
        internet_enabled: true,
        github_token_key: Some("GITHUB_TOKEN"),
    });
    for text in [&parts.script, &parts.task_preamble] {
        assert!(!text.contains("ghp_org_token_value"));
        assert!(!text.contains("sk-vault-value"));
        assert!(!text.contains("export GITHUB_TOKEN="));
        assert!(!text.contains("export API_KEY="));
        assert!(!text.contains("/tmp/ryu-workspace"));
    }
    assert!(parts.script.contains("$GITHUB_TOKEN"));
    assert!(parts.task_preamble.ends_with("cd 'acme/app'\n"));
    assert_eq!(parts.box_env, exports);
    assert_eq!(parts.working_directory, "/workspace/acme/app");
    assert_eq!(
        parts.repository_directories,
        vec!["/workspace/acme/app".to_owned()]
    );

    // Other backends keep the exported preamble and the legacy root.
    let parts = build_task_script(ScriptPlan {
        root: "/tmp/ryu-workspace",
        is_box: false,
        exports,
        repositories: &[],
        install_script: "true",
        internet_enabled: false,
        github_token_key: None,
    });
    assert!(parts.script.starts_with("set -eu\nmkdir -p /tmp/ryu-workspace\ncd /tmp/ryu-workspace\nexport GITHUB_TOKEN='ghp_org_token_value'\n"));
    assert!(parts.box_env.is_empty());
    assert_eq!(parts.working_directory, "/tmp/ryu-workspace");
}
#[test]
fn cloud_environment_basic_credential_matches_git_basic_auth() {
    assert_eq!(github_basic_credential("abc"), "eC1hY2Nlc3MtdG9rZW46YWJj");
}
#[test]
fn a_github_network_secret_pushes_with_its_placeholder_and_keeps_the_token_for_core() {
    let domains = vec!["github.com".to_owned(), "api.github.com".to_owned()];
    let placeholder = "__RYU_SECRET_0123456789abcdef__";
    for key in ["GITHUB_TOKEN", "GH_TOKEN"] {
        let credential = network_secret_push_credential(key, &domains, "ghp_value", placeholder)
            .expect("a GitHub network secret scoped to github.com can push");
        assert_eq!(credential.push_secret, placeholder);
        assert_eq!(credential.api_token, "ghp_value");
    }
    // Only a GitHub token the egress proxy substitutes on github.com pushes.
    assert!(network_secret_push_credential("OPENAI_API_KEY", &domains, "v", placeholder).is_none());
    let api_only = vec!["api.github.com".to_owned()];
    assert!(network_secret_push_credential("GITHUB_TOKEN", &api_only, "v", placeholder).is_none());
    let plain = GitPushCredential::plain("ghp_plain");
    assert_eq!(plain.push_secret, plain.api_token);
}
#[test]
fn platform_variables_and_unsafe_domains_are_rejected() {
    for key in [
        "PATH",
        "RYU_TOKEN",
        "LD_PRELOAD",
        "HTTP_PROXY",
        "NODE_OPTIONS",
        "BAD-KEY",
    ] {
        assert!(!valid_key(key));
    }
    assert!(valid_key("MY_TOKEN"));
    for domain in [
        "https://example.com",
        "user@example.com",
        "example..com",
        "*example.com",
    ] {
        assert!(!valid_domain(domain));
    }
    assert!(valid_domain("*.example.com"));
}
#[test]
fn vault_projection_and_sharing_never_expose_values_or_bindings() {
    let mut state: Snapshot = serde_json::from_str(include_str!(
        "../../../../../packages/protocol/src/fixtures/cloud-environments.json"
    ))
    .unwrap();
    state.vault[0].value = Some("sealed-value".into());
    let view = projection(state.clone());
    assert!(view.vault[0].has_value);
    assert!(view.vault[0].value.is_none());
    let template = shared::shareable(state.environments.remove(0));
    assert!(template.vault_keys.is_empty());
    assert!(template.tailscale_vault_key.is_none());
}
#[test]
fn shell_values_are_single_quoted() {
    assert_eq!(policy::quote("a'b;$x\n"), "'a'\\''b;$x\n'");
}
#[test]
fn vpn_credential_cannot_be_exposed_by_any_environment() {
    let mut state: Snapshot = serde_json::from_str(include_str!(
        "../../../../../packages/protocol/src/fixtures/cloud-environments.json"
    ))
    .unwrap();
    state.environments[0].tailscale_vault_key = Some("API_TOKEN".into());
    assert!(validate(&state).is_err());
    state.environments[0].vault_keys.clear();
    assert!(validate(&state).is_ok());
    let mut second = state.environments[0].clone();
    second.id = "other-environment".into();
    second.tailscale_vault_key = None;
    second.vault_keys.push("API_TOKEN".into());
    state.environments.push(second);
    assert!(validate(&state).is_err());
}

// ── Rollout gate: `cloud_tasks.box_backend` via the signed `ryu_flags` claim ──

const FLAG_TEST_KID: &str = "cloud-box-rollout-test-key";

#[test]
fn cloud_environment_import_body_cannot_carry_a_value() {
    let body = json!({"keys":["API_TOKEN"],"kind":"variable","environmentIds":[],"domains":[],"revision":0});
    assert!(serde_json::from_value::<handlers::Import>(body.clone()).is_ok());
    let mut smuggled = body;
    smuggled["value"] = json!("secret-value");
    assert!(serde_json::from_value::<handlers::Import>(smuggled).is_err());
}

#[test]
fn cloud_environment_update_validates_before_touching_the_store() {
    let mut state = box_environment();
    state.schema_version = 2;
    let (status, _) = store_update::update("node-owner", state, true).unwrap_err();
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn cloud_environment_prepare_refuses_an_unknown_environment() {
    let auth = box_gate_tests::auth_for(crate::authorization::Principal::Owner, None, None);
    let (status, body) = prepare::prepare_environment(&auth, "env-that-does-not-exist")
        .await
        .err()
        .expect("an unknown environment is refused");
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body.0["error"]["code"], "cloud_environment_not_found");
}

#[path = "box_gate_tests.rs"]
mod box_gate_tests;
pub(in crate::server) use box_gate_tests::{
    cloud_auth, denial_code, signed_user_jwt, signed_user_jwt_with_claims,
};
