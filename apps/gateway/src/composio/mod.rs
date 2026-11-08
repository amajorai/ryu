mod execute;
mod file_upload;
mod http_api;
mod routing;
mod tenant;
mod tool_loop;

use reqwest::Client;

use crate::config::ComposioConfig;

#[allow(unused_imports)] // referenced only from tests outside this module
pub use file_upload::FILE_UPLOAD_MAX_BYTES;
pub use tenant::ComposioTenantScope;

// Names the `tool_loop_tests` / `execute_tests` modules reach through
// `super::`.
#[cfg(test)]
use crate::{error::GatewayError, providers::Provider};
#[cfg(test)]
use execute::receipt_client;
#[cfg(test)]
use serde_json::{json, Value};

/// Default Composio REST base (v3.1, current as of 2026-06). The old `/api/v1`
/// is gone; v3.1 executes tools at `/tools/execute/{tool_slug}`. Swappable via
/// `COMPOSIO_BASE_URL` so a future surface change is one env, not a rebuild
/// (kept in sync with `apps/core/src/composio_catalog`).
const DEFAULT_COMPOSIO_BASE_URL: &str = "https://backend.composio.dev/api/v3.1";

fn composio_base_url() -> String {
    std::env::var("COMPOSIO_BASE_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('/').to_string())
        .unwrap_or_else(|| DEFAULT_COMPOSIO_BASE_URL.to_string())
}

pub struct ComposioClient {
    http: Client,
    config: ComposioConfig,
    #[cfg(test)]
    test_base_url: Option<String>,
}

impl ComposioClient {
    pub fn new(config: ComposioConfig, http: Client) -> Self {
        Self {
            http,
            config,
            #[cfg(test)]
            test_base_url: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test(config: ComposioConfig, http: Client, base_url: String) -> Self {
        Self {
            http,
            config,
            test_base_url: Some(base_url),
        }
    }

    fn base_url(&self) -> String {
        #[cfg(test)]
        if let Some(base) = &self.test_base_url {
            return base.clone();
        }
        composio_base_url()
    }

    /// Return the list of allowlisted Composio action names.
    pub fn actions(&self) -> &[String] {
        &self.config.actions
    }
}

#[cfg(test)]
mod execute_tests;

#[cfg(test)]
mod tenant_tests;

#[cfg(test)]
mod tool_loop_tests;
