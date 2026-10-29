// apps/core/src/catalog/pypi.rs

use anyhow::Context;

/// Fetches the latest released version of a PyPI package from the PyPI JSON
/// API (`https://pypi.org/pypi/<package>/json` → `info.version`).
pub async fn fetch_latest_version(
    client: &reqwest::Client,
    package: &str,
) -> anyhow::Result<String> {
    let encoded = urlencoding::encode(package);
    let url = format!("https://pypi.org/pypi/{encoded}/json");
    let resp = client
        .get(&url)
        .header("User-Agent", "ryu-core/1.0")
        .header("Accept", "application/json")
        .send()
        .await
        .context("pypi request failed")?
        .error_for_status()
        .context("pypi api error")?;

    let json: serde_json::Value = resp.json().await.context("parse json")?;
    parse_latest_version(&json)
}

/// Extracts `info.version` from a PyPI JSON API response.
pub fn parse_latest_version(json: &serde_json::Value) -> anyhow::Result<String> {
    let version = json["info"]["version"]
        .as_str()
        .map(str::trim)
        .filter(|version| !version.is_empty())
        .context("missing info.version field")?;
    Ok(version.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_info_version_from_response() {
        let json = serde_json::json!({
            "info": { "name": "vllm", "version": "0.6.3" },
            "releases": { "0.6.2": [], "0.6.3": [] }
        });
        assert_eq!(parse_latest_version(&json).unwrap(), "0.6.3");
    }

    #[test]
    fn errors_when_info_version_missing_or_empty() {
        assert!(parse_latest_version(&serde_json::json!({ "info": {} })).is_err());
        assert!(parse_latest_version(&serde_json::json!({ "info": { "version": "" } })).is_err());
        assert!(parse_latest_version(&serde_json::json!({ "message": "Not Found" })).is_err());
    }
}
