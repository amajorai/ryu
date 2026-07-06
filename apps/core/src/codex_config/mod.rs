//! Codex gateway-routing toggle (subscription-preserving egress governance).
//!
//! Codex (`acp:codex`) runs through Zed's `codex-acp` bridge. On a ChatGPT
//! Plus/Pro/Business **subscription** it authenticates with the user's own OAuth
//! credentials (`access_token` + `account_id` from `~/.codex/auth.json`) and hits
//! OpenAI's special backend `https://chatgpt.com/backend-api/codex/responses`
//! using the **Responses** wire API. That subscription egress is NOT governed by
//! the Ryu gateway: Codex ignores `OPENAI_BASE_URL` in ChatGPT-auth mode, so the
//! existing `codex_acp_cmd()` API-key injection only governs the *API-key* path,
//! not the subscription path.
//!
//! This module opts the user into routing the **subscription** egress through the
//! gateway's transparent passthrough proxy (`apps/gateway/src/passthrough`,
//! `/passthrough/openai-responses/*`), mirroring the Claude Code passthrough. The
//! mechanism (verified against the Codex config reference + the headroom proxy
//! design): point Codex at an **isolated `CODEX_HOME`** holding a `config.toml`
//! with a custom `model_provider` whose `base_url` is the gateway passthrough and
//! that has **no `env_key`**, so Codex delivers its subscription-auth request
//! (OAuth bearer + `ChatGPT-Account-ID` header) to the proxy untouched. The proxy
//! forwards both UNCHANGED to `chatgpt.com/backend-api/codex` while applying
//! request-side DLP + audit.
//!
//! **Subscription-preservation rule (same as Claude):** we never inject an API
//! key on this path. The isolated home reuses the user's real `~/.codex/auth.json`
//! (copied in) so the OAuth subscription credential is what reaches upstream. A
//! BYOK key would flip Codex onto API-key billing.
//!
//! Off by default (opt-in): enabling it changes how the subscription credential
//! flows, so the user must choose it explicitly. The flag is a process-global
//! seeded from the `codex-gateway-routing` preference at startup and on change,
//! read synchronously on the (sync) spawn path; the isolated `CODEX_HOME` is
//! (re)written lazily when the flag is on.
//!
//! **Known caveat (auth.json refresh divergence):** we copy the user's
//! `~/.codex/auth.json` into the isolated home at spawn. OAuth access tokens
//! refresh over time. A refresh written into the isolated home does NOT propagate
//! back to the user's real `~/.codex`, and the next spawn re-copies the user's
//! (possibly older) token over the isolated one. This is fine within a session;
//! a follow-up could share the auth file (symlink) or skip the re-copy when the
//! isolated token is newer.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Context, Result};

/// Preferences key the desktop writes; Core loads it on startup and on change.
pub const CODEX_GATEWAY_ROUTING_PREF_KEY: &str = "codex-gateway-routing";

/// The custom provider id written into the isolated `config.toml`. Arbitrary, but
/// stable so a re-write is idempotent.
const PROVIDER_ID: &str = "ryu-gateway";

/// In-process flag, populated from preferences. Defaults to `false` (opt-in).
static GATEWAY_ROUTING: AtomicBool = AtomicBool::new(false);

/// Set the in-process flag from a preferences value. Accepts the common truthy
/// string forms the desktop may persist (`"true"`, `"1"`, `"on"`).
pub fn set_enabled(value: &str) {
    let on = matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "true" | "1" | "on" | "yes"
    );
    GATEWAY_ROUTING.store(on, Ordering::Relaxed);
}

/// Whether Codex should route its subscription egress through the Ryu gateway
/// passthrough proxy. Read on the synchronous spawn path.
pub fn is_gateway_routing() -> bool {
    GATEWAY_ROUTING.load(Ordering::Relaxed)
}

/// The isolated `CODEX_HOME` for the gateway-routed Codex. Override with
/// `RYU_CODEX_HOME` (the "nothing hardcoded" knob); defaults to
/// `~/.ryu/codex-home`. Kept separate from the user's `~/.codex` so enabling the
/// toggle never mutates their own Codex config.
pub fn codex_home() -> PathBuf {
    if let Ok(custom) = std::env::var("RYU_CODEX_HOME") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    crate::sidecar::download_manager::ryu_dir().join("codex-home")
}

/// The user's real `CODEX_HOME` (where their OAuth `auth.json` lives). Honours the
/// `CODEX_HOME` env override Codex itself uses; defaults to `~/.codex`.
fn user_codex_home() -> PathBuf {
    if let Ok(custom) = std::env::var("CODEX_HOME") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
}

/// The gateway passthrough base URL Codex is pointed at via the custom provider's
/// `base_url`. Codex appends `/responses` (Responses wire API), which the
/// gateway's `/passthrough/openai-responses/*` proxy forwards upstream to
/// `chatgpt.com/backend-api/codex` with the caller's own subscription auth
/// unchanged.
pub fn passthrough_base_url() -> String {
    let base = crate::sidecar::gateway::gateway_url();
    format!(
        "{}/passthrough/openai-responses",
        base.trim_end_matches('/')
    )
}

/// Prepare the isolated `CODEX_HOME` for gateway routing: copy the user's OAuth
/// `auth.json` (subscription credential) in, then write a `config.toml` whose
/// default provider points the Responses traffic at the gateway passthrough with
/// no `env_key` (subscription-preserving). Returns the home dir as a string for
/// the `CODEX_HOME` env on the spawn command.
///
/// Idempotent: it overwrites `config.toml` and refreshes `auth.json` each call so
/// a token rotation in the user's real home propagates. Best-effort on the
/// `auth.json` copy: if the user has not signed into Codex yet there is nothing
/// to copy, and Codex will prompt as usual.
pub fn ensure_gateway_home() -> Result<String> {
    let home = codex_home();
    fs::create_dir_all(&home)
        .with_context(|| format!("creating isolated CODEX_HOME at {}", home.display()))?;

    // Refresh the OAuth credential from the user's real Codex home so the
    // subscription bearer + account id reach the passthrough. Best-effort.
    let user_auth = user_codex_home().join("auth.json");
    if user_auth.exists() {
        let _ = fs::copy(&user_auth, home.join("auth.json"));
    }

    let base_url = passthrough_base_url();
    // A custom provider with `wire_api = "responses"` and NO `env_key` makes
    // Codex deliver its subscription-auth request (OAuth bearer + ChatGPT
    // account id) to base_url untouched (verified: headroom proxy design).
    let config_toml = format!(
        "# Generated by Ryu (codex-gateway-routing). Do not edit by hand.\n\
         model_provider = \"{PROVIDER_ID}\"\n\
         \n\
         [model_providers.{PROVIDER_ID}]\n\
         name = \"Ryu Gateway (subscription passthrough)\"\n\
         base_url = \"{base_url}\"\n\
         wire_api = \"responses\"\n"
    );
    fs::write(home.join("config.toml"), config_toml)
        .with_context(|| format!("writing config.toml under {}", home.display()))?;

    Ok(home.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toggle_parses_truthy_forms() {
        set_enabled("true");
        assert!(is_gateway_routing());
        set_enabled("false");
        assert!(!is_gateway_routing());
        set_enabled("  ON ");
        assert!(is_gateway_routing());
        set_enabled("0");
        assert!(!is_gateway_routing());
    }

    #[test]
    fn passthrough_url_targets_openai_responses_path() {
        // Serialize against every other RYU_GATEWAY_URL toucher (process-global).
        let _lock = crate::sidecar::gateway::lock_gateway_env();
        std::env::set_var("RYU_GATEWAY_URL", "http://test-gw.local:9999");
        let url = passthrough_base_url();
        assert_eq!(
            url,
            "http://test-gw.local:9999/passthrough/openai-responses"
        );
        std::env::remove_var("RYU_GATEWAY_URL");
    }

    #[test]
    fn ensure_home_writes_config_with_provider_and_no_env_key() {
        let tmp = std::env::temp_dir().join(format!("ryu-codex-home-{}", std::process::id()));
        std::env::set_var("RYU_CODEX_HOME", &tmp);
        let home = ensure_gateway_home().expect("ensure home");
        let cfg = std::fs::read_to_string(std::path::Path::new(&home).join("config.toml"))
            .expect("config.toml written");
        assert!(cfg.contains("wire_api = \"responses\""), "got: {cfg}");
        assert!(cfg.contains("model_providers.ryu-gateway"), "got: {cfg}");
        // Subscription-preservation: never an env_key / api key on this path.
        assert!(
            !cfg.contains("env_key"),
            "config must not set env_key: {cfg}"
        );
        std::env::remove_var("RYU_CODEX_HOME");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
