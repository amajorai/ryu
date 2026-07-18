//! Room-keyed realtime primitive (Phase 1 of the multi-user collaboration epic).
//!
//! This module is the transport-agnostic fan-out core that chat fan-out,
//! CRDT doc-sync (Phase 3), and presence/awareness all consume. It is a sibling
//! to Core's `identity_verify` (the USER-identity layer) and intentionally
//! knows nothing about WebSockets, JWTs, or access control — those live in the
//! WS handler (stage 2/3) that drives this registry.
//!
//! ## Shape
//!
//! - A [`RoomRegistry`] maps `room_id` -> a [`RoomHandle`]. Each live room runs
//!   as ONE tokio actor task ([`run_room`]) that owns the room's ephemeral state
//!   (presence map + idle clock) behind a command channel, plus a
//!   [`tokio::sync::broadcast`] sender for fan-out to every joined member.
//! - Membership is reference-counted via an [`AtomicUsize`] shared between the
//!   handle and the actor. [`RoomHandle::join`] returns a [`RoomMembership`]
//!   RAII guard whose `Drop` decrements the count, evicts the member's presence,
//!   and broadcasts a `presence_leave` delta — so a client that drops its socket
//!   without a clean leave is still reaped.
//! - **Hibernation** is the single biggest scaling lever: a room that has had
//!   zero members for longer than [`RoomConfig::idle_window`] exits its actor and
//!   is removed from the registry (rehydrated on the next join). Evictions are
//!   logged.
//!
//! ## Race safety (membership vs eviction)
//!
//! Concurrent callers MUST join via [`RoomRegistry::join`], whose get-or-create
//! and `fetch_add` both run while holding the registry `Mutex`. The actor's
//! eviction recheck ([`try_evict`]) takes that same lock, so the two serialize:
//! either `join` wins (eviction then sees members > 0 and skips) or eviction wins
//! (removes the entry and exits; `join` transparently re-creates a fresh room).
//! There is no window in which a caller ends up holding a handle to a room the
//! registry has dropped.
//!
//! The lower-level [`RoomRegistry::get_or_create`] + [`RoomHandle::join`] two-step
//! is NOT race-safe against eviction (the increment happens outside the lock) and
//! exists only for single-threaded tests with controlled lifecycles.
//!
//! ## Channels
//!
//! A [`Frame`] carries a [`RealtimeChannel`] tag. `Events` and `Presence` carry
//! `serde_json::Value` (JSON text on the wire); `DocSync` carries opaque
//! `Vec<u8>` that passes through untouched (reserved for Phase 3 — accept and
//! relay binary without interpreting it).
//!
//! Presence is NEVER persisted: it lives only in the actor's in-memory map with a
//! heartbeat TTL, and vanishes when the room hibernates.
//!
//! Staging note: stage 1 builds the primitive with unit tests. Wiring into
//! `ServerState`, the `GET /api/realtime/ws` route, and `append_message` fan-out
//! happens in stages 2/3, so several items are intentionally unused for now.
#![allow(dead_code)]

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex, Weak,
    },
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc, oneshot};

/// How long a room may have zero members before its actor exits and the registry
/// entry is dropped (rehydrated on next join). The single biggest scaling lever.
const DEFAULT_IDLE_WINDOW: Duration = Duration::from_secs(5 * 60);

/// How long a presence entry survives without a heartbeat before the reaper
/// evicts it and broadcasts a `presence_leave` delta. A client is expected to
/// re-publish its presence well within this window.
const DEFAULT_PRESENCE_TTL: Duration = Duration::from_secs(30);

/// How often the per-room actor wakes to reap stale presence and re-evaluate
/// hibernation. Keep well below both TTLs so reaping is timely.
const DEFAULT_SWEEP_INTERVAL: Duration = Duration::from_secs(10);

/// Bounded fan-out buffer per room. A slow consumer that overflows this gets a
/// `RecvError::Lagged` and must resync — backpressure is a client concern.
const BROADCAST_CAPACITY: usize = 256;

// ── Frame envelope ───────────────────────────────────────────────────────────

/// The logical channel a [`Frame`] travels on. `DocSync` is reserved for Phase 3
/// CRDT sync and is relayed opaquely for now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RealtimeChannel {
    /// Durable-ish app events (e.g. a new chat message). JSON payload.
    Events,
    /// Ephemeral awareness (cursor / typing / name / color). JSON payload, never
    /// persisted.
    Presence,
    /// Opaque binary CRDT updates (Phase 3). Passed through untouched.
    DocSync,
}

/// One fan-out frame. `Event`/`Presence` carry JSON; `DocSync` carries opaque
/// bytes so binary CRDT updates pass through without interpretation. Clone is
/// cheap-ish (Value/Vec share via the broadcast clone on each receiver).
#[derive(Debug, Clone)]
pub enum Frame {
    Event(Value),
    Presence(Value),
    DocSync(Vec<u8>),
}

impl Frame {
    /// The channel tag for this frame.
    pub fn channel(&self) -> RealtimeChannel {
        match self {
            Frame::Event(_) => RealtimeChannel::Events,
            Frame::Presence(_) => RealtimeChannel::Presence,
            Frame::DocSync(_) => RealtimeChannel::DocSync,
        }
    }
}

// ── Typed named events (the Rivet-style event contract) ──────────────────────
//
// This layer sits *on top of* the [`Frame`] wire, not beside it: a named event is
// encoded as a self-describing envelope carried on the ordinary `Frame::Event`
// channel, so every existing consumer (the `frame_to_message` bridge, the DocSync
// relay, raw `subscribe()` receivers) keeps working byte-for-byte. Callers that
// opt into the typed contract publish/subscribe *by event name* instead of matching
// an opaque `Frame`, mirroring Rivet actors' `broadcast(event, payload)` /
// `conn.send(event, payload)` / `actor.on(event, …)` shape
// (rivet.dev/docs/actors/events). Targeted `send_event` never rides the shared
// broadcast — it takes a per-connection channel — so it is invisible to raw
// broadcast subscribers and to other connections.

/// Envelope key carrying the event name inside a `Frame::Event` value.
const EVENT_NAME_KEY: &str = "__ryu_event";
/// Envelope key carrying the event payload inside a `Frame::Event` value.
const EVENT_DATA_KEY: &str = "data";

/// Process-global source of [`ConnId`]s. Global (not per-room) so an id is unique
/// for the life of the process: a room that hibernates and rehydrates can never
/// reissue an id a stale holder still targets, so a late `send_event` can only ever
/// address the connection it was minted for (and no-op if that connection is gone).
static NEXT_CONN_ID: AtomicU64 = AtomicU64::new(1);

/// Opaque, process-unique identity for one subscriber [`Connection`]. The address
/// a targeted [`RoomHandle::send_event`] delivers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ConnId(u64);

impl ConnId {
    fn next() -> Self {
        Self(NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed))
    }

    /// The raw numeric id (diagnostics / stable wire identity).
    pub fn get(self) -> u64 {
        self.0
    }
}

/// A decoded typed room event: a name plus its JSON payload. Produced by
/// [`Connection::recv`] from an enveloped `Frame::Event`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    /// The event name the publisher broadcast/sent under.
    pub name: String,
    /// The event's JSON payload (`Value::Null` if the publisher sent none).
    pub payload: Value,
}

impl Event {
    /// Decode a frame into a typed event, or `None` if the frame is not a named
    /// event envelope (a presence delta, a DocSync blob, or a raw `publish_event`
    /// value with no envelope). Non-events are skipped by the typed reader, never
    /// surfaced as bogus zero-name events.
    ///
    /// Public so a consumer that subscribes to the *raw* [`Frame`] stream (because it
    /// must also relay presence/DocSync frames the typed [`Connection`] skips) can
    /// still recognise and unwrap typed named events off the shared broadcast — the
    /// WS gateway's fan-out path is exactly such a consumer.
    pub fn decode(frame: &Frame) -> Option<Event> {
        let Frame::Event(value) = frame else {
            return None;
        };
        let name = value.get(EVENT_NAME_KEY)?.as_str()?.to_string();
        let payload = value.get(EVENT_DATA_KEY).cloned().unwrap_or(Value::Null);
        Some(Event { name, payload })
    }
}

/// Encode a named event as its `Frame::Event` envelope value.
fn encode_event(name: impl Into<String>, payload: Value) -> Value {
    let mut map = serde_json::Map::with_capacity(2);
    map.insert(EVENT_NAME_KEY.to_string(), Value::String(name.into()));
    map.insert(EVENT_DATA_KEY.to_string(), payload);
    Value::Object(map)
}

// ── Config ───────────────────────────────────────────────────────────────────

/// Tunables for room lifecycle. [`RoomConfig::default`] uses production values;
/// tests construct short windows via [`RoomRegistry::with_config`].
#[derive(Debug, Clone, Copy)]
pub struct RoomConfig {
    /// Zero-member duration after which a room hibernates.
    pub idle_window: Duration,
    /// Presence heartbeat TTL.
    pub presence_ttl: Duration,
    /// Actor sweep cadence (presence reaping + hibernation check).
    pub sweep_interval: Duration,
}

impl Default for RoomConfig {
    fn default() -> Self {
        Self {
            idle_window: DEFAULT_IDLE_WINDOW,
            presence_ttl: DEFAULT_PRESENCE_TTL,
            sweep_interval: DEFAULT_SWEEP_INTERVAL,
        }
    }
}

// ── Actor command protocol ───────────────────────────────────────────────────

/// Messages the registry/handles send to a room's actor task. Membership counting
/// is done via the shared atomic under the registry lock; these commands carry the
/// *side effects* (presence mutation, idle-clock updates, test queries).
enum RoomCommand {
    /// A member joined — clear the idle clock.
    Joined,
    /// A member left — decrement already happened on the atomic; drop its presence
    /// and broadcast a `presence_leave` delta, then arm the idle clock if empty.
    Left { member_id: String },
    /// Upsert a member's presence and broadcast the delta on the Presence channel.
    Presence { member_id: String, value: Value },
    /// Test/diagnostic: snapshot the live presence member ids.
    PresenceMembers { reply: oneshot::Sender<Vec<String>> },
    /// A typed [`Connection`] opened: register its private delivery channel so
    /// [`RoomCommand::SendTo`] can address it.
    OpenConn {
        conn_id: ConnId,
        tx: mpsc::UnboundedSender<Frame>,
    },
    /// A typed [`Connection`] dropped/closed (RAII): unregister its channel.
    CloseConn { conn_id: ConnId },
    /// Deliver `frame` to exactly one connection. No-op if that connection is gone;
    /// a dead channel is pruned on the failed send.
    SendTo { conn_id: ConnId, frame: Frame },
    /// Test/diagnostic: number of registered typed connections.
    ConnCount { reply: oneshot::Sender<usize> },
}

// ── Registry ─────────────────────────────────────────────────────────────────

type RoomMap = HashMap<String, RoomHandle>;

/// Process-shared registry of live rooms. Cheap to clone (it is an `Arc` bag) so
/// it can live in `ServerState` and be reached from handlers and `append_message`.
#[derive(Clone)]
pub struct RoomRegistry {
    inner: Arc<Mutex<RoomMap>>,
    config: RoomConfig,
}

impl RoomRegistry {
    /// A registry with production lifecycle tunables.
    pub fn new() -> Self {
        Self::with_config(RoomConfig::default())
    }

    /// A registry with custom lifecycle tunables (used by tests for short
    /// windows).
    pub fn with_config(config: RoomConfig) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            config,
        }
    }

    /// Get the handle for `room_id`, spawning the room's actor if it is not yet
    /// live. Idempotent: repeated calls for the same id return clones of the same
    /// handle (same broadcast sender + member counter) until the room hibernates.
    pub fn get_or_create(&self, room_id: &str) -> RoomHandle {
        let mut map = self.lock();
        if let Some(handle) = map.get(room_id) {
            return handle.clone();
        }
        let handle = self.spawn_room(room_id.to_string());
        map.insert(room_id.to_string(), handle.clone());
        handle
    }

    /// Join `room_id` as `member_id`, get-or-creating the room AND incrementing its
    /// member count **atomically under the registry lock**. This is the race-safe
    /// entry point that any concurrent caller (the WS gateway) must use instead of
    /// `get_or_create()` followed by [`RoomHandle::join`].
    ///
    /// Because [`try_evict`] rechecks the member count under this same lock, the
    /// increment can never be observed as zero in the gap between get-or-create and
    /// join. So a join racing an eviction has exactly two outcomes: the join takes
    /// the lock first (eviction then sees `members > 0` and aborts, keeping the
    /// existing room), or eviction takes it first (removes the entry and exits;
    /// this call then transparently spawns a fresh room). Neither outcome yields an
    /// orphaned handle whose actor is dead and whose registry entry is gone.
    pub fn join(&self, room_id: &str, member_id: impl Into<String>) -> RoomMembership {
        let mut map = self.lock();
        let handle = match map.get(room_id) {
            Some(handle) => handle.clone(),
            None => {
                let handle = self.spawn_room(room_id.to_string());
                map.insert(room_id.to_string(), handle.clone());
                handle
            }
        };
        // The whole point of this method: increment while the registry lock is
        // still held, so `try_evict`'s locked recheck serializes against it.
        handle.members.fetch_add(1, Ordering::SeqCst);
        drop(map);
        // Reset the actor's idle clock; done outside the lock (channel send only).
        let _ = handle.cmd.send(RoomCommand::Joined);
        RoomMembership {
            handle,
            member_id: member_id.into(),
            left: false,
        }
    }

    /// Publish an Events frame to `room_id`. No-op if the room is not live (no
    /// members are subscribed, so there is nothing to deliver and no reason to
    /// spin up an actor).
    pub fn publish_event(&self, room_id: &str, value: Value) {
        if let Some(handle) = self.lock().get(room_id) {
            let _ = handle.broadcast.send(Frame::Event(value));
        }
    }

    /// Publish a presence delta for `member_id` to `room_id`: stores it in the
    /// room's ephemeral map (so the heartbeat TTL applies) and broadcasts on the
    /// Presence channel. No-op if the room is not live.
    pub fn publish_presence(&self, room_id: &str, member_id: &str, value: Value) {
        if let Some(handle) = self.lock().get(room_id) {
            handle.publish_presence(member_id, value);
        }
    }

    /// Broadcast a typed named event to `room_id` (Rivet's `broadcast(event,
    /// payload)`). No-op if the room is not live — the registry-level twin of
    /// [`publish_event`], for callers holding only the registry.
    ///
    /// [`publish_event`]: RoomRegistry::publish_event
    pub fn broadcast_event(&self, room_id: &str, name: impl Into<String>, payload: Value) {
        if let Some(handle) = self.lock().get(room_id) {
            handle.broadcast_event(name, payload);
        }
    }

    /// Deliver a typed named event to one connection in `room_id` (Rivet's
    /// `conn.send(event, payload)`). No-op if the room is not live or the connection
    /// has closed.
    pub fn send_event(
        &self,
        room_id: &str,
        conn: ConnId,
        name: impl Into<String>,
        payload: Value,
    ) {
        if let Some(handle) = self.lock().get(room_id) {
            handle.send_event(conn, name, payload);
        }
    }

    /// Number of live (non-hibernated) rooms. Primarily for tests/diagnostics.
    pub fn room_count(&self) -> usize {
        self.lock().len()
    }

    /// Spawn a room actor and build its handle. Caller must hold the registry lock
    /// and insert the returned handle.
    fn spawn_room(&self, room_id: String) -> RoomHandle {
        let (broadcast_tx, _rx) = broadcast::channel(BROADCAST_CAPACITY);
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let members = Arc::new(AtomicUsize::new(0));

        let handle = RoomHandle {
            room_id: room_id.clone(),
            broadcast: broadcast_tx.clone(),
            cmd: cmd_tx,
            members: Arc::clone(&members),
        };

        let registry = Arc::downgrade(&self.inner);
        let config = self.config;
        tokio::spawn(run_room(
            room_id,
            members,
            broadcast_tx,
            cmd_rx,
            registry,
            config,
        ));

        handle
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, RoomMap> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Default for RoomRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ── Handle ───────────────────────────────────────────────────────────────────

/// A cloneable handle to a live room: the broadcast sender for fan-out, the
/// command channel to the actor, and the shared member counter. Obtained from
/// [`RoomRegistry::get_or_create`].
#[derive(Clone)]
pub struct RoomHandle {
    room_id: String,
    broadcast: broadcast::Sender<Frame>,
    cmd: mpsc::UnboundedSender<RoomCommand>,
    members: Arc<AtomicUsize>,
}

impl RoomHandle {
    /// The room id this handle addresses.
    pub fn room_id(&self) -> &str {
        &self.room_id
    }

    /// Subscribe to this room's fan-out. Multiple receivers are allowed; each sees
    /// every frame published after it subscribed.
    pub fn subscribe(&self) -> broadcast::Receiver<Frame> {
        self.broadcast.subscribe()
    }

    /// Current member count.
    pub fn member_count(&self) -> usize {
        self.members.load(Ordering::SeqCst)
    }

    /// Join this room as `member_id`, returning an RAII [`RoomMembership`] guard.
    /// Dropping the guard leaves the room.
    ///
    /// NOT race-safe against hibernation: the increment happens outside the
    /// registry lock, so a room that hibernated between obtaining this handle and
    /// this call yields an orphaned membership. Concurrent callers must use
    /// [`RoomRegistry::join`] instead; this method is for single-threaded tests.
    pub fn join(&self, member_id: impl Into<String>) -> RoomMembership {
        self.members.fetch_add(1, Ordering::SeqCst);
        let _ = self.cmd.send(RoomCommand::Joined);
        RoomMembership {
            handle: self.clone(),
            member_id: member_id.into(),
            left: false,
        }
    }

    /// Publish an Events frame to this room.
    pub fn publish_event(&self, value: Value) {
        let _ = self.broadcast.send(Frame::Event(value));
    }

    /// Publish a presence delta for `member_id` (upsert + TTL + broadcast).
    pub fn publish_presence(&self, member_id: &str, value: Value) {
        let _ = self.cmd.send(RoomCommand::Presence {
            member_id: member_id.to_string(),
            value,
        });
    }

    /// Publish an opaque DocSync (binary) frame, passed through untouched. Phase 3
    /// CRDT updates ride this channel.
    pub fn publish_doc_sync(&self, bytes: Vec<u8>) {
        let _ = self.broadcast.send(Frame::DocSync(bytes));
    }

    /// Broadcast a typed named event to **every** subscriber of this room (Rivet's
    /// `broadcast(event, payload)`). Rides the ordinary `Frame::Event` channel as an
    /// envelope, so raw `subscribe()` receivers still get it and typed
    /// [`Connection`]s decode it into an [`Event`].
    pub fn broadcast_event(&self, name: impl Into<String>, payload: Value) {
        let _ = self
            .broadcast
            .send(Frame::Event(encode_event(name, payload)));
    }

    /// Deliver a typed named event to exactly **one** connection (Rivet's
    /// `conn.send(event, payload)`). Unlike [`broadcast_event`], this never touches
    /// the shared broadcast, so no other connection and no raw broadcast subscriber
    /// observes it. No-op if `conn` has closed or the room actor has exited.
    ///
    /// [`broadcast_event`]: RoomHandle::broadcast_event
    pub fn send_event(&self, conn: ConnId, name: impl Into<String>, payload: Value) {
        let _ = self.cmd.send(RoomCommand::SendTo {
            conn_id: conn,
            frame: Frame::Event(encode_event(name, payload)),
        });
    }

    /// Open a typed subscriber [`Connection`] on this room: it receives both
    /// broadcasts and events addressed to its [`ConnId`] via [`send_event`], and
    /// unregisters itself on `Drop` (the RAII unsubscribe handle). Distinct from the
    /// raw [`subscribe`] receiver, which is broadcast-only and cannot be targeted.
    ///
    /// [`send_event`]: RoomHandle::send_event
    /// [`subscribe`]: RoomHandle::subscribe
    pub fn open_connection(&self) -> Connection {
        let conn_id = ConnId::next();
        let (tx, targeted_rx) = mpsc::unbounded_channel();
        let _ = self.cmd.send(RoomCommand::OpenConn { conn_id, tx });
        Connection {
            conn_id,
            cmd: self.cmd.clone(),
            broadcast_rx: self.broadcast.subscribe(),
            targeted_rx,
            broadcast_open: true,
            targeted_open: true,
        }
    }

    /// Snapshot the number of registered typed connections (diagnostic / test
    /// helper). Returns 0 if the actor has already exited.
    pub async fn conn_count(&self) -> usize {
        let (reply, rx) = oneshot::channel();
        if self.cmd.send(RoomCommand::ConnCount { reply }).is_err() {
            return 0;
        }
        rx.await.unwrap_or(0)
    }

    /// Snapshot the live presence member ids (diagnostic / test helper). Returns
    /// an empty vec if the actor has already exited.
    pub async fn presence_members(&self) -> Vec<String> {
        let (reply, rx) = oneshot::channel();
        if self
            .cmd
            .send(RoomCommand::PresenceMembers { reply })
            .is_err()
        {
            return Vec::new();
        }
        rx.await.unwrap_or_default()
    }
}

// ── Membership guard ─────────────────────────────────────────────────────────

/// RAII guard for one member's presence in a room. Created by
/// [`RoomHandle::join`]. On `Drop` (or explicit [`RoomMembership::leave`]) it
/// decrements the member count, evicts this member's presence, and broadcasts a
/// `presence_leave` delta — so an abrupt disconnect is still reaped.
pub struct RoomMembership {
    handle: RoomHandle,
    member_id: String,
    left: bool,
}

impl RoomMembership {
    /// The member id this guard represents.
    pub fn member_id(&self) -> &str {
        &self.member_id
    }

    /// The room this membership is in.
    pub fn handle(&self) -> &RoomHandle {
        &self.handle
    }

    /// Subscribe to the room's fan-out (each call yields a fresh receiver).
    pub fn subscribe(&self) -> broadcast::Receiver<Frame> {
        self.handle.subscribe()
    }

    /// Publish this member's presence (cursor/typing/etc.).
    pub fn publish_presence(&self, value: Value) {
        self.handle.publish_presence(&self.member_id, value);
    }

    /// Open a typed subscriber [`Connection`] on this member's room (convenience for
    /// [`RoomHandle::open_connection`]).
    pub fn open_connection(&self) -> Connection {
        self.handle.open_connection()
    }

    /// Explicitly leave now (idempotent; `Drop` also calls this).
    pub fn leave(&mut self) {
        if self.left {
            return;
        }
        self.left = true;
        self.handle.members.fetch_sub(1, Ordering::SeqCst);
        let _ = self.handle.cmd.send(RoomCommand::Left {
            member_id: self.member_id.clone(),
        });
    }
}

impl Drop for RoomMembership {
    fn drop(&mut self) {
        self.leave();
    }
}

// ── Typed connection (subscribe = unsubscribe-on-drop handle) ────────────────

/// A typed subscriber to one room, addressable by its [`ConnId`]. It merges the
/// room's broadcast fan-out with events [`RoomHandle::send_event`] delivers to it
/// privately, decoding each into a typed [`Event`]. Dropping it unregisters the
/// targeted channel from the room actor — the RAII unsubscribe handle, the same
/// pattern Rivet's `actor.on(...)` teardown gives you.
///
/// Non-event frames (presence deltas, DocSync blobs, raw non-envelope
/// `publish_event` values) are skipped by [`recv`], never surfaced as bogus events;
/// consumers that need the raw wire use [`RoomHandle::subscribe`] instead.
///
/// [`recv`]: Connection::recv
pub struct Connection {
    conn_id: ConnId,
    cmd: mpsc::UnboundedSender<RoomCommand>,
    broadcast_rx: broadcast::Receiver<Frame>,
    targeted_rx: mpsc::UnboundedReceiver<Frame>,
    broadcast_open: bool,
    targeted_open: bool,
}

impl Connection {
    /// This connection's process-unique id — the address for
    /// [`RoomHandle::send_event`].
    pub fn id(&self) -> ConnId {
        self.conn_id
    }

    /// Await the next typed [`Event`] for this connection, from either the room
    /// broadcast or a targeted `send_event`. Non-event frames are skipped. Returns
    /// `None` once both delivery paths are permanently closed (the room actor exited
    /// and the broadcast channel is drained), so it drives a `while let` loop.
    pub async fn recv(&mut self) -> Option<Event> {
        loop {
            if !self.broadcast_open && !self.targeted_open {
                return None;
            }
            let frame = tokio::select! {
                // Prefer targeted delivery so a private send is never starved by a
                // busy broadcast stream.
                biased;
                targeted = self.targeted_rx.recv(), if self.targeted_open => match targeted {
                    Some(frame) => frame,
                    None => {
                        // Actor dropped the sender (room hibernated/exited): stop
                        // polling this arm and fall back to draining the broadcast.
                        self.targeted_open = false;
                        continue;
                    }
                },
                broadcast = self.broadcast_rx.recv(), if self.broadcast_open => match broadcast {
                    Ok(frame) => frame,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => {
                        self.broadcast_open = false;
                        continue;
                    }
                },
            };
            if let Some(event) = Event::decode(&frame) {
                return Some(event);
            }
            // Non-event frame (presence / doc-sync / raw value): skip and keep waiting.
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        // RAII unsubscribe: unregister our targeted channel from the actor. Best
        // effort — if the actor already exited the send simply fails.
        let _ = self.cmd.send(RoomCommand::CloseConn {
            conn_id: self.conn_id,
        });
    }
}

// ── Room actor ───────────────────────────────────────────────────────────────

/// Per-room actor task. Owns the ephemeral presence map and the idle clock,
/// serializes all state mutation, fans out presence deltas, reaps stale presence,
/// and hibernates (removing itself from the registry) after the idle window with
/// zero members.
async fn run_room(
    room_id: String,
    members: Arc<AtomicUsize>,
    broadcast_tx: broadcast::Sender<Frame>,
    mut cmd_rx: mpsc::UnboundedReceiver<RoomCommand>,
    registry: Weak<Mutex<RoomMap>>,
    config: RoomConfig,
) {
    // Presence: member_id -> (latest value, last heartbeat). Never persisted.
    let mut presence: HashMap<String, (Value, Instant)> = HashMap::new();
    // Typed connections: conn_id -> its private targeted-delivery channel. Used only
    // by `send_event`; broadcasts never touch this map. Dropped wholesale on
    // hibernation (targeted delivery is ephemeral, exactly like presence/broadcast).
    let mut conns: HashMap<ConnId, mpsc::UnboundedSender<Frame>> = HashMap::new();
    // Invariant: `empty_since` is `Some` whenever members == 0. Armed at birth so a
    // room created without any join still hibernates (no leak); cleared on join.
    let mut empty_since: Option<Instant> = Some(Instant::now());

    let mut sweep = tokio::time::interval(config.sweep_interval);
    sweep.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // The immediate first tick carries no elapsed time; skip it.
    sweep.tick().await;

    loop {
        tokio::select! {
            cmd = cmd_rx.recv() => {
                match cmd {
                    // All handles dropped: nothing can ever join again. Exit.
                    None => {
                        evict(&registry, &room_id, "all handles dropped");
                        return;
                    }
                    Some(RoomCommand::Joined) => {
                        empty_since = None;
                    }
                    Some(RoomCommand::Left { member_id }) => {
                        if presence.remove(&member_id).is_some() {
                            let _ = broadcast_tx.send(Frame::Presence(presence_leave(&member_id)));
                        }
                        if members.load(Ordering::SeqCst) == 0 {
                            empty_since = Some(Instant::now());
                        }
                    }
                    Some(RoomCommand::Presence { member_id, value }) => {
                        presence.insert(member_id, (value.clone(), Instant::now()));
                        let _ = broadcast_tx.send(Frame::Presence(value));
                    }
                    Some(RoomCommand::PresenceMembers { reply }) => {
                        let mut ids: Vec<String> = presence.keys().cloned().collect();
                        ids.sort();
                        let _ = reply.send(ids);
                    }
                    Some(RoomCommand::OpenConn { conn_id, tx }) => {
                        conns.insert(conn_id, tx);
                    }
                    Some(RoomCommand::CloseConn { conn_id }) => {
                        conns.remove(&conn_id);
                    }
                    Some(RoomCommand::SendTo { conn_id, frame }) => {
                        if let Some(tx) = conns.get(&conn_id) {
                            // Prune on the failed send so a connection that vanished
                            // without its CloseConn being processed is still reaped.
                            if tx.send(frame).is_err() {
                                conns.remove(&conn_id);
                            }
                        }
                    }
                    Some(RoomCommand::ConnCount { reply }) => {
                        let _ = reply.send(conns.len());
                    }
                }
            }
            _ = sweep.tick() => {
                // Reap stale presence and broadcast a leave delta for each.
                let ttl = config.presence_ttl;
                let stale: Vec<String> = presence
                    .iter()
                    .filter(|(_, (_, seen))| seen.elapsed() >= ttl)
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in stale {
                    presence.remove(&id);
                    let _ = broadcast_tx.send(Frame::Presence(presence_leave(&id)));
                }

                // Hibernate if empty for the idle window. The recheck under the
                // registry lock serializes against `join`'s increment, so a join
                // racing the eviction can never be lost.
                if let Some(since) = empty_since {
                    if since.elapsed() >= config.idle_window
                        && try_evict(&registry, &room_id, &members)
                    {
                        return;
                    }
                }
            }
        }
    }
}

/// Build a `presence_leave` delta frame body for a departed/reaped member.
fn presence_leave(member_id: &str) -> Value {
    json!({ "type": "presence_leave", "member_id": member_id })
}

/// Attempt eviction under the registry lock, rechecking member count so a join
/// that incremented after the actor's last observation aborts the eviction.
/// Returns `true` if the room was removed (actor should exit).
fn try_evict(registry: &Weak<Mutex<RoomMap>>, room_id: &str, members: &Arc<AtomicUsize>) -> bool {
    let Some(map) = registry.upgrade() else {
        // Registry gone (server shutdown): nothing to remove, just exit.
        return true;
    };
    let mut map = map.lock().unwrap_or_else(|e| e.into_inner());
    if members.load(Ordering::SeqCst) != 0 {
        // A member joined in the gap; stay alive.
        return false;
    }
    map.remove(room_id);
    tracing::info!(room_id, "realtime: hibernating idle room (0 members)");
    true
}

/// Remove the room from the registry on a non-idle exit path (all handles
/// dropped) and log it.
fn evict(registry: &Weak<Mutex<RoomMap>>, room_id: &str, reason: &str) {
    if let Some(map) = registry.upgrade() {
        map.lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(room_id);
    }
    tracing::info!(room_id, reason, "realtime: evicting room");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fast_config() -> RoomConfig {
        RoomConfig {
            idle_window: Duration::from_millis(80),
            presence_ttl: Duration::from_millis(100),
            sweep_interval: Duration::from_millis(20),
        }
    }

    #[tokio::test]
    async fn get_or_create_is_idempotent() {
        let reg = RoomRegistry::new();
        let a = reg.get_or_create("room-1");
        let b = reg.get_or_create("room-1");
        // Same underlying broadcast channel: a frame on one reaches a receiver of
        // the other.
        let mut rx = b.subscribe();
        a.publish_event(json!({"n": 1}));
        let frame = rx.recv().await.expect("frame");
        match frame {
            Frame::Event(v) => assert_eq!(v["n"], 1),
            _ => panic!("expected event frame"),
        }
        assert_eq!(reg.room_count(), 1, "one logical room");
    }

    #[tokio::test]
    async fn join_leave_member_counting() {
        let reg = RoomRegistry::new();
        let handle = reg.get_or_create("room-2");
        assert_eq!(handle.member_count(), 0);

        let m1 = handle.join("alice");
        assert_eq!(handle.member_count(), 1);
        let m2 = handle.join("bob");
        assert_eq!(handle.member_count(), 2);

        drop(m2);
        assert_eq!(handle.member_count(), 1);

        // Explicit leave is idempotent with Drop.
        let mut m1 = m1;
        m1.leave();
        assert_eq!(handle.member_count(), 0);
        drop(m1);
        assert_eq!(handle.member_count(), 0);
    }

    #[tokio::test]
    async fn registry_join_counts_and_recreates() {
        let reg = RoomRegistry::new();
        // Race-safe join get-or-creates and increments under the lock.
        let m1 = reg.join("room-j", "alice");
        assert_eq!(reg.room_count(), 1);
        assert_eq!(m1.handle().member_count(), 1);

        let m2 = reg.join("room-j", "bob");
        assert_eq!(m2.handle().member_count(), 2);

        drop(m1);
        drop(m2);
        // Members gone, but the room is still mapped until the actor hibernates;
        // a fresh join must observe a live, zero-or-recreated room and count 1.
        let m3 = reg.join("room-j", "carol");
        assert_eq!(m3.handle().member_count(), 1);
        assert_eq!(reg.room_count(), 1);
    }

    #[tokio::test]
    async fn published_event_reaches_subscriber() {
        let reg = RoomRegistry::new();
        let handle = reg.get_or_create("room-3");
        let _member = handle.join("alice");
        let mut rx = handle.subscribe();

        reg.publish_event("room-3", json!({"type": "message", "id": "m1"}));

        let frame = rx.recv().await.expect("frame");
        match frame {
            Frame::Event(v) => {
                assert_eq!(v["type"], "message");
                assert_eq!(v["id"], "m1");
            }
            _ => panic!("expected event frame"),
        }
        assert_eq!(handle.subscribe().len(), 0, "fresh receiver has no backlog");
    }

    #[tokio::test]
    async fn presence_delta_is_broadcast() {
        let reg = RoomRegistry::new();
        let handle = reg.get_or_create("room-4");
        let member = handle.join("alice");
        let mut rx = handle.subscribe();

        member.publish_presence(json!({"member_id": "alice", "cursor": [1, 2]}));

        let frame = rx.recv().await.expect("frame");
        match frame {
            Frame::Presence(v) => assert_eq!(v["cursor"][0], 1),
            _ => panic!("expected presence frame"),
        }
    }

    #[tokio::test]
    async fn presence_ttl_is_reaped() {
        let reg = RoomRegistry::with_config(fast_config());
        let handle = reg.get_or_create("room-5");
        // Hold membership so the room does not hibernate while we wait for the
        // presence sweep (presence reaping is independent of membership).
        let member = handle.join("alice");
        let mut rx = handle.subscribe();

        member.publish_presence(json!({"member_id": "alice"}));
        // Drain the initial presence upsert.
        let _ = rx.recv().await.expect("upsert");
        assert_eq!(handle.presence_members().await, vec!["alice".to_string()]);

        // Wait past the TTL for the reaper to fire.
        tokio::time::sleep(Duration::from_millis(220)).await;

        assert!(
            handle.presence_members().await.is_empty(),
            "stale presence should be reaped"
        );
        // And a presence_leave delta should have been broadcast.
        let mut saw_leave = false;
        while let Ok(frame) = rx.try_recv() {
            if let Frame::Presence(v) = frame {
                if v["type"] == "presence_leave" {
                    saw_leave = true;
                }
            }
        }
        assert!(saw_leave, "expected a presence_leave delta on reap");

        drop(member);
    }

    #[tokio::test]
    async fn idle_room_hibernates() {
        let reg = RoomRegistry::with_config(fast_config());
        let handle = reg.get_or_create("room-6");
        {
            let _m = handle.join("alice");
            assert_eq!(reg.room_count(), 1);
        } // member leaves here -> idle clock arms

        // Wait past the idle window + a sweep tick.
        tokio::time::sleep(Duration::from_millis(220)).await;
        assert_eq!(reg.room_count(), 0, "idle room should hibernate");

        // Rehydration: a fresh get_or_create spins up a new actor.
        let handle2 = reg.get_or_create("room-6");
        let _m2 = handle2.join("bob");
        assert_eq!(reg.room_count(), 1, "room rehydrates on next join");
    }

    #[tokio::test]
    async fn publish_event_to_absent_room_is_noop() {
        let reg = RoomRegistry::new();
        // No panic, no room created.
        reg.publish_event("ghost", json!({"x": 1}));
        assert_eq!(reg.room_count(), 0);
    }

    #[test]
    fn frame_channel_tags() {
        assert_eq!(Frame::Event(json!({})).channel(), RealtimeChannel::Events);
        assert_eq!(
            Frame::Presence(json!({})).channel(),
            RealtimeChannel::Presence
        );
        assert_eq!(
            Frame::DocSync(vec![1, 2, 3]).channel(),
            RealtimeChannel::DocSync
        );
    }

    // ── Typed named events ────────────────────────────────────────────────────

    #[test]
    fn event_decode_only_matches_the_envelope() {
        // A real envelope round-trips name + payload.
        let frame = Frame::Event(encode_event("chat.message", json!({"id": "m1"})));
        let ev = Event::decode(&frame).expect("named event");
        assert_eq!(ev.name, "chat.message");
        assert_eq!(ev.payload["id"], "m1");

        // A raw (non-envelope) event value is NOT a typed event — the pre-existing
        // `publish_event` wire is untouched and never misread as a zero-name event.
        assert!(Event::decode(&Frame::Event(json!({"id": "raw"}))).is_none());
        // Presence + DocSync frames are never typed events.
        assert!(Event::decode(&Frame::Presence(json!({"cursor": [1, 2]}))).is_none());
        assert!(Event::decode(&Frame::DocSync(vec![1, 2, 3])).is_none());
    }

    #[tokio::test]
    async fn broadcast_event_reaches_typed_and_raw_subscribers() {
        let reg = RoomRegistry::new();
        let handle = reg.get_or_create("evt-room");
        let mut conn = handle.open_connection();
        // A raw broadcast receiver: proves the typed layer rides the existing wire
        // without breaking it — the frame is still an ordinary `Frame::Event`.
        let mut raw = handle.subscribe();

        reg.broadcast_event("evt-room", "counter.tick", json!({"n": 7}));

        let ev = conn.recv().await.expect("typed event");
        assert_eq!(ev.name, "counter.tick");
        assert_eq!(ev.payload["n"], 7);

        match raw.recv().await.expect("raw frame") {
            Frame::Event(v) => {
                // Behavior-preserving: still a Frame::Event on the Events channel.
                let decoded = Event::decode(&Frame::Event(v)).expect("envelope");
                assert_eq!(decoded.name, "counter.tick");
            }
            other => panic!("expected Frame::Event, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn plugin_contributions_broadcast_payload_is_self_describing() {
        // Pins the wire contract of the first production consumer (Core's plugin
        // enable/disable/grants handlers → the desktop's `system:plugins`
        // subscription): the WS gateway's `frame_to_message` strips the envelope
        // (and with it the event NAME) before the client sees it, so the payload
        // itself must carry the discriminant the desktop keys off.
        let reg = RoomRegistry::new();
        let handle = reg.get_or_create("system:plugins");
        let mut raw = handle.subscribe();

        reg.broadcast_event(
            "system:plugins",
            "plugin.contributions.changed",
            json!({"type": "contributions_changed"}),
        );

        match raw.recv().await.expect("raw frame") {
            frame @ Frame::Event(_) => {
                let ev = Event::decode(&frame).expect("envelope");
                assert_eq!(ev.name, "plugin.contributions.changed");
                // What survives to the client after the envelope is unwrapped.
                assert_eq!(ev.payload["type"], "contributions_changed");
            }
            other => panic!("expected Frame::Event, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn send_event_is_isolated_to_its_connection() {
        let reg = RoomRegistry::new();
        let handle = reg.get_or_create("target-room");
        let mut conn_a = handle.open_connection();
        let mut conn_b = handle.open_connection();
        let mut raw = handle.subscribe();
        let a_id = conn_a.id();

        handle.send_event(a_id, "secret", json!({"for": "a"}));
        // Round-trip through the actor so the targeted delivery is guaranteed queued
        // before we broadcast — makes the ordering below deterministic.
        assert_eq!(handle.conn_count().await, 2);
        handle.broadcast_event("marker", json!({}));

        // conn_a sees its private event first (biased), then the broadcast.
        let first = conn_a.recv().await.expect("a first");
        assert_eq!(first.name, "secret");
        assert_eq!(first.payload["for"], "a");
        let second = conn_a.recv().await.expect("a second");
        assert_eq!(second.name, "marker");

        // conn_b NEVER sees the targeted event — its first (and only) event is the
        // broadcast marker. This is the core isolation guarantee.
        let b_first = conn_b.recv().await.expect("b first");
        assert_eq!(b_first.name, "marker");

        // The raw broadcast subscriber likewise only ever saw the broadcast, not the
        // targeted send (targeted delivery never touches the broadcast channel).
        match raw.recv().await.expect("raw first") {
            Frame::Event(v) => {
                assert_eq!(v[EVENT_NAME_KEY], "marker");
            }
            other => panic!("expected marker frame, got {other:?}"),
        }
        assert!(raw.try_recv().is_err(), "raw saw exactly one frame");
    }

    #[tokio::test]
    async fn dropping_a_connection_prunes_it_from_the_actor() {
        let reg = RoomRegistry::new();
        let handle = reg.get_or_create("drop-room");
        let conn_a = handle.open_connection();
        let conn_b = handle.open_connection();
        assert_eq!(handle.conn_count().await, 2);

        let a_id = conn_a.id();
        drop(conn_a);
        // CloseConn is ordered before this ConnCount on the same command channel.
        assert_eq!(handle.conn_count().await, 1);

        // A targeted send to the dropped connection is now a no-op; conn_b (still
        // open) receives the following broadcast, proving the room is healthy.
        handle.send_event(a_id, "ghost", json!({}));
        handle.broadcast_event("alive", json!({}));
        let mut conn_b = conn_b;
        assert_eq!(conn_b.recv().await.expect("b").name, "alive");
    }

    #[tokio::test]
    async fn typed_reader_skips_non_event_frames() {
        let reg = RoomRegistry::new();
        let handle = reg.get_or_create("skip-room");
        let mut conn = handle.open_connection();

        // A raw (non-envelope) event, then a real named event — both synchronous on
        // the broadcast channel, so the raw one is delivered first and must be
        // skipped, surfacing only the named event.
        handle.publish_event(json!({"legacy": true}));
        handle.broadcast_event("real", json!({"ok": 1}));

        let ev = conn.recv().await.expect("named event");
        assert_eq!(ev.name, "real");
        assert_eq!(ev.payload["ok"], 1);
    }

    #[test]
    fn conn_ids_are_process_unique_and_monotonic() {
        let a = ConnId::next();
        let b = ConnId::next();
        assert_ne!(a, b);
        assert!(b.get() > a.get());
    }
}
