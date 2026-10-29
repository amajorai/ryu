//! Core-side kernel remainder of the Ryu Hardware Protocol (RHP v1.1).
//!
//! The device registry, protocol wire types, pairing, the Opus/WAV codec, the
//! per-connection buffering session, the live sender registry, the display-nudge
//! loop, and the device-registry + display HTTP surface were all extracted into
//! the [`ryu_hardware`] crate (`crates/core/hardware`). Core consumes it as a
//! NON-optional path dependency (the codec is also used by the voice module, the
//! store backs `ServerState` in every build).
//!
//! What stays here is the irreducible kernel weld:
//!
//! - [`turn`] — the chat-turn orchestration that runs a captured device turn
//!   through Core's own session seams (`run_text_turn` + voice ASR + OuteTTS). It
//!   is welded to `apps/core` kernel types, so it stays Core-side as a consumer of
//!   the crate's `TurnInput`/`SessionOutput`/`protocol` types — the teams
//!   `@team`-orchestration precedent.
//! - [`node_key`] — the at-rest sealer for the node's static X25519 identity
//!   ([`ryu_hardware::identity::NodeKeySealer`] over Core's global field cipher).
//!
//! The public WebSocket ingress lives in `server::hardware_ws`; the protected
//! pairing and identity-reset routes live in `server::hardware_public` (kernel
//! ingress that forwards to the crate). Device capabilities reach agents through
//! the reserved `device` MCP server (`sidecar::mcp::device_tool`).

pub mod node_key;
pub mod turn;
