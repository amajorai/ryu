//! Swappable passthrough proxy backend (W6c decomposition).

use std::net::SocketAddr;

use axum::{
    body::Bytes,
    http::{HeaderMap, Method},
    response::Response,
};

use super::{forward, PassthroughRoute, WireFormat};
use crate::state::SharedState;

/// The native-format passthrough reverse proxy as a swappable capability. The
/// built-in [`BuiltinPassthrough`] (the transparent loopback [`forward`] core) is
/// the default; an alternative (e.g. a mesh-relayed or policy-augmented proxy)
/// can register without touching the route handlers, mirroring the
/// [`crate::budget::BudgetRegistry`] inversion. Async because the proxy streams
/// the upstream response, so it follows the [`crate::providers`] async-trait shape
/// rather than the sync budget closure.
#[async_trait::async_trait]
pub(crate) trait PassthroughBackend: Send + Sync {
    /// Proxy one native-format request upstream and stream the response back.
    #[allow(clippy::too_many_arguments)]
    async fn forward(
        &self,
        format: WireFormat,
        upstream_base: String,
        route: PassthroughRoute,
        state: SharedState,
        peer: SocketAddr,
        path: String,
        method: Method,
        headers: HeaderMap,
        raw_query: axum::extract::RawQuery,
        body: Bytes,
    ) -> Response;
}

/// The built-in passthrough proxy: delegates to the module's transparent
/// loopback [`forward`] core. Byte-identical to the pre-inversion behavior.
pub(crate) struct BuiltinPassthrough;

#[async_trait::async_trait]
impl PassthroughBackend for BuiltinPassthrough {
    async fn forward(
        &self,
        format: WireFormat,
        upstream_base: String,
        route: PassthroughRoute,
        state: SharedState,
        peer: SocketAddr,
        path: String,
        method: Method,
        headers: HeaderMap,
        raw_query: axum::extract::RawQuery,
        body: Bytes,
    ) -> Response {
        forward(
            format,
            &upstream_base,
            route,
            state,
            peer,
            path,
            method,
            headers,
            raw_query,
            body,
        )
        .await
    }
}

/// Id-keyed registry over [`PassthroughBackend`] implementations with a live-swap
/// discipline, matching [`crate::budget::BudgetRegistry`] in shape but yielding an
/// `Arc<dyn PassthroughBackend>` (not a borrowing closure) so the active backend
/// survives the streamed `.await` — the same discipline the async smart router
/// uses. The built-in [`BuiltinPassthrough`] is registered under
/// [`PassthroughRegistry::BUILTIN`] and active by default.
pub(crate) struct PassthroughRegistry {
    inner: std::sync::RwLock<PassthroughRegistryInner>,
}

struct PassthroughRegistryInner {
    backends: std::collections::HashMap<String, std::sync::Arc<dyn PassthroughBackend>>,
    order: Vec<String>,
    active_id: String,
    active: std::sync::Arc<dyn PassthroughBackend>,
}

impl PassthroughRegistry {
    /// Stable id of the built-in in-process passthrough proxy.
    pub const BUILTIN: &'static str = "builtin";

    /// Build the registry with the built-in passthrough proxy as the default
    /// active backend.
    pub fn new() -> Self {
        let builtin: std::sync::Arc<dyn PassthroughBackend> =
            std::sync::Arc::new(BuiltinPassthrough);
        let mut backends = std::collections::HashMap::new();
        backends.insert(Self::BUILTIN.to_string(), std::sync::Arc::clone(&builtin));
        Self {
            inner: std::sync::RwLock::new(PassthroughRegistryInner {
                backends,
                order: vec![Self::BUILTIN.to_string()],
                active_id: Self::BUILTIN.to_string(),
                active: builtin,
            }),
        }
    }

    /// Clone the active backend out under a brief read lock (recovering from a
    /// poisoned lock). The returned `Arc` holds no lock, so the handler can keep
    /// it across the streamed `.await`.
    pub fn active(&self) -> std::sync::Arc<dyn PassthroughBackend> {
        match self.inner.read() {
            Ok(guard) => std::sync::Arc::clone(&guard.active),
            Err(poisoned) => std::sync::Arc::clone(&poisoned.into_inner().active),
        }
    }

    /// Register a backend under a stable id (open extension point). Re-registering
    /// replaces in place; refreshes the live handle if it is the active id.
    #[allow(dead_code)]
    pub fn register(&self, id: impl Into<String>, backend: std::sync::Arc<dyn PassthroughBackend>) {
        let id = id.into();
        let mut guard = match self.inner.write() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if !guard.backends.contains_key(&id) {
            guard.order.push(id.clone());
        }
        let is_active = id == guard.active_id;
        guard.backends.insert(id, std::sync::Arc::clone(&backend));
        if is_active {
            guard.active = backend;
        }
    }

    /// Select the active backend by id. `false` (unchanged) if `id` is unknown.
    pub fn set_active(&self, id: &str) -> bool {
        let mut guard = match self.inner.write() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        match guard.backends.get(id).map(std::sync::Arc::clone) {
            Some(backend) => {
                guard.active = backend;
                guard.active_id = id.to_string();
                true
            }
            None => false,
        }
    }

    /// The id of the currently active backend.
    #[allow(dead_code)]
    pub fn active_id(&self) -> String {
        match self.inner.read() {
            Ok(g) => g.active_id.clone(),
            Err(p) => p.into_inner().active_id.clone(),
        }
    }

    /// The registered backend ids in registration order.
    pub fn available(&self) -> Vec<String> {
        match self.inner.read() {
            Ok(g) => g.order.clone(),
            Err(p) => p.into_inner().order.clone(),
        }
    }
}

impl Default for PassthroughRegistry {
    fn default() -> Self {
        Self::new()
    }
}
