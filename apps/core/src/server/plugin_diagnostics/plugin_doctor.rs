//! The installed-app projection, plugin doctor and plugin eval runs: `plugin_doctor` through `plugin_doctor`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `GET /api/plugins/doctor` — audit loaded plugin/app manifests through the
/// same Core loader output used by the Store and lifecycle routes.
///
/// This is intentionally a read-only lint profile. It does not import arbitrary
/// plugin code, start a sidecar, call a plugin endpoint, or mutate lifecycle
/// state. Those are explicit deep/runtime probes for a future trusted local
/// developer mode; a marketplace browse must never execute remote code in Core.
#[utoipa::path(
    get,
    path = "/api/plugins/doctor",
    tag = "Plugins",
    params(("id" = Option<String>, Query, description = "Audit one installed app/plugin")),
    summary = "Audit installed plugin and app manifests",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn plugin_doctor(
    State(state): State<ServerState>,
    Query(query): Query<PluginDoctorQuery>,
) -> Json<serde_json::Value> {
    // Audit the complete loaded inventory rather than the caller's surface-filtered
    // view. A desktop plugin can depend on a Core/Gateway-only companion, and
    // hiding that companion here would turn a valid dependency into a false error.
    let Json(payload) = list_apps_projection(&state, None, true).await;
    let all_apps = payload
        .get("apps")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let requested_id = query
        .id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let candidates: Vec<&serde_json::Value> = all_apps
        .iter()
        .filter(|app| {
            requested_id.is_none_or(|id| {
                app.get("id")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|candidate| candidate == id)
            })
        })
        .collect();

    let mut findings = Vec::new();
    let mut inventory = Vec::new();
    let mut installed_ids = std::collections::HashSet::new();
    for app in &all_apps {
        let installed = app
            .get("installed")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
            || app
                .get("built_in")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
        if installed {
            if let Some(id) = app.get("id").and_then(serde_json::Value::as_str) {
                installed_ids.insert(id.to_owned());
            }
        }
    }

    if let Some(id) = requested_id {
        if !candidates.iter().any(|app| {
            app.get("installed")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
                || app
                    .get("built_in")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
        }) {
            findings.push(plugin_doctor_finding(
                id,
                "plugin.not-installed",
                "lifecycle",
                "error",
                "Plugin or app is not installed",
                "The requested artifact is not present in Core's loaded installed set.",
                "Install the artifact first, then run the doctor again.",
                json!({ "requestedId": id }),
            ));
        }
    }

    for app in candidates {
        let plugin_id = app
            .get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("<unknown>");
        let installed = app
            .get("installed")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
            || app
                .get("built_in")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
        if !installed {
            continue;
        }
        let finding_start = findings.len();
        let artifact_kind = plugin_artifact_kind(app);
        let eval_suite = inspect_plugin_evals(plugin_id, artifact_kind);
        let name = app
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let version = app
            .get("version")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let installed_version = app
            .get("installed_version")
            .and_then(serde_json::Value::as_str);
        let enabled = app
            .get("enabled")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);

        if plugin_id == "<unknown>" || plugin_id.trim().is_empty() {
            findings.push(plugin_doctor_finding(
                plugin_id,
                "manifest.id",
                "manifest",
                "error",
                "Manifest id is missing",
                "Every loaded plugin/app needs a stable id for lifecycle, permissions, and routing.",
                "Set a canonical reverse-domain or scoped id in the manifest.",
                json!({ "id": plugin_id }),
            ));
        }
        if name.trim().is_empty() {
            findings.push(plugin_doctor_finding(
                plugin_id,
                "manifest.name",
                "manifest",
                "error",
                "Manifest name is missing",
                "The Store and lifecycle UI cannot identify this artifact to a user.",
                "Add a non-empty human-readable name to the manifest.",
                json!({ "name": name }),
            ));
        }
        if version.trim().is_empty() {
            findings.push(plugin_doctor_finding(
                plugin_id,
                "manifest.version",
                "compatibility",
                "error",
                "Manifest version is missing",
                "Core cannot compare upgrades or record a reproducible installed artifact without a version.",
                "Publish a semver version in the manifest.",
                json!({ "version": version }),
            ));
        }
        if installed_version.is_none()
            && !app
                .get("built_in")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        {
            findings.push(plugin_doctor_finding(
                plugin_id,
                "lifecycle.installed-version",
                "lifecycle",
                "error",
                "Installed plugin has no recorded version",
                "The lifecycle record and loaded manifest disagree about what is installed.",
                "Reinstall or update the artifact so Core can restore a versioned lifecycle record.",
                json!({ "manifestVersion": version, "installedVersion": installed_version }),
            ));
        }

        let grants = app
            .get("permission_grants")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        let approved = app
            .get("approved_grants")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        if enabled {
            for grant in &grants {
                let is_approved = approved.iter().any(|candidate| candidate == grant);
                if !is_approved {
                    findings.push(plugin_doctor_finding(
                        plugin_id,
                        "permissions.approved-drift",
                        "security",
                        "error",
                        "Enabled plugin has an unapproved declared grant",
                        "The loaded manifest asks for a capability that is not present in the lifecycle approval record.",
                        "Disable and re-enable the plugin through Core so the Gateway can validate its grants again.",
                        json!({ "grant": grant, "approvedGrants": approved }),
                    ));
                }
            }
        }
        for grant in &approved {
            if !grants.iter().any(|candidate| candidate == grant) {
                findings.push(plugin_doctor_finding(
                    plugin_id,
                    "permissions.stale-approval",
                    "security",
                    "warning",
                    "Lifecycle record contains a stale grant",
                    "A previously approved grant is no longer declared by the loaded manifest.",
                    "Disable and re-enable the plugin to refresh its approved capability set.",
                    json!({ "grant": grant, "declaredGrants": grants }),
                ));
            }
        }

        if app
            .get("suppressed_by_safe_mode")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            findings.push(plugin_doctor_finding(
                plugin_id,
                "runtime.safe-mode-suppressed",
                "runtime",
                "warning",
                "Plugin is suppressed by Safe Mode",
                "The lifecycle record says enabled, but Core intentionally did not activate it in this boot.",
                "Review the Safe Mode reason before enabling the plugin in a normal boot.",
                json!({ "enabled": enabled, "suppressedBySafeMode": true }),
            ));
        }

        let mut dependency_ids = std::collections::HashSet::new();
        if let Some(dependencies) = app
            .get("requires")
            .and_then(|value| value.get("apps"))
            .and_then(serde_json::Value::as_array)
        {
            for dependency in dependencies {
                let dependency_id = dependency
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                if dependency_id.is_empty() || !dependency_ids.insert(dependency_id) {
                    continue;
                }
                if !installed_ids.contains(dependency_id) {
                    findings.push(plugin_doctor_finding(
                        plugin_id,
                        "dependencies.missing",
                        "compatibility",
                        "error",
                        "Required plugin is not installed",
                        "The manifest declares a plugin dependency that Core cannot resolve.",
                        "Install the required dependency before enabling this artifact.",
                        json!({ "dependencyId": dependency_id }),
                    ));
                    continue;
                }
                let dependency_enabled = all_apps
                    .iter()
                    .find(|candidate| {
                        candidate
                            .get("id")
                            .and_then(serde_json::Value::as_str)
                            .is_some_and(|id| id == dependency_id)
                    })
                    .and_then(|candidate| candidate.get("enabled"))
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                if !dependency_enabled {
                    findings.push(plugin_doctor_finding(
                        plugin_id,
                        "dependencies.disabled",
                        "compatibility",
                        "warning",
                        "Required plugin is disabled",
                        "Core can see the dependency, but it is not active for this plugin's runtime contract.",
                        "Enable the dependency or disable this artifact until the dependency is ready.",
                        json!({ "dependencyId": dependency_id }),
                    ));
                }
            }
        }

        let mut runnable_ids = std::collections::HashSet::new();
        match app.get("runnables").and_then(serde_json::Value::as_array) {
            Some(runnables) => {
                for runnable in runnables {
                    let runnable_id = runnable
                        .get("id")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("");
                    let kind = runnable
                        .get("kind")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("");
                    if runnable_id.is_empty() || kind.is_empty() {
                        findings.push(plugin_doctor_finding(
                            plugin_id,
                            "manifest.runnable-shape",
                            "manifest",
                            "error",
                            "Runnable declaration is incomplete",
                            "Every runnable needs a stable id and kind so Core can register it deterministically.",
                            "Add id and kind to the runnable, then reload the manifest.",
                            json!({ "runnable": runnable }),
                        ));
                    } else if !runnable_ids.insert(runnable_id) {
                        findings.push(plugin_doctor_finding(
                            plugin_id,
                            "manifest.duplicate-runnable",
                            "manifest",
                            "error",
                            "Manifest declares a duplicate runnable id",
                            "Two contributions share one id and cannot be addressed deterministically.",
                            "Give every runnable a unique id within the plugin.",
                            json!({ "runnableId": runnable_id }),
                        ));
                    }
                }
            }
            None => findings.push(plugin_doctor_finding(
                plugin_id,
                "manifest.runnables",
                "manifest",
                "error",
                "Runnable list is unreadable",
                "Core could not reconcile this plugin's declared contributions with the loaded manifest.",
                "Regenerate the packed manifest and run the doctor again.",
                json!({ "runnables": app.get("runnables") }),
            )),
        }

        // Behavioral evals are an authoring signal layered on top of the
        // manifest/lifecycle doctor. The suite is parsed but never executed by
        // this read-only endpoint. A missing suite is informational; malformed
        // suite files are actionable findings, while unsupported grader types
        // remain warnings so the doctor never overstates coverage.
        let suite = &eval_suite.overview.suite;
        match suite.status.as_str() {
            "not_configured" => findings.push(plugin_doctor_finding(
                plugin_id,
                "evals.no-suite",
                "evaluations",
                "info",
                "No package eval suite found",
                "This artifact has no evals/ directory, so the doctor can validate its contract but cannot report behavioral coverage.",
                "Add evals/<case>/prompt.md and at least one grader when behavioral regression coverage is useful.",
                json!({ "directory": suite.directory, "caseCount": 0 }),
            )),
            "empty" => findings.push(plugin_doctor_finding(
                plugin_id,
                "evals.empty-suite",
                "evaluations",
                "warning",
                "Package eval suite is empty",
                "The evals/ directory exists, but it contains no readable cases.",
                "Add a prompt.md or case.yaml case before relying on behavioral coverage.",
                json!({ "directory": suite.directory }),
            )),
            "ready" | "ready_with_warnings" => findings.push(plugin_doctor_finding(
                plugin_id,
                "evals.suite-ready",
                "evaluations",
                "info",
                "Behavioral eval suite discovered",
                &format!(
                    "{} case(s) and {} grader(s) are available; the read-only doctor did not execute them.",
                    suite.case_count, suite.grader_count
                ),
                "Run the explicit plugin/app eval command to collect behavioral evidence.",
                json!({
                    "directory": suite.directory,
                    "caseCount": suite.case_count,
                    "graderCount": suite.grader_count,
                    "unsupportedGraders": suite.unsupported_graders,
                }),
            )),
            "invalid" => {}
            _ => {}
        }
        for eval_issue in &suite.issues {
            if eval_issue.severity == "info" || eval_issue.code == "evals.no-graders" {
                continue;
            }
            findings.push(plugin_doctor_finding(
                plugin_id,
                &eval_issue.code,
                "evaluations",
                &eval_issue.severity,
                "Package eval suite needs attention",
                &eval_issue.message,
                "Fix the reported eval file and run the plugin doctor again.",
                json!({ "path": eval_issue.path, "code": eval_issue.code }),
            ));
        }

        let plugin_findings = &findings[finding_start..];
        let error_count = plugin_findings
            .iter()
            .filter(|finding| {
                finding.get("severity").and_then(serde_json::Value::as_str) == Some("error")
            })
            .count();
        let warning_count = plugin_findings
            .iter()
            .filter(|finding| {
                finding.get("severity").and_then(serde_json::Value::as_str) == Some("warning")
            })
            .count();
        inventory.push(json!({
            "id": plugin_id,
            "name": name,
            "version": version,
            "installedVersion": installed_version,
            "enabled": enabled,
            "kind": artifact_kind,
            "status": if error_count > 0 { "error" } else if warning_count > 0 { "warning" } else { "healthy" },
            "findingCount": plugin_findings.len(),
            "evals": eval_suite.overview.suite,
        }));
    }

    let errors = findings
        .iter()
        .filter(|finding| {
            finding.get("severity").and_then(serde_json::Value::as_str) == Some("error")
        })
        .count();
    let warnings = findings
        .iter()
        .filter(|finding| {
            finding.get("severity").and_then(serde_json::Value::as_str) == Some("warning")
        })
        .count();
    let info = findings
        .iter()
        .filter(|finding| {
            finding.get("severity").and_then(serde_json::Value::as_str) == Some("info")
        })
        .count();
    let score = (100i64 - (errors as i64 * 20) - (warnings as i64 * 5)).max(0);
    Json(json!({
        "schemaVersion": "1",
        "rulesetVersion": "plugin-runtime-1",
        "generatedAt": chrono::Utc::now().to_rfc3339(),
        "profile": "lint",
        "scope": requested_id.unwrap_or("installed"),
        "readOnly": true,
        "score": score,
        "counts": {
            "errors": errors,
            "warnings": warnings,
            "info": info,
            "plugins": inventory.len(),
        },
        "plugins": inventory,
        "findings": findings,
    }))
}
