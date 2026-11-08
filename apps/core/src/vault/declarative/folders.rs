//! Folders and folder imports.

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{ApplyReport, InitSpec, Plan};
use crate::plugin_secrets::kv::FolderImport;
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::{AuditActor, AuditEntry};
use crate::vault::{is_valid_environment, normalize_path};

/// A declared folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeclaredFolder {
    pub environment: String,
    pub path: String,
}

fn checked_environment(environment: &str) -> Result<()> {
    if !is_valid_environment(environment) {
        bail!("invalid environment `{environment}`");
    }
    Ok(())
}

fn checked_path(path: &str) -> Result<String> {
    normalize_path(path).ok_or_else(|| anyhow!("invalid folder path `{path}`"))
}

impl DeclaredFolder {
    pub(super) fn normalize(&mut self) -> Result<()> {
        checked_environment(&self.environment)?;
        self.path = checked_path(&self.path)?;
        Ok(())
    }
}

/// A declared folder import: `path` in `environment` reads the values of
/// `sourcePath` in `sourceEnvironment`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeclaredImport {
    pub environment: String,
    pub path: String,
    pub source_environment: String,
    pub source_path: String,
    #[serde(default)]
    pub position: i64,
}

impl DeclaredImport {
    pub(super) fn normalize(&mut self) -> Result<()> {
        checked_environment(&self.environment)?;
        checked_environment(&self.source_environment)?;
        self.path = checked_path(&self.path)?;
        self.source_path = checked_path(&self.source_path)?;
        if self.environment == self.source_environment && self.path == self.source_path {
            bail!("a folder cannot import itself");
        }
        Ok(())
    }

    fn label(&self) -> String {
        format!(
            "import:{}:{}<-{}:{}",
            self.environment, self.path, self.source_environment, self.source_path
        )
    }

    fn matches(&self, stored: &FolderImport) -> bool {
        stored.environment == self.environment
            && stored.path == self.path
            && stored.source_environment == self.source_environment
            && stored.source_path == self.source_path
    }

    fn to_import(&self) -> FolderImport {
        FolderImport {
            id: String::new(),
            environment: self.environment.clone(),
            path: self.path.clone(),
            source_environment: self.source_environment.clone(),
            source_path: self.source_path.clone(),
            position: self.position,
        }
    }
}

async fn create_folder(
    store: &PluginSecretStore,
    declared: &DeclaredFolder,
    actor: &AuditActor,
) -> Result<()> {
    let path = store
        .create_folder(&declared.environment, &declared.path)
        .await?;
    let mut entry = AuditEntry::new(actor, "folder.create", "ok").details(json!({}));
    entry.environment = Some(declared.environment.clone());
    entry.path = Some(path);
    store.audit(&entry).await;
    Ok(())
}

pub(super) async fn apply(
    store: &PluginSecretStore,
    spec: &InitSpec,
    actor: &AuditActor,
    report: &mut ApplyReport,
) -> Result<()> {
    for declared in &spec.folders {
        let label = format!("folder:{}:{}", declared.environment, declared.path);
        let folders = store.list_folders(&declared.environment).await?;
        let plan = if folders.contains(&declared.path) {
            Plan::Same
        } else {
            Plan::Create
        };
        if report.decide(label.clone(), plan, spec.reconcile) {
            if let Err(error) = create_folder(store, declared, actor).await {
                report.fail(&label, &error);
            }
        }
    }

    let imports = store.list_imports().await?;
    for declared in &spec.imports {
        let label = declared.label();
        let existing = imports.iter().find(|stored| declared.matches(stored));
        let plan = match existing {
            None => Plan::Create,
            Some(stored) if stored.position == declared.position => Plan::Same,
            Some(_) => Plan::Drift,
        };
        if !report.decide(label.clone(), plan, spec.reconcile) {
            continue;
        }
        if let Some(stored) = existing {
            // The position is the only thing that can differ; an import is
            // replaced rather than edited.
            if let Err(error) = store.remove_import(&stored.id, actor).await {
                report.fail(&label, &error);
                continue;
            }
        }
        if let Err(error) = store.add_import(&declared.to_import(), actor).await {
            report.fail(&label, &error);
        }
    }
    Ok(())
}
