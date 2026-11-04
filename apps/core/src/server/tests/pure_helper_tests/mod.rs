use crate::server::*;
use axum::http::{HeaderMap, HeaderName, HeaderValue};

fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
    let mut h = HeaderMap::new();
    for (k, v) in pairs {
        h.insert(
            k.parse::<HeaderName>().unwrap(),
            HeaderValue::from_str(v).unwrap(),
        );
    }
    h
}

fn caller(user_id: &str, org: Option<&str>) -> crate::identity_verify::VerifiedCaller {
    crate::identity_verify::VerifiedCaller {
        user_id: user_id.to_owned(),
        email: None,
        email_verified: false,
        org_id: org.map(str::to_owned),
        role: crate::identity_verify::OrgRole::Member,
        teams: Vec::new(),
    }
}

// ── webhook freshness / dedup ────────────────────────────────────────────
fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ── Channel command registry (GET /api/channels/commands) ────────────────

fn manifest(value: serde_json::Value) -> crate::plugin_manifest::PluginManifest {
    serde_json::from_value(value).expect("test manifest deserializes")
}

fn enabled_set(ids: &[&str]) -> std::collections::HashSet<String> {
    ids.iter().map(|s| (*s).to_owned()).collect()
}

fn skill(id: &str, name: &str, description: Option<&str>) -> ryu_skills::SkillRecord {
    ryu_skills::SkillRecord {
        id: id.to_owned(),
        name: name.to_owned(),
        description: description.map(str::to_owned),
        instructions: String::new(),
        allowed_tools: Vec::new(),
        enabled: true,
        always_on: false,
    }
}

// ── Marketplace tabs (contributes.store_tabs) ────────────────────────────

fn store_tab_manifest(id: &str, tab_id: &str) -> crate::plugin_manifest::PluginManifest {
    let owner_path = format!("/api/ext/{id}/catalog");
    manifest(json!({
        "id": id, "name": id, "version": "1.0.0", "runnables": [],
        "contributes": { "store_tabs": [
            { "id": tab_id, "title": "Templates", "group": "catalog",
              "spec": { "source": { "http": { "path": owner_path } } } }
        ]}
    }))
}

// ── Settings tabs (contributes.settings_tabs) ────────────────────────────

fn settings_tab_manifest(id: &str) -> crate::plugin_manifest::PluginManifest {
    manifest(json!({
        "id": id, "name": id, "version": "1.0.0", "runnables": [],
        "contributes": { "settings_tabs": [
            { "id": "exa.settings", "title": "Exa Search", "scope": "node",
              "fields": [{ "type": "secret", "pref_key": "RYU_EXA_API_KEY",
                           "label": "Exa API key" }] }
        ]}
    }))
}

mod cannot_header;
mod channel_commands;
mod plugin_store;
mod plugin_webhook;
