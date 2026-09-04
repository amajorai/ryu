//! Runtime activation for installed portable packages.
//!
//! `portable_packages` owns the verified archive and its local install record.
//! This module owns the second half of the lifecycle: projecting the verified
//! artifact tree into the host registry that actually serves the package. A
//! package is not reported enabled until that projection succeeds, and every
//! projection has a symmetric disable/uninstall path.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};

use super::ServerState;

const PORTABLE_PLUGIN_MARKER: &str = ".ryu-portable-package";
const PORTABLE_SKILL_MARKER: &str = ".ryu-portable-owner";

fn namespace(kind: &str, id: &str) -> String {
    let digest = Sha256::digest(format!("{kind}:{id}").as_bytes());
    hex::encode(digest)[..16].to_owned()
}

fn package_source_id(kind: &str, id: &str) -> String {
    format!("portable:{kind}/{id}")
}

fn package_files(kind: &str, id: &str) -> Result<BTreeMap<String, Vec<u8>>> {
    crate::portable_packages::artifact_files(kind, id)
}

fn file_with_name<'a>(
    files: &'a BTreeMap<String, Vec<u8>>,
    name: &str,
) -> Option<(&'a str, &'a [u8])> {
    files
        .iter()
        .find(|(path, _)| path.as_str() == name || path.ends_with(&format!("/{name}")))
        .map(|(path, bytes)| (path.as_str(), bytes.as_slice()))
}

fn native_manifest(
    kind: &str,
    id: &str,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<crate::plugin_manifest::PluginManifest> {
    let (_, bytes) = file_with_name(files, "manifest.json")
        .or_else(|| file_with_name(files, "ryu.json"))
        .or_else(|| file_with_name(files, "plugin.json"))
        .ok_or_else(|| {
            anyhow::anyhow!("portable {kind} package `{id}` is missing manifest.json")
        })?;
    let manifest = serde_json::from_slice::<crate::plugin_manifest::PluginManifest>(bytes)
        .context("portable native manifest is invalid")?;
    if manifest.id != id {
        bail!(
            "portable native manifest id `{}` does not match package id `{id}`",
            manifest.id
        );
    }
    Ok(manifest)
}

fn plugin_runtime_dir(manifest: &crate::plugin_manifest::PluginManifest) -> PathBuf {
    crate::plugin_manifest::PluginManifestLoader::plugins_dir()
        .join(crate::plugin_manifest::plugin_dir_name(&manifest.id))
}

fn marker_matches(path: &Path, marker: &str, expected: &str) -> bool {
    std::fs::read_to_string(path.join(marker))
        .map(|value| value.trim() == expected)
        .unwrap_or(false)
}

fn write_artifact_tree(
    root: &Path,
    files: &BTreeMap<String, Vec<u8>>,
    skip_prefix: Option<&str>,
) -> Result<()> {
    for (relative, data) in files {
        if skip_prefix.is_some_and(|prefix| relative == prefix) {
            continue;
        }
        let destination = root.join(relative);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(destination, data)?;
    }
    Ok(())
}

fn materialize_plugin(
    kind: &str,
    id: &str,
    digest: &str,
    manifest: &crate::plugin_manifest::PluginManifest,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<()> {
    let destination = plugin_runtime_dir(manifest);
    let marker = package_source_id(kind, id);
    if destination.exists() && !marker_matches(&destination, PORTABLE_PLUGIN_MARKER, &marker) {
        bail!(
            "plugin directory `{}` is already owned by another install",
            destination.display()
        );
    }
    let parent = destination
        .parent()
        .context("plugin runtime directory has no parent")?;
    std::fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".portable-{}-{}", namespace(kind, id), digest));
    if temporary.exists() {
        std::fs::remove_dir_all(&temporary)?;
    }
    std::fs::create_dir_all(&temporary)?;
    if let Err(error) = (|| -> Result<()> {
        write_artifact_tree(
            &temporary,
            files,
            Some(crate::portable_packages::PACKAGE_MANIFEST_FILE),
        )?;
        std::fs::write(temporary.join(PORTABLE_PLUGIN_MARKER), marker.as_bytes())?;
        Ok(())
    })() {
        let _ = std::fs::remove_dir_all(&temporary);
        return Err(error);
    }
    if destination.exists() {
        std::fs::remove_dir_all(&destination)?;
    }
    std::fs::rename(temporary, destination)?;
    Ok(())
}

async fn enable_plugin(
    state: &ServerState,
    kind: &str,
    id: &str,
    package: &crate::portable_packages::InstalledPackage,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<crate::portable_packages::InstalledPackage> {
    let manifest = native_manifest(kind, id, files)?;
    let source_id = package_source_id(kind, id);
    let existing_record = state.app_store.get_record(id).await?;
    if let Some(record) = existing_record.as_ref() {
        if record
            .provenance
            .as_ref()
            .and_then(|value| value.source_id.as_deref())
            != Some(source_id.as_str())
        {
            bail!("plugin `{id}` is already installed outside this portable package");
        }
    }
    materialize_plugin(kind, id, &package.package_digest, &manifest, files)?;
    super::reload_manifests_inner(state).await;

    if existing_record.is_none() {
        crate::plugins::lifecycle::install_app_with_provenance(
            &state.app_store,
            &manifest,
            Some(&crate::plugins::isolation::PluginProvenance {
                source_id: Some(source_id.clone()),
                captured_at: Some(chrono::Utc::now().to_rfc3339()),
                ..Default::default()
            }),
        )
        .await?;
    }

    let all_manifests = state.app_manifests.read().await.clone();
    let outcome = crate::plugins::lifecycle::enable_app(
        &state.app_store,
        &manifest,
        &all_manifests,
        &crate::sidecar::gateway::gateway_url(),
        crate::sidecar::gateway::gateway_token().as_deref(),
        &state.client,
    )
    .await
    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    for record in outcome.in_enable_order() {
        let active_manifest = all_manifests
            .iter()
            .find(|candidate| candidate.id == record.id)
            .unwrap_or(&manifest);
        let _ = super::activate_plugin(state, active_manifest, record).await;
    }
    state.realtime.broadcast_event(
        "system:plugins",
        "plugin.contributions.changed",
        serde_json::json!({"type": "contributions_changed"}),
    );

    match crate::portable_packages::set_enabled(kind, id, true) {
        Ok(package) => Ok(package),
        Err(error) => {
            let _ = disable_plugin_lifecycle(state, &manifest).await;
            Err(error)
        }
    }
}

async fn disable_plugin_lifecycle(
    state: &ServerState,
    manifest: &crate::plugin_manifest::PluginManifest,
) -> Result<()> {
    let all_manifests = state.app_manifests.read().await.clone();
    let outcome = crate::plugins::lifecycle::disable_app(
        &state.app_store,
        &manifest.id,
        &all_manifests,
        false,
        false,
    )
    .await
    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    for record in &outcome.disabled {
        if let Some(active_manifest) = all_manifests
            .iter()
            .find(|candidate| candidate.id == record.id)
        {
            let _ = super::deactivate_plugin(state, active_manifest).await;
        }
    }
    state.realtime.broadcast_event(
        "system:plugins",
        "plugin.contributions.changed",
        serde_json::json!({"type": "contributions_changed"}),
    );
    Ok(())
}

async fn disable_plugin(
    state: &ServerState,
    kind: &str,
    id: &str,
) -> Result<crate::portable_packages::InstalledPackage> {
    let files = package_files(kind, id)?;
    let manifest = native_manifest(kind, id, &files)?;
    let source_id = package_source_id(kind, id);
    if state
        .app_store
        .get_record(id)
        .await?
        .map(|record| {
            if record
                .provenance
                .as_ref()
                .and_then(|value| value.source_id.as_deref())
                != Some(source_id.as_str())
            {
                return Err(anyhow::anyhow!(
                    "plugin `{id}` is owned by another install source"
                ));
            }
            Ok(record.enabled)
        })
        .transpose()?
        .unwrap_or(false)
    {
        disable_plugin_lifecycle(state, &manifest).await?;
    }
    crate::portable_packages::set_enabled(kind, id, false).map_err(Into::into)
}

async fn enable_space(
    state: &ServerState,
    kind: &str,
    id: &str,
    package: &crate::portable_packages::InstalledPackage,
    files: &BTreeMap<String, Vec<u8>>,
    owner: &crate::server::spaces::DocOwner,
) -> Result<crate::portable_packages::InstalledPackage> {
    if let Some(space_id) = package.runtime_ids.first() {
        if let Some(meta) = state.spaces.space_access_meta(space_id).await? {
            if !space_owner_matches(&meta, owner) {
                bail!("portable Space `{id}` belongs to another owner");
            }
            return crate::portable_packages::set_enabled(kind, id, true).map_err(Into::into);
        }
    }
    let manifest = crate::portable_packages::manifest(kind, id)?
        .ok_or_else(|| anyhow::anyhow!("portable Space package {id} is not installed"))?;
    let parsed = crate::server::space_portable::parse_package(&manifest, files)?;
    let imported =
        crate::server::space_portable::import_package(&state.spaces, &parsed, owner, None).await?;
    if let Err(error) =
        crate::portable_packages::set_runtime_ids(kind, id, vec![imported.space_id.clone()])
    {
        let _ = state.spaces.delete_space(&imported.space_id).await;
        return Err(error);
    }
    crate::portable_packages::set_enabled(kind, id, true).map_err(Into::into)
}

async fn disable_space(
    state: &ServerState,
    kind: &str,
    id: &str,
    owner: &crate::server::spaces::DocOwner,
) -> Result<crate::portable_packages::InstalledPackage> {
    let package = crate::portable_packages::get(kind, id)?
        .ok_or_else(|| anyhow::anyhow!("portable Space package {kind}/{id} is not installed"))?;
    for space_id in &package.runtime_ids {
        if let Some(meta) = state.spaces.space_access_meta(space_id).await? {
            if !space_owner_matches(&meta, owner) {
                bail!("portable Space `{id}` belongs to another owner");
            }
        }
    }
    for space_id in &package.runtime_ids {
        state.spaces.delete_space(space_id).await?;
    }
    crate::portable_packages::set_enabled(kind, id, false).map_err(Into::into)
}

fn space_owner_matches(
    meta: &crate::server::spaces::SpaceAccessMeta,
    owner: &crate::server::spaces::DocOwner,
) -> bool {
    meta.owner_user_id.as_deref() == owner.user_id.as_deref()
        && meta.org_id.as_deref() == owner.org_id.as_deref()
}

async fn uninstall_plugin(state: &ServerState, kind: &str, id: &str) -> Result<()> {
    let files = package_files(kind, id)?;
    let manifest = native_manifest(kind, id, &files)?;
    let source_id = package_source_id(kind, id);
    if let Some(record) = state.app_store.get_record(id).await? {
        if record
            .provenance
            .as_ref()
            .and_then(|value| value.source_id.as_deref())
            != Some(source_id.as_str())
        {
            bail!("plugin `{id}` is owned by another install source");
        }
        if record.enabled {
            disable_plugin_lifecycle(state, &manifest).await?;
        }
        let all_manifests = state.app_manifests.read().await.clone();
        let _ =
            crate::plugins::lifecycle::uninstall_app(&state.app_store, id, &all_manifests, false)
                .await
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    }
    let destination = plugin_runtime_dir(&manifest);
    let marker = package_source_id(kind, id);
    if marker_matches(&destination, PORTABLE_PLUGIN_MARKER, &marker) {
        std::fs::remove_dir_all(destination)?;
        super::reload_manifests_inner(state).await;
    }
    Ok(())
}

fn skill_groups(files: &BTreeMap<String, Vec<u8>>) -> Vec<(String, String)> {
    let mut groups = Vec::new();
    for path in files.keys() {
        let Some(prefix) = path.strip_suffix("/SKILL.md") else {
            if path == "SKILL.md" {
                groups.push((String::new(), path.clone()));
            }
            continue;
        };
        groups.push((prefix.to_owned(), path.clone()));
    }
    groups
}

fn portable_skill_slug(kind: &str, id: &str, group: &str) -> String {
    let suffix = group
        .rsplit('/')
        .next()
        .unwrap_or("skill")
        .chars()
        .map(|value| {
            if value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | '.') {
                value
            } else {
                '-'
            }
        })
        .collect::<String>();
    format!(
        "portable-{}-{}",
        namespace(kind, id),
        suffix.trim_matches('-')
    )
}

fn materialize_skills(
    kind: &str,
    id: &str,
    digest: &str,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<Vec<String>> {
    let root = ryu_skills::SkillRegistry::skills_dir();
    std::fs::create_dir_all(&root)?;
    let mut ids = Vec::new();
    for (group, manifest_path) in skill_groups(files) {
        let slug = portable_skill_slug(kind, id, &group);
        let destination = root.join(&slug);
        let marker = format!("{kind}/{id}/{digest}");
        if destination.exists() && !marker_matches(&destination, PORTABLE_SKILL_MARKER, &marker) {
            bail!(
                "skill directory `{}` is already owned by another install",
                destination.display()
            );
        }
        if destination.exists() {
            std::fs::remove_dir_all(&destination)?;
        }
        std::fs::create_dir_all(&destination)?;
        let source_prefix = if group.is_empty() {
            String::new()
        } else {
            format!("{group}/")
        };
        for (path, data) in files {
            if path != &manifest_path && !path.starts_with(&source_prefix) {
                continue;
            }
            let relative = if path == &manifest_path {
                "SKILL.md"
            } else {
                path.strip_prefix(&source_prefix)
                    .context("skill artifact is outside its declared directory")?
            };
            let target = destination.join(relative);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(target, data)?;
        }
        std::fs::write(destination.join(PORTABLE_SKILL_MARKER), marker)?;
        ryu_skills::set_active(&slug, true);
        ids.push(slug);
    }
    Ok(ids)
}

fn remove_portable_skills(kind: &str, package_id: &str, ids: &[String]) {
    let root = ryu_skills::SkillRegistry::skills_dir();
    for id in ids {
        ryu_skills::set_active(id, false);
        let path = root.join(id);
        let owned_prefix = format!("{kind}/{package_id}/");
        let owned = std::fs::read_to_string(path.join(PORTABLE_SKILL_MARKER))
            .map(|value| value.starts_with(&owned_prefix))
            .unwrap_or(false);
        if owned {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}

async fn enable_skill(
    state: &ServerState,
    kind: &str,
    id: &str,
    package: &crate::portable_packages::InstalledPackage,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<crate::portable_packages::InstalledPackage> {
    let root = ryu_skills::SkillRegistry::skills_dir();
    let marker = format!("{kind}/{id}/{}", package.package_digest);
    let ids = if package.runtime_ids.is_empty()
        || package
            .runtime_ids
            .iter()
            .any(|skill_id| !marker_matches(&root.join(skill_id), PORTABLE_SKILL_MARKER, &marker))
    {
        materialize_skills(kind, id, &package.package_digest, files)?
    } else {
        for skill_id in &package.runtime_ids {
            ryu_skills::set_active(skill_id, true);
        }
        package.runtime_ids.clone()
    };
    if ids.is_empty() {
        bail!("portable skill package `{id}` contains no skills/SKILL.md artifact");
    }
    state.skills.reload();
    crate::portable_packages::set_runtime_ids(kind, id, ids)?;
    crate::portable_packages::set_enabled(kind, id, true).map_err(Into::into)
}

async fn disable_skill(
    state: &ServerState,
    kind: &str,
    id: &str,
) -> Result<crate::portable_packages::InstalledPackage> {
    let package = crate::portable_packages::get(kind, id)?
        .ok_or_else(|| anyhow::anyhow!("portable package `{kind}/{id}` is not installed"))?;
    for skill_id in &package.runtime_ids {
        ryu_skills::set_active(skill_id, false);
    }
    state.skills.reload();
    crate::portable_packages::set_enabled(kind, id, false).map_err(Into::into)
}

async fn enable_agent(
    state: &ServerState,
    kind: &str,
    id: &str,
    package: &crate::portable_packages::InstalledPackage,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<crate::portable_packages::InstalledPackage> {
    if !package.runtime_ids.is_empty() {
        let mut all_present = true;
        for runtime_id in &package.runtime_ids {
            if state.agent_store.get(runtime_id).await?.is_none() {
                all_present = false;
                break;
            }
        }
        if all_present {
            return crate::portable_packages::set_enabled(kind, id, true).map_err(Into::into);
        }
    }
    let (_, bytes) = file_with_name(files, "agent.json")
        .ok_or_else(|| anyhow::anyhow!("portable agent package `{id}` is missing agent.json"))?;
    let template = serde_json::from_slice::<crate::agents::AgentTemplate>(bytes)
        .context("portable agent template is invalid")?;
    let schedules = template.agent_config.schedules.clone();
    let (template, _disclosure) = template.sanitize_for_untrusted_install();
    let record = state
        .agent_store
        .create(template.into_create_agent())
        .await?;
    if let Err(error) = super::persist_agent_schedules(&record.id, &record.name, &schedules) {
        let _ = state.agent_store.delete(&record.id).await;
        bail!("agent schedules could not be saved: {error}");
    }
    crate::portable_packages::set_runtime_ids(kind, id, vec![record.id.clone()])?;
    crate::portable_packages::set_enabled(kind, id, true).map_err(Into::into)
}

async fn disable_agent(
    state: &ServerState,
    kind: &str,
    id: &str,
) -> Result<crate::portable_packages::InstalledPackage> {
    let package = crate::portable_packages::get(kind, id)?
        .ok_or_else(|| anyhow::anyhow!("portable package `{kind}/{id}` is not installed"))?;
    for runtime_id in &package.runtime_ids {
        let _ = super::delete_agent_schedules(runtime_id);
        state.agent_store.delete(runtime_id).await?;
    }
    crate::portable_packages::set_enabled(kind, id, false).map_err(Into::into)
}

async fn enable_workflow(
    kind: &str,
    id: &str,
    package: &crate::portable_packages::InstalledPackage,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<crate::portable_packages::InstalledPackage> {
    if !package.runtime_ids.is_empty()
        && package
            .runtime_ids
            .iter()
            .all(|runtime_id| crate::workflow::store::load_workflow(runtime_id).is_ok())
    {
        return crate::portable_packages::set_enabled(kind, id, true).map_err(Into::into);
    }
    let (_, bytes) = file_with_name(files, "workflow.json").ok_or_else(|| {
        anyhow::anyhow!("portable workflow package `{id}` is missing workflow.json")
    })?;
    let mut workflow = serde_json::from_slice::<crate::workflow::Workflow>(bytes)
        .context("portable workflow is invalid")?;
    let saved = crate::workflow::persist_workflow(workflow.clone())
        .await
        .map_err(|error| anyhow::anyhow!(error))?;
    workflow.id = saved.id.clone();
    crate::portable_packages::set_runtime_ids(kind, id, vec![workflow.id])?;
    crate::portable_packages::set_enabled(kind, id, true).map_err(Into::into)
}

async fn disable_workflow(
    kind: &str,
    id: &str,
) -> Result<crate::portable_packages::InstalledPackage> {
    let package = crate::portable_packages::get(kind, id)?
        .ok_or_else(|| anyhow::anyhow!("portable package `{kind}/{id}` is not installed"))?;
    for runtime_id in &package.runtime_ids {
        crate::workflow::store::delete_workflow(runtime_id)?;
    }
    crate::portable_packages::set_enabled(kind, id, false).map_err(Into::into)
}

async fn enable_output_style(
    kind: &str,
    id: &str,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<crate::portable_packages::InstalledPackage> {
    let registry = ryu_output_styles::global_registry()
        .ok_or_else(|| anyhow::anyhow!("output-style registry is not initialized"))?;
    let mut ids = Vec::new();
    for (path, bytes) in files {
        if !path.ends_with(".md") || path == crate::portable_packages::PACKAGE_MANIFEST_FILE {
            continue;
        }
        let style_id = format!(
            "portable/{}/{}",
            namespace(kind, id),
            Path::new(path)
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("style")
        );
        let source = String::from_utf8(bytes.clone()).context("output style is not UTF-8")?;
        registry
            .register_plugin_style(style_id.clone(), &source)
            .map_err(|error| anyhow::anyhow!(error))?;
        ids.push(style_id);
    }
    if ids.is_empty() {
        bail!("portable output-style package `{id}` contains no Markdown style");
    }
    crate::portable_packages::set_runtime_ids(kind, id, ids)?;
    crate::portable_packages::set_enabled(kind, id, true).map_err(Into::into)
}

async fn disable_output_style(
    kind: &str,
    id: &str,
) -> Result<crate::portable_packages::InstalledPackage> {
    let package = crate::portable_packages::get(kind, id)?
        .ok_or_else(|| anyhow::anyhow!("portable package `{kind}/{id}` is not installed"))?;
    if let Some(registry) = ryu_output_styles::global_registry() {
        for runtime_id in &package.runtime_ids {
            registry.unregister_plugin_style(runtime_id);
        }
    }
    crate::portable_packages::set_enabled(kind, id, false).map_err(Into::into)
}

async fn enable_language_pack(
    kind: &str,
    id: &str,
    package: &crate::portable_packages::InstalledPackage,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<crate::portable_packages::InstalledPackage> {
    let manifest = crate::portable_packages::manifest(kind, id)?
        .ok_or_else(|| anyhow::anyhow!("portable language-pack manifest is missing"))?;
    super::language_packs::validate_language_pack_manifest(kind, id, &package.version, &manifest)?;
    super::language_packs::validate_package_files(kind, id, &package.version, files)?;
    crate::portable_packages::set_enabled(kind, id, true).map_err(Into::into)
}

async fn disable_language_pack(
    kind: &str,
    id: &str,
) -> Result<crate::portable_packages::InstalledPackage> {
    crate::portable_packages::set_enabled(kind, id, false).map_err(Into::into)
}

/// Enable an installed package through its host subsystem. Unsupported kinds
/// fail closed and remain disabled rather than advertising a no-op activation.
pub(crate) async fn enable(
    state: &ServerState,
    kind: &str,
    id: &str,
) -> Result<crate::portable_packages::InstalledPackage> {
    enable_with_owner(state, kind, id, &crate::server::spaces::background_owner()).await
}

pub(crate) async fn enable_with_owner(
    state: &ServerState,
    kind: &str,
    id: &str,
    owner: &crate::server::spaces::DocOwner,
) -> Result<crate::portable_packages::InstalledPackage> {
    let kind = kind.trim().to_ascii_lowercase();
    let id = id.trim();
    let package = crate::portable_packages::get(&kind, id)?
        .ok_or_else(|| anyhow::anyhow!("portable package `{kind}/{id}` is not installed"))?;
    let files = package_files(&kind, id)?;
    match kind.as_str() {
        "app" | "plugin" | "theme" => enable_plugin(state, &kind, id, &package, &files).await,
        "skill" => enable_skill(state, &kind, id, &package, &files).await,
        "agent" => enable_agent(state, &kind, id, &package, &files).await,
        "workflow" => enable_workflow(&kind, id, &package, &files).await,
        "output_style" => enable_output_style(&kind, id, &files).await,
        "language_pack" => enable_language_pack(&kind, id, &package, &files).await,
        "space" => enable_space(state, &kind, id, &package, &files, owner).await,
        _ => bail!("portable package kind `{kind}` has no host activation path"),
    }
}

pub(crate) async fn disable_with_owner(
    state: &ServerState,
    kind: &str,
    id: &str,
    owner: &crate::server::spaces::DocOwner,
) -> Result<crate::portable_packages::InstalledPackage> {
    let kind = kind.trim().to_ascii_lowercase();
    let id = id.trim();
    match kind.as_str() {
        "app" | "plugin" | "theme" => disable_plugin(state, &kind, id).await,
        "skill" => disable_skill(state, &kind, id).await,
        "agent" => disable_agent(state, &kind, id).await,
        "workflow" => disable_workflow(&kind, id).await,
        "output_style" => disable_output_style(&kind, id).await,
        "language_pack" => disable_language_pack(&kind, id).await,
        "space" => disable_space(state, &kind, id, owner).await,
        _ => bail!("portable package kind `{kind}` has no host deactivation path"),
    }
}

pub(crate) async fn uninstall_with_owner(
    state: &ServerState,
    kind: &str,
    id: &str,
    owner: &crate::server::spaces::DocOwner,
) -> Result<()> {
    let kind = kind.trim().to_ascii_lowercase();
    let id = id.trim();
    match kind.as_str() {
        "app" | "plugin" | "theme" => uninstall_plugin(state, &kind, id).await,
        "skill" => {
            let package = crate::portable_packages::get(&kind, id)?.ok_or_else(|| {
                anyhow::anyhow!("portable package `{kind}/{id}` is not installed")
            })?;
            remove_portable_skills(&kind, id, &package.runtime_ids);
            state.skills.reload();
            Ok(())
        }
        "agent" => {
            let _ = disable_agent(state, &kind, id).await?;
            Ok(())
        }
        "workflow" => {
            let _ = disable_workflow(&kind, id).await?;
            Ok(())
        }
        "output_style" => {
            let _ = disable_output_style(&kind, id).await?;
            Ok(())
        }
        "language_pack" => {
            let _ = disable_language_pack(&kind, id).await?;
            Ok(())
        }
        "space" => {
            let _ = disable_space(state, &kind, id, owner).await?;
            Ok(())
        }
        _ => bail!("portable package kind `{kind}` has no host uninstall path"),
    }
}

#[cfg(test)]
mod tests {
    use super::space_owner_matches;
    use crate::server::spaces::{DocOwner, SpaceAccessMeta};

    fn meta(user_id: Option<&str>, org_id: Option<&str>) -> SpaceAccessMeta {
        SpaceAccessMeta {
            owner_user_id: user_id.map(str::to_owned),
            org_id: org_id.map(str::to_owned),
            visibility: "private".to_owned(),
            team_id: None,
            system: false,
        }
    }

    fn owner(user_id: Option<&str>, org_id: Option<&str>) -> DocOwner {
        DocOwner::owned(user_id, org_id)
    }

    #[test]
    fn portable_space_lifecycle_requires_the_same_user_and_org() {
        assert!(space_owner_matches(
            &meta(Some("alice"), Some("org1")),
            &owner(Some("alice"), Some("org1"))
        ));
        assert!(!space_owner_matches(
            &meta(Some("alice"), Some("org1")),
            &owner(Some("bob"), Some("org1"))
        ));
        assert!(!space_owner_matches(
            &meta(Some("alice"), Some("org1")),
            &owner(Some("alice"), Some("org2"))
        ));
    }
}
