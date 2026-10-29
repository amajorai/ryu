//! Native configuration for a build that ships one Ryu app as its product.
//!
//! The normal Desktop binary has no standalone carriage. A standalone build sets
//! `RYU_STANDALONE_APP_ID` and `RYU_STANDALONE_APP_BUNDLE` during Cargo build;
//! `build.rs` embeds the verified app manifest/UI carriage into this binary. The
//! host still starts the same Core/Gateway process boundary and the same app
//! lifecycle APIs as ordinary Desktop.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;
use tokio::time::{sleep, Duration};

const EMBEDDED_BUNDLE: &str = include_str!(concat!(env!("OUT_DIR"), "/standalone-app-bundle.json"));
const PORT_OFFSET_MIN: u16 = 12_000;
const PORT_OFFSET_SPAN: u32 = 16_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppBundle {
    pub schema_version: u8,
    pub app_id: String,
    pub app_name: String,
    pub version: String,
    pub manifest: serde_json::Value,
    pub sidecars: Vec<SidecarResource>,
    pub ui_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarResource {
    pub command: Option<String>,
    pub command_env: Option<String>,
    pub mode: String,
    pub name: String,
    pub resource_path: Option<String>,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StandaloneBootstrapResult {
    pub app_id: String,
    pub app_name: String,
    pub companion_id: Option<String>,
    pub token: String,
}

/// True when this binary was built for one app rather than the general Desktop.
pub fn enabled() -> bool {
    app_id().is_some()
}

/// The app id embedded by the standalone build script, if any.
pub fn app_id() -> Option<&'static str> {
    option_env!("RYU_STANDALONE_APP_ID").filter(|value| !value.trim().is_empty())
}

/// Resolve the same deterministic offset as `packages/app-host/src/standalone.ts`.
pub fn port_offset_for(app_id: &str) -> u16 {
    let mut hash = 2_166_136_261_u32;
    for byte in app_id.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(16_777_619);
    }
    PORT_OFFSET_MIN + (hash % PORT_OFFSET_SPAN) as u16
}

fn safe_slug(app_id: &str) -> String {
    let slug = app_id
        .trim()
        .chars()
        .map(|value| {
            if value.is_ascii_alphanumeric() || matches!(value, '.' | '_' | '-') {
                value
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches(|value| matches!(value, '-' | '.'))
        .to_owned();
    if slug.is_empty() {
        "app".to_owned()
    } else {
        slug
    }
}

/// Seed app-local data and port namespaces before Desktop or Core resolve paths.
pub fn configure_environment() {
    let Some(app_id) = app_id() else {
        return;
    };
    // A standalone binary is an app-specific product boundary. Never inherit a
    // caller's general Desktop or another standalone product's data/port values:
    // doing so would silently merge state or make the two products race for Core.
    let data_dir = data_root_for_app(app_id);
    std::env::set_var("RYU_DIR", &data_dir);
    // Core's profile fallback is keyed by the release name, while standalone
    // products deliberately keep that name for compatibility. Pin the Gateway
    // config beside the app's data root as well, otherwise every standalone app
    // would share the ordinary release gateway.toml (including provider keys).
    std::env::set_var("GATEWAY_CONFIG", data_dir.join("gateway.toml"));
    std::env::set_var("RYU_PORT_OFFSET", port_offset_for(app_id).to_string());
}

fn data_root_for_app(app_id: &str) -> std::path::PathBuf {
    let data_root = dirs::data_dir().unwrap_or_else(|| std::env::temp_dir().join("Ryu"));
    data_root
        .join("Ryu")
        .join("ryu-apps")
        .join(safe_slug(app_id))
}

/// Point Core at sidecar binaries carried as Tauri resources. Core remains the
/// process owner; this only supplies the manifest-declared command override
/// after verifying the resource bytes against the build carriage.
pub fn configure_embedded_sidecars<R: tauri::Runtime, M: Manager<R>>(app: &M) {
    let Ok(Some(bundle)) = get_standalone_app_bundle() else {
        return;
    };
    let Ok(resource_root) = app.path().resource_dir() else {
        return;
    };
    for sidecar in bundle.sidecars {
        if sidecar.mode != "embedded" {
            continue;
        }
        let (Some(command_env), Some(resource_path)) = (sidecar.command_env, sidecar.resource_path)
        else {
            continue;
        };
        let relative = std::path::Path::new(&resource_path);
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            tracing::warn!(
                resource_path,
                "refusing unsafe standalone sidecar resource path"
            );
            continue;
        }
        let path = resource_root.join(relative);
        let Ok(bytes) = std::fs::read(&path) else {
            tracing::warn!(path = %path.display(), "embedded standalone sidecar resource is missing");
            continue;
        };
        if let Some(expected) = sidecar.sha256.as_deref() {
            let actual = hex::encode(Sha256::digest(&bytes));
            if actual != expected.trim().to_ascii_lowercase() {
                tracing::warn!(
                    path = %path.display(),
                    expected,
                    actual,
                    "embedded standalone sidecar hash mismatch"
                );
                continue;
            }
        }
        std::env::set_var(command_env, path);
    }
}

/// Return the embedded app carriage to the frontend bootstrap.
#[tauri::command]
pub fn get_standalone_app_bundle() -> Result<Option<AppBundle>, String> {
    if !enabled() {
        return Ok(None);
    }
    let bundle: AppBundle = serde_json::from_str(EMBEDDED_BUNDLE)
        .map_err(|error| format!("standalone app bundle is invalid: {error}"))?;
    if bundle.schema_version != 1 {
        return Err(format!(
            "unsupported standalone app bundle schema {}",
            bundle.schema_version
        ));
    }
    let expected = app_id().unwrap_or_default();
    if bundle.app_id != expected {
        return Err(format!(
            "standalone app bundle id '{}' does not match binary id '{expected}'",
            bundle.app_id
        ));
    }
    Ok(Some(bundle))
}

fn standalone_companion_id(bundle: &AppBundle) -> Option<String> {
    bundle
        .manifest
        .get("runnables")
        .and_then(serde_json::Value::as_array)
        .and_then(|runnables| {
            runnables.iter().find_map(|runnable| {
                let is_companion =
                    runnable.get("kind").and_then(serde_json::Value::as_str) == Some("companion");
                let id = runnable.get("id").and_then(serde_json::Value::as_str);
                (is_companion && id.is_some()).then(|| format!("app__{}", id.unwrap_or_default()))
            })
        })
}

fn standalone_bundle_needs_update(
    installed: Option<&serde_json::Value>,
    bundle_version: &str,
) -> bool {
    installed.is_some_and(|entry| {
        entry.get("version").and_then(serde_json::Value::as_str) != Some(bundle_version)
    })
}

async fn standalone_core_request(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: reqwest::Url,
    token: &str,
    body: Option<&serde_json::Value>,
) -> Result<reqwest::Response, String> {
    let mut request = client
        .request(method, url)
        .bearer_auth(token)
        .header("X-Ryu-Client-Label", "Ryu App")
        .header("X-Ryu-Surface", "desktop");
    if let Some(body) = body {
        request = request.json(body);
    }
    request.send().await.map_err(|error| error.to_string())
}

async fn standalone_plugin_url(id: &str, suffix: Option<&str>) -> Result<reqwest::Url, String> {
    let base = format!("{}/api/plugins", crate::profile::core_base_url());
    let mut url = reqwest::Url::parse(&base).map_err(|error| error.to_string())?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "standalone Core URL cannot accept path segments".to_owned())?;
        segments.push(id);
        if let Some(suffix) = suffix {
            segments.push(suffix);
        }
    }
    Ok(url)
}

/// Start an app's local lifecycle from the native host.
///
/// The browser-facing Desktop API remains the normal app contract. A standalone
/// product uses this native seam for its first boot because the host is already
/// the process that minted the node token and owns the embedded bundle; it avoids
/// making cold-start installation depend on a webview CORS/preflight race.
#[tauri::command]
pub async fn bootstrap_standalone_app() -> Result<StandaloneBootstrapResult, String> {
    let Some(bundle) = get_standalone_app_bundle()? else {
        return Err("standalone app bootstrap is unavailable in the general Desktop".to_owned());
    };
    let app_id = bundle.app_id.clone();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| error.to_string())?;

    let mut token = None;
    for _ in 0..240 {
        if let Some(disk_token) = crate::nodes::read_local_node_token() {
            token = Some(disk_token);
            break;
        }
        sleep(Duration::from_millis(250)).await;
    }
    let Some(token) = token else {
        return Err("standalone Core did not mint a local node token within 60 seconds".to_owned());
    };

    let list_url = reqwest::Url::parse(&format!("{}/api/plugins", crate::profile::core_base_url()))
        .map_err(|error| error.to_string())?;
    let mut list = None;
    for _ in 0..240 {
        match standalone_core_request(
            &client,
            reqwest::Method::GET,
            list_url.clone(),
            &token,
            None,
        )
        .await
        {
            Ok(response) if response.status().is_success() => {
                list = Some(response);
                break;
            }
            Ok(_) | Err(_) => sleep(Duration::from_millis(250)).await,
        }
    }
    let Some(list) = list else {
        return Err("standalone Ryu Core did not become ready within 60 seconds".to_owned());
    };
    let mut apps = list
        .json::<serde_json::Value>()
        .await
        .map_err(|error| error.to_string())?;
    let mut installed = apps
        .get_mut("apps")
        .and_then(serde_json::Value::as_array_mut)
        .and_then(|entries| {
            entries.iter_mut().find(|entry| {
                entry.get("id").and_then(serde_json::Value::as_str) == Some(app_id.as_str())
            })
        })
        .cloned();

    let needs_update = standalone_bundle_needs_update(installed.as_ref(), &bundle.version);
    if installed.is_none() || needs_update {
        let mut body = bundle.manifest.clone();
        if let Some(object) = body.as_object_mut() {
            if let Some(ui_code) = bundle.ui_code.as_ref() {
                object.insert(
                    "ui_code".to_owned(),
                    serde_json::Value::String(ui_code.clone()),
                );
            }
            if needs_update {
                object.insert("update".to_owned(), serde_json::Value::Bool(true));
            }
        }
        let install_url = reqwest::Url::parse(&format!(
            "{}/api/plugins/install-bundle",
            crate::profile::core_base_url()
        ))
        .map_err(|error| error.to_string())?;
        let response = standalone_core_request(
            &client,
            reqwest::Method::POST,
            install_url,
            &token,
            Some(&body),
        )
        .await?;
        let accepted = if needs_update {
            response.status().is_success()
        } else {
            response.status().is_success() || response.status() == reqwest::StatusCode::CONFLICT
        };
        if !accepted {
            return Err(format!(
                "standalone app {} failed with HTTP {}: {}",
                if needs_update { "update" } else { "install" },
                response.status(),
                response.text().await.unwrap_or_default()
            ));
        }
        let response =
            standalone_core_request(&client, reqwest::Method::GET, list_url, &token, None).await?;
        apps = response
            .json::<serde_json::Value>()
            .await
            .map_err(|error| error.to_string())?;
        installed = apps
            .get_mut("apps")
            .and_then(serde_json::Value::as_array_mut)
            .and_then(|entries| {
                entries.iter_mut().find(|entry| {
                    entry.get("id").and_then(serde_json::Value::as_str) == Some(app_id.as_str())
                })
            })
            .cloned();
    }

    let installed = installed.ok_or_else(|| format!("Ryu Core did not register {app_id}."))?;
    if installed
        .get("enabled")
        .and_then(serde_json::Value::as_bool)
        != Some(true)
    {
        let enable_url = standalone_plugin_url(&app_id, Some("enable")).await?;
        let mut enable_error = None;
        for _ in 0..240 {
            let response = standalone_core_request(
                &client,
                reqwest::Method::POST,
                enable_url.clone(),
                &token,
                None,
            )
            .await?;
            if response.status().is_success() {
                enable_error = None;
                break;
            }
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            enable_error = Some(format!(
                "standalone app enable failed with HTTP {status}: {body}"
            ));
            if !status.is_server_error() {
                break;
            }
            sleep(Duration::from_millis(250)).await;
        }
        if let Some(error) = enable_error {
            return Err(error);
        }
    }

    Ok(StandaloneBootstrapResult {
        app_id,
        app_name: bundle.app_name.clone(),
        companion_id: standalone_companion_id(&bundle),
        token,
    })
}

#[cfg(test)]
mod tests {
    use super::{data_root_for_app, port_offset_for, safe_slug, standalone_bundle_needs_update};

    #[test]
    fn port_offset_is_stable_and_outside_normal_profiles() {
        let first = port_offset_for("@ryu/expenses");
        assert_eq!(first, port_offset_for("@ryu/expenses"));
        assert!((12_000..28_000).contains(&first));
    }

    #[test]
    fn app_slug_is_safe() {
        assert_eq!(safe_slug("@ryu/expenses"), "ryu-expenses");
        assert_eq!(safe_slug("../../"), "app");
    }

    #[test]
    fn app_data_root_is_namespaced() {
        assert!(data_root_for_app("@ryu/expenses").ends_with("Ryu/ryu-apps/ryu-expenses"));
    }

    #[test]
    fn standalone_bundle_updates_when_the_installed_version_changes() {
        let installed = serde_json::json!({ "version": "1.0.0" });
        assert!(standalone_bundle_needs_update(Some(&installed), "1.1.0"));
        assert!(!standalone_bundle_needs_update(Some(&installed), "1.0.0"));
        assert!(!standalone_bundle_needs_update(None, "1.1.0"));
    }
}
