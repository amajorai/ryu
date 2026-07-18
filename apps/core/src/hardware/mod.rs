//! Core-side kernel remainder of the Ryu Hardware Protocol (RHP v1).
//!
//! The device registry, protocol wire types, pairing, the Opus/WAV codec, the
//! per-connection buffering session, the live sender registry, the display-nudge
//! loop, and the device-registry + display HTTP surface were all extracted into
//! the [`ryu_hardware`] crate (`crates/ryu-hardware`). Core consumes it as a
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
//!
//! The public ws/pair ingress lives in `server::hardware_ws` +
//! `server::hardware_public` (kernel ingress that forwards to the crate).

pub mod turn;
