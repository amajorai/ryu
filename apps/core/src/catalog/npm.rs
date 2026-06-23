// apps/core/src/catalog/npm.rs

use anyhow::Context;

/// Fetches the latest published version of an npm package.
pub async fn fetch_latest_version(
    client: &reqwest::Client,
    package: &str,
) -> anyhow::Result<String> {
    // URL-encode the package name (handles scoped packages like @ryu/qmd)
    let encoded = urlencoding::encode(package);
    let url = format!("https://registry.npmjs.org/{encoded}/latest");
    let resp = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .context("npm request failed")?
        .error_for_status()
        .context("npm registry error")?;

    let json: serde_json::Value = resp.json().await.context("parse json")?;
    let version = json["version"]
        .as_str()
        .context("missing version field")?
        .to_string();
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_version_from_response() {
        let json = serde_json::json!({ "version": "1.5.0", "name": "@ryu/qmd" });
        let v = json["version"].as_str().unwrap().to_string();
        assert_eq!(v, "1.5.0");
    }

    #[test]
    fn returns_error_when_version_missing() {
        let json = serde_json::json!({ "name": "no-version" });
        assert!(json["version"].as_str().is_none());
    }
}
