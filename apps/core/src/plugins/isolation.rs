//! Which installed plugins actually run sandboxed — and which run with full host
//! access, on whose authority.
//!
//! Ryu runs plugin code on lanes with **very different** isolation strength, and
//! until this module nothing reported the difference:
//!
//! - The **JS sandbox lane** (turn hooks, capability adapters, inline tools, PTC
//!   tool-exec) is a real sandbox: a WebAssembly instance with no filesystem,
//!   network or environment, whose only door out is the host bridge. A manifest
//!   granting filesystem or network is refused; `child_process` admits only the
//!   bare program names the manifest's `run` list and capability shims name. See
//!   `ryu_tool_exec`'s `js_backend`.
//! - The **browser lane** (a plugin's `ui_code` bundle) renders in an iframe with
//!   `sandbox="allow-scripts"` and no `allow-same-origin` — browser-enforced.
//! - The **native lane** (manifest `sidecars`, `mcp_servers`) has **no enforcement
//!   mechanism at all**. `crate::sidecar::manifest_sidecar` says so in as many
//!   words: a declared `permissions` set is "RECORDED BUT NOT OS-ENFORCED … the
//!   process runs unsandboxed with full host access". A `kind: "node"` sidecar is
//!   additionally gated behind the experimental-plugin-runtime flag, but the gate
//!   controls *whether it spawns*, not *what it can reach once spawned*.
//!
//! # Unenforceable is not the same as exempt
//!
//! These are kept as separate fields on purpose, and must never be collapsed into
//! one "unsandboxed" badge:
//!
//! - [`Enforcement::Unenforceable`] — the lane has no mechanism. **Nobody chose
//!   this.** It is a statement about Ryu, not about the plugin or the user.
//! - [`HostAccess::Permitted`] — the lane runs with host access and a trust basis
//!   says that is allowed.
//!
//! If the two ever render as one badge, then the day OS-level sandboxing lands for
//! native sidecars, every native app silently converts from "we cannot isolate
//! this" into "someone exempted this", and the trust allowlist becomes
//! retroactively load-bearing for plugins that never passed through it.
//!
//! # System plugins are described, not exempted
//!
//! [`TrustBasis::SystemPlugin`] is **descriptive**. A system plugin is compiled
//! into the Core binary via `include_str!` (see [`crate::plugins::builtins`]); it
//! was never a candidate for the sandbox in the first place, so calling it
//! "exempt" would imply a policy decision that does not exist.
//!
//! # Trust is captured at install, never fetched at spawn
//!
//! `org_verified` is control-plane state (an admin decision recorded in the
//! marketplace, see `packages/db/src/models/org-verification.model.ts`). This
//! module reads it only from [`PluginProvenance`] persisted at install time. It is
//! deliberately **not** fetched live when deciding isolation: that would make a
//! local security decision depend on network reachability, and a timeout that
//! fails open is a bypass.
//!
//! The cost of that choice, stated rather than left implicit: **revocation is not
//! retroactive**. If an org loses verification after a user installed its plugin,
//! the captured provenance keeps saying `org_verified = true` until the plugin is
//! updated or reinstalled. [`PluginProvenance::captured_at`] exists so a future
//! staleness policy can expire a capture without a schema change.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::plugin_manifest::schema::SidecarProcess;
use crate::plugin_manifest::PluginManifest;

/// The catalog source id of the first-party Ryu marketplace. Items served by this
/// source went through the publish boundary in `packages/api/src/routers/
/// marketplace.ts` (caps, review state, signature verification, channel
/// derivation) — which is what makes it a usable trust signal at all.
pub const OFFICIAL_MARKETPLACE_SOURCE_ID: &str = "ryu-marketplace";

/// Preference key: the user's explicit list of plugin ids allowed to run
/// host-access lanes. **Not** a bypass — an id here is only honoured when its
/// captured provenance already vouches for the publisher. See
/// [`TrustPolicy::resolve_trust`].
pub const TRUSTED_IDS_PREF: &str = "ryu:plugins-trusted-ids";

/// Preference key: when truthy, a plugin whose host-access lane has no trust basis
/// is refused rather than merely reported. **Default off** — turning it on is a
/// tightening that can stop an already-installed sideloaded app from running, so
/// it is the user's call, not a silent upgrade.
pub const REQUIRE_TRUST_PREF: &str = "ryu:plugins-require-trust-for-host-access";

/// Why Core will not run a plugin's host-access lanes right now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub enum HostAccessRefusal {
    /// The installed plugin (or this installed version of it) is on the node's
    /// local revocation list ([`crate::plugins::PluginStore::revoke`]).
    Revoked { entry: String },
    /// [`REQUIRE_TRUST_PREF`] is on and the plugin's host-access lane has no
    /// trust basis.
    UntrustedHostAccess,
}

impl std::fmt::Display for HostAccessRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Revoked { entry } => write!(
                f,
                "plugin is revoked on this node ('{entry}'); remove the revocation to run it again"
            ),
            Self::UntrustedHostAccess => f.write_str(
                "plugin runs unsandboxed host-access lanes (sidecars, MCP servers, Pi \
                 extensions or LSP servers) with no trust basis, and this node requires trust \
                 for host access",
            ),
        }
    }
}

/// What a lane's isolation mechanism can actually enforce.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Enforcement {
    /// A real, mechanically-enforced sandbox denies by default (JS sandbox lane, or the
    /// browser's iframe sandbox for UI bundles).
    Sandboxed,
    /// No isolation mechanism exists for this lane today. The process runs with
    /// the full ambient authority of the Core process. Nobody chose this.
    Unenforceable,
}

/// A distinct way a plugin can execute code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LaneKind {
    /// `contributes.turn_hooks[]` — a JS fragment spliced into an async IIFE and
    /// run in the JS sandbox on the turn boundary.
    TurnHook,
    /// `provides[].tools.<verb>.adapter` — a capability adapter body, same lane.
    CapabilityAdapter,
    /// The plugin's `ui_code` bundle, rendered in a `sandbox="allow-scripts"`
    /// iframe without `allow-same-origin`.
    UiBundle,
    /// A `sidecars[]` entry: an out-of-process backend. Full host access.
    Sidecar,
    /// A `mcp_servers` entry: a spawned MCP server subprocess. Full host access.
    McpServer,
    /// A `contributes.pi_extensions` file: TypeScript the managed Pi process
    /// loads with its own (full host) privilege.
    PiExtension,
    /// A `contributes.lsp_servers` entry: a spawned language-server process.
    LspServer,
    /// The top-level `runtime` block: an external runtime Core provisions on
    /// enable (a venv plus `pip install` of manifest-chosen requirements, whose
    /// build hooks run on the host). Full host access.
    ExternalRuntime,
}

impl LaneKind {
    /// The enforcement this lane's mechanism provides. A property of Ryu's
    /// implementation, never of the individual plugin.
    #[must_use]
    pub const fn enforcement(self) -> Enforcement {
        match self {
            Self::TurnHook | Self::CapabilityAdapter | Self::UiBundle => Enforcement::Sandboxed,
            Self::Sidecar
            | Self::McpServer
            | Self::PiExtension
            | Self::LspServer
            | Self::ExternalRuntime => Enforcement::Unenforceable,
        }
    }
}

/// One executable lane a plugin declares.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaneReport {
    pub kind: LaneKind,
    pub enforcement: Enforcement,
    /// Human-readable identifier for the specific lane instance (hook id, sidecar
    /// name, MCP server key) so a report can point at *which* one needs host access.
    pub detail: String,
}

/// Why a plugin's host-access lane is (or is not) considered vouched for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "basis", rename_all = "snake_case")]
pub enum TrustBasis {
    /// Compiled into the Core binary. Descriptive, not a grant — see the module
    /// docs.
    SystemPlugin,
    /// The publishing organization carries the marketplace identity check.
    VerifiedPublisher {
        org: Option<String>,
        tier: Option<String>,
    },
    /// Served by the first-party Ryu marketplace, which applies a publish
    /// boundary, but the publishing org is not identity-verified.
    OfficialMarketplace,
    /// The user named this id in [`TRUSTED_IDS_PREF`] *and* its provenance already
    /// vouched for the publisher.
    UserAllowlisted,
    /// No basis. Sideloaded, third-party source, or provenance never captured.
    Untrusted,
}

impl TrustBasis {
    /// Whether this basis vouches for running an unenforceable lane.
    #[must_use]
    pub const fn vouches(&self) -> bool {
        !matches!(self, Self::Untrusted)
    }
}

/// The verdict on a plugin's use of host-access lanes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum HostAccess {
    /// The plugin declares no unenforceable lane. Everything it runs is sandboxed.
    NotRequested,
    /// It runs an unenforceable lane and something vouches for the publisher.
    Permitted { basis: TrustBasis },
    /// It runs an unenforceable lane with nothing vouching for it.
    Unvetted,
}

/// Where an installed plugin came from, captured at install time.
///
/// `None` on a [`crate::plugins::PluginRecord`] means the column predates this
/// feature or the install path never supplied it. That reads as **untrusted**,
/// never as trusted-by-default — see [`TrustPolicy::resolve_trust`] and its test.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginProvenance {
    /// Catalog source that served the install (`ryu-marketplace`, `github-topic`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    /// Publishing organization id, when the source reported one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher_org: Option<String>,
    /// The marketplace blue check on the publishing ORG at install time.
    #[serde(default)]
    pub org_verified: bool,
    /// Verification tier, only meaningful alongside `org_verified`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_verified_tier: Option<String>,
    /// Whether the manifest signature verified at install.
    #[serde(default)]
    pub signature_verified: bool,
    /// Digest of the exact manifest bytes accepted by the signed install path.
    /// This binds reloaded on-disk bytes to the provenance; an ID match alone
    /// must never restore Core privileges.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_sha256: Option<String>,
    /// Transitional marker for a manifest compiled into the Core binary. This
    /// means official Ryu content, not system status; system status is derived
    /// only from `SYSTEM_PLUGINS`.
    #[serde(default)]
    pub builtin: bool,
    /// RFC3339 capture time, so a future staleness policy can expire a capture
    /// without a schema change (revocation is not retroactive — see module docs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub captured_at: Option<String>,
}

pub use digest::{manifest_sha256, manifest_sha256_for_trust};

impl PluginProvenance {
    /// Provenance for a manifest compiled into the Core binary.
    #[must_use]
    pub fn builtin() -> Self {
        Self {
            source_id: Some("built-in".to_owned()),
            builtin: true,
            captured_at: Some(chrono::Utc::now().to_rfc3339()),
            ..Self::default()
        }
    }
}

/// User configuration governing host-access lanes.
#[derive(Debug, Clone, Default)]
pub struct TrustPolicy {
    /// Plugin ids the user explicitly trusts ([`TRUSTED_IDS_PREF`]).
    pub trusted_ids: BTreeSet<String>,
    /// Refuse, rather than report, an unvetted host-access lane
    /// ([`REQUIRE_TRUST_PREF`]).
    pub require_trust_for_host_access: bool,
    /// The node's local revocation entries (`id` or `id@version`), read from
    /// [`crate::plugins::PluginStore::list_revocations`]. Revocation only ever
    /// tightens, so an unreadable list is reported, not trusted.
    pub revoked: BTreeSet<String>,
}

/// Whether the manifest Core has loaded no longer matches the manifest the
/// recorded provenance vouched for.
///
/// - Signed marketplace installs record [`PluginProvenance::manifest_sha256`] over
///   the exact accepted manifest; any other loaded manifest has drifted.
/// - Compiled (`builtin`) provenance vouches only for the manifest compiled into
///   this binary, so a loaded manifest that is not that exact manifest has drifted.
/// - A legacy signed row without a digest cannot be compared and is not reported as
///   drifted here; the startup re-verification backfills its digest.
#[must_use]
pub fn manifest_drifted(manifest: &PluginManifest, provenance: Option<&PluginProvenance>) -> bool {
    let Some(provenance) = provenance else {
        return false;
    };
    if provenance.builtin {
        return !crate::plugins::builtins::is_exact_compiled_manifest(manifest);
    }
    provenance
        .manifest_sha256
        .as_deref()
        .is_some_and(|recorded| recorded != manifest_sha256(manifest))
}

pub use policy::{load_trust_policy, revocation_matches};

/// The full isolation report for one installed plugin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginIsolation {
    pub id: String,
    pub name: String,
    /// Every executable lane the manifest declares.
    pub lanes: Vec<LaneReport>,
    /// Whether every lane it runs is mechanically sandboxed. True (vacuously) for
    /// a plugin that declares no executable lane at all.
    pub fully_sandboxed: bool,
    /// The lanes with no enforcement mechanism. Empty ⇒ nothing to vet.
    pub unenforceable_lanes: Vec<LaneReport>,
    pub trust: TrustBasis,
    pub host_access: HostAccess,
    /// The loaded manifest no longer matches the manifest its provenance vouched
    /// for, so `trust` was downgraded ([`manifest_drifted`]).
    #[serde(default)]
    pub manifest_drifted: bool,
}

impl PluginIsolation {
    /// Whether policy says this plugin's host-access lanes must be refused.
    ///
    /// Only ever true when the user has explicitly turned on
    /// [`REQUIRE_TRUST_PREF`]: the default is to report, not to break an install
    /// that worked yesterday.
    #[must_use]
    pub fn should_refuse_host_access(&self, policy: &TrustPolicy) -> bool {
        policy.require_trust_for_host_access && matches!(self.host_access, HostAccess::Unvetted)
    }
}

/// Enumerate the executable lanes a manifest declares.
#[must_use]
pub fn lanes_of(manifest: &PluginManifest) -> Vec<LaneReport> {
    let mut lanes = Vec::new();

    if let Some(contributes) = &manifest.contributes {
        for hook in &contributes.turn_hooks {
            lanes.push(LaneReport {
                kind: LaneKind::TurnHook,
                enforcement: LaneKind::TurnHook.enforcement(),
                detail: hook.id.clone(),
            });
        }
    }

    for entry in &manifest.provides {
        for (verb, tool) in &entry.tools {
            if tool.adapter.is_some() {
                lanes.push(LaneReport {
                    kind: LaneKind::CapabilityAdapter,
                    enforcement: LaneKind::CapabilityAdapter.enforcement(),
                    detail: format!("{}::{verb}", entry.capability),
                });
            }
        }
    }

    // The bundle itself is persisted in the store, not the manifest; the declared
    // integrity hash is the manifest-side signal that one exists.
    if manifest.ui_code_sha256.is_some() {
        lanes.push(LaneReport {
            kind: LaneKind::UiBundle,
            enforcement: LaneKind::UiBundle.enforcement(),
            detail: "ui_code".to_owned(),
        });
    }

    for sidecar in &manifest.sidecars {
        // Every process kind lands on the same verdict. A `node` sidecar is gated
        // behind the experimental-plugin-runtime flag, but that gate decides
        // whether it spawns — not what it can reach once it has.
        let runtime = match &sidecar.process {
            SidecarProcess::Binary(_) => "binary",
            SidecarProcess::Python(_) => "python",
            SidecarProcess::Local(_) => "local",
            SidecarProcess::Node(_) => "node",
        };
        lanes.push(LaneReport {
            kind: LaneKind::Sidecar,
            enforcement: LaneKind::Sidecar.enforcement(),
            detail: format!("{} ({runtime})", sidecar.name),
        });
    }

    for name in manifest.mcp_servers.keys() {
        lanes.push(LaneReport {
            kind: LaneKind::McpServer,
            enforcement: LaneKind::McpServer.enforcement(),
            detail: name.clone(),
        });
    }

    if let Some(contributes) = &manifest.contributes {
        for ext in &contributes.pi_extensions {
            lanes.push(LaneReport {
                kind: LaneKind::PiExtension,
                enforcement: LaneKind::PiExtension.enforcement(),
                detail: ext.id.clone(),
            });
        }
        for name in contributes.lsp_servers.keys() {
            lanes.push(LaneReport {
                kind: LaneKind::LspServer,
                enforcement: LaneKind::LspServer.enforcement(),
                detail: name.clone(),
            });
        }
    }

    if let Some(runtime) = &manifest.runtime {
        lanes.push(LaneReport {
            kind: LaneKind::ExternalRuntime,
            enforcement: LaneKind::ExternalRuntime.enforcement(),
            detail: format!("{} ({})", runtime.entry, runtime.kind),
        });
    }

    lanes
}

/// Build the isolation report for one installed plugin. Pure over persisted facts
/// — no network, no clock, no process state.
#[must_use]
pub fn resolve(
    manifest: &PluginManifest,
    provenance: Option<&PluginProvenance>,
    policy: &TrustPolicy,
) -> PluginIsolation {
    let lanes = lanes_of(manifest);
    let unenforceable_lanes: Vec<LaneReport> = lanes
        .iter()
        .filter(|l| l.enforcement == Enforcement::Unenforceable)
        .cloned()
        .collect();
    let manifest_drifted = manifest_drifted(manifest, provenance);
    let trust = policy.resolve_trust_for_manifest(manifest, provenance);
    let host_access = if unenforceable_lanes.is_empty() {
        HostAccess::NotRequested
    } else if trust.vouches() {
        HostAccess::Permitted {
            basis: trust.clone(),
        }
    } else {
        HostAccess::Unvetted
    };
    PluginIsolation {
        id: manifest.id.clone(),
        name: manifest.name.clone(),
        fully_sandboxed: unenforceable_lanes.is_empty(),
        unenforceable_lanes,
        lanes,
        trust,
        host_access,
        manifest_drifted,
    }
}

mod digest;
mod policy;

#[cfg(test)]
mod tests;
