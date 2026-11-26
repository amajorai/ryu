//! The relay's live state: the cached configuration, the event queue and the
//! batched POST.
//!
//! A model call reads one atomic to learn whether the relay is on, and queues
//! its event with one `try_send`. The configuration is resolved once, by the
//! first model call of the process. The environment cannot change after that,
//! so only a Core-managed node (whose relay file Core rewrites when the owner
//! changes the diagnostics setting or the credential rotates) re-reads it, in
//! a background task every [`CONFIG_REFRESH`] and after a 401 or 403.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Once, OnceLock, PoisonError, RwLock};
use std::time::Duration;

use futures_util::future::BoxFuture;

use super::batch::{Delivery, Post, Queue, Settings};
use super::{
    configured, relay_client, AuthMode, Config, ModelCallEvent, RelayBody,
    ANALYTICS_CONFIG_FILE_ENV, DIAGNOSTICS_OPT_IN_HEADER, REQUEST_TIMEOUT,
};

/// The relay accepts 20 events per POST (`RYU_ANALYTICS_MAX_BATCH_SIZE`) and
/// 60 POSTs per minute per rate key, so one POST per second at most keeps a
/// Gateway with its own key inside the limit. Hosted replicas share one key;
/// the backoff covers the case where together they exceed it.
pub(super) const SETTINGS: Settings = Settings {
    capacity: 2_000,
    batch_size: 20,
    flush_after: Duration::from_secs(2),
    post_interval: Duration::from_secs(1),
    backoff: Duration::from_secs(15),
};

/// How often a Core-managed node re-reads the relay file.
const CONFIG_REFRESH: Duration = Duration::from_secs(30);

/// Longest the exit path waits for the last batches.
const SHUTDOWN_FLUSH: Duration = Duration::from_secs(5);

const UNRESOLVED: u8 = 0;
const ON: u8 = 1;
const OFF: u8 = 2;

/// The resolved relay configuration and the gate the request path reads.
pub(super) struct RelayState {
    gate: AtomicU8,
    config: RwLock<Option<Arc<Config>>>,
}

impl RelayState {
    pub(super) const fn new() -> Self {
        Self {
            gate: AtomicU8::new(UNRESOLVED),
            config: RwLock::new(None),
        }
    }

    pub(super) fn store(&self, config: Option<Config>) {
        let gate = if config.is_some() { ON } else { OFF };
        *self.config.write().unwrap_or_else(PoisonError::into_inner) = config.map(Arc::new);
        self.gate.store(gate, Ordering::Release);
    }

    pub(super) fn current(&self) -> Option<Arc<Config>> {
        self.config
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Whether the relay is on; `None` until a configuration was stored.
    pub(super) fn enabled(&self) -> Option<bool> {
        match self.gate.load(Ordering::Acquire) {
            ON => Some(true),
            OFF => Some(false),
            _ => None,
        }
    }
}

static RELAY: RelayState = RelayState::new();
static QUEUE: OnceLock<Queue<ModelCallEvent>> = OnceLock::new();

/// Whether Core maintains a relay file for this Gateway. Without one the
/// configuration comes from the environment alone and never changes.
fn core_file_configured() -> bool {
    std::env::var(ANALYTICS_CONFIG_FILE_ENV).is_ok_and(|path| !path.trim().is_empty())
}

async fn refresh() {
    if let Ok(config) = tokio::task::spawn_blocking(configured).await {
        RELAY.store(config);
    }
}

async fn refresh_loop() {
    loop {
        tokio::time::sleep(CONFIG_REFRESH).await;
        refresh().await;
    }
}

/// Whether a model call should queue its event. The first call resolves the
/// configuration; every later call is one atomic load.
pub(super) fn enabled() -> bool {
    if let Some(enabled) = RELAY.enabled() {
        return enabled;
    }
    static RESOLVE: Once = Once::new();
    RESOLVE.call_once(|| {
        RELAY.store(configured());
        if core_file_configured() {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(refresh_loop());
            }
        }
    });
    RELAY.enabled().unwrap_or(false)
}

/// Queue one event for the next batch. Never waits: a full queue drops it.
pub(super) fn push(event: ModelCallEvent) {
    QUEUE
        .get_or_init(|| Queue::spawn(SETTINGS, Arc::new(RelayPost)))
        .push(event);
}

/// Send what is still queued before the process exits. Bounded, and a no-op
/// when no event was ever queued.
pub async fn shutdown() {
    if let Some(queue) = QUEUE.get() {
        let _ = tokio::time::timeout(SHUTDOWN_FLUSH, queue.flush()).await;
    }
}

/// Posts batches to the configured relay.
struct RelayPost;

impl Post<ModelCallEvent> for RelayPost {
    fn post<'a>(&'a self, events: &'a [ModelCallEvent]) -> BoxFuture<'a, Delivery> {
        Box::pin(async move {
            // The owner turned the relay off since these were queued.
            let Some(config) = RELAY.current() else {
                return Delivery::Lost;
            };
            let (delivery, status) = post_batch(relay_client(), &config, events).await;
            // Core may have rotated the relay credential since the last read.
            if matches!(status, Some(401 | 403)) && core_file_configured() {
                refresh().await;
            }
            delivery
        })
    }
}

/// One POST carrying `events`. Returns what became of it and the relay's
/// status code, when it answered.
pub(super) async fn post_batch(
    client: &reqwest::Client,
    config: &Config,
    events: &[ModelCallEvent],
) -> (Delivery, Option<u16>) {
    let mut request = client
        .post(&config.url)
        .timeout(REQUEST_TIMEOUT)
        .json(&RelayBody { events });
    request = match &config.auth {
        AuthMode::GatewayRelayToken(key) => request
            .header("x-gateway-key", key)
            .header(DIAGNOSTICS_OPT_IN_HEADER, "true"),
        AuthMode::HostedSecret(secret) => request.header("x-ryu-analytics-secret", secret),
    };
    let Ok(response) = request.send().await else {
        return (Delivery::Lost, None);
    };
    let status = response.status();
    let delivery = if status.is_success() {
        Delivery::Sent
    } else if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        Delivery::RateLimited
    } else {
        Delivery::Lost
    };
    (delivery, Some(status.as_u16()))
}

#[cfg(test)]
#[path = "relay_test.rs"]
mod tests;
