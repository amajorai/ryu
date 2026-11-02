//! The narrow host seam Core installs at boot, plus the per-node engine gate.

use super::*;

/// The bundled default chat/embed/Speech Processing model repos, as `(id, weight_url)`.
/// Used only to derive a Hugging Face repo fallback for origin-less pre-existing
/// installs, so they resolve to a real repo card instead of a bare `local:` one.
pub type DefaultModelRepos = Vec<(String, String)>;

/// The narrow kernel seam this extracted primitive inverts back into Core.
///
/// The catalog itself is pure orchestration (HF search/detail, device-fit,
/// installed-model tracking), but five cross-cutting couplings are process-global
/// Core state. Core implements this once (`apps/core/src/model_catalog_host.rs`)
/// and installs it at boot via [`set_global_host`], BEFORE the first catalog call.
/// Production [`host`] is strict: it panics if the host was never installed rather
/// than silently defaulting to a wrong data dir / dropping HF auth.
#[async_trait::async_trait]
pub trait ModelCatalogHost: Send + Sync {
    /// The active Ryu data dir (`~/.ryu`, or its profile/relocation variant).
    /// All catalog caches, `installed-models.json`, and downloaded weights live
    /// under it. Resolved per call because the user can relocate it at runtime.
    fn ryu_dir(&self) -> PathBuf;

    /// Attach the user's Hugging Face bearer token (preferences-first, env
    /// fallback) to an outgoing Hub request and return the (possibly modified)
    /// builder. Implementations must check `url` themselves; pass-through for
    /// non-Hub hosts or when no token is configured. The token never leaves the
    /// host.
    fn authorize_hf(&self, url: &str, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder;

    /// Whether the named local engine (llama.cpp, vllm, sglang, mlx, …) is
    /// runnable on this Core node (platform + install gate). Drives the per-node
    /// format-compatibility verdict.
    fn supported_on_node(&self, engine: &str) -> bool;

    /// The bundled default chat + embedding model repos as `(id, weight_url)`,
    /// read from the swappable local model registry.
    fn default_model_repos(&self) -> DefaultModelRepos;

    /// The active-model preference raw value (the `ACTIVE_MODEL_PREF` KV entry),
    /// or `None` when unset or the preferences store can't be opened.
    async fn active_model_pref(&self) -> Option<String>;
}

pub(crate) fn host_slot() -> &'static OnceLock<Arc<dyn ModelCatalogHost>> {
    static HOST: OnceLock<Arc<dyn ModelCatalogHost>> = OnceLock::new();
    &HOST
}

/// Install the process-wide [`ModelCatalogHost`]. Called once at Core boot,
/// before any catalog call. Idempotent-friendly for tests (first install wins).
pub fn set_global_host(host: Arc<dyn ModelCatalogHost>) {
    let _ = host_slot().set(host);
}

/// Fetch the installed host. Strict by design: panics if [`set_global_host`] was
/// never called, rather than silently defaulting to a wrong data dir.
pub(crate) fn host() -> Arc<dyn ModelCatalogHost> {
    host_slot().get().cloned().expect(
        "ryu-model-catalog host not installed — call ryu_model_catalog::set_global_host at boot",
    )
}

/// The active Ryu data dir, via the installed host.
pub(crate) fn ryu_dir() -> PathBuf {
    host().ryu_dir()
}

/// The active Ryu data dir when a host is installed, else `None`. For probes
/// that must stay infallible (hardware detection) in a process with no host.
pub(crate) fn try_ryu_dir() -> Option<PathBuf> {
    host_slot().get().map(|host| host.ryu_dir())
}

/// Test-only host backed by a process-wide temp data dir, installed on first use
/// (idempotent — `set_global_host` is first-wins). Tests that touch a data-dir
/// path (`installed`, `capabilities`, `aa`, `models_dev` caches) call this first
/// so they never hit a real `~/.ryu` and never panic on a missing host. Mirrors
/// the `ryu-downloads` crate's own `TestHost` pattern.
#[cfg(test)]
pub(crate) fn ensure_test_host() {
    use std::sync::OnceLock;
    static TMP: OnceLock<PathBuf> = OnceLock::new();
    let dir = TMP
        .get_or_init(|| {
            let d =
                std::env::temp_dir().join(format!("ryu-model-catalog-test-{}", std::process::id()));
            let _ = std::fs::create_dir_all(&d);
            d
        })
        .clone();

    struct TestHost {
        dir: PathBuf,
    }
    #[async_trait::async_trait]
    impl ModelCatalogHost for TestHost {
        fn ryu_dir(&self) -> PathBuf {
            self.dir.clone()
        }
        fn authorize_hf(
            &self,
            _url: &str,
            req: reqwest::RequestBuilder,
        ) -> reqwest::RequestBuilder {
            req
        }
        fn supported_on_node(&self, _engine: &str) -> bool {
            false
        }
        fn default_model_repos(&self) -> DefaultModelRepos {
            Vec::new()
        }
        async fn active_model_pref(&self) -> Option<String> {
            None
        }
    }
    set_global_host(Arc::new(TestHost { dir }));
}

pub(crate) const USER_AGENT: &str = "ryu-core/0.1 (+https://ryu.app)";

/// Whether an engine is runnable on this Core node (platform + install gate).
/// Thin wrapper so the capability helpers can be passed a plain `fn`.
pub(crate) fn engine_supported(name: &str) -> bool {
    host().supported_on_node(name)
}

/// The per-node compatibility verdict for a format: `(compatible, needs_engine)`.
/// `needs_engine` is the human label of the first engine that *could* serve the
/// format, shown when no serving engine is supported on this node. Computed on
/// the Core node so the verdict is authoritative even when the client is remote.
pub(crate) fn format_compat(fmt: ModelFormat) -> (bool, Option<String>) {
    let compatible = ryu_model_format::format_supported_on_node(fmt, engine_supported);
    let needs_engine = if compatible {
        None
    } else {
        ryu_model_format::needs_engine_label(fmt)
    };
    (compatible, needs_engine)
}

/// The active-model weight reference (stem or repo id) a given engine should
/// serve, when the user's active-model selection targets that engine. Returns
/// `None` when no selection is set, the selection is for another engine, or the
/// preferences store can't be opened — so providers fall through to their env /
/// default tier. This is the runtime-switch source feeding each provider's
/// `start()`, sitting *below* an explicit `with_model` override.
pub async fn active_model_ref_for_engine(engine: &str) -> Option<String> {
    let raw = host().active_model_pref().await?;
    let active = installed::parse_active_pref(&raw)?;
    if active.engine == engine && !active.r#ref.trim().is_empty() {
        Some(active.r#ref)
    } else {
        None
    }
}
