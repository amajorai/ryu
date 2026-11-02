//! Model catalog — the orchestration logic behind Ryu's "browse and install a
//! model" experience. **All logic lives here in Core** so every surface
//! (desktop, mobile, CLI, extension) reuses the exact same search, ranking,
//! device-fit, stats, and install behaviour through one HTTP API. Clients are
//! pure GUI layers.
//!
//! Placement rationale (Core vs Gateway, see CLAUDE.md §1): discovering *which*
//! model to run and downloading its weights is "what runs" — orchestration —
//! so it belongs in Core. The Gateway still governs every model *call*
//! (routing, budgets, policy); this module never makes inference calls.
//!
//! What it does, all swappable and graceful:
//! - **Search** the Hugging Face Hub, restricted to GGUF (llama.cpp-runnable)
//!   models, with friendly sort orders and an installed-only view.
//! - **Detail** a model: its README, every GGUF quant file with real sizes, and
//!   for each file a plain-language [`device::FitVerdict`] ("runs on your
//!   device") computed from detected RAM.
//! - **Stats** from Artificial Analysis ([`aa`]) when an API key is configured,
//!   degrading silently to no stats otherwise.
//! - **Install** a chosen GGUF by reusing the shared, checksum-verifying
//!   [`GgufDownloader`]; provenance is recorded so the catalog shows what's
//!   installed.
//!
//! Nothing is hardcoded to a single model: the Hub is the source, the local
//! engine (llama.cpp) consumes the downloaded weights, and the bundled default
//! still comes from the swappable the swappable local model registry.

pub mod aa;
pub mod capabilities;
pub mod device;
pub mod gguf;
pub mod insight;
pub mod installed;
pub mod llmfit;
pub mod models_dev;
pub mod openrouter_meta;
pub mod ryu_free_models;
pub(crate) mod win_process;

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use anyhow::{Context, Result};
use serde::Serialize;

use device::{estimate_fit, estimate_install_fit, human_bytes, DeviceInfo, FitVerdict};
use ryu_model_format::ModelFormat;
use ryu_sidecar_runtime::layout::{self, Modality};

mod catalog_host;
mod descriptor;
mod detail;
mod hf;
mod install;
mod local_files;
mod naming;
mod search;
mod snapshot;
#[cfg(test)]
mod test_support;

pub use catalog_host::*;
pub use descriptor::*;
pub use detail::*;
pub use hf::*;
pub use install::*;
pub use local_files::*;
pub use naming::*;
pub use search::*;
pub use snapshot::*;
