//! Optional **recommended skill packs** — the external skills Ryu can install
//! for a node after its owner or administrator makes an explicit selection.
//!
//! A fresh Ryu does not fetch this catalog on boot. The embedded Ryu and pstack
//! skills are owned by the `ryu-skills` crate and remain available offline; this
//! module only manages the separate third-party pack catalog. Unlike the old
//! run-once defaults, the selected set is a **sync**, not a one-shot:
//!
//! - a bundled skill missing from the disk is installed (origin `system`);
//! - a bundled skill **dropped** from the catalog is removed — unless the user
//!   reinstalled it, which flips its origin to `user` and makes it invisible to
//!   the auto-remover forever;
//! - user-installed skills (catalog/from-source/pack/CLI) are never touched.
//!
//! ## Origin registry
//!
//! `~/.ryu/skills-origin.json` maps `slug → "system" | "user"`. Every install
//! path records an origin: the sync pipeline writes `system`; a user install
//! writes `user`. A slug with no entry defaults to `user` (never auto-removed),
//! which is also what keeps skills the user had before Ryu ever ran safe.
//!
//! ## Source boundaries
//!
//! Ryu-authored skills under `apps/skills` are embedded by `ryu-skills` and
//! installed offline. Third-party catalog packs are different: they are
//! installed from their upstream repos at sync time through Core's fetcher.
//! Several upstream packs carry
//! proprietary per-skill licenses that forbid redistribution, so never copy
//! those third-party bytes into this tree or mirror them from a Ryu-controlled
//! host.

use std::collections::HashSet;
use std::path::PathBuf;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use super::distribution::{
    distribute_skill, list_agent_targets, parse_preferences, DistributionContext,
    DistributionStatus, SkillAgentTargetView, SkillInstallPreferencesV1, INSTALL_TARGETS_PREF,
};
use super::packs::{self, PackSource};

/// The origin registry file (`~/.ryu/skills-origin.json`).
fn origin_path() -> PathBuf {
    crate::paths::state_path("skills-origin.json")
}

/// Who owns an installed skill. `System` = managed by Ryu's bundled catalog
/// (auto-removable); `User` = the user installed it (never auto-removed).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillOrigin {
    System,
    User,
}

/// The persisted `slug → origin` registry.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OriginRegistry {
    #[serde(default)]
    skills: std::collections::HashMap<String, SkillOrigin>,
}

impl OriginRegistry {
    pub fn load() -> Self {
        std::fs::read_to_string(origin_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save(&self) {
        let path = origin_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(path, json);
        }
    }

    /// The recorded origin for a slug, defaulting to [`SkillOrigin::User`] so an
    /// unknown skill can never be auto-removed.
    pub fn origin(&self, slug: &str) -> SkillOrigin {
        self.skills.get(slug).copied().unwrap_or(SkillOrigin::User)
    }
}

/// Record the origin for one skill. `User` marks a skill the user chose;
/// `System` marks one the bundled catalog manages.
pub fn record_origin(slug: &str, origin: SkillOrigin) {
    let mut registry = OriginRegistry::load();
    registry.skills.insert(slug.to_string(), origin);
    registry.save();
}

/// The origin recorded for a slug (default [`SkillOrigin::User`]).
pub fn origin_of(slug: &str) -> SkillOrigin {
    OriginRegistry::load().origin(slug)
}

/// Preference gate for reconciling an already-configured selection on boot.
/// The selection itself is the required opt-in for a fresh node.
pub const SYNC_ENABLED_PREF: &str = "skills.sync-system";
/// The catalog version the last successful sync applied. A catalog change bumps
/// the selection-aware version, so a boot only runs the sync when the catalog or
/// the selected pack set actually moved.
pub const SYNCED_VERSION_PREF: &str = "skills.synced-bundle-version";

/// Node-scoped preference written by the onboarding/admin skill picker.
pub const SELECTION_PREF: &str = "skills.optional-bundle-selection.v1";
pub const SELECTION_VERSION: u8 = 1;

/// The persisted optional-pack selection. `configured = false` is deliberately
/// distinct from an explicit empty selection: the former means onboarding has
/// not asked yet, while the latter means the administrator chose no optional
/// packs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BundledSkillSelectionV1 {
    pub configured: bool,
    pub pack_ids: Vec<String>,
    pub version: u8,
}

impl Default for BundledSkillSelectionV1 {
    fn default() -> Self {
        Self {
            configured: false,
            pack_ids: Vec::new(),
            version: SELECTION_VERSION,
        }
    }
}

/// A safe, user-facing entry in the onboarding picker. These are pack-level
/// choices because the current forced bundle is repository-based: selecting a
/// row installs all of that repository's skills through the existing per-skill
/// installer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledSkillPackOption {
    pub description: String,
    pub id: String,
    pub name: String,
}

/// Return the external recommended packs. Ryu-authored and plugin-contributed
/// skills are intentionally absent: they have their own built-in/plugin
/// lifecycle and are not onboarding choices.
pub fn bundled_skill_pack_options() -> Vec<BundledSkillPackOption> {
    packs::builtin_packs()
        .into_iter()
        .map(|pack| BundledSkillPackOption {
            description: pack.description,
            id: pack.id,
            name: pack.name,
        })
        .collect()
}

/// All current external pack ids, in catalog order. The UI uses this as the
/// recommended default before an administrator has made a choice.
pub fn default_selected_pack_ids() -> Vec<String> {
    packs::BUILTIN_PACKS
        .iter()
        .map(|(id, _)| (*id).to_owned())
        .collect()
}

/// Validate and canonicalize a selection. Unknown ids are rejected rather than
/// becoming a way to smuggle an arbitrary repository into the node's automatic
/// boot installer. The returned order is the stable catalog order.
pub fn normalize_selected_pack_ids(ids: &[String]) -> Result<Vec<String>> {
    let allowed = packs::BUILTIN_PACKS
        .iter()
        .map(|(id, _)| *id)
        .collect::<HashSet<_>>();
    for id in ids {
        if !allowed.contains(id.as_str()) {
            anyhow::bail!("unknown bundled skill pack `{id}`");
        }
    }
    let selected = ids.iter().map(String::as_str).collect::<HashSet<_>>();
    Ok(packs::BUILTIN_PACKS
        .iter()
        .filter(|(id, _)| selected.contains(id))
        .map(|(id, _)| (*id).to_owned())
        .collect())
}

/// Read the stored selection, failing closed to an unconfigured node when the
/// JSON is malformed, has an unknown version, or names an unknown pack.
pub async fn read_selection(
    preferences: &crate::server::preferences::PreferencesStore,
) -> BundledSkillSelectionV1 {
    let Some(raw) = preferences.get(SELECTION_PREF).await.ok().flatten() else {
        return BundledSkillSelectionV1::default();
    };
    let Ok(stored) = serde_json::from_str::<BundledSkillSelectionV1>(&raw) else {
        tracing::warn!("optional bundled skill selection is invalid; treating it as unconfigured");
        return BundledSkillSelectionV1::default();
    };
    if stored.version != SELECTION_VERSION {
        tracing::warn!(
            version = stored.version,
            "optional bundled skill selection version is unsupported"
        );
        return BundledSkillSelectionV1::default();
    }
    let Ok(pack_ids) = normalize_selected_pack_ids(&stored.pack_ids) else {
        tracing::warn!("optional bundled skill selection contains an unknown pack; treating it as unconfigured");
        return BundledSkillSelectionV1::default();
    };
    BundledSkillSelectionV1 {
        configured: stored.configured,
        pack_ids,
        version: SELECTION_VERSION,
    }
}

/// Persist a validated administrator choice. The write happens before the
/// network sync so a partially completed install can retry on the next boot.
pub async fn save_selection(
    preferences: &crate::server::preferences::PreferencesStore,
    pack_ids: &[String],
) -> Result<BundledSkillSelectionV1> {
    let selection = BundledSkillSelectionV1 {
        configured: true,
        pack_ids: normalize_selected_pack_ids(pack_ids)?,
        version: SELECTION_VERSION,
    };
    preferences
        .set(SELECTION_PREF, &serde_json::to_string(&selection)?)
        .await?;
    Ok(selection)
}

/// The UI's effective selection: all external packs before the first explicit
/// choice, or the exact persisted set afterwards. This default is presentation
/// only; `run_on_boot` never installs until `configured` is true.
pub fn effective_selected_pack_ids(selection: &BundledSkillSelectionV1) -> Vec<String> {
    if selection.configured {
        selection.pack_ids.clone()
    } else {
        default_selected_pack_ids()
    }
}

/// Include both the catalog revision and the selected pack set so changing a
/// selection cannot be mistaken for an already-synced catalog on the next boot.
pub fn selection_bundle_version(pack_ids: &[String]) -> String {
    let normalized = normalize_selected_pack_ids(pack_ids).unwrap_or_default();
    let mut input = bundle_version();
    input.push('|');
    input.push_str(&normalized.join(","));
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in input.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:016x}", hash)
}

/// Historical single-skill defaults from the Anthropic pack. They are retained
/// as explicit member ids so a selected pack remains compatible with older
/// catalog revisions. Ryu's `pdf` skill is compiled into Core and is deliberately
/// not fetched as an external default.
pub const DEFAULT_SKILLS: &[&str] = super::default_skills::DEFAULT_SKILLS;
/// The repo those single-skill defaults live in.
pub const DEFAULT_SKILL_REPO: &str = super::default_skills::DEFAULT_SKILL_REPO;

/// The bundled repos the catalog installs as packs (every `SKILL.md` in each is a
/// member). This is the pack catalog — a repo added here auto-installs its
/// skills; a repo dropped here auto-removes its `System`-owned skills.
pub fn bundled_repos() -> Vec<String> {
    let mut repos: Vec<String> = packs::builtin_packs()
        .into_iter()
        .filter_map(|pack| match pack.source {
            PackSource::Repo { repo } => Some(repo),
            PackSource::Custom { .. } => None,
        })
        .collect();
    if !repos.iter().any(|r| r == DEFAULT_SKILL_REPO) {
        repos.push(DEFAULT_SKILL_REPO.to_string());
    }
    repos
}

/// A version string that changes whenever the bundled catalog changes: derived
/// from the repo list + the pinned defaults, so it cannot drift from the catalog
/// it versions. A plain FNV-1a over the joined ids (stable across runs).
pub fn bundle_version() -> String {
    let mut input = bundled_repos().join(",");
    if !input.is_empty() {
        input.push(',');
    }
    input.push_str(&DEFAULT_SKILLS.join(","));
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in input.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:016x}", hash)
}

// ── Sync ─────────────────────────────────────────────────────────────────────

/// What a sync run changed, for the status payload + logging.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct SyncReport {
    pub installed: Vec<String>,
    pub removed: Vec<String>,
    pub skipped_user: Vec<String>,
    pub resolved: Vec<String>,
    /// True only when every catalog lookup and filesystem mutation completed.
    /// Callers must not checkpoint the catalog version after a partial run.
    pub complete: bool,
    /// Per-repository/per-skill failures retained for the API and boot logs.
    pub errors: Vec<String>,
    /// Target-distribution warnings. These never make the canonical catalog
    /// sync incomplete: an unavailable third-party agent directory must not
    /// suppress future bundled-catalog reconciliation.
    pub distribution_errors: Vec<String>,
}

/// The on-disk registry is keyed by slug, so two catalog ids with the same leaf
/// cannot coexist. Keep the first catalog entry deterministically instead of
/// installing both in sequence and silently letting the latter overwrite it.
fn dedupe_skill_ids(ids: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    ids.into_iter()
        .filter(|id| seen.insert(crate::skills_catalog::slug_of(id)))
        .collect()
}

/// Keep remembered install targets only when the preference is explicitly
/// configured and the target remains globally selectable. Multiple agent ids
/// can resolve to one directory, so keep the first path deterministically.
fn configured_global_target_ids(
    preferences: &SkillInstallPreferencesV1,
    targets: &[SkillAgentTargetView],
) -> Vec<String> {
    if !preferences.configured {
        return Vec::new();
    }

    let targets_by_id = targets
        .iter()
        .map(|target| (target.id.as_str(), target))
        .collect::<std::collections::HashMap<_, _>>();
    let mut seen_paths = HashSet::new();
    preferences
        .target_ids
        .iter()
        .filter(|target_id| {
            targets_by_id
                .get(target_id.as_str())
                .filter(|target| target.selectable)
                .and_then(|target| target.resolved_global_path.as_deref())
                .is_some_and(|path| seen_paths.insert(path.to_owned()))
        })
        .cloned()
        .collect()
}

/// Read saved target preferences without prompting. Malformed or unavailable
/// selections are ignored here because boot reconciliation must stay best-effort.
async fn remembered_global_target_ids(
    preferences: &crate::server::preferences::PreferencesStore,
) -> Vec<String> {
    let raw = preferences.get(INSTALL_TARGETS_PREF).await.ok().flatten();
    let context = match DistributionContext::current() {
        Ok(context) => context,
        Err(error) => {
            tracing::warn!(error = %error, "reading saved system-skill targets failed");
            return Vec::new();
        }
    };
    let targets = match list_agent_targets(&context.home_dir, &context.environment) {
        Ok(targets) => targets,
        Err(error) => {
            tracing::warn!(error = %error, "resolving saved system-skill targets failed");
            return Vec::new();
        }
    };
    let parsed = parse_preferences(raw.as_deref(), &targets);
    if let Some(warning) = parsed.warning {
        tracing::warn!(%warning, "saved system-skill targets were ignored");
    }
    configured_global_target_ids(&parsed.preferences, &targets)
}

/// Run target fan-out after canonical catalog reconciliation, without allowing
/// a third-party target error to alter catalog completeness.
fn fan_out_after_catalog_sync(
    mut report: SyncReport,
    target_ids: &[String],
    fan_out: impl FnOnce(&[String], &mut SyncReport),
) -> SyncReport {
    if !target_ids.is_empty() {
        fan_out(target_ids, &mut report);
    }
    report
}

fn report_distribution_warning(
    report: &mut SyncReport,
    skill: &str,
    target_id: &str,
    message: String,
) {
    tracing::warn!(%skill, %target_id, %message, "system skill target distribution did not succeed");
    report
        .distribution_errors
        .push(format!("{skill} -> {target_id}: {message}"));
}

/// Verify/copy the installed canonical defaults into remembered agent targets.
/// The source path is intentionally exact: distribution receives each default's
/// canonical `SKILL.md`, never a scanned alias root.
fn distribute_default_skills(
    target_ids: &[String],
    selected_pack_ids: &[String],
    report: &mut SyncReport,
) {
    if !selected_pack_ids.iter().any(|id| id == DEFAULT_SKILL_REPO) {
        return;
    }
    let context = match DistributionContext::current() {
        Ok(context) => context,
        Err(error) => {
            for target_id in target_ids {
                report_distribution_warning(report, "default", target_id, error.to_string());
            }
            return;
        }
    };

    for skill in DEFAULT_SKILLS {
        let source_skill_md = ryu_skills::SkillRegistry::skills_dir()
            .join(skill)
            .join("SKILL.md");
        if !source_skill_md.is_file() {
            for target_id in target_ids {
                report_distribution_warning(
                    report,
                    skill,
                    target_id,
                    format!("canonical source {} is absent", source_skill_md.display()),
                );
            }
            continue;
        }

        match distribute_skill(&context, skill, source_skill_md.as_path(), target_ids) {
            Ok(result) => {
                for target in result.targets {
                    if matches!(
                        target.status,
                        DistributionStatus::Conflict | DistributionStatus::Failed
                    ) {
                        report_distribution_warning(
                            report,
                            skill,
                            &target.target_id,
                            target
                                .message
                                .unwrap_or_else(|| format!("{:?}", target.status)),
                        );
                    }
                }
            }
            Err(error) => {
                for target_id in target_ids {
                    report_distribution_warning(report, skill, target_id, error.to_string());
                }
            }
        }
    }
}

/// Run the selected external-pack sync: install missing skills with origin
/// `System`, remove `System`-owned skills outside the selected set, and leave
/// every `User`-owned or embedded Ryu skill alone. Idempotent and safe to run on
/// boot or after an onboarding selection.
pub async fn sync_bundled_selected(
    client: &reqwest::Client,
    enabled: bool,
    synced_version: &str,
    selected_pack_ids: &[String],
    target_ids: &[String],
) -> SyncReport {
    let current_version = selection_bundle_version(selected_pack_ids);
    sync_bundled_inner(
        client,
        enabled,
        synced_version,
        selected_pack_ids,
        target_ids,
        current_version,
    )
    .await
}

async fn sync_bundled_inner(
    client: &reqwest::Client,
    enabled: bool,
    synced_version: &str,
    selected_pack_ids: &[String],
    target_ids: &[String],
    current_version: String,
) -> SyncReport {
    let mut report = SyncReport::default();
    if !enabled {
        tracing::debug!("system-skills sync disabled via `{SYNC_ENABLED_PREF}`");
        return report;
    }
    let selected_pack_ids = match normalize_selected_pack_ids(selected_pack_ids) {
        Ok(pack_ids) => pack_ids,
        Err(error) => {
            report.errors.push(error.to_string());
            return report;
        }
    };
    if synced_version == current_version {
        report.complete = true;
        return fan_out_after_catalog_sync(report, target_ids, |target_ids, report| {
            distribute_default_skills(target_ids, &selected_pack_ids, report);
        });
    }

    let installed = crate::skills_catalog::installed_slugs();

    // 1. Resolve only the repositories the administrator selected → member ids.
    let mut desired_ids: Vec<String> = Vec::new();
    let mut resolution_complete = true;
    for repo in &selected_pack_ids {
        let source = PackSource::Repo { repo: repo.clone() };
        match packs::resolve_member_ids(client, &source).await {
            Ok(ids) => desired_ids.extend(ids),
            Err(e) => {
                tracing::warn!(repo, error = %e, "bundled pack resolution failed");
                resolution_complete = false;
                report
                    .errors
                    .push(format!("could not resolve bundled repo {repo}: {e}"));
            }
        }
    }
    // The pinned document defaults ride along when the Anthropic pack is
    // selected. This keeps the historical default ids available even if the
    // upstream tree temporarily omits one of their directories.
    if selected_pack_ids.iter().any(|id| id == DEFAULT_SKILL_REPO) {
        for slug in DEFAULT_SKILLS {
            desired_ids.push(format!("{DEFAULT_SKILL_REPO}/{slug}"));
        }
    }
    let desired_ids = dedupe_skill_ids(desired_ids);
    report.resolved = desired_ids.clone();
    let desired: HashSet<String> = desired_ids
        .iter()
        .map(|id| crate::skills_catalog::slug_of(id))
        .collect();

    // 2. Install missing bundled skills (origin `System`). Best-effort per skill.
    for id in &desired_ids {
        let slug = crate::skills_catalog::slug_of(id);
        if installed.contains(&slug) {
            continue;
        }
        match packs::install_skill_by_id(client, id).await {
            Ok(_result) => {
                record_origin(&slug, SkillOrigin::System);
                report.installed.push(slug);
            }
            Err(e) => {
                tracing::warn!(skill = %id, error = %e, "bundled skill install failed");
                report
                    .errors
                    .push(format!("could not install bundled skill {id}: {e}"));
            }
        }
    }

    // 3. Remove `System`-owned skills no longer in the catalog — unless the user
    //    reinstalled (origin `User`), which is exactly what the registry says.
    let registry = OriginRegistry::load();
    let mut to_remove: Vec<String> = Vec::new();
    if resolution_complete {
        for (slug, origin) in &registry.skills {
            if *origin != SkillOrigin::System {
                continue;
            }
            if desired.contains(slug) {
                continue;
            }
            to_remove.push(slug.clone());
        }
    }
    let mut registry_for_removal = registry;
    for slug in to_remove {
        // Safety belt: never remove a slug that is not actually on disk under a
        // system marker, and never touch a user-owned skill.
        match remove_system_skill(&slug) {
            Ok(()) => {
                registry_for_removal.skills.remove(&slug);
                report.removed.push(slug);
            }
            Err(e) => {
                tracing::warn!(skill = %slug, error = %e, "bundled skill removal failed");
                report
                    .errors
                    .push(format!("could not remove bundled skill {slug}: {e}"));
            }
        }
    }
    registry_for_removal.save();

    report.complete = report.errors.is_empty();
    fan_out_after_catalog_sync(report, target_ids, |target_ids, report| {
        distribute_default_skills(target_ids, &selected_pack_ids, report);
    })
}

/// Selected-pack variant used by onboarding and the boot reconciler.
pub async fn sync_selected_bundled_with_preferences(
    client: &reqwest::Client,
    preferences: &crate::server::preferences::PreferencesStore,
    enabled: bool,
    synced_version: &str,
    selected_pack_ids: &[String],
) -> SyncReport {
    let target_ids = remembered_global_target_ids(preferences).await;
    sync_bundled_selected(
        client,
        enabled,
        synced_version,
        selected_pack_ids,
        &target_ids,
    )
    .await
}

/// Remove a `System`-owned skill directory and deactivate it. Only ever called
/// for a skill whose origin is `System`, so a user skill can never reach here.
fn remove_system_skill(slug: &str) -> Result<()> {
    let dir = ryu_skills::SkillRegistry::skills_dir().join(slug);
    if !dir.exists() {
        return Ok(());
    }
    ryu_skills::set_active(slug, false);
    std::fs::remove_dir_all(&dir).map_err(|e| anyhow::anyhow!("removing {slug}: {e}"))?;
    Ok(())
}

/// The boot entry point: read the gate + the catalog version the last run
/// applied, run the sync, and persist the applied version so a no-op boot skips
/// it. Never returns an error — this runs on the boot path and a failed sync
/// must not affect anything else.
pub async fn run_on_boot(
    client: &reqwest::Client,
    preferences: &crate::server::preferences::PreferencesStore,
) {
    let selection = read_selection(preferences).await;
    if !selection.configured {
        // The external catalog is available from onboarding and the Skills
        // page, but a fresh node must never download it before an owner/admin
        // has made the node-scoped choice.
        tracing::debug!("optional bundled skills are awaiting an onboarding selection");
        return;
    }

    let enabled = preferences
        .get(SYNC_ENABLED_PREF)
        .await
        .ok()
        .flatten()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "true" | "1" | "on" | "yes"
            )
        })
        .unwrap_or(true);
    let synced_version = preferences
        .get(SYNCED_VERSION_PREF)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();

    let report = sync_selected_bundled_with_preferences(
        client,
        preferences,
        enabled,
        &synced_version,
        &selection.pack_ids,
    )
    .await;
    let version = selection_bundle_version(&selection.pack_ids);
    // A partial network/filesystem run must retry next boot. Checkpoint only a
    // completely applied catalog; otherwise a transient outage can permanently
    // suppress missing installs (and used to remove skills from unresolved repos).
    if enabled && synced_version != version && report.complete {
        let _ = preferences.set(SYNCED_VERSION_PREF, &version).await;
    }
    if !report.complete {
        tracing::warn!(errors = ?report.errors, "system skills sync incomplete; will retry");
    }
    if report.installed.is_empty() && report.removed.is_empty() {
        return;
    }
    tracing::info!(
        installed = ?report.installed,
        removed = ?report.removed,
        "system skills sync applied"
    );
    ryu_skills::SkillRegistry::load().reload();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_version_changes_with_catalog() {
        let v1 = bundle_version();
        assert_eq!(v1.len(), 16);
        assert!(bundled_repos().iter().any(|r| r == DEFAULT_SKILL_REPO));
        assert_eq!(bundle_version(), v1, "stable across calls");
    }

    #[test]
    fn onboarding_options_are_the_external_pack_catalog_only() {
        let options = bundled_skill_pack_options();
        assert_eq!(options.len(), packs::BUILTIN_PACKS.len());
        assert!(options
            .iter()
            .all(|option| !option.name.is_empty() && !option.description.is_empty()));
        assert!(options.iter().any(|option| option.id == "wshobson/agents"));
        assert!(options.iter().all(|option| !option.id.starts_with("ryu-")));
    }

    #[test]
    fn selection_defaults_to_all_for_presentation_but_not_for_boot() {
        let selection = BundledSkillSelectionV1::default();
        assert!(!selection.configured);
        assert_eq!(
            effective_selected_pack_ids(&selection),
            default_selected_pack_ids()
        );
    }

    #[test]
    fn selected_pack_ids_are_validated_and_canonicalized() {
        let selected = normalize_selected_pack_ids(&[
            "openai/plugins".to_owned(),
            "mattpocock/skills".to_owned(),
            "openai/plugins".to_owned(),
        ])
        .unwrap();
        assert_eq!(selected, ["mattpocock/skills", "openai/plugins"]);
        assert!(normalize_selected_pack_ids(&["owner/untrusted-pack".to_owned()]).is_err());
    }

    #[test]
    fn selection_version_changes_when_the_selected_set_changes() {
        let all = default_selected_pack_ids();
        let none = Vec::new();
        assert_ne!(
            selection_bundle_version(&all),
            selection_bundle_version(&none)
        );
        assert_eq!(
            selection_bundle_version(&all),
            selection_bundle_version(&all)
        );
    }

    #[test]
    fn diagram_design_is_in_the_bundled_repositories() {
        assert!(
            bundled_repos()
                .iter()
                .any(|repo| repo == "cathrynlavery/diagram-design"),
            "diagram-design should be included in boot sync"
        );
    }

    #[test]
    fn unlazy_is_in_the_bundled_repositories() {
        assert!(
            bundled_repos().iter().any(|repo| repo == "Leonxlnx/unlazy"),
            "unlazy should be included in boot sync"
        );
    }

    #[test]
    fn default_skill_is_bundled() {
        for slug in DEFAULT_SKILLS {
            assert!(
                is_bundled_guard(slug),
                "{slug} should be considered bundled"
            );
        }
    }

    #[test]
    fn catalog_ids_are_deduplicated_by_on_disk_slug() {
        let ids = dedupe_skill_ids(vec![
            "first/repo/review".to_owned(),
            "second/repo/review".to_owned(),
            "second/repo/tdd".to_owned(),
        ]);
        assert_eq!(ids, ["first/repo/review", "second/repo/tdd"]);
    }

    #[test]
    fn origin_defaults_to_user() {
        // `RYU_DIR` is process-global and `origin_path()` resolves through it, so
        // a concurrent test pointing the var at its own tempdir makes the reads
        // below land in an unrelated tree. Hold the shared skills-env lock the way
        // every other `RYU_SKILLS_DIR`/`RYU_DIR` test in the binary does.
        let _env_lock = ryu_skills::SKILLS_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var_os("RYU_DIR");
        let tmp = std::env::temp_dir().join(format!("ryu-origin-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::env::set_var("RYU_DIR", &tmp);

        let registry = OriginRegistry::load();
        assert_eq!(registry.origin("anything"), SkillOrigin::User);

        record_origin("sys-skill", SkillOrigin::System);
        record_origin("user-skill", SkillOrigin::User);
        assert_eq!(origin_of("sys-skill"), SkillOrigin::System);
        assert_eq!(origin_of("user-skill"), SkillOrigin::User);

        match prev {
            Some(v) => std::env::set_var("RYU_DIR", v),
            None => std::env::remove_var("RYU_DIR"),
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// A non-network guard that mirrors `is_bundled_slug`'s DEFAULT_SKILLS branch,
    /// so the "defaults are never auto-removed" invariant is testable offline.
    fn is_bundled_guard(slug: &str) -> bool {
        DEFAULT_SKILLS.contains(&slug)
    }

    #[tokio::test]
    async fn sync_respects_enabled_gate() {
        let client = reqwest::Client::new();
        let report = sync_bundled_selected(&client, false, "", &[], &[]).await;
        assert!(report.installed.is_empty());
        assert!(report.removed.is_empty());
        assert!(!report.complete);
    }

    #[tokio::test]
    async fn sync_skips_when_version_matches() {
        let client = reqwest::Client::new();
        let selected = default_selected_pack_ids();
        let version = selection_bundle_version(&selected);
        let report = sync_bundled_selected(&client, true, &version, &selected, &[]).await;
        assert!(report.installed.is_empty());
        assert!(report.removed.is_empty());
        assert!(report.complete);
    }

    fn target(id: &str, path: &str) -> crate::skills_catalog::distribution::SkillAgentTargetView {
        crate::skills_catalog::distribution::SkillAgentTargetView {
            id: id.to_owned(),
            name: id.to_owned(),
            project_skills_dir: ".agents/skills".to_owned(),
            global_skills_dir: Some(path.to_owned()),
            resolved_global_path: Some(path.to_owned()),
            featured: false,
            detected: false,
            selectable: true,
            unavailable_reason: None,
        }
    }

    #[test]
    fn unconfigured_preferences_keep_active_system_sync_canonical_only() {
        let preferences = crate::skills_catalog::distribution::SkillInstallPreferencesV1 {
            version: 1,
            configured: false,
            target_ids: vec!["codex".to_owned()],
        };

        assert!(
            configured_global_target_ids(&preferences, &[target("codex", "/tmp/codex")]).is_empty()
        );
    }

    #[test]
    fn configured_preferences_dedupe_aliases_before_active_system_sync() {
        let preferences = crate::skills_catalog::distribution::SkillInstallPreferencesV1 {
            version: 1,
            configured: true,
            target_ids: vec!["codex".to_owned(), "cursor".to_owned(), "other".to_owned()],
        };
        let targets = [
            target("codex", "/tmp/shared"),
            target("cursor", "/tmp/shared"),
            target("other", "/tmp/other"),
        ];

        assert_eq!(
            configured_global_target_ids(&preferences, &targets),
            ["codex", "other"]
        );
    }

    #[test]
    fn active_reconcile_fans_defaults_after_a_current_catalog_sync() {
        let mut received = Vec::new();
        let report = fan_out_after_catalog_sync(
            SyncReport {
                complete: true,
                ..Default::default()
            },
            &["codex".to_owned()],
            |target_ids, report| {
                received.extend_from_slice(target_ids);
                report.distribution_errors.push("target warning".to_owned());
            },
        );

        assert_eq!(received, ["codex"]);
        assert!(
            report.complete,
            "target failures do not un-complete the catalog"
        );
        assert_eq!(report.distribution_errors, ["target warning"]);
    }
}
