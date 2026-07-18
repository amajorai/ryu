//! Ryu Hardware Protocol (RHP v1) node backend — an extracted Core capability crate.
//!
//! This crate is the node half of the Ryu Hardware Protocol defined in
//! `apps/hardware/PROTOCOL.md`. Ryu hardware (watch / necklace / desk, all
//! ESP32-S3) talks to a node over a WebSocket, either directly over WiFi (Mode B)
//! or tunneled through the mobile app over BLE (Mode A — transparent to the node).
//!
//! ## Layout
//!
//! - [`protocol`] — serde structs/enums mirroring PROTOCOL.md §3 (the wire
//!   contract shared by the firmware and mobile relay mirrors).
//! - [`store`] — the device registry (SQLite): paired devices, per-device
//!   revocable Bearer tokens, last-seen/battery presence.
//! - [`pairing`] — pairing-nonce verification and token issuance.
//! - [`codec`] — the Opus/WAV codec edge, so the rest of Core sees PCM/WAV.
//! - [`session`] — the per-connection realtime session state machine (audio
//!   buffering + the ambient meetings bridge, via the [`ingest::MeetingIngest`]
//!   seam), the live device-sender registry, and
//!   [`session::SessionOutput`]/[`session::TurnInput`].
//! - [`ingest`] — the [`ingest::MeetingIngest`] seam inverting the ambient-audio
//!   coupling so this crate never links `ryu_meetings`.
//! - [`feed`] — the [`feed::DashboardFeed`] seam inverting the device-dashboard
//!   render coupling so this crate never links `ryu_dashboards`.
//! - [`nudge`] — the live display-nudge loop (dashboard change → device re-poll).
//! - [`api`] — the device-registry CRUD + TRMNL display HTTP surface.
//!
//! ## What stays Core-side (consumers of this crate's types)
//!
//! The **public ws/pair ingress route** (a per-device Bearer/nonce the global
//! `RYU_TOKEN` `require_auth` cannot gate, plus node-URL resolution welded to the
//! mesh + the SSRF guard) and the **chat-turn orchestration** (welded to Core's
//! `run_text_turn` / voice ASR / OuteTTS session loop) stay in `apps/core` and
//! consume this crate's [`session::HardwareSession`]/[`session::TurnInput`]/
//! [`session::SessionOutput`]/[`protocol`] types — the documented kernel weld,
//! exactly the teams `@team`-orchestration precedent.
//!
//! Placement (Core vs Gateway): the device registry, token lifecycle, and the
//! realtime session decide *what runs*, so they are Core-tier.

pub mod api;
pub mod codec;
pub mod feed;
pub mod ingest;
pub mod nudge;
pub mod pairing;
pub mod protocol;
pub mod session;
pub mod store;

pub use feed::{
    DashboardFeed, DeviceBinding, DeviceManifest, RenderedImage, ScreenProfile, SetDeviceResult,
};
pub use ingest::MeetingIngest;
pub use session::{live, HardwareSession, SessionOutput, TurnInput};
pub use store::{hash_token, DeviceRecord, DeviceStore};
