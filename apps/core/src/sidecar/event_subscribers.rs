//! **Sidecar event subscriptions** — the fan-out that delivers an event to every
//! enabled app sidecar that declared it in its manifest `subscribes`
//! (`docs/app-boundary-extraction-plan.md` §3 step 4, "Sidecar subscriptions").
//!
//! Before this, an event reached only sandboxed JS turn hooks and workflow `event`
//! triggers. A subscription binds an event id to one of the subscriber's own declared
//! sidecar POST routes, and Core POSTs
//! `{ "event", "payload", "emitted_at", "delivery_id" }` there through the ext-proxy's
//! single hop ([`crate::sidecar::ext_proxy::post_to_provider`]) with the SUBSCRIBER's
//! minted token — the same hop the capability broker and Core-as-consumer use.
//!
//! Two sources feed it, and both reach [`EventFanout::publish`]:
//!
//! - **app events** an app raises through the `events.emit` kernel capability (only
//!   its own declared events — see `plugin_host::may_emit_event`);
//! - **kernel events** (`core#<name>`) Core raises through [`emit_kernel_event`],
//!   limited to the reviewed [`ryu_kernel_contracts::KERNEL_EVENTS`] allowlist. No
//!   app can emit one.
//!
//! # Failure posture
//!
//! Delivery is best-effort and entirely off the emitter's path: [`EventFanout::publish`]
//! is synchronous, never awaits a subscriber, and never fails. Each subscriber gets
//! its own bounded queue ([`QUEUE_CAPACITY`]) drained by at most one task, so one slow
//! subscriber can neither block the emitter nor starve another subscriber; a full
//! queue drops its OLDEST delivery and logs. A delivery that fails transiently (the
//! provider is unreachable or answered 5xx) is retried exactly once after a short
//! delay, then dropped; a 4xx is the subscriber's own verdict and is not retried.
//! Concurrency across all subscribers is capped by [`MAX_CONCURRENT_DELIVERIES`].
//!
//! # Authorization
//!
//! The manifest loader already validated each subscription (own declared event or
//! allowlisted kernel event, declared POST route). Delivery re-checks, against the
//! live state at publish time: the subscriber is ENABLED, the subscription is still
//! one it may hold, and — for a kernel event that carries user data — that the
//! subscriber holds the event's grant (declared ∩ Gateway-approved).
//!
//! Subscription routes are ordinary declared routes, so they are also reachable
//! through the public ext-proxy by any node-bearer holder. Core therefore stamps its
//! own deliveries with [`crate::sidecar::ext_proxy::HDR_EVENT_DELIVERY`] (the
//! delivery id), which the proxy strips from every other hop: a request without it
//! did not come from Core. A subscriber that acts on a delivery must require the
//! header, and should still treat the payload as a notification, not as proof of
//! anything it could not re-read.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::Semaphore;

use ryu_kernel_contracts::{kernel_event_in, KernelEventSpec, KERNEL_EVENTS, KERNEL_EVENT_OWNER};

use crate::plugin_manifest::{PluginManifest, ProvidesEntry};
use crate::plugins::PluginStore;
use crate::sidecar::ext_proxy::ProviderRoute;
use crate::sidecar::ext_proxy::{post_event_delivery, provider_target, resolve_provider_route};
use crate::sidecar::SidecarManager;

/// Deliveries buffered per subscriber before the oldest is dropped.
pub const QUEUE_CAPACITY: usize = 64;

/// Deliveries in flight across every subscriber at once.
pub const MAX_CONCURRENT_DELIVERIES: usize = 4;

/// Delay before the single retry of a transiently failed delivery.
const RETRY_DELAY: Duration = Duration::from_millis(250);

/// One subscription target: `(subscriber plugin id, local sidecar name, route)`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SubscriberKey {
    pub plugin_id: String,
    pub sidecar: String,
    pub route: String,
}

/// One queued delivery: the resolved route and the encoded body.
#[derive(Clone)]
struct Delivery {
    event: Arc<str>,
    route: ProviderRoute,
    body: Arc<Vec<u8>>,
    /// The body's `delivery_id`, also stamped as the Core-only delivery header.
    delivery_id: Arc<str>,
}

#[derive(Default)]
struct SubscriberQueue {
    items: Mutex<VecDeque<Delivery>>,
    draining: AtomicBool,
}

struct Inner {
    manager: Arc<SidecarManager>,
    manifests: Arc<tokio::sync::RwLock<Vec<PluginManifest>>>,
    store: PluginStore,
    kernel_events: &'static [KernelEventSpec],
    queues: Mutex<HashMap<SubscriberKey, Arc<SubscriberQueue>>>,
    permits: Semaphore,
    capacity: usize,
    retry_delay: Duration,
    dropped: AtomicU64,
    delivered: AtomicU64,
}

/// Core's sidecar event fan-out. Cheap to clone.
#[derive(Clone)]
pub struct EventFanout {
    inner: Arc<Inner>,
}

impl EventFanout {
    #[must_use]
    pub fn new(
        manager: Arc<SidecarManager>,
        manifests: Arc<tokio::sync::RwLock<Vec<PluginManifest>>>,
        store: PluginStore,
    ) -> Self {
        Self::with_limits(
            manager,
            manifests,
            store,
            KERNEL_EVENTS,
            QUEUE_CAPACITY,
            RETRY_DELAY,
        )
    }

    fn with_limits(
        manager: Arc<SidecarManager>,
        manifests: Arc<tokio::sync::RwLock<Vec<PluginManifest>>>,
        store: PluginStore,
        kernel_events: &'static [KernelEventSpec],
        capacity: usize,
        retry_delay: Duration,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                manager,
                manifests,
                store,
                kernel_events,
                queues: Mutex::new(HashMap::new()),
                permits: Semaphore::new(MAX_CONCURRENT_DELIVERIES),
                capacity: capacity.max(1),
                retry_delay,
                dropped: AtomicU64::new(0),
                delivered: AtomicU64::new(0),
            }),
        }
    }

    /// Build from the server state's own manager, manifest set, and plugin store.
    #[must_use]
    pub fn from_state(state: &crate::server::ServerState) -> Self {
        Self::new(
            Arc::clone(&state.manager),
            Arc::clone(&state.app_manifests),
            state.app_store.clone(),
        )
    }

    /// Fan `event` out to its sidecar subscribers. Never blocks and never fails:
    /// resolution and delivery run on a detached task. The caller must already have
    /// authorized the emit (the `events.emit` ownership gate, or
    /// [`emit_kernel_event`]'s allowlist).
    pub fn publish(&self, event: &str, payload: Value) {
        let this = self.clone();
        let event = event.to_owned();
        tokio::spawn(async move {
            this.enqueue(&event, payload).await;
        });
    }

    /// Resolve `event`'s current subscribers and queue one delivery for each.
    /// Returns how many were queued.
    async fn enqueue(&self, event: &str, payload: Value) -> usize {
        let approved: HashMap<String, Vec<String>> = match self.inner.store.list().await {
            Ok(records) => records
                .into_iter()
                .filter(|r| r.enabled)
                .map(|r| (r.id, r.approved_grants))
                .collect(),
            Err(e) => {
                tracing::warn!(event, "event fan-out: could not list plugins: {e}");
                return 0;
            }
        };
        let targets: Vec<(SubscriberKey, ProviderRoute)> = {
            let manifests = self.inner.manifests.read().await;
            subscribers_for(event, &manifests, &approved, self.inner.kernel_events)
                .into_iter()
                .filter_map(|key| {
                    let manifest = manifests.iter().find(|m| m.id == key.plugin_id)?;
                    let entry = ProvidesEntry {
                        sidecar: Some(key.sidecar.clone()),
                        route: Some(key.route.clone()),
                        ..Default::default()
                    };
                    let route = resolve_provider_route(manifest, &entry, &manifest.id).ok()?;
                    Some((key, route))
                })
                .collect()
        };
        if targets.is_empty() {
            return 0;
        }
        let delivery_id: Arc<str> = Arc::from(uuid::Uuid::new_v4().to_string());
        let body = Arc::new(
            serde_json::to_vec(&json!({
                "event": event,
                "payload": payload,
                "emitted_at": chrono::Utc::now().to_rfc3339(),
                "delivery_id": &*delivery_id,
            }))
            .unwrap_or_default(),
        );
        let event: Arc<str> = Arc::from(event);
        let queued = targets.len();
        for (key, route) in targets {
            self.push(
                key,
                Delivery {
                    event: Arc::clone(&event),
                    route,
                    body: Arc::clone(&body),
                    delivery_id: Arc::clone(&delivery_id),
                },
            );
        }
        queued
    }

    /// Append to the subscriber's bounded queue (dropping the oldest when full) and
    /// make sure exactly one drain task is running for it.
    fn push(&self, key: SubscriberKey, delivery: Delivery) {
        let queue = {
            let mut queues = self.inner.queues.lock().expect("fan-out queue map");
            Arc::clone(queues.entry(key.clone()).or_default())
        };
        {
            let mut items = queue.items.lock().expect("fan-out queue");
            if items.len() >= self.inner.capacity {
                if let Some(old) = items.pop_front() {
                    self.inner.dropped.fetch_add(1, Ordering::Relaxed);
                    tracing::warn!(
                        subscriber = %key.plugin_id,
                        route = %key.route,
                        dropped_event = %old.event,
                        capacity = self.inner.capacity,
                        "event fan-out: subscriber queue full; dropped the oldest delivery"
                    );
                }
            }
            items.push_back(delivery);
        }
        if !queue.draining.swap(true, Ordering::AcqRel) {
            let this = self.clone();
            tokio::spawn(async move { this.drain(key, queue).await });
        }
    }

    /// Deliver a subscriber's queue in order until it is empty.
    async fn drain(&self, key: SubscriberKey, queue: Arc<SubscriberQueue>) {
        loop {
            let next = queue.items.lock().expect("fan-out queue").pop_front();
            let Some(delivery) = next else {
                queue.draining.store(false, Ordering::Release);
                // A push may have landed between the empty pop and the flag reset;
                // reclaim the drain role if so, otherwise stop.
                let refilled = !queue.items.lock().expect("fan-out queue").is_empty();
                if refilled && !queue.draining.swap(true, Ordering::AcqRel) {
                    continue;
                }
                return;
            };
            let Ok(_permit) = self.inner.permits.acquire().await else {
                return;
            };
            self.deliver(&key, &delivery).await;
        }
    }

    /// One delivery with at most one retry for a transient failure.
    async fn deliver(&self, key: &SubscriberKey, delivery: &Delivery) {
        for attempt in 0..2 {
            match self.attempt(delivery).await {
                Ok(()) => {
                    self.inner.delivered.fetch_add(1, Ordering::Relaxed);
                    return;
                }
                Err(Failure::Rejected(status)) => {
                    tracing::warn!(
                        subscriber = %key.plugin_id,
                        route = %key.route,
                        event = %delivery.event,
                        status,
                        "event fan-out: subscriber rejected the delivery"
                    );
                    return;
                }
                Err(Failure::Transient(reason)) => {
                    if attempt == 0 {
                        tokio::time::sleep(self.inner.retry_delay).await;
                        continue;
                    }
                    tracing::warn!(
                        subscriber = %key.plugin_id,
                        route = %key.route,
                        event = %delivery.event,
                        "event fan-out: delivery failed after one retry: {reason}"
                    );
                }
            }
        }
    }

    async fn attempt(&self, delivery: &Delivery) -> Result<(), Failure> {
        let (target, _activity) = provider_target(&self.inner.manager, &delivery.route)
            .await
            .map_err(Failure::Transient)?;
        let response = post_event_delivery(
            target,
            &delivery.route,
            delivery.body.to_vec(),
            &delivery.delivery_id,
        )
        .await;
        let status = response.status();
        if status.is_success() {
            Ok(())
        } else if status.is_server_error() {
            Err(Failure::Transient(format!("HTTP {}", status.as_u16())))
        } else {
            Err(Failure::Rejected(status.as_u16()))
        }
    }

    /// Deliveries dropped because a subscriber queue was full (diagnostics/tests).
    #[must_use]
    pub fn dropped_total(&self) -> u64 {
        self.inner.dropped.load(Ordering::Relaxed)
    }

    /// Deliveries a subscriber accepted (diagnostics/tests).
    #[must_use]
    pub fn delivered_total(&self) -> u64 {
        self.inner.delivered.load(Ordering::Relaxed)
    }
}

enum Failure {
    /// Unreachable, not registered, or 5xx: retried once.
    Transient(String),
    /// A 4xx: the subscriber's own verdict, not retried.
    Rejected(u16),
}

/// The subscriptions `event` should be delivered to right now: enabled subscribers
/// only (`approved` maps each ENABLED plugin id to its Gateway-approved grants),
/// with the load-time ownership rule re-checked and a kernel event's grant required
/// as declared ∩ approved. Pure, so the gate is unit-testable.
#[must_use]
pub fn subscribers_for(
    event: &str,
    manifests: &[PluginManifest],
    approved: &HashMap<String, Vec<String>>,
    kernel_events: &[KernelEventSpec],
) -> Vec<SubscriberKey> {
    let Some((owner, _)) = crate::plugin_manifest::split_hook_event_id(event) else {
        return Vec::new();
    };
    let kernel = if owner == KERNEL_EVENT_OWNER {
        match kernel_event_in(kernel_events, event) {
            Some(spec) => Some(spec),
            None => return Vec::new(),
        }
    } else {
        None
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for manifest in manifests {
        let Some(grants) = approved.get(&manifest.id) else {
            continue;
        };
        if kernel.is_none() && owner != manifest.id {
            continue;
        }
        if let Some(grant) = kernel.and_then(|spec| spec.grant) {
            let held = manifest.approved_permission_grants(grants);
            if !held.iter().any(|g| g == grant) {
                tracing::debug!(
                    subscriber = %manifest.id,
                    event,
                    grant,
                    "event fan-out: subscriber lacks the kernel event's grant; skipped"
                );
                continue;
            }
        }
        for sub in manifest.subscribes.iter().filter(|s| s.event == event) {
            let key = SubscriberKey {
                plugin_id: manifest.id.clone(),
                sidecar: sub.sidecar.clone(),
                route: sub.route.clone(),
            };
            if seen.insert(key.clone()) {
                out.push(key);
            }
        }
    }
    out
}

static GLOBAL: OnceLock<EventFanout> = OnceLock::new();

/// Install the process-wide fan-out (once, at startup).
pub fn install_global(fanout: EventFanout) {
    let _ = GLOBAL.set(fanout);
}

/// The process-wide fan-out, when Core installed one.
#[must_use]
pub fn global() -> Option<&'static EventFanout> {
    GLOBAL.get()
}

/// Why [`emit_kernel_event`] refused an emit.
#[derive(Debug, PartialEq, Eq)]
pub enum KernelEmitError {
    /// The id is not `core#<name>` on the reviewed allowlist.
    NotAllowlisted(String),
    /// The payload exceeds the app-event size cap.
    TooLarge(usize),
}

impl std::fmt::Display for KernelEmitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAllowlisted(id) => write!(f, "'{id}' is not an allowlisted kernel event"),
            Self::TooLarge(n) => write!(f, "kernel event payload too large ({n} bytes)"),
        }
    }
}

impl std::error::Error for KernelEmitError {}

/// Raise a **kernel event** (`core#<name>`) from inside Core: validated against the
/// reviewed allowlist and the size cap, then published to its sidecar subscribers.
/// Never blocks on a subscriber. A node with no installed fan-out (early boot, some
/// tests) accepts and drops the event.
///
/// The only caller-facing Core emit API for kernel events; nothing else can raise a
/// `core#` id (the `events.emit` capability refuses them).
///
/// # Errors
/// [`KernelEmitError`] when the id is not allowlisted or the payload is too large.
/// Production caller: [`crate::run_failures`] (`core#run.failed`).
pub fn emit_kernel_event(event: &str, payload: Value) -> Result<(), KernelEmitError> {
    let fanout = global();
    #[cfg(test)]
    let captured = payload.clone();
    emit_kernel_event_with(fanout, KERNEL_EVENTS, event, payload)?;
    #[cfg(test)]
    test_capture::record(event, captured);
    Ok(())
}

/// Test-only record of every kernel event [`emit_kernel_event`] accepted, so a
/// failure source can be asserted to raise its event without a running fan-out.
/// Tests share the process, so each filters on its own unique `source_id`.
#[cfg(test)]
pub(crate) mod test_capture {
    use serde_json::Value;
    use std::sync::Mutex;

    static EMITTED: Mutex<Vec<(String, Value)>> = Mutex::new(Vec::new());

    pub(super) fn record(event: &str, payload: Value) {
        EMITTED
            .lock()
            .expect("kernel-event capture")
            .push((event.to_owned(), payload));
    }

    /// The `core#run.failed` payloads accepted for `source_id`.
    pub(crate) fn emitted_for(source_id: &str) -> Vec<Value> {
        EMITTED
            .lock()
            .expect("kernel-event capture")
            .iter()
            .filter(|(event, payload)| {
                event == crate::run_failures::RUN_FAILED_EVENT && payload["source_id"] == source_id
            })
            .map(|(_, payload)| payload.clone())
            .collect()
    }
}

fn emit_kernel_event_with(
    fanout: Option<&EventFanout>,
    table: &[KernelEventSpec],
    event: &str,
    payload: Value,
) -> Result<(), KernelEmitError> {
    if kernel_event_in(table, event).is_none() {
        return Err(KernelEmitError::NotAllowlisted(event.to_owned()));
    }
    let size = serde_json::to_vec(&payload).map_or(0, |v| v.len());
    if size > crate::plugin_host::MAX_EVENT_PAYLOAD_BYTES {
        return Err(KernelEmitError::TooLarge(size));
    }
    if let Some(fanout) = fanout {
        fanout.publish(event, payload);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_manifest::{Contributes, EventSubscription, HookEventContribution};
    use crate::sidecar::capability_consumer::test_support::{
        expected_bearer, fixture_manifest, register_fixture_sidecar, reserve_port, serve,
        FIXTURE_ID,
    };
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::post;
    use axum::{Json, Router};
    use std::sync::atomic::AtomicUsize;

    const EVENT: &str = "com.example.fixture-provider#thing.done";
    const KERNEL: &str = "core#node.ready";
    const FIXTURE_KERNEL_EVENTS: &[KernelEventSpec] = &[
        KernelEventSpec {
            name: "node.ready",
            title: "Node ready",
            description: "fixture: no user data",
            grant: None,
        },
        KernelEventSpec {
            name: "thing.failed",
            title: "Thing failed",
            description: "fixture: carries user data",
            grant: Some("fixture:read"),
        },
    ];

    fn subscriber_manifest(port: u16, events: &[&str], grants: &[&str]) -> PluginManifest {
        let mut m = fixture_manifest(port, &[("fixture.sink", Some("/events"))]);
        m.provides.clear();
        m.permission_grants = grants.iter().map(|g| (*g).to_owned()).collect();
        m.contributes = Some(Contributes {
            hook_events: vec![HookEventContribution {
                id: EVENT.to_owned(),
                title: "Thing done".to_owned(),
                description: None,
                payload_example: None,
            }],
            ..Default::default()
        });
        m.subscribes = events
            .iter()
            .map(|event| EventSubscription {
                event: (*event).to_owned(),
                sidecar: "engine".to_owned(),
                route: "/events".to_owned(),
            })
            .collect();
        m
    }

    async fn fanout_for(
        manifest: PluginManifest,
        enabled: bool,
        grants: &[&str],
        capacity: usize,
    ) -> (EventFanout, Arc<SidecarManager>) {
        let store = PluginStore::open_in_memory().unwrap();
        store.insert(FIXTURE_ID, "1.0.0").await.unwrap();
        if enabled {
            let grants: Vec<String> = grants.iter().map(|g| (*g).to_owned()).collect();
            store.set_enabled(FIXTURE_ID, &grants).await.unwrap();
        }
        let manager = SidecarManager::new_noop();
        let fanout = EventFanout::with_limits(
            Arc::clone(&manager),
            Arc::new(tokio::sync::RwLock::new(vec![manifest])),
            store,
            FIXTURE_KERNEL_EVENTS,
            capacity,
            Duration::from_millis(20),
        );
        (fanout, manager)
    }

    async fn wait_until(mut done: impl FnMut() -> bool) {
        for _ in 0..200 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("condition never became true");
    }

    fn approved(grants: &[&str]) -> HashMap<String, Vec<String>> {
        HashMap::from([(
            FIXTURE_ID.to_owned(),
            grants.iter().map(|g| (*g).to_owned()).collect(),
        )])
    }

    #[test]
    fn subscribers_gate_on_enabled_ownership_and_kernel_grants() {
        let own = subscriber_manifest(1, &[EVENT], &[]);
        assert_eq!(
            subscribers_for(EVENT, &[own.clone()], &approved(&[]), FIXTURE_KERNEL_EVENTS).len(),
            1
        );
        // Disabled (absent from the enabled map) ⇒ skipped.
        assert!(subscribers_for(
            EVENT,
            &[own.clone()],
            &HashMap::new(),
            FIXTURE_KERNEL_EVENTS
        )
        .is_empty());
        // A foreign app's event is never delivered, even if a manifest names it.
        let mut foreign = own.clone();
        foreign.subscribes[0].event = "@other/app#thing.done".to_owned();
        assert!(subscribers_for(
            "@other/app#thing.done",
            &[foreign],
            &approved(&[]),
            FIXTURE_KERNEL_EVENTS
        )
        .is_empty());
        // Kernel events: unknown ⇒ nobody; no-user-data ⇒ no grant needed;
        // user-data ⇒ declared ∩ approved grant required.
        let k = subscriber_manifest(1, &[KERNEL, "core#thing.failed"], &["fixture:read"]);
        assert!(subscribers_for(
            "core#nope",
            &[k.clone()],
            &approved(&[]),
            FIXTURE_KERNEL_EVENTS
        )
        .is_empty());
        assert_eq!(
            subscribers_for(KERNEL, &[k.clone()], &approved(&[]), FIXTURE_KERNEL_EVENTS).len(),
            1
        );
        assert!(subscribers_for(
            "core#thing.failed",
            &[k.clone()],
            &approved(&[]),
            FIXTURE_KERNEL_EVENTS
        )
        .is_empty());
        assert_eq!(
            subscribers_for(
                "core#thing.failed",
                &[k],
                &approved(&["fixture:read"]),
                FIXTURE_KERNEL_EVENTS
            )
            .len(),
            1
        );
    }

    #[tokio::test]
    async fn delivers_to_an_enabled_subscriber_with_its_own_token() {
        let port = reserve_port();
        let (fanout, manager) =
            fanout_for(subscriber_manifest(port, &[EVENT], &[]), true, &[], 8).await;
        register_fixture_sidecar(&manager, port).await;
        let seen = Arc::new(Mutex::new(Vec::<(String, Option<String>, Value)>::new()));
        let sink = Arc::clone(&seen);
        let app = Router::new().route(
            "/api/fixture/events",
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let sink = Arc::clone(&sink);
                async move {
                    let header = |name: &str| {
                        headers
                            .get(name)
                            .and_then(|v| v.to_str().ok())
                            .map(str::to_owned)
                    };
                    let bearer = header("authorization").unwrap_or_default();
                    let marker = header(crate::sidecar::ext_proxy::HDR_EVENT_DELIVERY);
                    sink.lock().unwrap().push((bearer, marker, body));
                    StatusCode::NO_CONTENT
                }
            }),
        );
        let _server = serve(port, app).await;

        fanout.publish(EVENT, json!({ "id": 7 }));
        wait_until(|| !seen.lock().unwrap().is_empty()).await;
        let (bearer, marker, body) = seen.lock().unwrap()[0].clone();
        assert_eq!(bearer, expected_bearer());
        assert_eq!(body["event"], EVENT);
        assert_eq!(body["payload"], json!({ "id": 7 }));
        assert!(body["emitted_at"].is_string() && body["delivery_id"].is_string());
        // Core marks its own delivery with the delivery id, which no proxied
        // caller can supply.
        assert_eq!(marker.as_deref(), body["delivery_id"].as_str());
        wait_until(|| fanout.delivered_total() == 1).await;
    }

    #[tokio::test]
    async fn skips_a_disabled_subscriber() {
        let port = reserve_port();
        let (fanout, _manager) =
            fanout_for(subscriber_manifest(port, &[EVENT], &[]), false, &[], 8).await;
        assert_eq!(fanout.enqueue(EVENT, json!({})).await, 0);
    }

    #[tokio::test]
    async fn a_failing_subscriber_is_retried_once_and_never_blocks_the_emitter() {
        let port = reserve_port();
        let (fanout, manager) =
            fanout_for(subscriber_manifest(port, &[EVENT], &[]), true, &[], 8).await;
        register_fixture_sidecar(&manager, port).await;
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&hits);
        let app = Router::new().route(
            "/api/fixture/events",
            post(move || {
                let counter = Arc::clone(&counter);
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    // Slow AND failing.
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    StatusCode::INTERNAL_SERVER_ERROR
                }
            }),
        );
        let _server = serve(port, app).await;

        let started = std::time::Instant::now();
        fanout.publish(EVENT, json!({}));
        assert!(
            started.elapsed() < Duration::from_millis(50),
            "publish must return without awaiting any subscriber"
        );
        wait_until(|| hits.load(Ordering::SeqCst) == 2).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(hits.load(Ordering::SeqCst), 2, "exactly one retry");
        assert_eq!(fanout.delivered_total(), 0);
    }

    #[tokio::test]
    async fn a_full_queue_drops_the_oldest_delivery() {
        let port = reserve_port();
        let (fanout, manager) =
            fanout_for(subscriber_manifest(port, &[EVENT], &[]), true, &[], 2).await;
        register_fixture_sidecar(&manager, port).await;
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let received = Arc::new(Mutex::new(Vec::<i64>::new()));
        let (g, r) = (Arc::clone(&gate), Arc::clone(&received));
        let app = Router::new().route(
            "/api/fixture/events",
            post(move |Json(body): Json<Value>| {
                let (g, r) = (Arc::clone(&g), Arc::clone(&r));
                async move {
                    g.acquire().await.unwrap().forget();
                    r.lock()
                        .unwrap()
                        .push(body["payload"]["n"].as_i64().unwrap());
                    StatusCode::OK
                }
            }),
        );
        let _server = serve(port, app).await;

        // The first delivery goes in flight and blocks; the next five contend for
        // a two-slot queue, so three of them must be dropped (oldest first).
        assert_eq!(fanout.enqueue(EVENT, json!({ "n": 0 })).await, 1);
        tokio::time::sleep(Duration::from_millis(100)).await;
        for n in 1..=5 {
            fanout.enqueue(EVENT, json!({ "n": n })).await;
        }
        assert_eq!(fanout.dropped_total(), 3);
        gate.add_permits(16);
        wait_until(|| received.lock().unwrap().len() == 3).await;
        assert_eq!(*received.lock().unwrap(), vec![0, 4, 5]);
    }

    #[tokio::test]
    async fn kernel_emit_is_allowlist_only() {
        let port = reserve_port();
        let (fanout, _manager) =
            fanout_for(subscriber_manifest(port, &[KERNEL], &[]), true, &[], 8).await;
        assert_eq!(
            emit_kernel_event_with(Some(&fanout), FIXTURE_KERNEL_EVENTS, "core#nope", json!({})),
            Err(KernelEmitError::NotAllowlisted("core#nope".to_owned()))
        );
        // An app event can never be raised through the kernel API.
        assert!(matches!(
            emit_kernel_event_with(Some(&fanout), FIXTURE_KERNEL_EVENTS, EVENT, json!({})),
            Err(KernelEmitError::NotAllowlisted(_))
        ));
        let big = json!({ "x": "a".repeat(crate::plugin_host::MAX_EVENT_PAYLOAD_BYTES) });
        assert!(matches!(
            emit_kernel_event_with(Some(&fanout), FIXTURE_KERNEL_EVENTS, KERNEL, big),
            Err(KernelEmitError::TooLarge(_))
        ));
        assert_eq!(
            emit_kernel_event_with(Some(&fanout), FIXTURE_KERNEL_EVENTS, KERNEL, json!({})),
            Ok(())
        );
        assert_eq!(fanout.enqueue(KERNEL, json!({})).await, 1);
        // The fixture-only event is not on the production allowlist.
        assert!(emit_kernel_event(KERNEL, json!({})).is_err());
    }

    /// The real `core#run.failed` row against the real Self-Healing manifest: it
    /// subscribes the `ryu-healing` sidecar's `/report-failure`, and delivery
    /// requires the app to be enabled AND to hold the approved `runs:failures`.
    #[test]
    fn run_failed_reaches_healing_only_when_enabled_and_granted() {
        let healing: PluginManifest =
            serde_json::from_str(include_str!("../../../../generated/ryu-runtime/apps-store/healing/manifest.json"))
                .expect("healing manifest parses");
        healing
            .validate_event_subscriptions(KERNEL_EVENTS)
            .expect("healing's subscription is valid");
        let event = crate::run_failures::RUN_FAILED_EVENT;
        let manifests = [healing.clone()];
        let grants_only = |grants: &[&str]| {
            HashMap::from([(
                healing.id.clone(),
                grants.iter().map(|g| (*g).to_owned()).collect::<Vec<_>>(),
            )])
        };
        // Disabled (absent from the enabled map): nobody.
        assert!(subscribers_for(event, &manifests, &HashMap::new(), KERNEL_EVENTS).is_empty());
        // Enabled, but `runs:failures` not approved: nobody.
        assert!(subscribers_for(
            event,
            &manifests,
            &grants_only(&["approvals:request"]),
            KERNEL_EVENTS
        )
        .is_empty());
        // Enabled and approved: exactly the declared route.
        assert_eq!(
            subscribers_for(
                event,
                &manifests,
                &grants_only(&[ryu_kernel_contracts::RUNS_FAILURES_GRANT]),
                KERNEL_EVENTS
            ),
            vec![SubscriberKey {
                plugin_id: "@ryu/healing".to_owned(),
                sidecar: "ryu-healing".to_owned(),
                route: "/report-failure".to_owned(),
            }]
        );
        // A manifest that subscribes but never declared the grant gets nothing
        // even when the store claims it was approved.
        let mut undeclared = healing.clone();
        undeclared
            .permission_grants
            .retain(|g| g != ryu_kernel_contracts::RUNS_FAILURES_GRANT);
        assert!(subscribers_for(
            event,
            &[undeclared],
            &grants_only(&[ryu_kernel_contracts::RUNS_FAILURES_GRANT]),
            KERNEL_EVENTS
        )
        .is_empty());
    }

    /// A disabled subscriber: the emit is accepted (no error reaches the failing
    /// run) and nothing is queued.
    #[tokio::test]
    async fn run_failed_with_a_disabled_subscriber_is_accepted_and_dropped() {
        let port = reserve_port();
        let manifest = subscriber_manifest(
            port,
            &[crate::run_failures::RUN_FAILED_EVENT],
            &[ryu_kernel_contracts::RUNS_FAILURES_GRANT],
        );
        let store = PluginStore::open_in_memory().unwrap();
        store.insert(FIXTURE_ID, "1.0.0").await.unwrap();
        let fanout = EventFanout::with_limits(
            SidecarManager::new_noop(),
            Arc::new(tokio::sync::RwLock::new(vec![manifest])),
            store,
            KERNEL_EVENTS,
            8,
            Duration::from_millis(20),
        );
        let payload = crate::run_failures::run_failed_payload(
            "conv-x",
            &crate::run_failures::FailedRun::Workflow,
            "i",
            "f",
        );
        assert_eq!(
            emit_kernel_event_with(
                Some(&fanout),
                KERNEL_EVENTS,
                crate::run_failures::RUN_FAILED_EVENT,
                payload.clone()
            ),
            Ok(())
        );
        assert_eq!(
            fanout
                .enqueue(crate::run_failures::RUN_FAILED_EVENT, payload)
                .await,
            0
        );
    }
}
