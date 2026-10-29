//! Internal production-path fixtures: suppress unrelated bootstrap effects only.
//! This flag is rejected outside an explicitly isolated debug/dev process.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const ENV: &str = "RYU_TEST_OFFLINE_BOOTSTRAP";
const PREFIX: &str = "ryu-ego-production-proof-";
static ACTIVE: AtomicBool = AtomicBool::new(false);

/// Published only after startup has validated every isolation requirement.
/// Background helpers must never interpret the environment flag themselves.
pub fn is_active() -> bool {
    ACTIVE.load(Ordering::Acquire)
}

pub fn requested() -> Result<bool, String> {
    let Some(value) = std::env::var_os(ENV) else {
        return Ok(false);
    };
    if value != "1" {
        return Err(format!("{ENV} requires the exact value 1"));
    }
    if std::env::args()
        .skip(1)
        .any(|argument| argument.starts_with("--bind="))
    {
        return Err(
            "offline bootstrap refuses a CLI bind override; use the validated RYU_BIND".into(),
        );
    }
    validate(
        cfg!(debug_assertions),
        std::env::var("RYU_PROFILE").ok().as_deref(),
        std::env::var("RYU_KEYCHAIN").ok().as_deref(),
        std::env::var_os("RYU_DIR").map(PathBuf::from).as_deref(),
        std::env::var("RYU_BIND").ok().as_deref(),
        std::env::var("RYU_TOKEN").ok().as_deref(),
        std::env::var("RYU_GATEWAY_REMOTE").ok().as_deref(),
        std::env::var("RYU_GATEWAY_URL").ok().as_deref(),
        std::env::var("RYU_GATEWAY_TOKEN").ok().as_deref(),
    )?;
    validate_optional_core_relay(std::env::var("RYU_GATEWAY_CORE_TOKEN").ok().as_deref())?;
    for key in [
        "RYU_PRODUCT_ANALYTICS_ENABLED",
        "RYU_CRASH_REPORTS_ENABLED",
        "RYU_DIAGNOSTICS_EXPORT_ENABLED",
        "RYU_COMMUNITY_STATS_ENABLED",
        "RYU_SUPPORT_ACCESS_LOCAL_ENABLED",
    ] {
        if std::env::var(key).ok().as_deref() != Some("false") {
            return Err(format!("offline bootstrap requires {key}=false"));
        }
    }
    for key in [
        "RYU_MESH_ENABLED",
        "RYU_MESH_PREINSTALL_CLIENT",
        "RYU_SYNC_ENABLED",
        "RYU_DOWNLOADS_AUTORESUME",
    ] {
        if std::env::var(key).ok().as_deref() != Some("0") {
            return Err(format!("offline bootstrap requires {key}=0"));
        }
    }
    for (key, value) in std::env::vars_os() {
        let key = key.to_string_lossy();
        if value.is_empty() {
            continue;
        }
        let allowed = matches!(
            key.as_ref(),
            "RYU_TOKEN" | "RYU_GATEWAY_TOKEN" | "RYU_GATEWAY_CORE_TOKEN"
        );
        if !allowed
            && (key.ends_with("_API_KEY")
                || key.ends_with("_TOKEN")
                || matches!(
                    key.as_ref(),
                    "RYU_GATEWAY_KEY"
                        | "RYU_MASTER_KEY"
                        | "RYU_VAULT_KEY"
                        | "AWS_ACCESS_KEY_ID"
                        | "AWS_SECRET_ACCESS_KEY"
                        | "GOOGLE_APPLICATION_CREDENTIALS"
                        | "RYU_MANAGED_NODE"
                        | "RYU_PASSPORT_URL"
                        | "RYU_MESH_AUTHKEY"
                        | "HTTP_PROXY"
                        | "HTTPS_PROXY"
                        | "ALL_PROXY"
                        | "http_proxy"
                        | "https_proxy"
                        | "all_proxy"
                ))
        {
            return Err(format!(
                "offline bootstrap refuses ambient credential/configuration {key}"
            ));
        }
    }
    ACTIVE.store(true, Ordering::Release);
    Ok(true)
}

fn validate_optional_core_relay(value: Option<&str>) -> Result<(), String> {
    if value.is_some_and(|value| !value.starts_with("ryu-fixture-") || value.len() < 32) {
        return Err(
            "offline bootstrap requires a synthetic Core relay token when configured".into(),
        );
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate(
    debug: bool,
    profile: Option<&str>,
    keychain: Option<&str>,
    dir: Option<&Path>,
    bind: Option<&str>,
    token: Option<&str>,
    remote: Option<&str>,
    gateway: Option<&str>,
    gateway_token: Option<&str>,
) -> Result<(), String> {
    if !debug || profile != Some("dev") || keychain != Some("off") {
        return Err(
            "offline bootstrap requires a debug build, explicit dev profile and keychain off"
                .into(),
        );
    }
    let dir = dir.ok_or("offline bootstrap requires explicit RYU_DIR")?;
    let canonical = dir
        .canonicalize()
        .map_err(|_| "offline bootstrap requires an existing canonical fixture directory")?;
    let roots = [std::env::temp_dir(), PathBuf::from("/private/tmp")];
    let under_temp = roots
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .any(|root| canonical.starts_with(root));
    if dir != canonical
        || !under_temp
        || !canonical
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(PREFIX))
    {
        return Err(format!(
            "offline bootstrap requires a canonical temporary {PREFIX} directory"
        ));
    }
    // Only authored packages/isolated skills may be staged before first boot.
    // Existing databases/config/enrollment state are never adopted by this seam.
    for entry in std::fs::read_dir(&canonical).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !matches!(entry.file_name().to_str(), Some("plugins" | "skills"))
            || !entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_dir()
        {
            return Err("offline bootstrap requires fresh state (only plugins/skills directories may be staged)".into());
        }
    }
    let address: std::net::SocketAddr = bind
        .ok_or("offline bootstrap requires explicit RYU_BIND")?
        .parse()
        .map_err(|_| "offline bootstrap requires a loopback socket bind")?;
    if !address.ip().is_loopback() || address.port() == 0 {
        return Err("offline bootstrap requires a nonzero loopback bind".into());
    }
    let synthetic = |value: Option<&str>| {
        value.is_some_and(|value| value.starts_with("ryu-fixture-") && value.len() >= 32)
    };
    if !synthetic(token) || !synthetic(gateway_token) || remote != Some("1") {
        return Err("offline bootstrap requires synthetic node/Gateway tokens and explicit remote Gateway mode".into());
    }
    let gateway =
        url::Url::parse(gateway.ok_or("offline bootstrap requires explicit Gateway URL")?)
            .map_err(|_| "invalid fixture Gateway URL")?;
    if gateway.scheme() != "http"
        || !gateway.username().is_empty()
        || gateway.password().is_some()
        || gateway.query().is_some()
        || gateway.fragment().is_some()
        || !gateway
            .host_str()
            .and_then(|host| host.parse::<std::net::IpAddr>().ok())
            .is_some_and(|ip| ip.is_loopback())
        || gateway.port().is_none_or(|port| port == 0)
    {
        return Err("offline bootstrap requires an HTTP loopback IP Gateway URL with an explicit port and no credentials/query".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn isolated_bootstrap_rejects_release_profiles_credentials_and_reused_state() {
        assert!(validate_optional_core_relay(None).is_ok());
        assert!(
            validate_optional_core_relay(Some("ryu-fixture-core-synthetic-token-only")).is_ok()
        );
        for value in ["", "real-core-token", "ryu-fixture-short"] {
            assert!(validate_optional_core_relay(Some(value)).is_err());
        }
        let dir = tempfile::Builder::new().prefix(PREFIX).tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap();
        let check = |debug, profile, keychain, bind, token, gateway| {
            validate(
                debug,
                profile,
                keychain,
                Some(&path),
                bind,
                token,
                Some("1"),
                gateway,
                Some("ryu-fixture-gateway-synthetic-token"),
            )
        };
        assert!(check(
            true,
            Some("dev"),
            Some("off"),
            Some("127.0.0.1:4317"),
            Some("ryu-fixture-node-synthetic-token-1"),
            Some("http://127.0.0.1:4318")
        )
        .is_ok());
        for (debug, profile, keychain, bind, token, gateway) in [
            (
                false,
                Some("dev"),
                Some("off"),
                Some("127.0.0.1:4317"),
                Some("ryu-fixture-node-synthetic-token-1"),
                Some("http://127.0.0.1:4318"),
            ),
            (
                true,
                Some("release"),
                Some("off"),
                Some("127.0.0.1:4317"),
                Some("ryu-fixture-node-synthetic-token-1"),
                Some("http://127.0.0.1:4318"),
            ),
            (
                true,
                Some("dev"),
                None,
                Some("127.0.0.1:4317"),
                Some("ryu-fixture-node-synthetic-token-1"),
                Some("http://127.0.0.1:4318"),
            ),
            (
                true,
                Some("dev"),
                Some("off"),
                Some("0.0.0.0:4317"),
                Some("ryu-fixture-node-synthetic-token-1"),
                Some("http://127.0.0.1:4318"),
            ),
            (
                true,
                Some("dev"),
                Some("off"),
                Some("127.0.0.1:4317"),
                Some("real-node-token"),
                Some("http://127.0.0.1:4318"),
            ),
            (
                true,
                Some("dev"),
                Some("off"),
                Some("127.0.0.1:4317"),
                Some("ryu-fixture-node-synthetic-token-1"),
                Some("https://provider.invalid"),
            ),
        ] {
            assert!(check(debug, profile, keychain, bind, token, gateway).is_err());
        }
        std::fs::write(path.join("identities.db"), b"existing").unwrap();
        assert!(check(
            true,
            Some("dev"),
            Some("off"),
            Some("127.0.0.1:4317"),
            Some("ryu-fixture-node-synthetic-token-1"),
            Some("http://127.0.0.1:4318")
        )
        .unwrap_err()
        .contains("fresh state"));
    }
}
