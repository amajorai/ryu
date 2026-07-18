//! Core's kernel side of the extracted [`ryu_vad`] seam.
//!
//! The `ryu-vad` crate owns the voice-activity-detection primitive — the
//! endpointing/barge-in state machine ([`ryu_vad::VadGate`]), the energy + Silero
//! speech-probability backends, the per-hop [`ryu_vad::Vad`] driver, and the Silero
//! model download spec + path. VAD is a per-frame HOT path, so it stays in-process
//! FOREVER (never IPC); the crate is a NON-optional path dependency the voice
//! session drives per uplink hop.
//!
//! The one coupling the crate cannot own — the active `~/.ryu` data dir the Silero
//! model resolves against (user-relocatable at runtime) — is injected through the
//! narrow [`ryu_vad::VadHost`] trait, implemented here and installed once at boot
//! via [`install`] (mirrors the `downloads`/`crypto` boot-install precedent). The
//! rest of the tree keeps using `crate::voice::vad::{Vad, VadEvent, VAD_RATE,
//! silero_download_spec, …}` unchanged via the glob re-export below.

pub use ryu_vad::*;

use std::path::PathBuf;

/// Install [`CoreVadHost`] as the process-global VAD host. Called once from `main`
/// at boot, before the first voice session can construct a [`ryu_vad::Vad`].
pub fn install() {
    ryu_vad::set_global_host(std::sync::Arc::new(CoreVadHost));
}

/// Core's [`ryu_vad::VadHost`] — resolves the active `~/.ryu` data dir the Silero
/// model lives under.
pub struct CoreVadHost;

impl ryu_vad::VadHost for CoreVadHost {
    fn ryu_dir(&self) -> PathBuf {
        crate::paths::ryu_dir()
    }
}
