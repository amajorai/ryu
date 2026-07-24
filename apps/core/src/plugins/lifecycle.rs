//! App lifecycle operations: install, enable, disable, update.
//!
//! Each operation maps to an HTTP handler in `server/mod.rs`.
//!
//! ## Core-vs-Gateway boundary (strict)
//!
//! - **Core** (this module): decides *what runs* (install/enable/disable/update
//!   state transitions, semver compare, persisting lifecycle state).
//! - **Gateway**: decides *what is allowed*. [`enable_app`] calls the Gateway's
//!   `/v1/grants/validate` for each declared grant in the manifest. Core stores
//!   the result but applies **no inline policy** — if the Gateway is unreachable
//!   the enable fails closed (app stays disabled) rather than silently allowing.
//!
//! ## Gateway stub
//!
//! The Gateway-side grant storage/registry is its own Gateway concern. Until the
//! Gateway endpoint is available it can be stubbed to allow-all by setting the
//! env var `RYU_STUB_GRANT_VALIDATION=1`. This keeps the seam explicit so
//! reviewers know exactly where the real Gateway call will land.

use anyhow::Result;
use serde_json::json;

use super::graph::{self, DependencyError};
use super::{GrantValidationResult, PluginRecord, PluginStore};
use crate::plugin_manifest::PluginManifest;

/// Env var that stubs the Gateway grant-validation call to "allow all". Set to
/// `1` or `true` in environments where the Gateway is not yet available.
const ENV_STUB_GRANTS: &str = "RYU_STUB_GRANT_VALIDATION";

/// Error returned when an enable fails because the Gateway denied a grant, the
/// Gateway was unreachable (fail-closed), or the dependency graph could not be
/// satisfied.
#[derive(Debug)]
pub enum EnableError {
    /// The Gateway denied one or more grants. The app stays disabled.
    /// `plugin` names WHICH plugin was denied — it may be an auto-enabled
    /// dependency, not the plugin the user clicked.
    GrantsDenied { plugin: String, denied: Vec<String> },
    /// The Gateway was unreachable. The app stays disabled (fail-closed).
    GatewayUnreachable { reason: String },
    /// The dependency graph could not be satisfied (missing dep, version too
    /// low, cycle, …). Nothing was enabled — the graph resolves BEFORE any
    /// enabled bit is flipped, so this is never a partial enable.
    Dependency(DependencyError),
    /// A required **capability** could not be bound to a provider (none installed,
    /// ambiguous with no override, or a version floor unmet). `plugin` names which
    /// plugin in the enable order carried the unbindable requirement — nothing was
    /// enabled (bindings resolve BEFORE any bit is flipped).
    Binding {
        plugin: String,
        source: super::binding::BindingError,
    },
    /// A store or manifest error.
    Other(anyhow::Error),
}

impl std::fmt::Display for EnableError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::GrantsDenied { plugin, denied } => {
                write!(
                    f,
                    "Gateway denied grants for '{plugin}': {}",
                    denied.join(", ")
                )
            }
            Self::GatewayUnreachable { reason } => {
                write!(f, "Gateway unreachable (fail-closed): {reason}")
            }
            Self::Dependency(e) => write!(f, "{e}"),
            Self::Binding { plugin, source } => {
                write!(f, "capability binding failed for '{plugin}': {source}")
            }
            Self::Other(e) => write!(f, "{e}"),
        }
    }
}

impl From<anyhow::Error> for EnableError {
    fn from(e: anyhow::Error) -> Self {
        Self::Other(e)
    }
}

impl From<DependencyError> for EnableError {
    fn from(e: DependencyError) -> Self {
        Self::Dependency(e)
    }
}

/// Error returned when a disable is refused.
#[derive(Debug)]
pub enum DisableError {
    /// The app is not installed.
    NotInstalled { id: String },
    /// The plugin is **load-bearing** (a core subsystem depends on it, e.g.
    /// `engines`/`durable`) and `force` was not set. Disabling it would break a
    /// function every install relies on, so the guard refuses unless the caller
    /// explicitly forces it. See [`crate::plugins::builtins::LOAD_BEARING_PLUGINS`].
    LoadBearing { id: String },
    /// Other ENABLED plugins depend on this one. Carries the typed
    /// [`DependencyError::BlockedByDependents`] so a client can list the
    /// blockers (or offer a one-click cascade) without parsing a string.
    Dependency(DependencyError),
    /// A store error.
    Other(anyhow::Error),
}

impl std::fmt::Display for DisableError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotInstalled { id } => write!(f, "app '{id}' is not installed"),
            Self::LoadBearing { id } => write!(
                f,
                "app '{id}' is load-bearing and cannot be disabled without force; \
                 disabling it would break a core function (chat engine / durable \
                 workflow execution). Pass force=true to override."
            ),
            Self::Dependency(e) => write!(f, "{e}"),
            Self::Other(e) => write!(f, "{e}"),
        }
    }
}

impl From<anyhow::Error> for DisableError {
    fn from(e: anyhow::Error) -> Self {
        Self::Other(e)
    }
}

/// What an [`enable_app`] call actually turned on.
///
/// Enabling a plugin can enable its dependencies too (in topological order), so
/// the caller must run its per-plugin activation side effects — runnable
/// registration, policy flags, external runtime, sidecars — for **every** record
/// here, in [`EnableOutcome::in_enable_order`]. Flipping a dependency's enabled
/// bit without activating its runnables would leave a half-enabled plugin.
#[derive(Debug)]
pub struct EnableOutcome {
    /// Dependencies auto-enabled by this call, in topological order (a plugin's
    /// own dependencies always precede it). Empty in the common no-deps case and
    /// when every dependency was already enabled.
    pub dependencies: Vec<PluginRecord>,
    /// The plugin the caller asked to enable. Always enabled last.
    pub target: PluginRecord,
}

impl EnableOutcome {
    /// Every record enabled by this call, in the order it was enabled:
    /// dependencies first, target last.
    pub fn in_enable_order(&self) -> impl Iterator<Item = &PluginRecord> {
        self.dependencies
            .iter()
            .chain(std::iter::once(&self.target))
    }
}

/// What a [`disable_app`] call actually turned off.
#[derive(Debug)]
pub struct DisableOutcome {
    /// Records disabled by this call, in the order they were disabled:
    /// dependents first, the target last. Without `cascade` this is exactly one
    /// record (the target). The caller must run its per-plugin teardown for
    /// every record here.
    pub disabled: Vec<PluginRecord>,
}

impl DisableOutcome {
    /// The plugin the caller asked to disable (always the last one disabled).
    pub fn target(&self) -> &PluginRecord {
        self.disabled
            .last()
            .expect("a DisableOutcome always contains the target")
    }
}

/// Error returned when an update is refused due to a downgrade attempt.
#[derive(Debug)]
pub enum UpdateError {
    /// The new version is older than the installed version and `force = false`.
    Downgrade {
        installed: String,
        requested: String,
    },
    /// A store or semver error.
    Other(anyhow::Error),
}

impl std::fmt::Display for UpdateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Downgrade {
                installed,
                requested,
            } => {
                write!(
                    f,
                    "refusing downgrade from {installed} to {requested}; \
                     pass force=true to override"
                )
            }
            Self::Other(e) => write!(f, "{e}"),
        }
    }
}

impl From<anyhow::Error> for UpdateError {
    fn from(e: anyhow::Error) -> Self {
        Self::Other(e)
    }
}

// ── Operations ────────────────────────────────────────────────────────────────

/// Install an app: create a new [`PluginRecord`] with `enabled = false`.
///
/// Fails if the app is already installed. Callers that want idempotent
/// install-or-update should call [`install_app`] then [`update_app`] on
/// `AlreadyExists`.
pub async fn install_app(store: &PluginStore, manifest: &PluginManifest) -> Result<PluginRecord> {
    // Validate semver before persisting (the loader validates it too, but we
    // re-check here so the endpoint never persists a bad version).
    semver::Version::parse(&manifest.version).map_err(|e| {
        anyhow::anyhow!(
            "manifest version '{}' is not valid semver: {e}",
            manifest.version
        )
    })?;

    store
        .insert(&manifest.id, &manifest.version)
        .await
        .map_err(|e| anyhow::anyhow!("install failed: {e}"))
}

/// Enable an app **and its dependencies**, in topological order.
///
/// `all_manifests` is the full set of loaded manifests (typically
/// `state.app_manifests`); this function filters it down to the *installed* set
/// itself, so a caller can never get that filter wrong.
///
/// # Order of operations (the safety contract): resolve → validate → flip
///
/// The whole call is **all-or-nothing**. Three phases, in this order, and no
/// phase starts until the one before it has succeeded for *every* plugin:
///
/// 1. **Resolve the whole graph.** A missing dependency, a version that is too
///    low, or a cycle fails here — before anything else happens.
/// 2. **Validate every plugin's grants through the Gateway**, target AND every
///    not-yet-enabled dependency, each against its *own* declared grants (an
///    auto-enabled dependency never inherits the target's approval — auto-enable
///    is a convenience, not a policy bypass). A denial or an unreachable Gateway
///    aborts here, with **zero** enabled bits flipped and **zero** grants
///    persisted.
/// 3. **Flip the enabled bits**, dependencies first in topological order, target
///    last. If a store write fails partway, every bit this call already flipped
///    is rolled back before returning.
///
/// Phase 2 is what makes the dominant failure mode safe: the target is enabled
/// LAST, so a one-pass "validate-then-flip-each" would leave every dependency
/// enabled-with-grants-persisted whenever the *target's* grants get denied — an
/// operation that reports failure but silently turned things on. It would also
/// desync from the caller, which only runs its activation side effects
/// (`activate_plugin`: runnable registration, policy flags, sidecars) on the `Ok`
/// path — so those dependencies would be enabled-but-dead until the next restart.
///
/// A plugin with no `requires` behaves exactly as before: one grant validation,
/// one `set_enabled`, and an [`EnableOutcome`] whose `dependencies` is empty.
///
/// Fails closed on Gateway errors — the app stays disabled with a clear error.
pub async fn enable_app(
    store: &PluginStore,
    manifest: &PluginManifest,
    all_manifests: &[PluginManifest],
    gateway_base_url: &str,
    gateway_token: Option<&str>,
    http_client: &reqwest::Client,
) -> Result<EnableOutcome, EnableError> {
    // Check that the app is installed.
    let _record = store
        .get(&manifest.id)
        .await
        .map_err(EnableError::Other)?
        .ok_or_else(|| {
            EnableError::Other(anyhow::anyhow!("app '{}' is not installed", manifest.id))
        })?;

    let records = store.list().await.map_err(EnableError::Other)?;

    // The graph resolves over the INSTALLED manifests (see `graph`'s module
    // contract): a declared dependency that is not installed must surface as
    // `MissingDependency`, not silently resolve against a merely-loaded manifest.
    let installed_ids: std::collections::HashSet<&str> =
        records.iter().map(|r| r.id.as_str()).collect();
    let mut installed: Vec<PluginManifest> = all_manifests
        .iter()
        .filter(|m| installed_ids.contains(m.id.as_str()))
        .cloned()
        .collect();
    // The manifest we were handed is authoritative for the target (and we just
    // confirmed it IS installed), so make sure the graph can see it even if the
    // caller's `all_manifests` snapshot does not carry it.
    if !installed.iter().any(|m| m.id == manifest.id) {
        installed.push(manifest.clone());
    }

    // ── Phase 1: resolve ──────────────────────────────────────────────────────
    // Resolve the full enable order BEFORE touching any enabled bit. Missing /
    // version-mismatched / cyclic dependencies all fail here, so a failed enable
    // never leaves the system half-enabled.
    //
    // Capability edges (`requires.capabilities`) are lowered to concrete app-id
    // edges against the installed set + active bindings FIRST, so the graph pulls
    // each bound provider into the enable order transitively (as an ordinary app
    // dep). Lowering silently skips an unbindable capability; the explicit refusal
    // is the binding-validation pass below, which surfaces the real cause
    // (Unprovided / Ambiguous / version) instead of a downstream MissingDependency.
    let binding_cfg = super::binding::active_config();
    let lowered = super::binding::lower_manifests(&installed, &binding_cfg);
    let order = graph::resolve_enable_order(&manifest.id, &lowered)?;

    // Capability governance gate. Bindings are validated over the POST-ENABLE
    // ENABLED set — every plugin that will be enabled after this call
    // (currently-enabled ∪ the enable order) — NOT the installed set. This is what
    // the broker sees at call time, and it catches BOTH failure modes:
    //   * the target or an auto-enabled dep whose capability is unbound/ambiguous;
    //   * a pre-existing enabled CONSUMER that THIS enable would render ambiguous
    //     (e.g. enabling a second `rag` provider) — the hole a target-only check
    //     misses. Refuse before any bit flips, naming the affected plugin.
    // Resolving over the enabled (not installed) set also avoids a false ambiguity
    // from a merely-installed-but-disabled second provider.
    let post_enabled_ids: std::collections::HashSet<&str> = order
        .iter()
        .map(String::as_str)
        .chain(records.iter().filter(|r| r.enabled).map(|r| r.id.as_str()))
        .collect();
    let post_enabled: Vec<PluginManifest> = installed
        .iter()
        .filter(|m| post_enabled_ids.contains(m.id.as_str()))
        .cloned()
        .collect();
    if let Some((plugin, source)) = super::binding::first_binding_error(&post_enabled, &binding_cfg)
    {
        return Err(EnableError::Binding { plugin, source });
    }

    // ── Phase 2: validate EVERY plugin's grants, flipping NOTHING ─────────────
    // The target is enabled last, so its denial is the most likely failure. If we
    // validated-and-flipped one plugin at a time, that denial would leave every
    // dependency enabled (with grants persisted) while the call reports failure.
    // Validate the whole order first; only an all-approved order proceeds.
    struct Pending {
        id: String,
        approved: Vec<String>,
        is_target: bool,
    }
    let mut pending: Vec<Pending> = Vec::new();

    for id in &order {
        let is_target = *id == manifest.id;

        // Skip dependencies that are already enabled — nothing to do, and no
        // reason to re-run their Gateway validation. The target is always
        // (re-)enabled, preserving the pre-dependency behaviour of this call.
        if !is_target && records.iter().any(|r| r.id == *id && r.enabled) {
            continue;
        }

        // The target uses the caller's manifest; a dependency uses its own.
        let dep_manifest: &PluginManifest = if is_target {
            manifest
        } else {
            installed
                .iter()
                .find(|m| m.id == *id)
                .ok_or_else(|| EnableError::Other(anyhow::anyhow!("manifest '{id}' disappeared")))?
        };

        // Every plugin — target OR auto-enabled dependency — goes through the
        // Gateway grant gate with its OWN declared grants. No inheritance, no
        // bypass.
        let validation = validate_grants_via_gateway(
            &dep_manifest.permission_grants,
            &dep_manifest.id,
            gateway_base_url,
            gateway_token,
            http_client,
        )
        .await?;

        if !validation.all_approved {
            // Nothing has been flipped yet — this is a clean abort.
            return Err(EnableError::GrantsDenied {
                plugin: dep_manifest.id.clone(),
                denied: validation.denied,
            });
        }

        pending.push(Pending {
            id: dep_manifest.id.clone(),
            approved: validation.approved,
            is_target,
        });
    }

    // ── Phase 3: flip the bits, dependencies first, target last ───────────────
    // Every plugin here is resolved and Gateway-approved. Only a store failure
    // can still abort, and that rolls back whatever this call already flipped.
    let mut dependencies: Vec<PluginRecord> = Vec::new();
    let mut target: Option<PluginRecord> = None;
    let mut flipped: Vec<String> = Vec::new();

    for p in &pending {
        let result = store.set_enabled(&p.id, &p.approved).await;

        let record = match result {
            Ok(Some(record)) => record,
            Ok(None) => {
                rollback_enabled(store, &flipped).await;
                return Err(EnableError::Other(anyhow::anyhow!(
                    "app '{}' disappeared during enable",
                    p.id
                )));
            }
            Err(e) => {
                rollback_enabled(store, &flipped).await;
                return Err(EnableError::Other(e));
            }
        };

        flipped.push(p.id.clone());

        if p.is_target {
            target = Some(record);
        } else {
            dependencies.push(record);
        }
    }

    let target = target.ok_or_else(|| {
        EnableError::Other(anyhow::anyhow!(
            "app '{}' was not in its own enable order",
            manifest.id
        ))
    })?;

    Ok(EnableOutcome {
        dependencies,
        target,
    })
}

/// Undo the enabled bits an aborted [`enable_app`] already flipped, newest first.
///
/// Only reachable from a store failure in phase 3 (grant denials and Gateway
/// outages abort in phase 2, before anything is flipped). Best-effort: the store
/// is already misbehaving, so a failed rollback write is logged, not propagated —
/// the original error is what the caller needs to see.
async fn rollback_enabled(store: &PluginStore, flipped: &[String]) {
    for id in flipped.iter().rev() {
        if let Err(e) = store.set_disabled(id).await {
            tracing::error!(
                "plugin enable: rollback of '{id}' failed: {e}; it may be left enabled without \
                 having been activated"
            );
        }
    }
}

/// Set an ALREADY-ENABLED app's approved grants to an explicit subset — the
/// backend for per-grant revocation (a user turning off "use AI models" without
/// disabling the whole app). The desired set is re-validated through the Gateway
/// exactly like [`enable_app`], so:
///   - **Escalation is impossible**: every desired grant must be one the manifest
///     DECLARED (a client can't approve a grant the app never asked for), and the
///     Gateway still gets the final say (restoring a previously-denied grant stays
///     denied). Narrowing is always safe; widening back within the declared set
///     goes through the same policy gate.
///   - **No backdoor enable**: refuses unless the app is already enabled, so this
///     never bypasses the Gateway validation `enable_app` performs on first enable.
/// An empty `desired` is valid — the app stays enabled but every capability call
/// is denied (revoke-all without uninstalling).
pub async fn set_app_grants(
    store: &PluginStore,
    manifest: &PluginManifest,
    desired: &[String],
    gateway_base_url: &str,
    gateway_token: Option<&str>,
    http_client: &reqwest::Client,
) -> Result<PluginRecord, EnableError> {
    let record = store
        .get(&manifest.id)
        .await
        .map_err(EnableError::Other)?
        .ok_or_else(|| {
            EnableError::Other(anyhow::anyhow!("app '{}' is not installed", manifest.id))
        })?;
    // Security: only an already-enabled app may have its grants edited. Using this
    // on a disabled app would set `enabled = 1` while skipping the first-enable
    // Gateway gate — a backdoor enable. Force the caller through `enable_app` first.
    if !record.enabled {
        return Err(EnableError::Other(anyhow::anyhow!(
            "app '{}' must be enabled before its grants can be edited",
            manifest.id
        )));
    }
    // Escalation guard: every desired grant must be one the app DECLARED in its
    // manifest. A grant outside the declared set can never be approved here.
    let declared: std::collections::HashSet<&str> = manifest
        .permission_grants
        .iter()
        .map(String::as_str)
        .collect();
    for grant in desired {
        if !declared.contains(grant.as_str()) {
            return Err(EnableError::Other(anyhow::anyhow!(
                "grant '{grant}' is not declared by app '{}'",
                manifest.id
            )));
        }
    }
    // Re-validate the desired subset through the Gateway (same gate as enable), so
    // re-adding a grant the Gateway would deny stays denied. Narrowing passes
    // trivially. Fail-closed on an unreachable Gateway.
    let validation = validate_grants_via_gateway(
        desired,
        &manifest.id,
        gateway_base_url,
        gateway_token,
        http_client,
    )
    .await?;
    if !validation.all_approved {
        return Err(EnableError::GrantsDenied {
            plugin: manifest.id.clone(),
            denied: validation.denied,
        });
    }
    store
        .set_enabled(&manifest.id, &validation.approved)
        .await
        .map_err(EnableError::Other)?
        .ok_or_else(|| {
            EnableError::Other(anyhow::anyhow!(
                "app '{}' disappeared during grant update",
                manifest.id
            ))
        })
}

/// Disable an app: flip `enabled = false` and clear approved grants.
///
/// # Dependents
///
/// Disabling a plugin that other **enabled** plugins depend on would leave them
/// running against a missing dependency. So:
///
/// - `cascade = false` (**the default posture**): REFUSE, with the typed
///   [`DependencyError::BlockedByDependents`] naming the full transitive blast
///   radius, so a client can say "Disable Meetings, Whiteboard, Canvas first"
///   without parsing a string. Nothing is disabled.
/// - `cascade = true` (explicit opt-in): disable the dependents too, in
///   reverse-topological order (deepest dependent first, the target last), so a
///   plugin is never left enabled with a disabled dependency.
///
/// A plugin nothing depends on behaves identically either way: one record
/// disabled, exactly as before.
///
/// `all_manifests` is the full loaded manifest set; the dependent search is
/// filtered to the currently ENABLED plugins, so a merely-installed (disabled)
/// dependent never blocks a disable.
///
/// # Load-bearing guard
///
/// A **load-bearing** plugin (see
/// [`crate::plugins::builtins::LOAD_BEARING_PLUGINS`] — `engines`, `durable`) is
/// refused with [`DisableError::LoadBearing`] unless `force = true`. This is the
/// one guard on the "everything swappable" default: disabling the local chat
/// engine or the durable workflow engine breaks a core function every install
/// relies on, so it takes an explicit override. The check is on the **target**
/// only (the id the caller asked to disable), before anything is touched, so a
/// refused disable changes nothing.
pub async fn disable_app(
    store: &PluginStore,
    id: &str,
    all_manifests: &[PluginManifest],
    cascade: bool,
    force: bool,
) -> Result<DisableOutcome, DisableError> {
    let records = store.list().await.map_err(DisableError::Other)?;
    if !records.iter().any(|r| r.id == id) {
        return Err(DisableError::NotInstalled { id: id.to_owned() });
    }

    // Load-bearing guard: refuse to disable a core subsystem unless forced. Checked
    // before any bit is flipped, so a refusal is never a partial disable.
    if !force && crate::plugins::builtins::is_load_bearing(id) {
        return Err(DisableError::LoadBearing { id: id.to_owned() });
    }

    // Only ENABLED plugins can block a disable — a disabled dependent is already
    // not running, so it has nothing to break.
    let enabled_ids: std::collections::HashSet<&str> = records
        .iter()
        .filter(|r| r.enabled)
        .map(|r| r.id.as_str())
        .collect();
    let enabled: Vec<PluginManifest> = all_manifests
        .iter()
        .filter(|m| enabled_ids.contains(m.id.as_str()))
        .cloned()
        .collect();

    // Lower capability edges over the ENABLED set so a consumer bound to `id`
    // (via `requires.capabilities`, not a hard `requires.apps`) counts as a
    // dependent and blocks/cascades the disable symmetrically with the enable path.
    // Every enabled consumer has a deterministic binding (single provider, or an
    // override — an ambiguous one could never have enabled), so this reconstructs
    // the exact consumer→provider edge chosen at enable time.
    let enabled = super::binding::lower_manifests(&enabled, &super::binding::active_config());

    let dependents = graph::dependents_of(id, &enabled);

    if !dependents.is_empty() && !cascade {
        return Err(DisableError::Dependency(
            DependencyError::BlockedByDependents {
                plugin: id.to_owned(),
                dependents,
            },
        ));
    }

    // Cascade: dependents first (deepest first), target last. With no dependents
    // this is just `[id]`, i.e. today's single-record disable.
    let order = if dependents.is_empty() {
        vec![id.to_owned()]
    } else {
        graph::resolve_disable_order(id, &enabled)
    };

    // Load-bearing guard across the WHOLE resolved order, not just the root: a
    // cascade must not tear down a core subsystem pulled in as a collateral
    // dependent. Checked before any bit is flipped, so a refusal is never a partial
    // disable. Unreachable while `engines`/`durable` declare no `requires` edge (so
    // nothing depends on them), but the guard must not silently lapse if one ever
    // gains a dependency.
    if !force {
        if let Some(lb) = order
            .iter()
            .find(|pid| crate::plugins::builtins::is_load_bearing(pid))
        {
            return Err(DisableError::LoadBearing { id: lb.clone() });
        }
    }

    let mut disabled: Vec<PluginRecord> = Vec::new();
    for plugin_id in &order {
        let record = store
            .set_disabled(plugin_id)
            .await
            .map_err(DisableError::Other)?;
        match record {
            Some(r) => disabled.push(r),
            // A dependent that vanished between the list and the disable is not
            // fatal — the goal (it is not enabled) already holds.
            None if plugin_id != id => {
                tracing::warn!("plugin disable: dependent '{plugin_id}' is no longer installed");
            }
            None => {
                return Err(DisableError::NotInstalled { id: id.to_owned() });
            }
        }
    }

    Ok(DisableOutcome { disabled })
}

/// What an [`uninstall_app`] call disabled on its way to removing the record.
#[derive(Debug)]
pub struct UninstallOutcome {
    /// The plugin id whose lifecycle record was removed.
    pub removed: String,
    /// Records that were disabled (torn down) as part of the uninstall, in disable
    /// order (dependents first, the target last). Without `cascade` this is the
    /// target alone. The caller must run its per-plugin teardown for every record
    /// here (deactivate runnables, stop sidecars, flip policy flags) — the record
    /// removal is only the store row; the runtime side effects are the caller's.
    pub disabled: Vec<PluginRecord>,
}

/// Error returned when an uninstall is refused.
#[derive(Debug)]
pub enum UninstallError {
    /// The app is not installed.
    NotInstalled { id: String },
    /// The plugin may only be **disabled**, never uninstalled — it is a built-in
    /// system app or a default-on plugin whose manifest is compiled into the
    /// binary and would be resurrected by the startup seed on the next boot. See
    /// [`crate::plugins::builtins::is_uninstall_protected`].
    Protected { id: String },
    /// Enabled plugins depend on this one (the disable step refused). Carries the
    /// typed [`DependencyError::BlockedByDependents`] so a client can name the
    /// blockers or retry with `cascade = true` — identical to [`disable_app`].
    Dependency(DependencyError),
    /// A store error.
    Other(anyhow::Error),
}

impl std::fmt::Display for UninstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotInstalled { id } => write!(f, "app '{id}' is not installed"),
            Self::Protected { id } => write!(
                f,
                "app '{id}' is a built-in and can only be disabled, not uninstalled \
                 (its manifest ships in the binary and the startup seed would re-add it)"
            ),
            Self::Dependency(e) => write!(f, "{e}"),
            Self::Other(e) => write!(f, "{e}"),
        }
    }
}

impl From<anyhow::Error> for UninstallError {
    fn from(e: anyhow::Error) -> Self {
        Self::Other(e)
    }
}

/// Uninstall an app: **disable it (and, with `cascade`, its dependents), then
/// remove its lifecycle record.**
///
/// # Semantics — auto-disable-then-remove (not refuse-if-enabled)
///
/// Uninstalling first tears the plugin down through the exact same path a manual
/// disable takes, then deletes the record. This composes with [`disable_app`]
/// rather than duplicating it: the dependents refusal, the opt-in `cascade`, and
/// the reverse-topological teardown order all come from `disable_app`. An
/// already-disabled target passes through harmlessly (the disable is idempotent).
/// The alternative — refusing while enabled — was rejected so the caller does not
/// have to make two round-trips (disable, then uninstall) for the common case.
///
/// # Order of operations (a refused uninstall changes nothing)
///
/// 1. **Installed?** — else [`UninstallError::NotInstalled`].
/// 2. **Protected?** — a built-in / default-on plugin is refused with
///    [`UninstallError::Protected`] **before** anything is disabled or removed, so
///    a refusal never partially tears down the plugin. Built-ins can only be
///    disabled (their manifest is compiled in; the seed would resurrect a removed
///    default-on record — see [`crate::plugins::builtins::is_uninstall_protected`]).
/// 3. **Disable** the target + (with `cascade`) its dependents via [`disable_app`].
///    An enabled dependent without `cascade` refuses here with the typed
///    `BlockedByDependents`, mapped to [`UninstallError::Dependency`]. The load-
///    bearing plugins are all default-on, so they are already refused at step 2 and
///    never reach this disable (hence `force = false` is safe here).
/// 4. **Remove** the target's record via [`PluginStore::remove`]. Only the target
///    is removed; cascaded dependents are left installed-but-disabled (a user who
///    wants them gone uninstalls each explicitly, mirroring `disable_app`'s "only
///    the target is the subject" shape).
pub async fn uninstall_app(
    store: &PluginStore,
    id: &str,
    all_manifests: &[PluginManifest],
    cascade: bool,
) -> Result<UninstallOutcome, UninstallError> {
    // 1. Installed?
    let records = store.list().await.map_err(UninstallError::Other)?;
    if !records.iter().any(|r| r.id == id) {
        return Err(UninstallError::NotInstalled { id: id.to_owned() });
    }

    // 2. Protected? Refuse built-in / default-on plugins BEFORE any teardown, so a
    // refused uninstall is never a partial one.
    if crate::plugins::builtins::is_uninstall_protected(id) {
        return Err(UninstallError::Protected { id: id.to_owned() });
    }

    // 3. Disable the target (+ dependents under cascade). Reuses disable_app for the
    // dependents refusal, cascade order, and idempotent teardown of the bits.
    // `force = false`: any load-bearing plugin is default-on and already refused at
    // step 2, so this can never be a forced disable of a core subsystem.
    let disabled = match disable_app(store, id, all_manifests, cascade, false).await {
        Ok(outcome) => outcome.disabled,
        Err(DisableError::NotInstalled { id }) => return Err(UninstallError::NotInstalled { id }),
        Err(DisableError::Dependency(e)) => return Err(UninstallError::Dependency(e)),
        // Unreachable in practice (load-bearing ⊂ default-on ⊂ protected), but map
        // it to Protected rather than panicking if the invariant ever changes.
        Err(DisableError::LoadBearing { id }) => return Err(UninstallError::Protected { id }),
        Err(DisableError::Other(e)) => return Err(UninstallError::Other(e)),
    };

    // 4. Remove the record (wires the previously-unused PluginStore::remove).
    store.remove(id).await.map_err(UninstallError::Other)?;

    Ok(UninstallOutcome {
        removed: id.to_owned(),
        disabled,
    })
}

/// Whether a requested update needs the store transition or is a no-op.
#[derive(Debug, PartialEq, Eq)]
pub enum UpdatePlan {
    /// The requested version equals the installed one: nothing to write.
    NoOp,
    /// The requested version is newer (or `force` allowed a downgrade): perform
    /// the version + `ui_code` transition.
    Proceed,
}

/// Decide whether an update from `installed_version` to `requested_version` may
/// proceed, WITHOUT touching the store.
///
/// The single semver gate shared by the store transition ([`update_app`]) and the
/// server handler's pre-mutation pre-check, so the downgrade rule and the
/// same-version no-op have exactly one definition. Refuses a downgrade
/// (new < installed) unless `force = true`.
pub fn plan_update(
    installed_version: &str,
    requested_version: &str,
    force: bool,
) -> Result<UpdatePlan, UpdateError> {
    let installed_ver = semver::Version::parse(installed_version).map_err(|e| {
        UpdateError::Other(anyhow::anyhow!(
            "installed version '{installed_version}' is not valid semver: {e}"
        ))
    })?;
    let new_ver = semver::Version::parse(requested_version).map_err(|e| {
        UpdateError::Other(anyhow::anyhow!(
            "new version '{requested_version}' is not valid semver: {e}"
        ))
    })?;

    if !force && new_ver < installed_ver {
        return Err(UpdateError::Downgrade {
            installed: installed_version.to_owned(),
            requested: requested_version.to_owned(),
        });
    }
    if new_ver == installed_ver {
        return Ok(UpdatePlan::NoOp);
    }
    Ok(UpdatePlan::Proceed)
}

/// Update an app to a new, **already-verified** manifest version, persisting the
/// new version AND its bundled `ui_code`.
///
/// # Security contract — the caller MUST have re-verified this manifest
///
/// This is the STORE half of an update; it performs no signature / `ui_code`
/// verification of its own. That verification lives in the catalog resolve path
/// the server handler drives (`resolve_plugin_from_catalog` → `install_descriptor`,
/// the SAME ed25519 signature + `ui_code_sha256` integrity gate + paid-entitlement
/// gate that `install` runs). Callers MUST pass only a `(manifest, ui_code)` pair
/// that path returned — never an unverified or merely-loaded manifest — so an
/// update can never swap in unverified code the way the old `set_version`-only
/// path could.
///
/// # What it does
///
/// - Refuses a downgrade (new < installed) unless `force = true` ([`plan_update`]).
/// - Same version: no-op, returns the current record (no write).
/// - Otherwise: `set_version` THEN `set_ui_code`. `set_version` leaves the
///   `enabled` bit and `approved_grants` untouched, so a disabled app stays
///   disabled and an enabled app keeps its grants — the update never silently
///   (re-)enables. The `ui_code` is replaced with whatever the verified descriptor
///   carried (`None` for a manifest-only / unsigned version, which correctly clears
///   any stale bundled code).
///
/// Does NOT enable a disabled app; the caller runs [`enable_app`] afterwards if it
/// wants the new version active.
pub async fn update_app(
    store: &PluginStore,
    manifest: &PluginManifest,
    ui_code: Option<&str>,
    force: bool,
) -> Result<PluginRecord, UpdateError> {
    let record = store
        .get(&manifest.id)
        .await
        .map_err(UpdateError::Other)?
        .ok_or_else(|| {
            UpdateError::Other(anyhow::anyhow!("app '{}' is not installed", manifest.id))
        })?;

    match plan_update(&record.version, &manifest.version, force)? {
        UpdatePlan::NoOp => return Ok(record),
        UpdatePlan::Proceed => {}
    }

    // Bump the version (this also confirms the row still exists and returns the
    // record with the preserved enabled bit + grants), then replace the bundled
    // UI code with the freshly-verified blob.
    let updated = store
        .set_version(&manifest.id, &manifest.version)
        .await
        .map_err(UpdateError::Other)?
        .ok_or_else(|| {
            UpdateError::Other(anyhow::anyhow!(
                "app '{}' disappeared during update",
                manifest.id
            ))
        })?;
    store
        .set_ui_code(&manifest.id, ui_code)
        .await
        .map_err(UpdateError::Other)?;
    Ok(updated)
}

/// Plan which **new** dependencies an update must install.
///
/// Given the target's NEW manifest (`target`), the currently-installed manifests,
/// and the manifests freshly resolved from the catalog for the target's declared
/// dependencies (`fetched`), returns the dependency manifests to install in
/// topological order — the **target itself EXCLUDED** (an update is not a reinstall
/// of the target) and anything already installed subtracted.
///
/// It roots the closure at the NEW manifest by dropping the OLD target from the
/// installed set (so the resolver sees the NEW dependency edges, not the stale ones
/// the loaded manifest carried) and adding the NEW manifest to the fetched set, then
/// delegates all ordering / cycle / `min_version` decisions to the ONE resolver
/// ([`crate::plugins::catalog::plan_install_closure`]). A version bump that raises an
/// already-installed dependency's `min_version` beyond what is present surfaces as
/// that resolver's typed [`DependencyError::VersionMismatch`] (installed always wins
/// over fetched, so the update never silently downgrades a shared dependency).
pub fn plan_update_dep_closure(
    target: &PluginManifest,
    installed: &[PluginManifest],
    fetched: &[PluginManifest],
) -> Result<Vec<PluginManifest>, DependencyError> {
    let installed_minus_target: Vec<PluginManifest> = installed
        .iter()
        .filter(|m| m.id != target.id)
        .cloned()
        .collect();
    let mut fetched_plus_target: Vec<PluginManifest> = fetched.to_vec();
    fetched_plus_target.push(target.clone());

    let order = crate::plugins::catalog::plan_install_closure(
        &target.id,
        &installed_minus_target,
        &fetched_plus_target,
    )?;
    Ok(order.into_iter().filter(|m| m.id != target.id).collect())
}

// ── Gateway grant validation ──────────────────────────────────────────────────

/// Call the Gateway's `/v1/grants/validate` to authorise the grants declared
/// in the manifest.
///
/// ## Stub mode
///
/// When `RYU_STUB_GRANT_VALIDATION=1` is set (or the Gateway endpoint does not
/// yet exist), this function returns an allow-all result. The stub is explicit
/// and logged so it is visible in tests and operator logs. This is the noted
/// seam: full Gateway-side storage is the Gateway's concern.
async fn validate_grants_via_gateway(
    grants: &[String],
    app_id: &str,
    gateway_base_url: &str,
    gateway_token: Option<&str>,
    http_client: &reqwest::Client,
) -> Result<GrantValidationResult, EnableError> {
    // Empty grant list — nothing to validate, always allow.
    if grants.is_empty() {
        return Ok(GrantValidationResult {
            approved: vec![],
            denied: vec![],
            all_approved: true,
        });
    }

    // Stub mode: opt-in allow-all for environments where the Gateway endpoint
    // is not yet available. Always logged at WARN so it is visible. In a RELEASE
    // build the stub seam never approves an arbitrary-code-execution grant
    // (`sidecar:process`): a shipped/misconfigured `RYU_STUB_GRANT_VALIDATION=1`
    // must not become unsandboxed node-sidecar RCE. Debug builds (the integration
    // harness) keep the full allow-all so node-sidecar spawn tests still exercise
    // the path.
    if is_stub_mode() {
        let (approved, denied): (Vec<String>, Vec<String>) =
            grants.iter().cloned().partition(|g| stub_may_approve(g));
        if !denied.is_empty() {
            tracing::warn!(
                app_id,
                denied = ?denied,
                "grant validation: stub mode refused arbitrary-code-execution grant(s) in a release build"
            );
        }
        tracing::warn!(
            app_id,
            grants = ?approved,
            "grant validation: RYU_STUB_GRANT_VALIDATION=1 — allowing grants without Gateway check (stub seam)"
        );
        let all_approved = denied.is_empty();
        return Ok(GrantValidationResult {
            approved,
            denied,
            all_approved,
        });
    }

    let url = format!(
        "{}/v1/grants/validate",
        gateway_base_url.trim_end_matches('/')
    );

    let body = json!({
        "app_id": app_id,
        "grants": grants,
    });

    let mut req = http_client
        .post(&url)
        .timeout(std::time::Duration::from_secs(5))
        .json(&body);
    if let Some(token) = gateway_token {
        req = req.bearer_auth(token);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| EnableError::GatewayUnreachable {
            reason: e.to_string(),
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(EnableError::GatewayUnreachable {
            reason: format!("Gateway returned {status}: {body_text}"),
        });
    }

    let result: serde_json::Value =
        resp.json()
            .await
            .map_err(|e| EnableError::GatewayUnreachable {
                reason: format!("invalid JSON from Gateway: {e}"),
            })?;

    // Parse Gateway response. Expected shape:
    // { "approved": [...], "denied": [...] }
    let approved: Vec<String> = result
        .get("approved")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let denied: Vec<String> = result
        .get("denied")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let all_approved = denied.is_empty();

    Ok(GrantValidationResult {
        approved,
        denied,
        all_approved,
    })
}

fn is_stub_mode() -> bool {
    match std::env::var(ENV_STUB_GRANTS) {
        Ok(v) => matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"),
        Err(_) => false,
    }
}

/// Whether the stub allow-all seam may auto-approve `grant`. In a RELEASE build it
/// refuses `sidecar:process` (running an unsandboxed managed process from a manifest
/// = arbitrary code execution) so a misconfigured `RYU_STUB_GRANT_VALIDATION=1`
/// cannot become node-sidecar RCE; in a debug build (integration harness) every
/// grant is allowed so node-sidecar tests still spawn.
fn stub_may_approve(grant: &str) -> bool {
    !(cfg!(not(debug_assertions))
        && grant == crate::sidecar::manifest_sidecar::GRANT_SIDECAR_PROCESS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_manifest::schema::RunnableEntry;
    use crate::plugin_manifest::PluginManifest;
    use crate::runnable::RunnableKind;

    fn make_manifest(id: &str, version: &str, grants: Vec<&str>) -> PluginManifest {
        PluginManifest {
            id: id.to_owned(),
            name: "Test App".to_owned(),
            version: version.to_owned(),
            runnables: vec![RunnableEntry {
                id: "agent-x".to_owned(),
                name: "Agent X".to_owned(),
                kind: RunnableKind::Agent,
                config: None,
            }],
            permission_grants: grants.into_iter().map(str::to_owned).collect(),
            companion: None,
            ..Default::default()
        }
    }

    fn store() -> PluginStore {
        PluginStore::open_in_memory().unwrap()
    }

    // ── install ────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn install_creates_disabled_record() {
        let s = store();
        let m = make_manifest("com.test.app", "1.0.0", vec![]);
        let rec = install_app(&s, &m).await.unwrap();
        assert_eq!(rec.id, "com.test.app");
        assert_eq!(rec.version, "1.0.0");
        assert!(!rec.enabled);
    }

    #[tokio::test]
    async fn install_rejects_invalid_semver() {
        let s = store();
        let m = make_manifest("com.test.app", "not-semver", vec![]);
        assert!(install_app(&s, &m).await.is_err());
    }

    // ── enable (stub mode) ─────────────────────────────────────────────────────

    /// Serialize the tests that mutate the process-global `RYU_STUB_GRANT_VALIDATION`
    /// env var. Rust runs tests in parallel, so without this they clobber each
    /// other's save/restore and one sees the var cleared mid-flight — falling
    /// through to a real Gateway call (127.0.0.1:7981) that is not running. The
    /// function-local `static` is a single shared lock; hold the guard for the
    /// whole test body (fine under the current-thread `#[tokio::test]` runtime).
    fn stub_grants_guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[tokio::test]
    async fn enable_in_stub_mode_allows_all_grants() {
        let _env = stub_grants_guard();
        let prev = std::env::var(super::ENV_STUB_GRANTS).ok();
        std::env::set_var(super::ENV_STUB_GRANTS, "1");

        let s = store();
        let m = make_manifest("com.test.app", "1.0.0", vec!["mcp:web_search"]);
        install_app(&s, &m).await.unwrap();

        let client = reqwest::Client::new();
        let out = enable_app(
            &s,
            &m,
            std::slice::from_ref(&m),
            "http://127.0.0.1:7981",
            None,
            &client,
        )
        .await
        .unwrap();
        let rec = &out.target;
        assert!(rec.enabled);
        assert_eq!(rec.approved_grants, vec!["mcp:web_search"]);
        assert!(
            out.dependencies.is_empty(),
            "a plugin with no requires enables nothing else"
        );

        match prev {
            Some(v) => std::env::set_var(super::ENV_STUB_GRANTS, v),
            None => std::env::remove_var(super::ENV_STUB_GRANTS),
        }
    }

    #[tokio::test]
    async fn enable_uninstalled_app_fails() {
        let _env = stub_grants_guard();
        let prev = std::env::var(super::ENV_STUB_GRANTS).ok();
        std::env::set_var(super::ENV_STUB_GRANTS, "1");

        let s = store();
        let m = make_manifest("com.test.app", "1.0.0", vec![]);
        let client = reqwest::Client::new();
        let result = enable_app(
            &s,
            &m,
            std::slice::from_ref(&m),
            "http://127.0.0.1:7981",
            None,
            &client,
        )
        .await;
        assert!(result.is_err(), "enable of uninstalled app should fail");

        match prev {
            Some(v) => std::env::set_var(super::ENV_STUB_GRANTS, v),
            None => std::env::remove_var(super::ENV_STUB_GRANTS),
        }
    }

    // ── disable ────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn disable_clears_state() {
        let _env = stub_grants_guard();
        let prev = std::env::var(super::ENV_STUB_GRANTS).ok();
        std::env::set_var(super::ENV_STUB_GRANTS, "1");

        let s = store();
        let m = make_manifest("com.test.app", "1.0.0", vec!["mcp:web_search"]);
        install_app(&s, &m).await.unwrap();
        let client = reqwest::Client::new();
        enable_app(
            &s,
            &m,
            std::slice::from_ref(&m),
            "http://127.0.0.1:7981",
            None,
            &client,
        )
        .await
        .unwrap();

        let out = disable_app(&s, "com.test.app", std::slice::from_ref(&m), false, false)
            .await
            .unwrap();
        let rec = out.target();
        assert!(!rec.enabled);
        assert!(rec.approved_grants.is_empty());

        match prev {
            Some(v) => std::env::set_var(super::ENV_STUB_GRANTS, v),
            None => std::env::remove_var(super::ENV_STUB_GRANTS),
        }
    }

    // ── set_app_grants (per-grant revocation) ──────────────────────────────────

    #[tokio::test]
    async fn set_app_grants_narrows_approved_set() {
        let _env = stub_grants_guard();
        let prev = std::env::var(super::ENV_STUB_GRANTS).ok();
        std::env::set_var(super::ENV_STUB_GRANTS, "1");

        let s = store();
        let m = make_manifest(
            "com.test.app",
            "1.0.0",
            vec!["spaces:docs", "hook:side-model"],
        );
        install_app(&s, &m).await.unwrap();
        let client = reqwest::Client::new();
        enable_app(
            &s,
            &m,
            std::slice::from_ref(&m),
            "http://127.0.0.1:7981",
            None,
            &client,
        )
        .await
        .unwrap();

        // Revoke hook:side-model, keep spaces:docs — the app stays enabled.
        let rec = set_app_grants(
            &s,
            &m,
            &["spaces:docs".to_owned()],
            "http://127.0.0.1:7981",
            None,
            &client,
        )
        .await
        .unwrap();
        assert!(rec.enabled, "app stays enabled after revoking a grant");
        assert_eq!(rec.approved_grants, vec!["spaces:docs"]);

        match prev {
            Some(v) => std::env::set_var(super::ENV_STUB_GRANTS, v),
            None => std::env::remove_var(super::ENV_STUB_GRANTS),
        }
    }

    #[tokio::test]
    async fn set_app_grants_rejects_undeclared_grant() {
        let _env = stub_grants_guard();
        let prev = std::env::var(super::ENV_STUB_GRANTS).ok();
        std::env::set_var(super::ENV_STUB_GRANTS, "1");

        let s = store();
        let m = make_manifest("com.test.app", "1.0.0", vec!["spaces:docs"]);
        install_app(&s, &m).await.unwrap();
        let client = reqwest::Client::new();
        enable_app(
            &s,
            &m,
            std::slice::from_ref(&m),
            "http://127.0.0.1:7981",
            None,
            &client,
        )
        .await
        .unwrap();

        // A grant the app never declared can never be approved (escalation guard).
        let res = set_app_grants(
            &s,
            &m,
            &["hook:run-agent".to_owned()],
            "http://127.0.0.1:7981",
            None,
            &client,
        )
        .await;
        assert!(
            matches!(res, Err(EnableError::Other(_))),
            "undeclared grant must be rejected"
        );

        match prev {
            Some(v) => std::env::set_var(super::ENV_STUB_GRANTS, v),
            None => std::env::remove_var(super::ENV_STUB_GRANTS),
        }
    }

    #[tokio::test]
    async fn set_app_grants_rejects_disabled_app() {
        let _env = stub_grants_guard();
        let prev = std::env::var(super::ENV_STUB_GRANTS).ok();
        std::env::set_var(super::ENV_STUB_GRANTS, "1");

        let s = store();
        let m = make_manifest("com.test.app", "1.0.0", vec!["spaces:docs"]);
        install_app(&s, &m).await.unwrap(); // installed but NOT enabled
        let client = reqwest::Client::new();

        // Editing grants on a disabled app is refused — it must never set
        // enabled = 1 while skipping the first-enable Gateway gate (backdoor enable).
        let res = set_app_grants(
            &s,
            &m,
            &["spaces:docs".to_owned()],
            "http://127.0.0.1:7981",
            None,
            &client,
        )
        .await;
        assert!(
            matches!(res, Err(EnableError::Other(_))),
            "grant edit on a disabled app must be rejected"
        );
        let rec = s.get("com.test.app").await.unwrap().unwrap();
        assert!(!rec.enabled, "app must remain disabled");

        match prev {
            Some(v) => std::env::set_var(super::ENV_STUB_GRANTS, v),
            None => std::env::remove_var(super::ENV_STUB_GRANTS),
        }
    }

    // ── update / semver ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn update_same_version_is_noop() {
        let s = store();
        let m = make_manifest("com.test.app", "1.0.0", vec![]);
        install_app(&s, &m).await.unwrap();
        let rec = update_app(&s, &m, None, false).await.unwrap();
        assert_eq!(rec.version, "1.0.0");
    }

    #[tokio::test]
    async fn update_newer_version_succeeds() {
        let s = store();
        install_app(&s, &make_manifest("com.test.app", "1.0.0", vec![]))
            .await
            .unwrap();
        let m2 = make_manifest("com.test.app", "2.0.0", vec![]);
        let rec = update_app(&s, &m2, None, false).await.unwrap();
        assert_eq!(rec.version, "2.0.0");
    }

    #[tokio::test]
    async fn update_older_version_refused_without_force() {
        let s = store();
        install_app(&s, &make_manifest("com.test.app", "2.0.0", vec![]))
            .await
            .unwrap();
        let m_old = make_manifest("com.test.app", "1.0.0", vec![]);
        let result = update_app(&s, &m_old, None, false).await;
        assert!(
            matches!(result, Err(UpdateError::Downgrade { .. })),
            "should refuse downgrade without force"
        );
    }

    #[tokio::test]
    async fn update_older_version_allowed_with_force() {
        let s = store();
        install_app(&s, &make_manifest("com.test.app", "2.0.0", vec![]))
            .await
            .unwrap();
        let m_old = make_manifest("com.test.app", "1.0.0", vec![]);
        let rec = update_app(&s, &m_old, None, true).await.unwrap();
        assert_eq!(rec.version, "1.0.0");
    }

    /// An update NEVER flips the enabled bit: a plugin installed-but-disabled stays
    /// disabled across a version bump (the update must not silently activate it).
    #[tokio::test]
    async fn update_preserves_disabled_state() {
        let s = store();
        let m = make_manifest("com.test.app", "1.0.0", vec![]);
        install_app(&s, &m).await.unwrap(); // installed, NOT enabled
        let m2 = make_manifest("com.test.app", "2.0.0", vec![]);
        let rec = update_app(&s, &m2, None, false).await.unwrap();
        assert_eq!(rec.version, "2.0.0");
        assert!(
            !rec.enabled,
            "a disabled app must stay disabled across an update"
        );
        assert!(!s.get("com.test.app").await.unwrap().unwrap().enabled);
    }

    /// An update on an ENABLED plugin keeps it enabled and preserves its approved
    /// grants (only the version + ui_code change).
    #[tokio::test]
    async fn update_preserves_enabled_state_and_grants() {
        let _stub = StubGrants::on();
        let s = store();
        let m = make_manifest("com.test.app", "1.0.0", vec!["spaces:docs"]);
        install_app(&s, &m).await.unwrap();
        let client = reqwest::Client::new();
        enable_app(
            &s,
            &m,
            std::slice::from_ref(&m),
            "http://127.0.0.1:7981",
            None,
            &client,
        )
        .await
        .unwrap();

        let m2 = make_manifest("com.test.app", "2.0.0", vec!["spaces:docs"]);
        let rec = update_app(&s, &m2, None, false).await.unwrap();
        assert_eq!(rec.version, "2.0.0");
        assert!(rec.enabled, "an enabled app stays enabled across an update");
        assert_eq!(rec.approved_grants, vec!["spaces:docs"]);
    }

    /// The verified `ui_code` is persisted on the record, and a later version that
    /// carries none clears the stale code.
    #[tokio::test]
    async fn update_persists_and_can_clear_ui_code() {
        let s = store();
        install_app(&s, &make_manifest("com.test.app", "1.0.0", vec![]))
            .await
            .unwrap();

        let m2 = make_manifest("com.test.app", "2.0.0", vec![]);
        update_app(&s, &m2, Some("export default {}"), false)
            .await
            .unwrap();
        assert_eq!(
            s.get_ui_code("com.test.app").await.unwrap().as_deref(),
            Some("export default {}"),
        );

        // A newer, manifest-only version (no ui_code) clears the stale bundle.
        let m3 = make_manifest("com.test.app", "3.0.0", vec![]);
        update_app(&s, &m3, None, false).await.unwrap();
        assert_eq!(s.get_ui_code("com.test.app").await.unwrap(), None);
    }

    /// ATOMICITY: a refused update (here a downgrade without force — the analog of a
    /// failed re-verify, both of which abort BEFORE any store write) leaves the
    /// installed version AND its bundled ui_code exactly as they were.
    #[tokio::test]
    async fn refused_update_leaves_version_and_ui_code_intact() {
        let s = store();
        install_app(&s, &make_manifest("com.test.app", "2.0.0", vec![]))
            .await
            .unwrap();
        // Seed a known-good bundle for the installed version.
        s.set_ui_code("com.test.app", Some("GOOD")).await.unwrap();

        let m_old = make_manifest("com.test.app", "1.0.0", vec![]);
        let err = update_app(&s, &m_old, Some("EVIL"), false)
            .await
            .unwrap_err();
        assert!(matches!(err, UpdateError::Downgrade { .. }), "got {err:?}");

        // Nothing was mutated: old version, old (good) code.
        assert_eq!(
            s.get("com.test.app").await.unwrap().unwrap().version,
            "2.0.0"
        );
        assert_eq!(
            s.get_ui_code("com.test.app").await.unwrap().as_deref(),
            Some("GOOD"),
        );
    }

    #[test]
    fn plan_update_classifies_noop_proceed_and_downgrade() {
        assert_eq!(
            plan_update("1.0.0", "1.0.0", false).unwrap(),
            UpdatePlan::NoOp
        );
        assert_eq!(
            plan_update("1.0.0", "2.0.0", false).unwrap(),
            UpdatePlan::Proceed
        );
        assert!(matches!(
            plan_update("2.0.0", "1.0.0", false),
            Err(UpdateError::Downgrade { .. })
        ));
        // Force allows the downgrade.
        assert_eq!(
            plan_update("2.0.0", "1.0.0", true).unwrap(),
            UpdatePlan::Proceed
        );
        // Invalid semver is a typed Other, never a panic.
        assert!(matches!(
            plan_update("not-semver", "1.0.0", false),
            Err(UpdateError::Other(_))
        ));
    }

    /// The novel update-closure wrapper: a new version that adds a dependency plans
    /// exactly that dependency to install — the target is excluded (it is an update,
    /// not a reinstall), and the resolver still sees the NEW edges despite the OLD
    /// target manifest being in `installed`.
    #[test]
    fn plan_update_dep_closure_installs_only_the_new_dependency() {
        // Installed: the OLD target (v1, no deps). New: v2 declaring a NEW dep.
        let old_app = make_manifest("app", "1.0.0", vec![]);
        let new_app = make_dep_manifest("app", "2.0.0", &[("newdep", None)]);
        let newdep = make_manifest("newdep", "1.0.0", vec![]);

        let installed = vec![old_app];
        let fetched = vec![newdep];
        let plan = plan_update_dep_closure(&new_app, &installed, &fetched).unwrap();

        let ids: Vec<&str> = plan.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["newdep"],
            "only the new dep is installed; target excluded"
        );
    }

    /// A dependency the new version declares that is ALREADY installed is not
    /// re-installed, and the target is still excluded — so an update that only
    /// depends on already-present plugins installs nothing.
    #[test]
    fn plan_update_dep_closure_excludes_installed_deps_and_the_target() {
        let old_app = make_manifest("app", "1.0.0", vec![]);
        let new_app = make_dep_manifest("app", "2.0.0", &[("existing", None)]);
        let existing = make_manifest("existing", "1.0.0", vec![]);

        // `existing` is installed, so it is neither fetched nor re-installed.
        let installed = vec![old_app, existing];
        let fetched: Vec<PluginManifest> = vec![];
        let plan = plan_update_dep_closure(&new_app, &installed, &fetched).unwrap();

        assert!(
            plan.is_empty(),
            "an already-satisfied dependency set installs nothing"
        );
    }

    /// A version bump that adds NO dependencies plans an empty install (the target is
    /// always excluded), so a pure code/version update touches no other plugin.
    #[test]
    fn plan_update_dep_closure_is_empty_for_a_depless_update() {
        let old_app = make_manifest("app", "1.0.0", vec![]);
        let new_app = make_manifest("app", "2.0.0", vec![]);
        let plan = plan_update_dep_closure(&new_app, &[old_app], &[]).unwrap();
        assert!(plan.is_empty());
    }

    // ── dependencies (enable order / disable refusal / cascade) ────────────────

    /// A manifest with plugin-to-plugin dependencies. `deps` = `(id, min_version)`.
    fn make_dep_manifest(id: &str, version: &str, deps: &[(&str, Option<&str>)]) -> PluginManifest {
        use crate::plugin_manifest::{AppDependency, Requires};
        PluginManifest {
            requires: Some(Requires {
                apps: deps
                    .iter()
                    .map(|(d, mv)| AppDependency {
                        id: (*d).to_owned(),
                        min_version: mv.map(str::to_owned),
                    })
                    .collect(),
                capabilities: vec![],
                grants: vec![],
            }),
            ..make_manifest(id, version, vec![])
        }
    }

    /// Enter stub-grant mode for the duration of a test (deps are grant-validated
    /// individually, so these tests need the Gateway stub).
    struct StubGrants {
        _guard: std::sync::MutexGuard<'static, ()>,
        prev: Option<String>,
    }
    impl StubGrants {
        fn on() -> Self {
            let guard = stub_grants_guard();
            let prev = std::env::var(super::ENV_STUB_GRANTS).ok();
            std::env::set_var(super::ENV_STUB_GRANTS, "1");
            Self {
                _guard: guard,
                prev,
            }
        }
    }
    impl Drop for StubGrants {
        fn drop(&mut self) {
            match &self.prev {
                Some(v) => std::env::set_var(super::ENV_STUB_GRANTS, v),
                None => std::env::remove_var(super::ENV_STUB_GRANTS),
            }
        }
    }

    /// BACKWARD COMPAT: a plugin with no `requires` enables exactly as before —
    /// one record, no dependencies. Every one of the 37 shipped manifests is this
    /// case.
    #[tokio::test]
    async fn enable_without_requires_enables_only_the_target() {
        let _stub = StubGrants::on();
        let s = store();
        let m = make_manifest("com.test.solo", "1.0.0", vec![]);
        install_app(&s, &m).await.unwrap();

        let client = reqwest::Client::new();
        let out = enable_app(
            &s,
            &m,
            std::slice::from_ref(&m),
            "http://127.0.0.1:7981",
            None,
            &client,
        )
        .await
        .unwrap();

        assert!(out.dependencies.is_empty(), "no deps means none enabled");
        assert!(out.target.enabled);
        assert_eq!(out.in_enable_order().count(), 1);
    }

    /// The headline behaviour: enabling a plugin auto-enables its installed-but-
    /// disabled dependency FIRST, then the target.
    #[tokio::test]
    async fn enable_auto_enables_disabled_dependency_in_topological_order() {
        let _stub = StubGrants::on();
        let s = store();
        let spaces = make_manifest("spaces", "1.0.0", vec![]);
        let meetings = make_dep_manifest("meetings", "1.0.0", &[("spaces", Some("1.0.0"))]);
        let all = vec![spaces.clone(), meetings.clone()];

        install_app(&s, &spaces).await.unwrap();
        install_app(&s, &meetings).await.unwrap();

        let client = reqwest::Client::new();
        let out = enable_app(&s, &meetings, &all, "http://127.0.0.1:7981", None, &client)
            .await
            .unwrap();

        // The dependency was enabled, before the target.
        let order: Vec<&str> = out.in_enable_order().map(|r| r.id.as_str()).collect();
        assert_eq!(order, vec!["spaces", "meetings"]);
        assert_eq!(out.target.id, "meetings");

        // Both are persisted enabled.
        assert!(s.get("spaces").await.unwrap().unwrap().enabled);
        assert!(s.get("meetings").await.unwrap().unwrap().enabled);
    }

    /// An ALREADY-enabled dependency is not re-enabled (no redundant work), but the
    /// target still enables.
    #[tokio::test]
    async fn enable_skips_an_already_enabled_dependency() {
        let _stub = StubGrants::on();
        let s = store();
        let spaces = make_manifest("spaces", "1.0.0", vec![]);
        let meetings = make_dep_manifest("meetings", "1.0.0", &[("spaces", None)]);
        let all = vec![spaces.clone(), meetings.clone()];

        install_app(&s, &spaces).await.unwrap();
        install_app(&s, &meetings).await.unwrap();
        let client = reqwest::Client::new();
        enable_app(&s, &spaces, &all, "http://127.0.0.1:7981", None, &client)
            .await
            .unwrap();

        let out = enable_app(&s, &meetings, &all, "http://127.0.0.1:7981", None, &client)
            .await
            .unwrap();
        assert!(
            out.dependencies.is_empty(),
            "an already-enabled dep is not re-enabled"
        );
        assert_eq!(out.target.id, "meetings");
    }

    /// A dependency that is NOT INSTALLED fails the enable — and, critically,
    /// enables NOTHING (the graph resolves before any bit flips).
    #[tokio::test]
    async fn enable_with_missing_dependency_enables_nothing() {
        let _stub = StubGrants::on();
        let s = store();
        let meetings = make_dep_manifest("meetings", "1.0.0", &[("spaces", None)]);
        // `spaces` manifest is loaded but never installed.
        let spaces = make_manifest("spaces", "1.0.0", vec![]);
        let all = vec![spaces, meetings.clone()];
        install_app(&s, &meetings).await.unwrap();

        let client = reqwest::Client::new();
        let err = enable_app(&s, &meetings, &all, "http://127.0.0.1:7981", None, &client)
            .await
            .unwrap_err();

        assert!(matches!(
            err,
            EnableError::Dependency(DependencyError::MissingDependency { .. })
        ));
        assert!(
            !s.get("meetings").await.unwrap().unwrap().enabled,
            "a failed dependency resolve must not partially enable the target"
        );
    }

    /// A dependency installed at too low a version fails the enable and enables
    /// nothing.
    #[tokio::test]
    async fn enable_with_version_too_low_dependency_enables_nothing() {
        let _stub = StubGrants::on();
        let s = store();
        let spaces = make_manifest("spaces", "1.0.0", vec![]);
        let meetings = make_dep_manifest("meetings", "1.0.0", &[("spaces", Some("2.0.0"))]);
        let all = vec![spaces.clone(), meetings.clone()];
        install_app(&s, &spaces).await.unwrap();
        install_app(&s, &meetings).await.unwrap();

        let client = reqwest::Client::new();
        let err = enable_app(&s, &meetings, &all, "http://127.0.0.1:7981", None, &client)
            .await
            .unwrap_err();

        assert!(matches!(
            err,
            EnableError::Dependency(DependencyError::VersionMismatch { .. })
        ));
        assert!(!s.get("spaces").await.unwrap().unwrap().enabled);
        assert!(!s.get("meetings").await.unwrap().unwrap().enabled);
    }

    /// Force stub mode OFF for the duration of a test, so grant validation makes a
    /// REAL call to the (deliberately unreachable) Gateway URL and fails closed.
    /// Takes the same lock as [`StubGrants`] so the two can never interleave.
    struct NoStubGrants {
        _guard: std::sync::MutexGuard<'static, ()>,
        prev: Option<String>,
    }
    impl NoStubGrants {
        fn on() -> Self {
            let guard = stub_grants_guard();
            let prev = std::env::var(super::ENV_STUB_GRANTS).ok();
            std::env::remove_var(super::ENV_STUB_GRANTS);
            Self {
                _guard: guard,
                prev,
            }
        }
    }
    impl Drop for NoStubGrants {
        fn drop(&mut self) {
            if let Some(v) = &self.prev {
                std::env::set_var(super::ENV_STUB_GRANTS, v);
            }
        }
    }

    /// ATOMICITY (the dominant failure mode): the TARGET is enabled last, so its
    /// grant check is the one most likely to fail. When it does, the dependencies
    /// resolved for it must NOT be left enabled — the whole call flips nothing.
    ///
    /// Regression test for the one-pass "validate-then-flip-each" loop, which
    /// enabled `spaces` (grantless ⇒ trivially approved), then failed on
    /// `meetings`' Gateway call and returned Err — leaving `spaces` enabled but
    /// never activated (the handler only activates on the Ok path).
    #[tokio::test]
    async fn target_grant_failure_leaves_no_dependency_enabled() {
        let _no_stub = NoStubGrants::on();
        let s = store();
        // `spaces` declares NO grants ⇒ validation is a trivial local allow (no
        // Gateway call), so it is the plugin that WOULD have been flipped early.
        let spaces = make_manifest("spaces", "1.0.0", vec![]);
        // `meetings` declares a grant ⇒ its validation makes a real Gateway call,
        // which fails closed against this unroutable port.
        let meetings = PluginManifest {
            permission_grants: vec!["spaces:docs".to_owned()],
            ..make_dep_manifest("meetings", "1.0.0", &[("spaces", None)])
        };
        let all = vec![spaces.clone(), meetings.clone()];
        install_app(&s, &spaces).await.unwrap();
        install_app(&s, &meetings).await.unwrap();

        let client = reqwest::Client::new();
        // Port 1 is unroutable ⇒ GatewayUnreachable, i.e. fail-closed.
        let err = enable_app(&s, &meetings, &all, "http://127.0.0.1:1", None, &client)
            .await
            .unwrap_err();

        assert!(
            matches!(err, EnableError::GatewayUnreachable { .. }),
            "expected fail-closed on an unreachable Gateway, got {err:?}"
        );
        assert!(
            !s.get("spaces").await.unwrap().unwrap().enabled,
            "the dependency must NOT be left enabled when the target's grant check fails"
        );
        assert!(
            !s.get("meetings").await.unwrap().unwrap().enabled,
            "the target must not be enabled"
        );
        assert!(
            s.get("spaces")
                .await
                .unwrap()
                .unwrap()
                .approved_grants
                .is_empty(),
            "no grants may be persisted for a plugin the user never successfully enabled"
        );
    }

    /// A disable that would break an ENABLED dependent is REFUSED, and the typed
    /// error names the blockers so the UI never string-parses.
    #[tokio::test]
    async fn disable_is_blocked_by_an_enabled_dependent() {
        let _stub = StubGrants::on();
        let s = store();
        let spaces = make_manifest("spaces", "1.0.0", vec![]);
        let meetings = make_dep_manifest("meetings", "1.0.0", &[("spaces", None)]);
        let all = vec![spaces.clone(), meetings.clone()];
        install_app(&s, &spaces).await.unwrap();
        install_app(&s, &meetings).await.unwrap();
        let client = reqwest::Client::new();
        enable_app(&s, &meetings, &all, "http://127.0.0.1:7981", None, &client)
            .await
            .unwrap();

        let err = disable_app(&s, "spaces", &all, false, false)
            .await
            .unwrap_err();
        let DisableError::Dependency(DependencyError::BlockedByDependents { plugin, dependents }) =
            err
        else {
            panic!("expected BlockedByDependents, got {err:?}");
        };
        assert_eq!(plugin, "spaces");
        assert_eq!(dependents, vec!["meetings"]);

        // Refused means REFUSED — spaces is still enabled.
        assert!(s.get("spaces").await.unwrap().unwrap().enabled);
    }

    /// Once the dependent is disabled, the dependency disables freely.
    #[tokio::test]
    async fn disable_is_allowed_once_the_dependent_is_disabled() {
        let _stub = StubGrants::on();
        let s = store();
        let spaces = make_manifest("spaces", "1.0.0", vec![]);
        let meetings = make_dep_manifest("meetings", "1.0.0", &[("spaces", None)]);
        let all = vec![spaces.clone(), meetings.clone()];
        install_app(&s, &spaces).await.unwrap();
        install_app(&s, &meetings).await.unwrap();
        let client = reqwest::Client::new();
        enable_app(&s, &meetings, &all, "http://127.0.0.1:7981", None, &client)
            .await
            .unwrap();

        // Disable the dependent first — now nothing depends on spaces.
        disable_app(&s, "meetings", &all, false, false)
            .await
            .unwrap();
        let out = disable_app(&s, "spaces", &all, false, false).await.unwrap();

        assert_eq!(out.disabled.len(), 1);
        assert_eq!(out.target().id, "spaces");
        assert!(!s.get("spaces").await.unwrap().unwrap().enabled);
    }

    /// The explicit opt-in cascade disables the dependents too, deepest first,
    /// target last — so nothing is ever left enabled against a disabled dependency.
    #[tokio::test]
    async fn cascade_disable_takes_dependents_down_in_reverse_topological_order() {
        let _stub = StubGrants::on();
        let s = store();
        // canvas -> whiteboard -> spaces
        let spaces = make_manifest("spaces", "1.0.0", vec![]);
        let whiteboard = make_dep_manifest("whiteboard", "1.0.0", &[("spaces", None)]);
        let canvas = make_dep_manifest("canvas", "1.0.0", &[("whiteboard", None)]);
        let all = vec![spaces.clone(), whiteboard.clone(), canvas.clone()];
        for m in &all {
            install_app(&s, m).await.unwrap();
        }
        let client = reqwest::Client::new();
        // Enabling canvas pulls the whole chain up.
        enable_app(&s, &canvas, &all, "http://127.0.0.1:7981", None, &client)
            .await
            .unwrap();
        for id in ["spaces", "whiteboard", "canvas"] {
            assert!(
                s.get(id).await.unwrap().unwrap().enabled,
                "{id} should be on"
            );
        }

        let out = disable_app(&s, "spaces", &all, true, false).await.unwrap();

        let order: Vec<&str> = out.disabled.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(
            order,
            vec!["canvas", "whiteboard", "spaces"],
            "dependents first (deepest first), target last"
        );
        for id in ["spaces", "whiteboard", "canvas"] {
            assert!(
                !s.get(id).await.unwrap().unwrap().enabled,
                "{id} should be off after the cascade"
            );
        }
    }

    /// A disabled dependent never blocks a disable — only ENABLED plugins can.
    #[tokio::test]
    async fn a_disabled_dependent_does_not_block() {
        let _stub = StubGrants::on();
        let s = store();
        let spaces = make_manifest("spaces", "1.0.0", vec![]);
        let meetings = make_dep_manifest("meetings", "1.0.0", &[("spaces", None)]);
        let all = vec![spaces.clone(), meetings.clone()];
        install_app(&s, &spaces).await.unwrap();
        install_app(&s, &meetings).await.unwrap(); // installed, never enabled
        let client = reqwest::Client::new();
        enable_app(&s, &spaces, &all, "http://127.0.0.1:7981", None, &client)
            .await
            .unwrap();

        // meetings is installed but disabled, so it cannot break.
        let out = disable_app(&s, "spaces", &all, false, false).await.unwrap();
        assert_eq!(out.target().id, "spaces");
    }

    #[tokio::test]
    async fn disable_of_an_uninstalled_plugin_is_not_installed() {
        let s = store();
        let err = disable_app(&s, "nope", &[], false, false)
            .await
            .unwrap_err();
        assert!(matches!(err, DisableError::NotInstalled { .. }));
    }

    // ── load-bearing guard ─────────────────────────────────────────────────────

    /// Disabling a load-bearing plugin (`engines`) is REFUSED without force, and a
    /// refusal changes nothing. `force = true` is the explicit override.
    #[tokio::test]
    async fn disable_of_a_load_bearing_plugin_is_refused_without_force() {
        let s = store();
        // `engines` is load-bearing (the local chat engine every default agent uses).
        let m = make_manifest("engines", "1.0.0", vec![]);
        install_app(&s, &m).await.unwrap();
        s.set_enabled("engines", &[]).await.unwrap();

        let err = disable_app(&s, "engines", std::slice::from_ref(&m), false, false)
            .await
            .unwrap_err();
        assert!(
            matches!(err, DisableError::LoadBearing { .. }),
            "got {err:?}"
        );
        // Refused means REFUSED — engines is still enabled.
        assert!(s.get("engines").await.unwrap().unwrap().enabled);

        // The explicit force override goes through.
        let out = disable_app(&s, "engines", std::slice::from_ref(&m), false, true)
            .await
            .unwrap();
        assert_eq!(out.target().id, "engines");
        assert!(!s.get("engines").await.unwrap().unwrap().enabled);
    }

    /// A cascade must not tear down a load-bearing plugin pulled in as a collateral
    /// dependent. If `engines` (load-bearing) ever depends on some plugin `x`, a
    /// `cascade=true` disable of `x` resolves an order containing `engines` — and
    /// must refuse without `force`, not silently strip a core subsystem.
    #[tokio::test]
    async fn cascade_disable_refuses_when_a_dependent_is_load_bearing() {
        let s = store();
        let x = make_manifest("com.test.x", "1.0.0", vec![]);
        // `engines` depends on `x`, so disabling `x` cascades into `engines`.
        let engines = make_dep_manifest("engines", "1.0.0", &[("com.test.x", None)]);
        let all = vec![x.clone(), engines.clone()];
        install_app(&s, &x).await.unwrap();
        install_app(&s, &engines).await.unwrap();
        s.set_enabled("com.test.x", &[]).await.unwrap();
        s.set_enabled("engines", &[]).await.unwrap();

        let err = disable_app(&s, "com.test.x", &all, true, false)
            .await
            .unwrap_err();
        let DisableError::LoadBearing { id } = err else {
            panic!("expected LoadBearing, got {err:?}");
        };
        assert_eq!(id, "engines");
        // Refused means REFUSED — nothing was flipped, engines still up.
        assert!(s.get("engines").await.unwrap().unwrap().enabled);
        assert!(s.get("com.test.x").await.unwrap().unwrap().enabled);
    }

    // ── uninstall ──────────────────────────────────────────────────────────────

    /// Uninstalling a dependency while an ENABLED dependent needs it is refused with
    /// the SAME typed `BlockedByDependents` a disable uses — and removes nothing.
    #[tokio::test]
    async fn uninstall_is_refused_by_an_enabled_dependent() {
        let _stub = StubGrants::on();
        let s = store();
        let lib = make_manifest("com.test.lib", "1.0.0", vec![]);
        let app = make_dep_manifest("com.test.app", "1.0.0", &[("com.test.lib", None)]);
        let all = vec![lib.clone(), app.clone()];
        install_app(&s, &lib).await.unwrap();
        install_app(&s, &app).await.unwrap();
        let client = reqwest::Client::new();
        enable_app(&s, &app, &all, "http://127.0.0.1:7981", None, &client)
            .await
            .unwrap();

        let err = uninstall_app(&s, "com.test.lib", &all, false)
            .await
            .unwrap_err();
        let UninstallError::Dependency(DependencyError::BlockedByDependents { plugin, dependents }) =
            err
        else {
            panic!("expected BlockedByDependents, got {err:?}");
        };
        assert_eq!(plugin, "com.test.lib");
        assert_eq!(dependents, vec!["com.test.app"]);
        // A refused uninstall is never a partial one — the record survives.
        assert!(s.get("com.test.lib").await.unwrap().is_some());
    }

    /// The opt-in cascade disables the dependents (dependents first, target last)
    /// and removes the target record. Cascaded dependents stay installed-but-disabled.
    #[tokio::test]
    async fn uninstall_cascade_disables_dependents_then_removes_the_target() {
        let _stub = StubGrants::on();
        let s = store();
        let lib = make_manifest("com.test.lib", "1.0.0", vec![]);
        let app = make_dep_manifest("com.test.app", "1.0.0", &[("com.test.lib", None)]);
        let all = vec![lib.clone(), app.clone()];
        install_app(&s, &lib).await.unwrap();
        install_app(&s, &app).await.unwrap();
        let client = reqwest::Client::new();
        enable_app(&s, &app, &all, "http://127.0.0.1:7981", None, &client)
            .await
            .unwrap();

        let out = uninstall_app(&s, "com.test.lib", &all, true).await.unwrap();
        assert_eq!(out.removed, "com.test.lib");
        let order: Vec<&str> = out.disabled.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(
            order,
            vec!["com.test.app", "com.test.lib"],
            "dependents disabled first, target last"
        );
        // The target is gone; the dependent remains installed but disabled.
        assert!(s.get("com.test.lib").await.unwrap().is_none());
        assert!(!s.get("com.test.app").await.unwrap().unwrap().enabled);
    }

    /// Uninstalling a built-in is REFUSED so it can never be resurrected by the
    /// startup seed. `goal` isolates the `is_default_on` branch: default-on, NOT a
    /// SYSTEM plugin, NOT load-bearing — a weak `is_builtin`-only guard would wrongly
    /// allow it and the seed would re-add it on the next boot.
    #[tokio::test]
    async fn uninstall_of_a_builtin_is_refused_so_it_never_resurrects() {
        let s = store();
        let m = make_manifest("goal", "1.0.0", vec![]);
        install_app(&s, &m).await.unwrap();
        s.set_enabled("goal", &[]).await.unwrap();

        let err = uninstall_app(&s, "goal", std::slice::from_ref(&m), false)
            .await
            .unwrap_err();
        assert!(
            matches!(err, UninstallError::Protected { .. }),
            "got {err:?}"
        );
        // Untouched: refusing the uninstall is exactly what stops the seed re-adding it.
        assert!(s.get("goal").await.unwrap().unwrap().enabled);
    }

    /// A Community plugin uninstalls cleanly and can be reinstalled — no tombstone,
    /// a fresh disabled record.
    #[tokio::test]
    async fn uninstall_then_reinstall_of_a_community_plugin() {
        let s = store();
        let m = make_manifest("com.test.app", "1.0.0", vec![]);
        install_app(&s, &m).await.unwrap();

        let out = uninstall_app(&s, "com.test.app", std::slice::from_ref(&m), false)
            .await
            .unwrap();
        assert_eq!(out.removed, "com.test.app");
        assert!(
            s.get("com.test.app").await.unwrap().is_none(),
            "the record is removed"
        );

        // Reinstall mints a fresh disabled record (uninstall left no tombstone).
        let rec = install_app(&s, &m).await.unwrap();
        assert!(!rec.enabled);
        assert!(s.get("com.test.app").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn uninstall_of_an_uninstalled_plugin_is_not_installed() {
        let s = store();
        let err = uninstall_app(&s, "nope", &[], false).await.unwrap_err();
        assert!(matches!(err, UninstallError::NotInstalled { .. }));
    }

}
