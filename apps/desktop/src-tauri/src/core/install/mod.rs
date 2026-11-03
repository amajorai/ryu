//! Production-only auto-install of the out-of-process Ryu sidecar binaries from the
//! public download hub (amajorai/ryu) into `~/.ryu/bin/`. In dev the binaries are
//! owned by turbo (`bun run dev:core` / `dev:gateway`), so this path never runs
//! there — `lib.rs` gates every call on `not(debug_assertions)`.
//!
//! The binaries are resolved by Core the same way (env override else bare command
//! name on a PATH that includes `~/.ryu/bin`), split into two policy classes:
//!
//! **Required (loud on failure):**
//!   - `ryu-core`     — the orchestration engine (auto-installed since day one).
//!   - `ryu-gateway`  — the control layer Core spawns as a managed sidecar.
//!                      Core hands every model call to it (`sidecar/gateway.rs`,
//!                      `DEFAULT_GATEWAY_BIN = "ryu-gateway"`, resolved on PATH). Nothing
//!                      installed it before this module — that was the real gap.
//!
//! **App sidecars (opt-in feature backends) are NOT installed here.** This desktop
//! layer only fetches the two required bins above. Each apps-store app's `ryu-<app>`
//! binary (mail/teams/research/clips/finetune/quests/healing/meetings/recipes/
//! dashboards/monitors) is downloaded by **Core on-demand the first time the app is
//! enabled**, and removed on uninstall — tying the binary to the app lifecycle
//! instead of a blanket boot-prefetch. See
//! `apps/core/src/sidecar/manifest_sidecar.rs` (`ensure_local_sidecar_present` /
//! `remove_local_sidecar_binaries`) and `plans/019-sidecar-binary-lifecycle.md`.
//! (`ryu-browser` is an Electron bundle, never a single-file spawnable, and still
//! resolves only when already on PATH via `RYU_BROWSER_BIN`.)
//!
//! **One verified download path.** Desktop runs only the canonical installer
//! bundled into its signed app ([`installer_script`]), from a Ryu-owned scratch
//! folder rather than the shared temp directory, into a staged generation. Before
//! any staged binary runs, [`release_digests`] pins every one of them to the
//! SHA-256 digest GitHub published for its release asset, fetched over HTTPS with
//! redirects refused. The direct `releases/latest` downloader that wrote straight
//! into `~/.ryu/bin` with no checksum had no callers and was deleted; a guard in
//! `tests.rs` keeps it from returning.

mod binaries;
mod installer_script;
mod island;
mod release_digests;
mod stack;

pub(crate) use binaries::{managed_core_path, managed_gateway_path};
pub(crate) use stack::{prepare_app_runtime, prepared_core_for_update};
// Their callers in `app_setup.rs` and `core_lifecycle.rs` exist only in release
// builds (`not(debug_assertions)`), where dev builds leave the runtime to turbo.
#[cfg_attr(debug_assertions, allow(unused_imports))]
pub use binaries::is_managed_core_stale;
#[cfg_attr(debug_assertions, allow(unused_imports))]
pub use island::{ensure_island_installed, launch_island};
#[cfg_attr(debug_assertions, allow(unused_imports))]
pub use stack::{ensure_gateway_installed, ensure_unified_installed};
#[cfg_attr(debug_assertions, allow(unused_imports))]
pub(crate) use stack::has_prepared_runtime;

#[cfg(test)]
mod tests;
