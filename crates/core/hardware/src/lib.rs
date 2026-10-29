//! Ryu Hardware Protocol (RHP v1.1) node backend — an extracted Core capability crate.
//!
//! This crate is the node half of the Ryu Hardware Protocol defined in
//! `apps/hardware/PROTOCOL.md`. Ryu hardware (watch / necklace / desk, all
//! ESP32-S3) talks to a node over a WebSocket, either directly over WiFi (Mode B)
//! or relayed by the mobile app over BLE (Mode A). Paired v1.1 devices run an
//! end-to-end `Noise_XX_25519_AESGCM_SHA256` session inside that socket, so the
//! relaying phone sees only ciphertext; v1 devices keep the legacy plaintext
//! session until they are re-paired.
//!
//! ## Layout
//!
//! - [`protocol`] — serde structs/enums mirroring PROTOCOL.md §3 and the pairing
//!   REST bodies (the wire contract shared by the firmware and mobile mirrors),
//!   plus two-step [`protocol::parse_client_msg`].
//! - [`noise`] — the hand-written Noise rev 34 XX handshake and cipher states.
//! - [`secure`] — RHN: outer frames, the node and device handshake roles, and the
//!   owned send/receive halves (fragmentation, rekey, limits).
//! - [`identity`] — the node's static X25519 identity and the host-supplied
//!   [`identity::NodeKeySealer`] that seals it at rest.
//! - [`pair_crypto`] — pairing v2 commitment, transcript, SAS, confirm tag and
//!   credential sealing.
//! - [`pairing`] — legacy v1 nonce pairing and the v2 begin/reveal/confirm/cancel
//!   flows.
//! - [`capability`] — device capability validation, JSON-schema translation,
//!   argument checks and tool naming (rules shared with the C firmware).
//! - [`store`] — the device registry (SQLite): paired devices, per-device and
//!   relay tokens, pinned keys, pending pairings, the consumed-nonce ledger and
//!   the sealed node identity.
//! - [`codec`] — the Opus/WAV codec edge, so the rest of Core sees PCM/WAV.
//! - [`session`] — the per-connection realtime session state machine (audio
//!   buffering + the ambient meetings bridge, via the [`ingest::MeetingIngest`]
//!   seam), the live connection registry with capability invoke
//!   ([`session::live`]), and [`session::SessionOutput`]/[`session::TurnInput`].
//! - [`ingest`] — the [`ingest::MeetingIngest`] seam inverting the ambient-audio
//!   coupling so this crate never links `ryu_meetings`.
//! - [`feed`] — the [`feed::DashboardFeed`] seam inverting the device-dashboard
//!   render coupling so this crate never links `ryu_dashboards`.
//! - [`nudge`] — the live display-nudge loop (dashboard change → device re-poll).
//! - [`api`] — the device-registry CRUD + TRMNL display HTTP surface.
//!
//! ## What stays Core-side (consumers of this crate's types)
//!
//! - The **public ws ingress** (`server::hardware_ws`): a per-device Bearer the
//!   global `RYU_TOKEN` `require_auth` cannot gate, resolved with
//!   [`store::DeviceStore::authenticate_bearer`] before any DH, then driven
//!   through [`secure`].
//! - The **protected pairing routes** (`server::hardware_public`): legacy `pair`,
//!   `pair/{begin,reveal,confirm,cancel}` and `identity/reset`, over [`pairing`],
//!   plus node-URL resolution welded to the mesh + the SSRF guard.
//! - The **chat-turn orchestration** (welded to Core's `run_text_turn` / voice ASR /
//!   OuteTTS session loop) and the reserved `device` MCP server that exposes
//!   device capabilities to agents.
//!
//! This crate has ZERO dependency on `apps/core`.
//!
//! Placement (Core vs Gateway): the device registry, token lifecycle, and the
//! realtime session decide *what runs*, so they are Core-tier.

pub mod api;
pub mod capability;
pub mod codec;
pub mod feed;
pub mod identity;
pub mod ingest;
pub mod noise;
pub mod nudge;
pub mod pair_crypto;
pub mod pairing;
pub mod protocol;
pub mod secure;
pub mod session;
pub mod store;

pub use feed::{
    DashboardFeed, DeviceBinding, DeviceManifest, RenderedImage, ScreenProfile, SetDeviceResult,
};
pub use ingest::MeetingIngest;
pub use session::{live, HardwareSession, SessionOutput, TurnInput};
pub use store::{hash_token, DeviceRecord, DeviceStore};
