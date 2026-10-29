use super::{local_embed_base_url, DEFAULT_EMBED_PORT};

static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct EnvVar {
    name: &'static str,
    prior: Option<std::ffi::OsString>,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl EnvVar {
    fn set(name: &'static str, value: &str) -> Self {
        let lock = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let prior = std::env::var_os(name);
        std::env::set_var(name, value);
        Self {
            name,
            prior,
            _lock: lock,
        }
    }
    fn cleared(name: &'static str) -> Self {
        let lock = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let prior = std::env::var_os(name);
        std::env::remove_var(name);
        Self {
            name,
            prior,
            _lock: lock,
        }
    }
}
impl Drop for EnvVar {
    fn drop(&mut self) {
        match self.prior.take() {
            Some(prior) => std::env::set_var(self.name, prior),
            None => std::env::remove_var(self.name),
        }
    }
}

/// The default must be the PROFILE-ADJUSTED embed port, not a bare 8081. A dev
/// gateway that dials the release sidecar embeds against whatever model the
/// other profile happens to be serving, which is a silently wrong vector rather
/// than an error.
#[test]
fn defaults_to_the_profile_adjusted_embed_port() {
    let _env = EnvVar::cleared("RYU_EMBED_LLM_URL");
    let expected = format!(
        "http://127.0.0.1:{}/v1",
        crate::profile::port(DEFAULT_EMBED_PORT)
    );
    assert_eq!(local_embed_base_url(), expected);
}

/// `RYU_EMBED_LLM_URL` wins, mirroring `RYU_CLASSIFY_LLM_URL` for the classify
/// tier — that is how a Core-spawned gateway is repointed.
#[test]
fn env_override_wins() {
    let _env = EnvVar::set("RYU_EMBED_LLM_URL", "http://10.0.0.4:9999/v1");
    assert_eq!(local_embed_base_url(), "http://10.0.0.4:9999/v1");
}

/// A blank or whitespace-only override is not an endpoint. Treating it as one
/// would send every embed call to the empty string and fail every request,
/// where falling back to the local sidecar still works.
#[test]
fn blank_override_falls_back_to_the_local_sidecar() {
    let _env = EnvVar::set("RYU_EMBED_LLM_URL", "   ");
    let expected = format!(
        "http://127.0.0.1:{}/v1",
        crate::profile::port(DEFAULT_EMBED_PORT)
    );
    assert_eq!(local_embed_base_url(), expected);
}
