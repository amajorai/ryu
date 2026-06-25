//! Ryu hardware support (RHP v1) — node side of the device protocol.
//!
//! This module is the Core half of the Ryu Hardware Protocol defined in
//! `apps/hardware/PROTOCOL.md`. Ryu hardware (watch / necklace / desk, all
//! ESP32-S3) talks to a node over a WebSocket (`/api/hardware/ws`), either
//! directly over WiFi (Mode B) or tunneled through the mobile app over BLE
//! (Mode A — transparent to the node).
//!
//! ## Layout
//!
//! - [`protocol`] — serde structs/enums mirroring PROTOCOL.md §3. The wire
//!   contract, shared by the firmware (C) and mobile relay (TS) mirrors.
//! - [`store`] — the device registry (SQLite): paired devices, per-device
//!   revocable Bearer tokens, last-seen/battery presence. Extends the
//!   connections/presence model (§6). **Stub** this phase.
//! - [`pairing`] — pairing-nonce verification and token issuance for
//!   `POST /api/hardware/pair` (§5). **Stub** this phase.
//! - [`session`] — per-connection WS session state: decode Opus uplink →
//!   whisper.cpp transcribe → chat turn (in-process) → TTS (OuteTTS) → Opus
//!   downlink; and the ambient path → meetings chunk pipeline. Reuses existing
//!   Core seams (`server::chat_stream`, `server::voice`, `meetings_api`). The
//!   WS handler itself lands in `server::hardware_ws` in a later phase.
//!   **Stub** this phase.
//!
//! ## Placement (Core vs Gateway)
//!
//! Per `CLAUDE.md` §1, the device registry, token lifecycle, and the realtime
//! session decide *what runs*, so they live in Core. None of this is wired into
//! the router yet — the Core agent does that in the next phase.

pub mod protocol;

// Realtime + registry implementation. Consumed by `server::hardware_ws` (the WS
// handler) and `server::hardware_api` (the REST registry surface).
pub mod codec;
pub mod nudge;
pub mod pairing;
pub mod session;
pub mod store;
