//! Core glue for OS-level isolation of manifest-declared native sidecars.
//!
//! The mechanism (policy derivation, Landlock, Seatbelt, Job Object) lives in
//! [`ryu_sandbox::os_isolation`]. This module owns what is Core's to decide:
//!
//! - the **mode**: the operator setting [`MODE_ENV`] (`off` by default, also
//!   settable as `settings.sidecar.sandbox` in `node-config.json`), an optional
//!   per-plugin override [`PLUGIN_MODES_ENV`], and the manifest's own
//!   `sidecars[].sandbox.mode`. The effective mode is the **strictest** of the
//!   three, so neither a per-plugin override nor a manifest can loosen the
//!   operator's choice;
//! - the **roots** a policy is derived from (the app's own directory and data
//!   directory, Core's data directory, the apps directory, home, temp);
//! - the **status record** served on `/api/sidecar/status` (per-sidecar
//!   `sandbox` field), and the operator-facing error text when `enforce` stops a
//!   sidecar from starting.
//!
//! With the default `off` nothing here changes how a sidecar is spawned.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use ryu_sandbox::os_isolation::{
    derive_policy, prepare, IsolationMode, IsolationRoots, IsolationStatus, PreparedIsolation,
};

use crate::plugin_manifest::schema::SidecarSpec;

/// Core setting selecting the isolation mode for every manifest sidecar:
/// `off` (default), `audit`, or `enforce`.
pub const MODE_ENV: &str = "RYU_SIDECAR_SANDBOX";

/// Optional per-plugin overrides, `<plugin_id>=<mode>` pairs separated by commas
/// (e.g. `@ryu/mail=enforce,@acme/tool=audit`). An override can only make a
/// plugin stricter than [`MODE_ENV`].
pub const PLUGIN_MODES_ENV: &str = "RYU_SIDECAR_SANDBOX_PLUGINS";

/// Combine the operator setting, the per-plugin overrides, and the manifest's
/// requested mode into the effective mode (the strictest). Unknown spellings are
/// ignored and reported in the returned warnings.
pub(crate) fn combine_modes(
    global: Option<&str>,
    per_plugin: Option<&str>,
    plugin_id: &str,
    manifest: Option<IsolationMode>,
) -> (IsolationMode, Vec<String>) {
    let mut warnings = Vec::new();
    let mut mode = IsolationMode::Off;
    if let Some(raw) = global.map(str::trim).filter(|raw| !raw.is_empty()) {
        match IsolationMode::parse(raw) {
            Some(parsed) => mode = parsed,
            None => warnings.push(format!(
                "{MODE_ENV}='{raw}' is not one of off/audit/enforce; treating it as off"
            )),
        }
    }
    for entry in per_plugin
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        let Some((id, raw)) = entry.rsplit_once('=') else {
            warnings.push(format!(
                "{PLUGIN_MODES_ENV} entry '{entry}' is not <plugin_id>=<mode>"
            ));
            continue;
        };
        if id.trim() != plugin_id {
            continue;
        }
        match IsolationMode::parse(raw) {
            Some(parsed) => mode = mode.max(parsed),
            None => warnings.push(format!(
                "{PLUGIN_MODES_ENV} entry '{entry}' has an unknown mode; ignored"
            )),
        }
    }
    if let Some(requested) = manifest {
        mode = mode.max(requested);
    }
    (mode, warnings)
}

/// The effective isolation mode for `plugin_id`'s sidecar `spec`.
pub(crate) fn effective_mode(plugin_id: &str, spec: &SidecarSpec) -> IsolationMode {
    let (mode, warnings) = combine_modes(
        std::env::var(MODE_ENV).ok().as_deref(),
        std::env::var(PLUGIN_MODES_ENV).ok().as_deref(),
        plugin_id,
        spec.sandbox.as_ref().and_then(|s| s.mode),
    );
    for warning in warnings {
        tracing::warn!(target: "ryu::permissions", plugin_id = %plugin_id, "{warning}");
    }
    mode
}

/// The roots a sidecar policy is resolved against.
pub(crate) fn roots_for(plugin_id: &str, plugin_dir: &Path) -> IsolationRoots {
    let ryu_dir = crate::paths::ryu_dir();
    IsolationRoots {
        app_data: plugin_dir.to_path_buf(),
        plugin_data: ryu_sidecar_runtime::layout::plugin_data_dir(&ryu_dir, plugin_id),
        ryu_dir,
        plugins_dir: crate::plugin_manifest::PluginManifestLoader::plugins_dir(),
        home: dirs::home_dir(),
        temp: std::env::temp_dir(),
    }
}

fn status_record() -> &'static Mutex<HashMap<String, IsolationStatus>> {
    static RECORD: OnceLock<Mutex<HashMap<String, IsolationStatus>>> = OnceLock::new();
    RECORD.get_or_init(|| Mutex::new(HashMap::new()))
}

fn record_status(name: &str, status: IsolationStatus) {
    if let Ok(mut record) = status_record().lock() {
        record.insert(name.to_owned(), status);
    }
}

/// The isolation status recorded at `name`'s last start, for the status
/// surface. `None` for a sidecar that is not manifest-declared or never started.
pub fn sandbox_status(name: &str) -> Option<IsolationStatus> {
    status_record()
        .lock()
        .ok()
        .and_then(|record| record.get(name).cloned())
}

/// How to switch the mode, appended to every enforce-caused failure.
fn switch_mode_hint(manifest_requires_enforce: bool) -> String {
    let mut hint = format!(
        "To run it without OS isolation, set the Core setting {MODE_ENV} to 'audit' or 'off' \
         (node-config.json: settings.sidecar.sandbox) and restart Core"
    );
    if manifest_requires_enforce {
        hint.push_str(
            "; this app's manifest itself requests sandbox mode 'enforce', which the setting \
             cannot loosen, so the app must declare the paths it needs in sidecars[].sandbox.fs",
        );
    }
    hint
}

/// Text for a sidecar that failed to start while `enforce` was in effect.
pub(crate) fn enforce_failure_message(
    name: &str,
    status: &IsolationStatus,
    spec: &SidecarSpec,
    error: &dyn std::fmt::Display,
) -> String {
    let manifest_requires_enforce = spec
        .sandbox
        .as_ref()
        .and_then(|s| s.mode)
        .is_some_and(|mode| mode == IsolationMode::Enforce);
    format!(
        "sidecar '{name}' could not start under the OS sandbox ({}, mode=enforce): {error}. {}",
        status.backend.label(),
        switch_mode_hint(manifest_requires_enforce)
    )
}

/// Append the sandbox hint to a crash reason when the crashed process ran with
/// filesystem confinement, since a denied path usually looks like a plain crash.
pub(crate) fn annotate_crash_reason(name: &str, reason: &str) -> String {
    match sandbox_status(name) {
        Some(status) if status.enforced => format!(
            "{reason} (the process ran under the OS sandbox: {}, mode=enforce; a denied file \
             access can cause this. {})",
            status.backend.label(),
            switch_mode_hint(false)
        ),
        _ => reason.to_owned(),
    }
}

/// Resolve `program` (absolute, or a bare name looked up on `PATH`).
fn resolve_program(program: &str) -> Option<PathBuf> {
    let path = Path::new(program);
    if path.is_absolute() {
        return Some(path.to_path_buf());
    }
    crate::sidecar::manifest_sidecar::which_on_path(program)
}

/// Decide and prepare the isolation for one sidecar launch, recording its
/// status. `off` returns an inactive launch without computing anything; `audit`
/// computes and logs the policy and returns an inactive launch; `enforce`
/// returns an active launch, or an error naming the sandbox and the setting.
pub(crate) async fn prepare_launch(
    name: &str,
    plugin_id: &str,
    spec: &SidecarSpec,
    plugin_dir: &Path,
    program: &str,
    args: &[String],
) -> anyhow::Result<PreparedIsolation> {
    let mode = effective_mode(plugin_id, spec);
    if mode == IsolationMode::Off {
        record_status(name, IsolationStatus::off());
        return prepare(IsolationMode::Off, &Default::default(), program, args)
            .map_err(anyhow::Error::msg);
    }
    let roots = roots_for(plugin_id, plugin_dir);
    if mode == IsolationMode::Enforce {
        // Landlock rules attach to existing inodes, so the own dirs must exist.
        let _ = tokio::fs::create_dir_all(plugin_dir).await;
        let _ = tokio::fs::create_dir_all(&roots.plugin_data).await;
    }
    let resolved = resolve_program(program);
    let policy = match derive_policy(spec.sandbox.as_ref(), &roots, resolved.as_deref()) {
        Ok(policy) => policy,
        Err(error) => {
            let mut status = IsolationStatus::off();
            status.mode = mode;
            status.detail = Some(format!("invalid sandbox policy: {error}"));
            record_status(name, status.clone());
            if mode == IsolationMode::Enforce {
                return Err(anyhow::anyhow!(enforce_failure_message(
                    name, &status, spec, &error
                )));
            }
            tracing::warn!(
                target: "ryu::permissions",
                sidecar = %name,
                plugin_id = %plugin_id,
                "audit: sidecar sandbox policy is invalid and would refuse to start under enforce: {error}"
            );
            return prepare(IsolationMode::Off, &Default::default(), program, args)
                .map_err(anyhow::Error::msg);
        }
    };
    tracing::info!(
        target: "ryu::permissions",
        sidecar = %name,
        plugin_id = %plugin_id,
        mode = mode.as_str(),
        read_only = ?policy.read_only,
        read_write = ?policy.read_write,
        protected = ?policy.protected,
        program = ?policy.program,
        notes = ?policy.notes,
        "sidecar OS sandbox policy"
    );
    match prepare(mode, &policy, program, args) {
        Ok(prepared) => {
            let status = prepared.status().clone();
            if mode == IsolationMode::Enforce && !status.fs_restricted {
                tracing::warn!(
                    target: "ryu::permissions",
                    sidecar = %name,
                    plugin_id = %plugin_id,
                    detail = ?status.detail,
                    "sidecar OS sandbox is in enforce mode but filesystem access is not confined on this host"
                );
            }
            record_status(name, status);
            Ok(prepared)
        }
        Err(error) => {
            let mut status = IsolationStatus::off();
            status.mode = mode;
            status.backend = ryu_sandbox::os_isolation::IsolationBackend::for_platform();
            status.detail = Some(error.clone());
            record_status(name, status.clone());
            Err(anyhow::anyhow!(enforce_failure_message(
                name, &status, spec, &error
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_and_unknown_settings_are_off() {
        assert_eq!(
            combine_modes(None, None, "@x/a", None).0,
            IsolationMode::Off
        );
        assert_eq!(
            combine_modes(Some(""), None, "@x/a", None).0,
            IsolationMode::Off
        );
        let (mode, warnings) = combine_modes(Some("strict"), None, "@x/a", None);
        assert_eq!(mode, IsolationMode::Off);
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn overrides_only_ever_tighten() {
        // Per-plugin override tightens its own plugin only.
        let per = Some("@x/a=enforce, @x/b=audit");
        assert_eq!(
            combine_modes(Some("off"), per, "@x/a", None).0,
            IsolationMode::Enforce
        );
        assert_eq!(
            combine_modes(Some("off"), per, "@x/b", None).0,
            IsolationMode::Audit
        );
        assert_eq!(
            combine_modes(Some("off"), per, "@x/c", None).0,
            IsolationMode::Off
        );
        // A looser per-plugin override or manifest mode cannot loosen the global.
        assert_eq!(
            combine_modes(
                Some("enforce"),
                Some("@x/a=off"),
                "@x/a",
                Some(IsolationMode::Audit)
            )
            .0,
            IsolationMode::Enforce
        );
        // The manifest can opt itself in.
        assert_eq!(
            combine_modes(Some("audit"), None, "@x/a", Some(IsolationMode::Enforce)).0,
            IsolationMode::Enforce
        );
        let (_, warnings) = combine_modes(None, Some("garbage,@x/a=sometimes"), "@x/a", None);
        assert_eq!(warnings.len(), 2, "{warnings:?}");
    }

    #[test]
    fn enforce_failure_names_the_sandbox_and_the_setting() {
        let spec: SidecarSpec = serde_json::from_str(
            r#"{"name":"svc","process":{"kind":"local","command":"svc"},"port":9000,
                "sandbox":{"mode":"enforce"}}"#,
        )
        .unwrap();
        let status = IsolationStatus {
            mode: IsolationMode::Enforce,
            backend: ryu_sandbox::os_isolation::IsolationBackend::Landlock,
            enforced: true,
            fs_restricted: true,
            detail: None,
        };
        let message = enforce_failure_message("@x/a/svc", &status, &spec, &"Permission denied");
        assert!(
            message.contains("OS sandbox (Landlock, mode=enforce)"),
            "{message}"
        );
        assert!(message.contains(MODE_ENV), "{message}");
        assert!(message.contains("settings.sidecar.sandbox"), "{message}");
        assert!(message.contains("manifest itself requests"), "{message}");
    }
}
