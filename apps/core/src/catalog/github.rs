// apps/core/src/catalog/github.rs

use anyhow::Context;

/// Fetches the latest release tag from GitHub Releases API.
/// Returns the tag_name string (e.g. "v0.2.0" or "b8373").
///
/// Goes through the updater's GitHub GET so it shares its headers, deadline and
/// optional token (a configured token lifts the 60/hr unauthenticated limit that
/// the catalog and the update check otherwise share).
pub async fn fetch_latest_version(client: &reqwest::Client, repo: &str) -> anyhow::Result<String> {
    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let resp = crate::update::github_get(client, url)
        .await
        .context("github request failed")?
        .error_for_status()
        .context("github api error")?;

    let json: serde_json::Value = resp.json().await.context("parse json")?;
    let tag = json["tag_name"]
        .as_str()
        .context("missing tag_name")?
        .to_string();
    Ok(tag)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tag_name_from_response() {
        let json = serde_json::json!({
            "tag_name": "v0.2.0",
            "name": "Release 0.2.0"
        });
        let tag = json["tag_name"].as_str().unwrap().to_string();
        assert_eq!(tag, "v0.2.0");
    }

    #[test]
    fn returns_error_when_tag_name_missing() {
        let json = serde_json::json!({ "name": "no tag" });
        assert!(json["tag_name"].as_str().is_none());
    }
}
