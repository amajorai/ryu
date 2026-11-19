//! Tests for [`super::username_template`]: valid templates, rejected ones,
//! and the length bounds, through the Postgres and Redis configs too.

use super::postgres::PostgresConfig;
use super::redis::RedisConfig;
use super::target_guard::TargetEgress;
use super::username_template::{render, render_username, TemplateContext, MAX_TEMPLATE_BYTES};

fn ctx() -> TemplateContext {
    TemplateContext {
        role_name: "Analytics-RO".into(),
        display_name: "machine-ci".into(),
    }
}

#[test]
fn templates_render_fields_functions_and_pipelines() {
    let name = render(
        "v_{{.RoleName | lowercase | replace \"-\" \"_\" | truncate 8}}_{{random 6}}",
        &ctx(),
    )
    .unwrap();
    let (prefix, random) = name.rsplit_once('_').unwrap();
    assert_eq!(prefix, "v_analytic");
    assert_eq!(random.len(), 6);
    assert!(random
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()));
    // Two renders differ (randomness), the fixed part does not.
    let template = "{{.DisplayName}}-{{ uuid }}";
    let first = render(template, &ctx()).unwrap();
    let second = render(template, &ctx()).unwrap();
    assert_ne!(first, second);
    assert!(first.starts_with("machine-ci-"));
    assert_eq!(first.len(), "machine-ci-".len() + 36);
    let hashed = render("{{.RoleName | sha256 | truncate 12}}{{random 1}}", &ctx()).unwrap();
    assert_eq!(hashed.len(), 13);
    let upper = render("{{\"a\\\"b\" | uppercase}}{{random 2}}", &ctx()).unwrap();
    assert!(upper.starts_with("A\"B"));
    let time = render("t{{unix_time}}_{{random 4}}", &ctx()).unwrap();
    assert!(time[1..11].bytes().all(|b| b.is_ascii_digit()));
}

#[test]
fn unsafe_unknown_or_malformed_templates_are_rejected() {
    for template in [
        "",
        "plain-text",     // no randomness
        "{{.RoleName}}",  // no randomness
        "{{random 8}",    // unclosed
        "{{random 8}}}}", // stray close
        "{{random 0}}",
        "{{random 65}}",
        "{{random}}",
        "{{.Secret}}{{random 4}}",      // unknown field
        "{{env \"HOME\"}}{{random 4}}", // unknown function
        "{{printf \"%s\" .RoleName}}{{random 4}}",
        "{{random 4 | exec}}",
        "{{truncate 4}}{{random 4}}", // no piped value
        "{{.RoleName | replace \"\" \"x\"}}{{random 4}}",
        "{{.RoleName ; random 4}}",
        "{{\"unterminated}}",
        "{{.RoleName | truncate \"4\"}}{{random 4}}",
        "{{random 4 4}}",
    ] {
        assert!(render(template, &ctx()).is_err(), "{template}");
    }
    let too_long = format!("{}{{{{random 4}}}}", "a".repeat(MAX_TEMPLATE_BYTES));
    assert!(render(&too_long, &ctx()).is_err());
    let too_many = "{{random 1}}".repeat(17);
    assert!(render(&too_many, &ctx()).is_err());
    // Intermediate values are bounded: replace cannot blow a value up.
    let blowup = format!(
        "{{{{\"{}\" | replace \"a\" \"aaaaaaaa\"}}}}{{{{random 1}}}}",
        "a".repeat(40)
    );
    assert!(render(&blowup, &ctx()).is_err());
}

#[test]
fn rendered_names_are_length_and_charset_bounded() {
    let lower = |name: &str| name.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
    assert!(render_username(
        "a_{{random 8 | truncate 0}}{{random 1}}",
        &ctx(),
        63,
        |_| true
    )
    .is_ok());
    assert!(render_username("{{random 64}}", &ctx(), 63, |_| true).is_err());
    assert!(render_username("{{random 63}}", &ctx(), 63, |_| true).is_ok());
    let error = render_username("{{.RoleName}}_{{random 4}}", &ctx(), 63, lower).unwrap_err();
    assert!(error.to_string().contains("characters"));
    // Errors never echo the rendered value.
    assert!(!error.to_string().contains("Analytics"));
}

fn postgres(template: Option<&str>, prefix: Option<&str>) -> PostgresConfig {
    PostgresConfig {
        connection_url: "postgres://admin:pw@db.internal/app".into(),
        creation_statements: vec!["CREATE ROLE \"{{name}}\" PASSWORD '{{password}}'".into()],
        revocation_statements: vec![],
        username_prefix: prefix.map(str::to_owned),
        username_template: template.map(str::to_owned),
        egress: TargetEgress::Trusted,
    }
}

#[test]
fn provider_configs_validate_and_apply_templates() {
    let config = postgres(
        Some("v_{{.RoleName | lowercase | replace \"-\" \"_\"}}_{{random 10}}"),
        None,
    );
    config.validate().unwrap();
    let name = config.username_for("app-ro", "token").unwrap();
    assert!(name.starts_with("v_app_ro_"), "{name}");
    assert_eq!(name.len(), "v_app_ro_".len() + 10);
    // Postgres names must stay lowercase, digits, and underscores.
    assert!(postgres(Some("v-{{random 8}}"), None).validate().is_err());
    assert!(postgres(Some("{{random 64}}"), None).validate().is_err());
    assert!(postgres(Some("v_{{random 8}}"), Some("svc"))
        .validate()
        .is_err());
    // Without a template the prefix form is unchanged.
    let plain = postgres(None, Some("svc"))
        .username_for("app-ro", "token")
        .unwrap();
    assert!(plain.starts_with("svc_appro_"), "{plain}");

    let redis: RedisConfig = serde_json::from_value(serde_json::json!({
        "connectionUrl": "redis://admin:pw@cache.internal:6379",
        "usernameTemplate": "svc-{{.DisplayName}}.{{random 6}}",
    }))
    .unwrap();
    redis.validate().unwrap();
    let name = redis.username_for("cache", "machine-ci").unwrap();
    assert!(name.starts_with("svc-machine-ci."), "{name}");
    let bad: RedisConfig = serde_json::from_value(serde_json::json!({
        "connectionUrl": "redis://admin:pw@cache.internal:6379",
        "usernameTemplate": "svc {{random 6}}",
    }))
    .unwrap();
    assert!(bad.validate().is_err());
}
