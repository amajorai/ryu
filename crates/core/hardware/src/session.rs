//! Per-connection realtime session: the bridge from RHP frames to existing Core
//! seams (PROTOCOL.md §4).
//!
//! One [`HardwareSession`] exists per live WS connection. It owns the per-turn
//! state and routes work IN-PROCESS (never self-HTTP) to:
//!
//! - chat: Core's `sidecar::adapters::run_text_turn` (the same non-stream
//!   text-turn primitive the off-chat `AgentRunner` uses) for the model turn,
//!   plus Core's `server::voice` for ASR/TTS;
//! - ambient: the [`crate::ingest::MeetingIngest`] seam
//!   ([`MeetingIngest::append_segment`]) feeding the long-running meeting that is
//!   the ambient session, inverted so this crate never links `ryu_meetings`.
//!
//! Opus decode/encode happens at the codec edge ([`super::codec`]) so the rest of
//! Core sees PCM/WAV. The WS upgrade + frame pump lives in
//! `server::hardware_ws`; this type holds the logic the pump drives.
//!
//! ## Streaming model
//!
//! `run_text_turn` is non-streaming (it returns the full reply text). For v1 we
//! emit the reply as sentence-chunked `chat_delta`s + a `chat_end`, then
//! synthesize the whole reply to TTS. True per-token deltas would require
//! consuming the SSE chat adapter — out of scope for the device link.

use std::sync::Arc;

use anyhow::Result;

use super::codec::{self, UplinkDecoder, DOWNLINK_RATE, FRAME_MS, UPLINK_RATE};
use super::protocol::{AudioFormat, Caps, DeviceType, Emotion, Mode, RhpServerMsg};
use crate::ingest::MeetingIngest;

/// Process-global registry of live device WS connections, so out-of-band producers
/// (the dashboard refresh loop, the ambient rolling-summary, Core's `device` MCP
/// server) can reach a connected device without holding its socket. Keyed by
/// `device_id`; the WS handler registers on connect and unregisters on disconnect
/// (review gap #4: the desk e-ink got no content because nothing ever told it to
/// re-poll).
///
/// This is the hardware analog of `ryu_dashboards::store`'s SSE broadcast: the
/// desktop learns of fresh widget data over SSE; a device learns over its RHP WS.
///
/// ## RHP v1.1 (design §6.3)
///
/// Each connection also carries its [`live::LiveMeta`], a priority control channel
/// (capacity 32, which the send task reads first with a biased `select` over ctrl
/// and the main output channel), the validated capability table, the pending
/// invokes, and an in-flight semaphore of 4. The end watch carries
/// `Option<EndReason>` so a reconnect (`Superseded`) is no longer mistaken for a
/// revoke.
pub mod live {
    use super::{RhpServerMsg, SessionOutput};
    use crate::capability::{self, ValidCapability, MAX_INFLIGHT, MAX_RESULT_BYTES};
    use crate::protocol::DeviceType;
    use serde_json::Value;
    use std::collections::HashMap;
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, MutexGuard, OnceLock,
    };
    use std::time::Duration;
    use tokio::sync::{mpsc, oneshot, watch, Semaphore};

    /// Capacity of the per-connection priority control channel.
    pub const CTRL_CHANNEL_CAPACITY: usize = 32;
    /// How long `invoke` waits for an in-flight slot before answering `Busy`.
    pub const PERMIT_WAIT: Duration = Duration::from_secs(1);
    /// How long `invoke` waits to queue on the control channel.
    pub const SEND_WAIT: Duration = Duration::from_secs(2);
    /// The longest capability deadline the node grants.
    pub const MAX_INVOKE_TIMEOUT: Duration = Duration::from_secs(60);
    /// Grace added to the deadline while awaiting the device's result.
    pub const RESULT_GRACE: Duration = Duration::from_secs(2);

    /// Why a live connection ended (the value of the end watch).
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum EndReason {
        /// The device was revoked (`DELETE`): secure sessions send `unpaired`.
        Revoked,
        /// A newer connection (or an identity reset) replaced this one.
        Superseded,
    }

    /// What the registry knows about a connection.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct LiveMeta {
        pub name: String,
        pub device_type: DeviceType,
        /// The session runs over the RHN secure layer.
        pub secure: bool,
        /// The session is relayed by the phone (Mode A).
        pub relay: bool,
    }

    /// What `register` hands back to the WS handler.
    pub struct LiveHandle {
        /// This connection's generation (used for `unregister` / `complete`).
        pub generation: u64,
        /// Fires with `Some(reason)` when the connection must end.
        pub ended: watch::Receiver<Option<EndReason>>,
        /// The priority control channel (capability invokes); the send task drains
        /// it before the main output channel.
        pub ctrl_rx: mpsc::Receiver<RhpServerMsg>,
    }

    /// One connected device's capabilities, for listings and agent tools.
    #[derive(Clone, Debug, PartialEq)]
    pub struct LiveCapabilities {
        pub device_id: String,
        pub generation: u64,
        pub meta: LiveMeta,
        pub cap_generation: u32,
        pub caps: Vec<ValidCapability>,
    }

    /// Why an invoke failed.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub enum InvokeError {
        /// The device has no live connection.
        NotConnected,
        /// The device is connected over a legacy (plaintext) session.
        NotSecure,
        /// The device did not register a capability with this name.
        UnknownCapability,
        /// The arguments do not match the capability's schema.
        InvalidArgs(String),
        /// Four calls are already in flight, or the control channel stayed full.
        Busy,
        /// No result arrived within the deadline plus grace.
        Timeout,
        /// The connection went away (disconnect or supersede) before the result.
        Disconnected,
        /// The device was revoked while the call was pending.
        Revoked,
        /// The result exceeded 16384 serialized bytes.
        ResultTooLarge,
        /// The device answered `ok:false` with this code.
        Device { code: String, message: String },
    }

    impl InvokeError {
        /// Stable machine code (device errors keep the device's code).
        pub fn code(&self) -> &str {
            match self {
                InvokeError::NotConnected => "not_connected",
                InvokeError::NotSecure => "not_secure",
                InvokeError::UnknownCapability => "unknown_capability",
                InvokeError::InvalidArgs(_) => "invalid_args",
                InvokeError::Busy => "busy",
                InvokeError::Timeout => "timeout",
                InvokeError::Disconnected => "disconnected",
                InvokeError::Revoked => "revoked",
                InvokeError::ResultTooLarge => "result_too_large",
                InvokeError::Device { code, .. } => code,
            }
        }
    }

    impl std::fmt::Display for InvokeError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                InvokeError::InvalidArgs(message) => write!(f, "invalid_args: {message}"),
                InvokeError::Device { code, message } => write!(f, "{code}: {message}"),
                other => f.write_str(other.code()),
            }
        }
    }

    impl std::error::Error for InvokeError {}

    type Outcome = Result<Value, InvokeError>;

    struct CapTable {
        cap_generation: u32,
        caps: Vec<ValidCapability>,
    }

    struct LiveConnection {
        generation: u64,
        tx: mpsc::Sender<SessionOutput>,
        ctrl_tx: mpsc::Sender<RhpServerMsg>,
        ended: watch::Sender<Option<EndReason>>,
        meta: LiveMeta,
        caps: Option<CapTable>,
        pending: HashMap<String, oneshot::Sender<Outcome>>,
        inflight: Arc<Semaphore>,
        counter: u64,
    }

    impl LiveConnection {
        fn fail_pending(&mut self, error: &InvokeError) {
            for (_, waiter) in self.pending.drain() {
                let _ = waiter.send(Err(error.clone()));
            }
        }
    }

    static REGISTRY: OnceLock<Mutex<HashMap<String, LiveConnection>>> = OnceLock::new();
    static NEXT_GENERATION: AtomicU64 = AtomicU64::new(0);

    /// The registry lock. It is a plain mutex held only for short, non-async
    /// critical sections, so a cancelled invoke can clean up from `Drop`.
    fn registry() -> MutexGuard<'static, HashMap<String, LiveConnection>> {
        REGISTRY
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Register a connected device. Replaces any prior entry: a reconnect
    /// supersedes the stale socket (its end watch fires `Superseded` and its
    /// pending invokes fail with `Disconnected`).
    pub async fn register(
        device_id: &str,
        tx: mpsc::Sender<SessionOutput>,
        meta: LiveMeta,
    ) -> LiveHandle {
        let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
        let (ended, ended_rx) = watch::channel(None);
        let (ctrl_tx, ctrl_rx) = mpsc::channel(CTRL_CHANNEL_CAPACITY);
        let mut connections = registry();
        if let Some(mut previous) = connections.remove(device_id) {
            let _ = previous.ended.send(Some(EndReason::Superseded));
            previous.fail_pending(&InvokeError::Disconnected);
        }
        connections.insert(
            device_id.to_string(),
            LiveConnection {
                generation,
                tx,
                ctrl_tx,
                ended,
                meta,
                caps: None,
                pending: HashMap::new(),
                inflight: Arc::new(Semaphore::new(MAX_INFLIGHT)),
                counter: 0,
            },
        );
        LiveHandle {
            generation,
            ended: ended_rx,
            ctrl_rx,
        }
    }

    /// Remove a device's connection on disconnect (only if `generation` is still
    /// current). Pending invokes fail with `Disconnected`. Idempotent.
    pub async fn unregister(device_id: &str, generation: u64) {
        let mut connections = registry();
        if connections
            .get(device_id)
            .is_some_and(|connection| connection.generation == generation)
        {
            if let Some(mut connection) = connections.remove(device_id) {
                connection.fail_pending(&InvokeError::Disconnected);
            }
        }
    }

    /// Signal the current connection to end. Pending invokes fail with `Revoked`
    /// (for [`EndReason::Revoked`]) or `Disconnected`. The entry stays until the WS
    /// handler unregisters. Returns `true` when a live connection was signalled.
    pub async fn end(device_id: &str, reason: EndReason) -> bool {
        let mut connections = registry();
        let Some(connection) = connections.get_mut(device_id) else {
            return false;
        };
        let error = match reason {
            EndReason::Revoked => InvokeError::Revoked,
            EndReason::Superseded => InvokeError::Disconnected,
        };
        connection.fail_pending(&error);
        connection.caps = None;
        connection.ended.send(Some(reason)).is_ok()
    }

    /// Mark the current live connection revoked. The receive loop observes the end
    /// watch and tears down the socket even though the durable device row has
    /// already been deleted.
    pub async fn revoke(device_id: &str) -> bool {
        end(device_id, EndReason::Revoked).await
    }

    /// Whether a device currently has a live socket (so a producer can skip work
    /// for offline devices — the device will re-poll on its own cadence anyway).
    pub async fn is_connected(device_id: &str) -> bool {
        registry().contains_key(device_id)
    }

    /// Whether any device still has an open outbound channel.
    pub(crate) async fn has_connections() -> bool {
        registry()
            .values()
            .any(|connection| !connection.tx.is_closed())
    }

    /// Push one control message to a connected device. Returns `true` if it was
    /// queued (the device is connected and its channel is not full/closed). A closed
    /// channel is pruned so it isn't retried.
    pub async fn send(device_id: &str, msg: RhpServerMsg) -> bool {
        let connection = registry()
            .get(device_id)
            .map(|connection| (connection.generation, connection.tx.clone()));
        match connection {
            Some((generation, tx)) => match tx.try_send(SessionOutput::Control(msg)) {
                Ok(()) => true,
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    unregister(device_id, generation).await;
                    false
                }
                // Full: the device is busy draining; the nudge is best-effort.
                Err(mpsc::error::TrySendError::Full(_)) => false,
            },
            None => false,
        }
    }

    /// Replace a connection's capability table (after `validate_register`). Only
    /// applies when `generation` is still the current connection. Returns `true`
    /// when stored.
    pub async fn set_capabilities(
        device_id: &str,
        generation: u64,
        cap_generation: u32,
        caps: Vec<ValidCapability>,
    ) -> bool {
        let mut connections = registry();
        match connections.get_mut(device_id) {
            Some(connection) if connection.generation == generation => {
                connection.caps = Some(CapTable {
                    cap_generation,
                    caps,
                });
                true
            }
            _ => false,
        }
    }

    fn snapshot(device_id: &str, connection: &LiveConnection) -> Option<LiveCapabilities> {
        connection.caps.as_ref().map(|table| LiveCapabilities {
            device_id: device_id.to_string(),
            generation: connection.generation,
            meta: connection.meta.clone(),
            cap_generation: table.cap_generation,
            caps: table.caps.clone(),
        })
    }

    /// Every connected device that registered capabilities (secure sessions only).
    pub async fn capabilities() -> Vec<LiveCapabilities> {
        let mut out: Vec<LiveCapabilities> = registry()
            .iter()
            .filter_map(|(device_id, connection)| snapshot(device_id, connection))
            .collect();
        out.sort_by(|a, b| a.device_id.cmp(&b.device_id));
        out
    }

    /// One device's live capabilities, if it is connected and registered some.
    pub async fn capabilities_for(device_id: &str) -> Option<LiveCapabilities> {
        registry()
            .get(device_id)
            .and_then(|connection| snapshot(device_id, connection))
    }

    /// The `meta` of a live connection.
    pub async fn meta(device_id: &str) -> Option<LiveMeta> {
        registry()
            .get(device_id)
            .map(|connection| connection.meta.clone())
    }

    /// Removes the pending entry on every exit path of `invoke`, including when
    /// the caller drops the future.
    struct PendingGuard<'a> {
        device_id: &'a str,
        generation: u64,
        request_id: String,
    }

    impl Drop for PendingGuard<'_> {
        fn drop(&mut self) {
            if let Some(connection) = registry().get_mut(self.device_id) {
                if connection.generation == self.generation {
                    connection.pending.remove(&self.request_id);
                }
            }
        }
    }

    /// Invoke a device capability and await its result (design §6.3):
    ///
    /// 1. the connection must be secure (`NotSecure`);
    /// 2. the capability must be registered (`UnknownCapability`);
    /// 3. `args` must validate (`InvalidArgs`);
    /// 4. an in-flight slot (of 4) must free up within 1 s (`Busy`);
    /// 5. the pending entry is recorded, then the invoke is queued on the priority
    ///    channel with a 2 s send timeout (never `try_send`);
    /// 6. the result is awaited for `min(timeout, 60 s) + 2 s` (`Timeout`); a
    ///    result over 16384 bytes is `ResultTooLarge`;
    /// 7. the pending entry is removed on every path.
    pub async fn invoke(
        device_id: &str,
        name: &str,
        args: Value,
        timeout: Duration,
    ) -> Result<Value, InvokeError> {
        let (generation, capability, cap_generation, inflight) = {
            let connections = registry();
            let connection = connections
                .get(device_id)
                .ok_or(InvokeError::NotConnected)?;
            if !connection.meta.secure {
                return Err(InvokeError::NotSecure);
            }
            let table = connection
                .caps
                .as_ref()
                .ok_or(InvokeError::UnknownCapability)?;
            let capability = table
                .caps
                .iter()
                .find(|cap| cap.name == name)
                .cloned()
                .ok_or(InvokeError::UnknownCapability)?;
            (
                connection.generation,
                capability,
                table.cap_generation,
                Arc::clone(&connection.inflight),
            )
        };
        capability::validate_args(&capability, &args)
            .map_err(|error| InvokeError::InvalidArgs(error.message))?;

        let _permit = match tokio::time::timeout(PERMIT_WAIT, inflight.acquire_owned()).await {
            Ok(Ok(permit)) => permit,
            Ok(Err(_)) => return Err(InvokeError::Disconnected),
            Err(_) => return Err(InvokeError::Busy),
        };

        let deadline = timeout.min(MAX_INVOKE_TIMEOUT);
        let (result_tx, result_rx) = oneshot::channel();
        let (request_id, ctrl_tx) = {
            let mut connections = registry();
            let connection = match connections.get_mut(device_id) {
                Some(connection) if connection.generation == generation => connection,
                _ => return Err(InvokeError::Disconnected),
            };
            if connection.ended.borrow().is_some() {
                return Err(InvokeError::Disconnected);
            }
            connection.counter += 1;
            let request_id = format!("inv_{generation}_{}", connection.counter);
            connection.pending.insert(request_id.clone(), result_tx);
            (request_id, connection.ctrl_tx.clone())
        };
        let _guard = PendingGuard {
            device_id,
            generation,
            request_id: request_id.clone(),
        };

        let message = RhpServerMsg::CapabilityInvoke {
            request_id,
            generation: cap_generation,
            name: name.to_string(),
            args,
            deadline_ms: u32::try_from(deadline.as_millis()).unwrap_or(u32::MAX),
        };
        match ctrl_tx.send_timeout(message, SEND_WAIT).await {
            Ok(()) => {}
            Err(mpsc::error::SendTimeoutError::Timeout(_)) => return Err(InvokeError::Busy),
            Err(mpsc::error::SendTimeoutError::Closed(_)) => return Err(InvokeError::Disconnected),
        }

        match tokio::time::timeout(deadline + RESULT_GRACE, result_rx).await {
            Ok(Ok(Ok(value))) => {
                let size = serde_json::to_vec(&value).map_or(usize::MAX, |bytes| bytes.len());
                if size > MAX_RESULT_BYTES {
                    Err(InvokeError::ResultTooLarge)
                } else {
                    Ok(value)
                }
            }
            Ok(Ok(Err(error))) => Err(error),
            Ok(Err(_)) => Err(InvokeError::Disconnected),
            Err(_) => Err(InvokeError::Timeout),
        }
    }

    /// The invoke outcome of a `capability_result` message.
    pub fn result_outcome(
        ok: bool,
        result: Option<Value>,
        error: Option<crate::protocol::CapabilityErrorBody>,
    ) -> Result<Value, InvokeError> {
        if ok {
            return Ok(result.unwrap_or(Value::Null));
        }
        let error = error.unwrap_or(crate::protocol::CapabilityErrorBody {
            code: "internal".into(),
            message: String::new(),
        });
        Err(InvokeError::Device {
            code: error.code,
            message: error.message,
        })
    }

    /// Deliver a device's `capability_result`. Ignored (returns `false`) when the
    /// connection generation is stale or the request id is unknown (already
    /// timed out, or never issued).
    pub async fn complete(
        device_id: &str,
        generation: u64,
        request_id: &str,
        outcome: Result<Value, InvokeError>,
    ) -> bool {
        let waiter = {
            let mut connections = registry();
            match connections.get_mut(device_id) {
                Some(connection) if connection.generation == generation => {
                    connection.pending.remove(request_id)
                }
                _ => None,
            }
        };
        waiter.is_some_and(|waiter| waiter.send(outcome).is_ok())
    }

    /// Serialises the tests (in this crate) that register live connections, since
    /// the registry is process-global and `has_connections` observes all of them.
    #[cfg(test)]
    pub(crate) static TEST_SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[cfg(test)]
    pub(crate) async fn pending_count(device_id: &str) -> usize {
        registry()
            .get(device_id)
            .map_or(0, |connection| connection.pending.len())
    }
}

/// What the session wants the WS pump to send back to the device. The pump
/// serializes control variants to TEXT frames and audio to BINARY frames.
pub enum SessionOutput {
    /// A control message to serialize and send.
    Control(RhpServerMsg),
    /// One Opus packet of TTS audio (24 kHz, 60 ms) to send as a BINARY frame.
    Audio(Vec<u8>),
}

impl SessionOutput {
    fn control(msg: RhpServerMsg) -> Self {
        SessionOutput::Control(msg)
    }
}

/// Live state for one connected device.
pub struct HardwareSession {
    pub device_id: String,
    pub device_type: DeviceType,
    pub caps: Caps,
    pub mode: Mode,
    /// The ambient long-running meeting id, if this device is ambient-capable.
    pub ambient_session_id: Option<String>,
    /// Stable per-device conversation id used for each chat turn's trace + (future)
    /// history binding. NOTE: v1 hardware chat is per-turn STATELESS — the turn
    /// runs `run_text_turn(persist=false)` with only the current user message, so
    /// prior turns are not replayed into the model. The stable id is here so a
    /// later `persist=true` / history-prefill upgrade has a durable key to hang on.
    /// Public so the Core WS pump (which owns the kernel-welded chat turn) can build
    /// the turn's key without reaching into the session.
    pub conversation_id: String,
    /// The agent that handles device chat turns (None = the default LLM path).
    /// Resolved once at connect by the Core WS handler and carried here so the
    /// pump can build the kernel-welded `ChatTurn` from a pure [`TurnInput`].
    pub agent_id: Option<String>,
    /// Meeting-ingest seam: the ambient capture path feeds WAV segments here. Held
    /// as a trait object ([`MeetingIngest`]) so this crate links neither the
    /// in-process engine nor the sidecar — Core injects the concrete impl.
    meetings: Arc<dyn MeetingIngest>,
    /// Opus decoder for the mic uplink (stateful across frames).
    uplink: UplinkDecoder,
    /// PCM accumulated for the current chat turn (decoded uplink, 16 kHz mono).
    chat_pcm: Vec<i16>,
    /// PCM accumulated for the ambient pipeline since the last flush (16 kHz mono).
    ambient_pcm: Vec<i16>,
}

/// ~1 s of 16 kHz mono audio — the ambient flush granularity (PROTOCOL.md §4.2).
const AMBIENT_FLUSH_SAMPLES: usize = UPLINK_RATE as usize;
const MAX_CHAT_SAMPLES: usize = UPLINK_RATE as usize * 60;

impl HardwareSession {
    /// Create a session from the device's `hello`. `ambient_session_id` is the
    /// resumed/opened long-running meeting (set by the WS handler when the device
    /// is ambient-capable); `None` for interactive-only devices.
    pub fn new(
        device_id: String,
        device_type: DeviceType,
        caps: Caps,
        ambient_session_id: Option<String>,
        meetings: Arc<dyn MeetingIngest>,
        agent_id: Option<String>,
    ) -> Result<Self> {
        Ok(Self {
            conversation_id: format!("hw_{device_id}"),
            device_id,
            device_type,
            caps,
            mode: Mode::Idle,
            ambient_session_id,
            agent_id,
            meetings,
            uplink: UplinkDecoder::new()?,
            chat_pcm: Vec::new(),
            ambient_pcm: Vec::new(),
        })
    }

    /// The TTS downlink format advertised back to the device in `hello_ack`.
    pub fn tts_format() -> AudioFormat {
        AudioFormat {
            codec: "opus".to_string(),
            sample_rate: DOWNLINK_RATE,
            frame_ms: FRAME_MS,
        }
    }

    /// Switch operating mode. On entering chat we clear any stale turn buffer.
    pub fn set_mode(&mut self, mode: Mode) {
        if mode == Mode::Chat {
            self.chat_pcm.clear();
        }
        self.mode = mode;
    }

    /// Begin a chat turn: drop any buffered audio so the turn starts clean.
    pub fn on_listen_start(&mut self) {
        self.chat_pcm.clear();
    }

    /// Handle a decoded uplink Opus packet for the current mode.
    ///
    /// In `chat` it accumulates the turn (the model runs on `listen:stop`). In
    /// `ambient` it buffers ~1 s then feeds a WAV chunk to the meetings pipeline,
    /// returning `ambient_ack`/`ambient_skip`. Idle mode ignores audio.
    pub async fn on_audio(&mut self, opus_packet: &[u8]) -> Result<Vec<SessionOutput>> {
        let pcm = self.uplink.decode(opus_packet)?;
        match self.mode {
            Mode::Chat => {
                if self.chat_pcm.len().saturating_add(pcm.len()) > MAX_CHAT_SAMPLES {
                    self.chat_pcm.clear();
                    anyhow::bail!("hardware chat audio exceeded the 60-second buffer limit");
                }
                self.chat_pcm.extend_from_slice(&pcm);
                Ok(Vec::new())
            }
            Mode::Ambient => {
                self.ambient_pcm.extend_from_slice(&pcm);
                if self.ambient_pcm.len() >= AMBIENT_FLUSH_SAMPLES {
                    self.flush_ambient().await
                } else {
                    Ok(Vec::new())
                }
            }
            Mode::Idle => Ok(Vec::new()),
        }
    }

    /// Feed the buffered ambient PCM to the meetings chunk pipeline as one WAV
    /// chunk, emitting `ambient_ack` (a segment was transcribed) or `ambient_skip`
    /// (silence / no meeting bound).
    async fn flush_ambient(&mut self) -> Result<Vec<SessionOutput>> {
        let pcm = std::mem::take(&mut self.ambient_pcm);
        let Some(meeting_id) = self.ambient_session_id.clone() else {
            return Ok(vec![SessionOutput::control(RhpServerMsg::AmbientSkip {
                reason: "no ambient session".to_string(),
            })]);
        };
        let wav = codec::pcm16_to_wav(&pcm, UPLINK_RATE)?;
        match self
            .meetings
            .append_segment(&meeting_id, wav, "ambient.wav".to_string())
            .await
        {
            Ok(segment_id) => Ok(vec![SessionOutput::control(RhpServerMsg::AmbientAck {
                segment_id,
            })]),
            // A silent chunk is the common case, not an error worth surfacing.
            Err(e) if e.contains("silence") || e.contains("empty") => {
                Ok(vec![SessionOutput::control(RhpServerMsg::AmbientSkip {
                    reason: "silence".to_string(),
                })])
            }
            Err(e) => Ok(vec![SessionOutput::control(RhpServerMsg::AmbientSkip {
                reason: e,
            })]),
        }
    }

    /// Take the buffered chat turn on `listen:stop`. Returns the captured 16 kHz
    /// mono PCM as a pure [`TurnInput`], or `None` when nothing was captured. The
    /// Core WS pump wraps this in its kernel-welded `ChatTurn` (with the session
    /// deps + `conversation_id`) and spawns the ASR → model → TTS turn off the recv
    /// loop so the loop stays live for barge-in.
    pub fn take_voice_turn(&mut self) -> Option<TurnInput> {
        let pcm = std::mem::take(&mut self.chat_pcm);
        if pcm.is_empty() {
            return None;
        }
        Some(TurnInput::Voice(pcm))
    }

    /// Build a `text`-fallback turn input (skips ASR). `None` for empty input.
    pub fn take_text_turn(&mut self, content: &str) -> Option<TurnInput> {
        let content = content.trim();
        if content.is_empty() {
            return None;
        }
        Some(TurnInput::Text(content.to_string()))
    }

    /// Map a chat/processing phase to the face emotion to push. Used by the WS
    /// handler when it wants to nudge the face outside a full turn.
    pub fn emotion_for_phase(&self) -> Emotion {
        match self.mode {
            Mode::Chat => Emotion::Listening,
            Mode::Ambient => Emotion::Neutral,
            Mode::Idle => Emotion::Neutral,
        }
    }
}

/// The user input that opens a chat turn.
pub enum TurnInput {
    /// Captured mic PCM (16 kHz mono) to transcribe before the model turn.
    Voice(Vec<i16>),
    /// Already-text input (the `text` fallback frame) — skips ASR.
    Text(String),
}

#[cfg(test)]
mod tests {
    use super::live::{self, EndReason, InvokeError, LiveHandle, LiveMeta};
    use super::SessionOutput;
    use crate::capability::validate_register;
    use crate::protocol::{DeviceType, RhpServerMsg};
    use serde_json::{json, Value};
    use std::time::Duration;
    use tokio::sync::mpsc;

    fn unique(prefix: &str) -> String {
        format!("{prefix}-{}", uuid::Uuid::new_v4())
    }

    fn meta(secure: bool) -> LiveMeta {
        LiveMeta {
            name: "Watch".into(),
            device_type: DeviceType::Watch,
            secure,
            relay: false,
        }
    }

    const CAPS: &str = include_str!("../tests/vectors/rhp_v1_1_capabilities.json");

    async fn connect_with_caps(
        device_id: &str,
        out_capacity: usize,
    ) -> (LiveHandle, mpsc::Receiver<SessionOutput>) {
        let (tx, rx) = mpsc::channel(out_capacity);
        let handle = live::register(device_id, tx, meta(true)).await;
        let v: Value = serde_json::from_str(CAPS).unwrap();
        let raw = v["register_valid"]["capabilities"]
            .as_array()
            .unwrap()
            .clone();
        let (caps, _) = validate_register(1, None, &raw, 100).unwrap();
        assert!(live::set_capabilities(device_id, handle.generation, 1, caps).await);
        (handle, rx)
    }

    /// A fake device: answers every invoke on the ctrl channel with `{shown:true}`.
    fn spawn_responder(
        device_id: String,
        mut handle: LiveHandle,
    ) -> tokio::task::JoinHandle<Vec<String>> {
        tokio::spawn(async move {
            let mut seen = Vec::new();
            while let Some(msg) = handle.ctrl_rx.recv().await {
                if let RhpServerMsg::CapabilityInvoke { request_id, .. } = msg {
                    seen.push(request_id.clone());
                    live::complete(
                        &device_id,
                        handle.generation,
                        &request_id,
                        Ok(json!({"shown": true})),
                    )
                    .await;
                }
            }
            seen
        })
    }

    #[tokio::test]
    async fn revocation_notifies_only_the_current_connection() {
        let _serial = live::TEST_SERIAL.lock().await;
        let device_id = unique("revocation-test");
        let (tx, _rx) = tokio::sync::mpsc::channel::<SessionOutput>(1);
        let mut first = live::register(&device_id, tx.clone(), meta(false)).await;
        let mut second = live::register(&device_id, tx, meta(false)).await;
        // The reconnect superseded the first connection; it is not a revoke.
        first
            .ended
            .changed()
            .await
            .expect("supersede watch remains live");
        assert_eq!(*first.ended.borrow(), Some(EndReason::Superseded));

        assert!(second.ended.borrow().is_none());
        assert!(live::revoke(&device_id).await);
        second
            .ended
            .changed()
            .await
            .expect("revocation watch remains live");
        assert_eq!(*second.ended.borrow(), Some(EndReason::Revoked));

        live::unregister(&device_id, second.generation).await;
        assert!(!live::is_connected(&device_id).await);
    }

    #[tokio::test]
    async fn invoke_and_complete() {
        let _serial = live::TEST_SERIAL.lock().await;
        let device_id = unique("invoke");
        let (handle, _rx) = connect_with_caps(&device_id, 4).await;
        let generation = handle.generation;
        let responder = spawn_responder(device_id.clone(), handle);
        let result = live::invoke(
            &device_id,
            "display.show_text",
            json!({"text": "Hi"}),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        assert_eq!(result, json!({"shown": true}));
        assert_eq!(live::pending_count(&device_id).await, 0);

        let caps = live::capabilities_for(&device_id).await.unwrap();
        assert_eq!(caps.cap_generation, 1);
        assert_eq!(caps.caps.len(), 2);
        assert!(live::capabilities()
            .await
            .iter()
            .any(|c| c.device_id == device_id));

        live::unregister(&device_id, generation).await;
        let seen = responder.await.unwrap();
        assert_eq!(seen, [format!("inv_{generation}_1")]);
    }

    #[tokio::test]
    async fn invoke_refusals() {
        let _serial = live::TEST_SERIAL.lock().await;
        let device_id = unique("refusals");
        assert_eq!(
            live::invoke(&device_id, "x", json!({}), Duration::from_secs(1)).await,
            Err(InvokeError::NotConnected)
        );
        let (tx, _rx) = mpsc::channel(1);
        let legacy = live::register(&device_id, tx, meta(false)).await;
        assert_eq!(
            live::invoke(&device_id, "x", json!({}), Duration::from_secs(1)).await,
            Err(InvokeError::NotSecure)
        );
        live::unregister(&device_id, legacy.generation).await;

        let (handle, _rx) = connect_with_caps(&device_id, 1).await;
        assert_eq!(
            live::invoke(&device_id, "led.set", json!({}), Duration::from_secs(1)).await,
            Err(InvokeError::UnknownCapability)
        );
        assert!(matches!(
            live::invoke(
                &device_id,
                "display.show_text",
                json!({"text": 5}),
                Duration::from_secs(1)
            )
            .await,
            Err(InvokeError::InvalidArgs(_))
        ));
        live::unregister(&device_id, handle.generation).await;
    }

    #[tokio::test]
    async fn timeout_cleans_up_the_pending_entry() {
        let _serial = live::TEST_SERIAL.lock().await;
        let device_id = unique("timeout");
        let (handle, _rx) = connect_with_caps(&device_id, 1).await;
        // Nobody answers; a 0 ms deadline waits only the 2 s grace.
        let started = std::time::Instant::now();
        let outcome = live::invoke(&device_id, "device.status", json!({}), Duration::ZERO).await;
        assert_eq!(outcome, Err(InvokeError::Timeout));
        assert!(started.elapsed() >= live::RESULT_GRACE);
        assert_eq!(live::pending_count(&device_id).await, 0);
        // A late completion for the timed-out id is ignored.
        let late = format!("inv_{}_1", handle.generation);
        assert!(!live::complete(&device_id, handle.generation, &late, Ok(json!({}))).await);
        live::unregister(&device_id, handle.generation).await;
    }

    #[tokio::test]
    async fn unregister_and_revoke_fail_pending_calls() {
        let _serial = live::TEST_SERIAL.lock().await;
        let device_id = unique("fail-pending");
        let (handle, _rx) = connect_with_caps(&device_id, 1).await;
        let id = device_id.clone();
        let call = tokio::spawn(async move {
            live::invoke(&id, "device.status", json!({}), Duration::from_secs(30)).await
        });
        while live::pending_count(&device_id).await == 0 {
            tokio::task::yield_now().await;
        }
        live::unregister(&device_id, handle.generation).await;
        assert_eq!(call.await.unwrap(), Err(InvokeError::Disconnected));

        let (handle, _rx) = connect_with_caps(&device_id, 1).await;
        let id = device_id.clone();
        let call = tokio::spawn(async move {
            live::invoke(&id, "device.status", json!({}), Duration::from_secs(30)).await
        });
        while live::pending_count(&device_id).await == 0 {
            tokio::task::yield_now().await;
        }
        assert!(live::revoke(&device_id).await);
        assert_eq!(call.await.unwrap(), Err(InvokeError::Revoked));
        // After a revoke the capabilities are withdrawn.
        assert!(live::capabilities_for(&device_id).await.is_none());
        live::unregister(&device_id, handle.generation).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn busy_when_four_calls_are_in_flight() {
        let _serial = live::TEST_SERIAL.lock().await;
        let device_id = unique("busy");
        let (handle, _rx) = connect_with_caps(&device_id, 1).await;
        let mut calls = Vec::new();
        for _ in 0..4 {
            let id = device_id.clone();
            calls.push(tokio::spawn(async move {
                live::invoke(&id, "device.status", json!({}), Duration::from_secs(30)).await
            }));
        }
        while live::pending_count(&device_id).await < 4 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            live::invoke(
                &device_id,
                "device.status",
                json!({}),
                Duration::from_secs(30)
            )
            .await,
            Err(InvokeError::Busy)
        );
        live::unregister(&device_id, handle.generation).await;
        for call in calls {
            assert_eq!(call.await.unwrap(), Err(InvokeError::Disconnected));
        }
    }

    #[tokio::test]
    async fn ctrl_is_delivered_while_the_main_channel_is_full() {
        let _serial = live::TEST_SERIAL.lock().await;
        let device_id = unique("priority");
        let (tx, mut out_rx) = mpsc::channel(256);
        for _ in 0..256 {
            tx.try_send(SessionOutput::Audio(vec![0xF8, 0xFF, 0xFE]))
                .unwrap();
        }
        let handle = live::register(&device_id, tx.clone(), meta(true)).await;
        let generation = handle.generation;
        let v: Value = serde_json::from_str(CAPS).unwrap();
        let raw = v["register_valid"]["capabilities"]
            .as_array()
            .unwrap()
            .clone();
        let (caps, _) = validate_register(1, None, &raw, 100).unwrap();
        assert!(live::set_capabilities(&device_id, generation, 1, caps).await);
        // The main channel is full: a best-effort nudge is dropped.
        assert!(!live::send(&device_id, RhpServerMsg::Pong).await);

        // Queue the invoke first (single-threaded runtime: once the pending entry
        // is visible, the invoke is already on the ctrl channel).
        let id = device_id.clone();
        let call = tokio::spawn(async move {
            live::invoke(
                &id,
                "display.show_text",
                json!({"text": "Hi"}),
                Duration::from_secs(5),
            )
            .await
        });
        while live::pending_count(&device_id).await == 0 {
            tokio::task::yield_now().await;
        }

        // The pump: a biased select drains ctrl before the full main channel.
        let mut ctrl_rx = handle.ctrl_rx;
        let mut drained_main = 0usize;
        loop {
            tokio::select! {
                biased;
                Some(msg) = ctrl_rx.recv() => {
                    if let RhpServerMsg::CapabilityInvoke { request_id, .. } = msg {
                        live::complete(&device_id, generation, &request_id, Ok(json!({"shown": true}))).await;
                        break;
                    }
                }
                Some(_) = out_rx.recv() => drained_main += 1,
            }
        }
        assert_eq!(
            drained_main, 0,
            "ctrl must not wait behind 256 queued audio items"
        );
        assert_eq!(call.await.unwrap(), Ok(json!({"shown": true})));
        live::unregister(&device_id, generation).await;
        drop(tx);
    }

    #[tokio::test]
    async fn stale_generation_completion_is_ignored() {
        let _serial = live::TEST_SERIAL.lock().await;
        let device_id = unique("stale");
        let (old, _rx_old) = connect_with_caps(&device_id, 1).await;
        let (new, _rx_new) = connect_with_caps(&device_id, 1).await;
        let new_generation = new.generation;
        let id = device_id.clone();
        let call = tokio::spawn(async move {
            live::invoke(&id, "device.status", json!({}), Duration::from_secs(30)).await
        });
        while live::pending_count(&device_id).await == 0 {
            tokio::task::yield_now().await;
        }
        let request_id = format!("inv_{new_generation}_1");
        // A result tagged with the superseded connection's generation is dropped.
        assert!(
            !live::complete(
                &device_id,
                old.generation,
                &request_id,
                Ok(json!({"stale": true}))
            )
            .await
        );
        assert!(!live::complete(&device_id, new_generation, "inv_0_9", Ok(json!({}))).await);
        assert!(
            live::complete(
                &device_id,
                new_generation,
                &request_id,
                Ok(json!({"fresh": true}))
            )
            .await
        );
        assert_eq!(call.await.unwrap(), Ok(json!({"fresh": true})));
        live::unregister(&device_id, new_generation).await;
        drop(new);
    }

    #[tokio::test]
    async fn oversized_result_and_device_errors() {
        let _serial = live::TEST_SERIAL.lock().await;
        let device_id = unique("results");
        let (handle, _rx) = connect_with_caps(&device_id, 1).await;
        let generation = handle.generation;
        let mut ctrl_rx = handle.ctrl_rx;
        let id = device_id.clone();
        let device = tokio::spawn(async move {
            let mut n = 0;
            while let Some(RhpServerMsg::CapabilityInvoke { request_id, .. }) = ctrl_rx.recv().await
            {
                n += 1;
                let outcome = if n == 1 {
                    Ok(json!({"blob": "x".repeat(20_000)}))
                } else {
                    live::result_outcome(
                        false,
                        None,
                        Some(crate::protocol::CapabilityErrorBody {
                            code: "unconfirmed".into(),
                            message: "no press".into(),
                        }),
                    )
                };
                live::complete(&id, generation, &request_id, outcome).await;
            }
        });
        assert_eq!(
            live::invoke(
                &device_id,
                "device.status",
                json!({}),
                Duration::from_secs(5)
            )
            .await,
            Err(InvokeError::ResultTooLarge)
        );
        let err = live::invoke(
            &device_id,
            "device.status",
            json!({}),
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code(), "unconfirmed");
        live::unregister(&device_id, generation).await;
        device.await.unwrap();
    }
}
