//! Official Qoder CLI profiles. PATs stay in the sealed vault, never Pi files.

use super::accounts::{self, AccountVault, KIND_API_KEY};
use anyhow::{bail, Context, Result};
use serde_json::{json, Map, Value};

pub const GLOBAL_ID: &str = "qoder";
pub const CN_ID: &str = "qoder-cn";

pub fn is_provider(id: &str) -> bool {
    matches!(id, GLOBAL_ID | CN_ID)
}

pub fn cli_available(id: &str) -> Option<bool> {
    let region = match id {
        GLOBAL_ID => ryu_gw_providers::QoderRegion::Global,
        CN_ID => ryu_gw_providers::QoderRegion::Cn,
        _ => return None,
    };
    Some(ryu_gw_providers::QoderProvider::cli_available(region))
}

pub fn validate_selector(id: &str, base_url: Option<&str>, api: Option<&str>) -> Result<()> {
    let selector = match id {
        GLOBAL_ID => "https://qoder.com",
        CN_ID => "https://qoder.cn",
        _ => bail!("Unknown Qoder region"),
    };
    if base_url.is_some_and(|value| value.trim_end_matches('/') != selector)
        || api.is_some_and(|value| value != "openai-completions")
    {
        bail!("Qoder uses its official CLI; custom inference endpoints are not supported");
    }
    Ok(())
}

fn validate_token(token: &str) -> Result<()> {
    if token.is_empty() || token.len() > 8192 || token.chars().any(char::is_control) {
        bail!("Enter a valid Qoder personal access token");
    }
    Ok(())
}

fn store_in_vault(vault: &AccountVault, id: &str, token: &str) -> Result<()> {
    validate_selector(id, None, None)?;
    validate_token(token)?;
    super::vault_upsert_credential(
        Some(vault),
        &accounts::provider_scope(id),
        if id == GLOBAL_ID {
            "Qoder Global PAT"
        } else {
            "Qoder CN PAT"
        },
        KIND_API_KEY,
        json!({"type":"api_key", "key":token}),
    )
}

pub fn store_token(id: &str, token: &str) -> Result<()> {
    super::with_account_vault(|vault| store_in_vault(vault, id, token))?;
    // Remove any legacy plaintext entry instead of refreshing it with the PAT.
    let mut auth = super::read_auth();
    if auth.remove(id).is_some() {
        super::write_secret_file(&super::auth_path(), &serde_json::to_string_pretty(&auth)?)?;
    }
    ensure_models(id, None)
}

pub(crate) fn capture_token_from_vault(vault: &AccountVault, id: &str) -> Result<String> {
    validate_selector(id, None, None)?;
    let scope = accounts::provider_scope(id);
    let (account_id, credential) = vault
        .active_credential(&scope)?
        .context("Configure a Qoder personal access token first")?;
    let valid_account = vault.list(&scope)?.iter().any(|account| {
        account.account_id == account_id && account.kind == KIND_API_KEY && !account.needs_reauth
    });
    if !valid_account || credential["type"].as_str() != Some("api_key") {
        bail!("The selected Qoder PAT account is unavailable");
    }
    let token = credential["key"]
        .as_str()
        .context("The selected Qoder PAT is unavailable")?;
    validate_token(token)?;
    Ok(token.to_owned())
}

/// Capture the explicitly selected account once before the child process starts.
pub fn capture_token(id: &str) -> Result<String> {
    super::with_account_vault(|vault| capture_token_from_vault(vault, id))
}

fn proxy_patch(
    id: &str,
    core_url: &str,
    node_token: &str,
    models: Vec<Value>,
) -> Result<Map<String, Value>> {
    validate_selector(id, None, None)?;
    if node_token.is_empty() {
        bail!("Core node authentication is not ready");
    }
    let mut patch = Map::new();
    patch.insert(
        "baseUrl".into(),
        json!(format!(
            "{}/api/pi-config/{id}/v1",
            core_url.trim_end_matches('/')
        )),
    );
    patch.insert("api".into(), json!("openai-completions"));
    patch.insert("apiKey".into(), json!("ryu-local-proxy"));
    patch.insert("headers".into(), json!({"x-ryu-node-token":node_token}));
    patch.insert("models".into(), Value::Array(models));
    Ok(patch)
}

pub fn ensure_models(id: &str, selected_model: Option<&str>) -> Result<()> {
    validate_selector(id, None, None)?;
    if selected_model.is_some() && cli_available(id) != Some(true) {
        bail!("Install the official regional Qoder CLI on this Core host before activating it");
    }
    let models = super::read_models()["providers"][id]["models"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if let Some(model) = selected_model {
        if !models.iter().any(|row| row["id"].as_str() == Some(model)) {
            bail!("Discover this Qoder account's models before selecting a model");
        }
    }
    crate::node_token::active_token().context("Core node authentication is not ready")?;
    // models.json names the node bearer by reference; Pi receives the value in
    // its spawn environment (see `secret_env`).
    let node_token = super::secret_env::reference(super::secret_env::NODE_TOKEN_ENV);
    super::upsert_provider(
        id,
        proxy_patch(
            id,
            &crate::sidecar::gateway::core_self_url(),
            &node_token,
            models,
        )?,
    )
}

pub fn persist_discovered_models(id: &str, models: &[Value]) -> Result<()> {
    let existing = super::read_models();
    let previous = existing["providers"][id]["models"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let rows = models
        .iter()
        .filter_map(|row| row["id"].as_str())
        .map(|model_id| {
            let mut row = json!({"id":model_id,"name":model_id,"input":["text"]});
            if let Some(enabled) = previous
                .iter()
                .find(|entry| entry["id"].as_str() == Some(model_id))
                .and_then(|entry| entry["x-ryu-enabled"].as_bool())
            {
                row["x-ryu-enabled"] = json!(enabled);
            }
            row
        })
        .collect();
    crate::node_token::active_token().context("Core node authentication is not ready")?;
    // models.json names the node bearer by reference; Pi receives the value in
    // its spawn environment (see `secret_env`).
    let node_token = super::secret_env::reference(super::secret_env::NODE_TOKEN_ENV);
    super::upsert_provider(
        id,
        proxy_patch(
            id,
            &crate::sidecar::gateway::core_self_url(),
            &node_token,
            rows,
        )?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_and_cn_pats_are_selected_from_separate_sealed_scopes() {
        let vault = AccountVault::in_memory().unwrap();
        store_in_vault(&vault, GLOBAL_ID, "synthetic-global-pat").unwrap();
        store_in_vault(&vault, CN_ID, "synthetic-cn-pat").unwrap();
        assert_eq!(
            capture_token_from_vault(&vault, GLOBAL_ID).unwrap(),
            "synthetic-global-pat"
        );
        assert_eq!(
            capture_token_from_vault(&vault, CN_ID).unwrap(),
            "synthetic-cn-pat"
        );
        assert_eq!(
            vault.list(&accounts::provider_scope(GLOBAL_ID)).unwrap()[0].kind,
            KIND_API_KEY
        );
        assert!(capture_token_from_vault(&vault, "qoder-unknown").is_err());
    }

    #[test]
    fn qoder_selectors_cannot_become_arbitrary_http_endpoints() {
        assert!(validate_selector(GLOBAL_ID, Some("https://qoder.com"), None).is_ok());
        assert!(validate_selector(CN_ID, Some("https://qoder.cn"), None).is_ok());
        assert!(validate_selector(GLOBAL_ID, Some("https://qoder.cn"), None).is_err());
        assert!(validate_selector(GLOBAL_ID, Some("http://127.0.0.1:9999"), None).is_err());
        assert!(validate_selector(CN_ID, None, Some("openai-responses")).is_err());
    }

    #[test]
    fn pi_proxy_pin_never_contains_the_vendor_pat() {
        let patch = proxy_patch(
            GLOBAL_ID,
            "http://127.0.0.1:54531",
            "synthetic-node-token",
            vec![json!({"id":"roster-model"})],
        )
        .unwrap();
        assert_eq!(
            patch["baseUrl"],
            "http://127.0.0.1:54531/api/pi-config/qoder/v1"
        );
        assert_eq!(patch["apiKey"], "ryu-local-proxy");
        assert_eq!(patch["headers"]["x-ryu-node-token"], "synthetic-node-token");
        assert!(!serde_json::to_string(&patch)
            .unwrap()
            .contains("synthetic-global-pat"));
        assert!(proxy_patch(CN_ID, "http://127.0.0.1:54531", "", vec![]).is_err());
    }
}
