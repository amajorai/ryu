//! Distribution locations belong to the packaged app, never to renderer input.
use serde::Deserialize;

pub(crate) const DEFAULT_RELEASE_BASE: &str = "https://github.com/amajorai/ryu/releases";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DistributionConfig {
    schema_version: u32,
    release_base: String,
}

fn configured_release_base(config: Option<&serde_json::Value>) -> Result<String, String> {
    let Some(config) = config else {
        return Ok(DEFAULT_RELEASE_BASE.to_owned());
    };
    let config: DistributionConfig = serde_json::from_value(config.clone())
        .map_err(|error| format!("Invalid packaged distribution configuration: {error}"))?;
    if config.schema_version != 1 {
        return Err("Unsupported packaged distribution configuration schema".into());
    }
    let base = &config.release_base;
    let url = reqwest::Url::parse(base)
        .map_err(|error| format!("Invalid packaged release base: {error}"))?;
    let authority = base
        .split_once("://")
        .map(|(_, rest)| rest.split('/').next().unwrap_or(""));
    if base.trim() != base
        || !base.starts_with("https://")
        || base.chars().any(char::is_control)
        || base.contains('\\')
        || url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || authority.is_some_and(|authority| authority.contains('@'))
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Packaged release base must be HTTPS without credentials, query, or fragment".into(),
        );
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

/// Updater feed family for the regular Ryu desktop app (`latest.json`,
/// `latest-<channel>.json`).
pub(crate) const DEFAULT_FEED_STEM: &str = "latest";

/// Bundle identifier of the standalone Ryu Bot build (`tauri.bot.conf.json`).
const BOT_IDENTIFIER: &str = "ai.amajor.ryu.bot";

/// The updater feed family for the app with bundle `identifier`. The standalone
/// Bot build is a different bundle (name, identifier, deep-link scheme), so it
/// reads `latest-bot*.json`: reading Ryu's feed would replace Ryu Bot with Ryu.
pub(crate) fn feed_stem(identifier: &str) -> &'static str {
    if identifier == BOT_IDENTIFIER {
        "latest-bot"
    } else {
        DEFAULT_FEED_STEM
    }
}

pub(crate) fn release_base(app: &tauri::AppHandle) -> Result<String, String> {
    configured_release_base(app.config().plugins.0.get("ryu-distribution"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_and_packaged_https_bases() {
        assert_eq!(configured_release_base(None).unwrap(), DEFAULT_RELEASE_BASE);
        let config = serde_json::json!({"schemaVersion": 1, "releaseBase": "https://localhost:9443/releases/"});
        assert_eq!(
            configured_release_base(Some(&config)).unwrap(),
            "https://localhost:9443/releases"
        );
    }

    #[test]
    fn invalid_packaged_configuration_fails_closed() {
        for base in [
            "http://localhost/releases",
            "file:///releases",
            "https://user:secret@example.com/releases",
            "https://@example.com/releases",
            "https://example.com/releases?feed=1",
            "https://example.com/releases#feed",
            " https://example.com/releases",
            "https://example.com\\releases",
            "https:example.com/releases",
            "https://example.com/re\tleases",
        ] {
            let config = serde_json::json!({"schemaVersion": 1, "releaseBase": base});
            assert!(configured_release_base(Some(&config)).is_err(), "{base}");
        }
        for config in [
            serde_json::json!({"schemaVersion": 2, "releaseBase": DEFAULT_RELEASE_BASE}),
            serde_json::json!({"schemaVersion": 1}),
            serde_json::json!({"schemaVersion": 1, "releaseBase": DEFAULT_RELEASE_BASE, "extra": true}),
        ] {
            assert!(configured_release_base(Some(&config)).is_err());
        }
    }
}
