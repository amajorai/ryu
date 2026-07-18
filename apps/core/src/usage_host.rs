//! Core's implementation of the extracted [`ryu_usage::UsageHost`] seam.
//!
//! The `ryu-usage` crate owns the subscription usage-metering primitive — the
//! per-vendor OAuth-token readers (Claude Code / Codex), the never-refresh token
//! safety, and the normalized [`ryu_usage::UsageSnapshot`] windows. What it
//! cannot own — because it is a kernel data-dir concept — is the one path
//! coupling the Codex reader needs: the Ryu-isolated `CODEX_HOME`
//! ([`crate::codex_config::codex_home`], `RYU_CODEX_HOME` override, else the
//! profile/relocation-aware `~/.ryu/codex-home`). This shim implements it, and
//! Core installs it once at boot via [`ryu_usage::set_global_host`].

use std::path::PathBuf;

use ryu_usage::UsageHost;

/// Install [`CoreUsageHost`] as the process-global usage host. Idempotent (a
/// second call is a no-op). Called once from `main` at boot; usage backs a
/// poll-driven widget, so if it were ever fetched before install the reader
/// would just skip the Ryu-isolated Codex candidate rather than fail.
pub fn install() {
    ryu_usage::set_global_host(std::sync::Arc::new(CoreUsageHost));
}

/// Core's `UsageHost` — the kernel side of the usage seam.
pub struct CoreUsageHost;

impl UsageHost for CoreUsageHost {
    fn ryu_codex_home(&self) -> PathBuf {
        crate::codex_config::codex_home()
    }
}
