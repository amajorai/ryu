//! Core's kernel side of the extracted [`ryu_image`] seam.
//!
//! The `ryu-image` crate owns the image-generation primitive — the image-gen
//! abstraction + routing (`generate`), the local-vs-cloud dispatch, and the media
//! proxy/gateway-forward mechanics. What it cannot own — because they read Core
//! config/sidecar state — are three couplings: the local sd-server base-url, the
//! Gateway url + token, and lazy-starting the off-by-default sd.cpp sidecar (the
//! [`SidecarManager`](crate::sidecar::SidecarManager) that owns the process stays
//! Core-side sidecar lifecycle). This shim wires all three behind the crate's
//! narrow [`ryu_image::ImageHost`] trait; the `server::media` route handlers are
//! thin wrappers over the crate, so `openapi.rs` and the desktop callers are
//! unchanged.
//!
//! Mirrors the `stt_host`/`search_host`/`rag_host` precedent (kernel wiring the
//! extracted crate can't own).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use ryu_image::ImageHost;

use crate::sidecar::SidecarManager;

/// Core's [`ImageHost`] — resolves the local sd-server base-url and the Gateway
/// url/token from Core config, and lazily starts the `sdcpp` sidecar through the
/// [`SidecarManager`].
pub struct CoreImageHost {
    manager: Arc<SidecarManager>,
}

impl CoreImageHost {
    pub fn new(manager: Arc<SidecarManager>) -> Self {
        Self { manager }
    }
}

impl ImageHost for CoreImageHost {
    fn sd_base_url(&self) -> String {
        crate::sidecar::providers::sdcpp::sd_base_url()
    }

    fn gateway_url(&self) -> String {
        crate::sidecar::gateway::gateway_url()
    }

    fn gateway_token(&self) -> Option<String> {
        crate::sidecar::gateway::gateway_token()
    }

    fn start_local_engine(&self) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        let manager = Arc::clone(&self.manager);
        Box::pin(async move {
            manager
                .start_sidecar("sdcpp")
                .await
                .map_err(|e| format!("{e:#}"))
        })
    }
}
