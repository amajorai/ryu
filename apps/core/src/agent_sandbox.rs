//! OS-level containment for Ryu-managed ACP agents.
//!
//! The Codex hook and command scanner are policy guardrails, but an ACP agent
//! still runs as a child process. This module inserts a tiny Ryu-owned runner
//! between the ACP client and the agent so the operating system enforces limits
//! before the agent's shell or any descendant starts. The runner is the Core
//! binary re-executed with [`AGENT_SANDBOX_RUNNER_ARG`]; options between the
//! marker and `--` select what it confines.
//!
//! Two layers:
//!
//! - **Deletion denial** (managed Codex, always). Linux uses Landlock with
//!   `REMOVE_FILE` and `REMOVE_DIR` handled and no allow rules; macOS uses a
//!   narrow Seatbelt profile. Windows fails closed for managed Codex until Ryu
//!   has a native AppContainer runner. Other agents opt out with
//!   `--allow-delete`: their process contracts (atomic renames of their own
//!   state files) have not been audited against it.
//! - **Untrusted-workspace profile** (every ACP agent whose folder is not
//!   trusted, see [`crate::workspace_trust`]). Credential stores in the home
//!   directory and Core's own state files are hidden from the agent, and its
//!   network is cut to the Ryu Gateway (and Core, for the managed Pi) so a
//!   payload a repository talks the agent into running cannot read keys or
//!   send them anywhere.
//!   - Linux: a private user + mount + network namespace. Credential paths are
//!     covered by empty read-only mounts, then a second user namespace locks
//!     those mounts so the agent cannot unmount them. Inside the network
//!     namespace only loopback exists; a forwarder there relays the allowed
//!     ports over Unix sockets to Core, which connects them to the real
//!     loopback services ([`ensure_loopback_relay`]).
//!   - macOS: a Seatbelt profile denying reads and writes of the same paths
//!     and all outbound network except `localhost`.
//!   - Hosts without the needed primitives (Windows, Linux without
//!     unprivileged user namespaces) report [`untrusted_support`] as
//!     unavailable; Core then runs the agent unconfined and says so, keeping
//!     the workspace-trust permission rules as the remaining guard.
//! - **Account-access profile** (every ACP agent whose account access is
//!   limited, see [`crate::agent_access::AccountConfinement`], in any folder).
//!   The same mask mechanism hides Core's tokens, keys, databases, state, app
//!   data and logs ([`account_restricted_masks`]), and, when the agent's model
//!   providers are limited, every stored provider key and sign-in except the
//!   one its own engine signs in with. Its network is left alone unless the
//!   folder is also untrusted. Without the runner this profile cannot be
//!   applied, so Core refuses the agent instead (Ryu's own engine may still run
//!   with its shell and file tools off).
//!   - macOS also denies the user's Keychain ([`UntrustedProfile::deny_keychain`]):
//!     Seatbelt refuses the Keychain daemons' Mach services
//!     ([`KEYCHAIN_MACH_SERVICES`]) and `~/Library/Keychains`
//!     ([`keychain_masks`]), so neither the `security` CLI nor the Security
//!     framework can read an item from inside the sandbox. `(allow default)`
//!     still lets the tree ask launchd or LaunchServices (`launchctl submit`,
//!     `open`) to start a job, which runs unconfined, so this denies the
//!     sandboxed process tree, not every way the agent could reach the
//!     Keychain (the file masks share that gap; not verified on a Mac).
//!     Seatbelt cannot allow single items, so an
//!     engine whose own sign-in lives in the Keychain (Claude Code) keeps the
//!     whole Keychain; Core decides that per engine. Linux's Secret Service
//!     (reached over the D-Bus session bus) is not covered.
//!
//! None of this is a VM: the agent still runs as the user, can read the
//! repository and anything not listed here, and UDP/DNS is only cut on Linux.
//! It narrows what a hijacked agent can reach; it does not make untrusted code
//! safe to run.

use std::path::{Path, PathBuf};

use agent_client_protocol::schema::v1::McpServerStdio;
use anyhow::{bail, Context, Result};

mod codex_identity;
#[cfg(test)]
mod core_policy_classifier_tests;

mod codex_launch;
#[cfg(target_os = "linux")]
mod linux;
mod masks;
mod relay;
mod runner;
#[cfg(test)]
mod tests;

pub use codex_identity::is_codex_stdio;
pub use codex_launch::*;
pub use masks::*;
pub use relay::*;
pub use runner::*;

/// Marker argument used when the Ryu Core binary is acting as the child runner.
pub const AGENT_SANDBOX_RUNNER_ARG: &str = "--ryu-agent-sandbox-runner";

const ARG_SEPARATOR: &str = "--";

/// Runner option: do not install deletion denial (non-Codex agents).
const OPT_ALLOW_DELETE: &str = "--allow-delete";
/// Runner option: hide this path (repeatable).
const OPT_MASK: &str = "--mask";
/// Runner option: cut the network except relayed loopback ports.
const OPT_ISOLATE_NETWORK: &str = "--isolate-network";
/// Runner option: deny the user's Keychain (macOS; ignored elsewhere).
const OPT_DENY_KEYCHAIN: &str = "--deny-keychain";
/// Runner option: a loopback TCP port to relay out of the isolated network.
const OPT_LOOPBACK_PORT: &str = "--loopback-port";
/// Runner option: the directory holding Core's per-port relay sockets.
const OPT_RELAY_DIR: &str = "--relay-dir";
/// Marker argument for the one-shot capability probe (Linux).
pub const AGENT_SANDBOX_PROBE_ARG: &str = "--ryu-agent-sandbox-probe";
