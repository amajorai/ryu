//! The managed Pi's route-scoped bearer for Core's loopback provider routes.
//!
//! Pi's `models.json` sends `x-ryu-node-token: ${RYU_PI_NODE_TOKEN}` to Core's
//! subscription-provider proxies (`/api/pi-config/claude|chatgpt|kiro|qoder…`).
//! Pi's shell tool and every process it starts inherit that variable, including
//! code from an untrusted workspace inside the agent sandbox, so it must never
//! hold the node owner bearer (`node_token::active_token()`), which every Core
//! route and the `/api/ws/ticket` mint accept. It holds this per-process value
//! instead, which `require_auth` admits only on [`is_provider_route`] paths.

use std::sync::OnceLock;

/// Every value starts with this, so it can never be mistaken for a minted
/// node bearer (`ryu_…`).
const PREFIX: &str = "ryu-pi-provider-";

static TOKEN: OnceLock<String> = OnceLock::new();

/// This Core process's provider-route bearer. Random per process, never
/// persisted; a restarted Core re-spawns its Pi agents with the new value.
pub(crate) fn provider_token() -> &'static str {
    TOKEN.get_or_init(|| {
        use rand::RngCore;
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        format!("{PREFIX}{}", hex::encode(bytes))
    })
}

/// The Core routes a managed Pi provider calls with `x-ryu-node-token`, and
/// the only routes where [`provider_token`] is accepted.
pub(crate) fn is_provider_route(path: &str) -> bool {
    path.starts_with("/api/pi-config/chatgpt/codex/")
        || path.starts_with("/api/pi-config/chatgpt-plan/")
        || matches!(
            path,
            "/api/pi-config/claude/v1/messages"
                | "/api/pi-config/kiro/v1/chat/completions"
                | "/api/pi-config/kiro/v1/models"
                | "/api/pi-config/qoder/v1/chat/completions"
                | "/api/pi-config/qoder/v1/models"
                | "/api/pi-config/qoder-cn/v1/chat/completions"
                | "/api/pi-config/qoder-cn/v1/models"
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_token_is_stable_random_and_not_a_node_bearer() {
        let token = provider_token();
        assert_eq!(token, provider_token());
        assert!(token.starts_with(PREFIX));
        assert_eq!(token.len(), PREFIX.len() + 64);
        assert!(!token.starts_with("ryu_"));
    }

    #[test]
    fn only_the_provider_proxies_are_provider_routes() {
        for path in [
            "/api/pi-config/claude/v1/messages",
            "/api/pi-config/chatgpt/codex/responses",
            "/api/pi-config/chatgpt-plan/v1/responses",
            "/api/pi-config/kiro/v1/models",
            "/api/pi-config/qoder-cn/v1/chat/completions",
        ] {
            assert!(is_provider_route(path), "{path}");
        }
        for path in [
            "/api/settings",
            "/api/ws/ticket",
            "/api/vault/secrets",
            "/api/pi-config/claude/v1/models",
            "/api/pi-config/settings",
            "/api/pi-config/chatgpt/codex",
        ] {
            assert!(!is_provider_route(path), "{path}");
        }
    }
}
