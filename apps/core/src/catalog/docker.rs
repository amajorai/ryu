// apps/core/src/catalog/docker.rs

use anyhow::Context;

/// A Docker Hub repository resolved from an image reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DockerHubRepo {
    pub namespace: String,
    pub repository: String,
}

/// Resolves an image reference to a Docker Hub repository.
///
/// Official images without a namespace (`docker`, `redis:7`) map to the
/// `library/` namespace. References that name another registry (`ghcr.io/…`,
/// `quay.io/…`, `localhost:5000/…`) return `None`: their tag listing needs a
/// registry-specific token flow, so the catalog reports no latest version for
/// them rather than guessing.
pub fn docker_hub_repo(image: &str) -> Option<DockerHubRepo> {
    let image = image.trim();
    // Drop any digest, then any tag on the last path segment.
    let image = image.split('@').next().unwrap_or(image);
    let image = match image.rsplit_once(':') {
        Some((name, tag)) if !tag.contains('/') => name,
        _ => image,
    };
    let mut segments: Vec<&str> = image.split('/').collect();
    if segments.iter().any(|segment| segment.is_empty()) {
        return None;
    }
    if segments.len() > 1 {
        let first = segments[0];
        let is_registry = first.contains('.') || first.contains(':') || first == "localhost";
        if is_registry {
            let is_docker_hub = matches!(
                first,
                "docker.io"
                    | "index.docker.io"
                    | "registry-1.docker.io"
                    | "registry.hub.docker.com"
            );
            if !is_docker_hub {
                return None;
            }
            segments.remove(0);
        }
    }
    match segments.as_slice() {
        [repository] => Some(DockerHubRepo {
            namespace: "library".to_string(),
            repository: (*repository).to_string(),
        }),
        [namespace, repository] => Some(DockerHubRepo {
            namespace: (*namespace).to_string(),
            repository: (*repository).to_string(),
        }),
        _ => None,
    }
}

/// Fetches the highest stable semver tag of a Docker Hub image.
///
/// Returns `Ok(None)` when the image lives on a registry other than Docker Hub
/// or when no tag is a stable semver version (e.g. only `latest`).
pub async fn fetch_latest_version(
    client: &reqwest::Client,
    image: &str,
) -> anyhow::Result<Option<String>> {
    let Some(repo) = docker_hub_repo(image) else {
        return Ok(None);
    };
    let url = format!(
        "https://hub.docker.com/v2/repositories/{}/{}/tags?page_size=100&ordering=last_updated",
        repo.namespace, repo.repository
    );
    let resp = client
        .get(&url)
        .header("User-Agent", "ryu-core/1.0")
        .header("Accept", "application/json")
        .send()
        .await
        .context("docker hub request failed")?
        .error_for_status()
        .context("docker hub api error")?;

    let json: serde_json::Value = resp.json().await.context("parse json")?;
    Ok(highest_semver_tag(&json))
}

/// Picks the highest stable semver tag from a Docker Hub tag-list response
/// (`{"results": [{"name": "27.3.1"}, …]}`). Accepts an optional leading `v`
/// and ignores floating tags (`latest`, `27`, `27.3`), variants and
/// pre-releases (`27.3.1-dind`, `1.0.0-rc.1`). The tag is returned verbatim.
pub fn highest_semver_tag(json: &serde_json::Value) -> Option<String> {
    json["results"]
        .as_array()?
        .iter()
        .filter_map(|entry| entry["name"].as_str())
        .filter_map(|tag| stable_semver(tag).map(|version| (version, tag)))
        .max_by(|(left, _), (right, _)| left.cmp(right))
        .map(|(_, tag)| tag.to_string())
}

fn stable_semver(tag: &str) -> Option<semver::Version> {
    let stripped = tag.strip_prefix('v').unwrap_or(tag);
    let version = semver::Version::parse(stripped).ok()?;
    (version.pre.is_empty() && version.build.is_empty()).then_some(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(namespace: &str, repository: &str) -> Option<DockerHubRepo> {
        Some(DockerHubRepo {
            namespace: namespace.to_string(),
            repository: repository.to_string(),
        })
    }

    #[test]
    fn maps_official_images_to_library_namespace() {
        assert_eq!(docker_hub_repo("docker"), repo("library", "docker"));
        assert_eq!(docker_hub_repo("redis:7.2"), repo("library", "redis"));
        assert_eq!(
            docker_hub_repo("docker.io/library/nginx"),
            repo("library", "nginx")
        );
    }

    #[test]
    fn keeps_user_namespaces_and_strips_tags_and_digests() {
        assert_eq!(
            docker_hub_repo("docker/model-runner"),
            repo("docker", "model-runner")
        );
        assert_eq!(
            docker_hub_repo("docker.io/ollama/ollama:0.3.0@sha256:abc"),
            repo("ollama", "ollama")
        );
    }

    #[test]
    fn other_registries_are_not_resolved() {
        assert_eq!(docker_hub_repo("ghcr.io/owner/image"), None);
        assert_eq!(docker_hub_repo("quay.io/org/image:1.0.0"), None);
        assert_eq!(docker_hub_repo("localhost:5000/image"), None);
        assert_eq!(docker_hub_repo(""), None);
    }

    #[test]
    fn picks_highest_stable_semver_tag() {
        let json = serde_json::json!({
            "count": 7,
            "results": [
                { "name": "latest" },
                { "name": "27.3.1-dind" },
                { "name": "27.3.1" },
                { "name": "27.10.0" },
                { "name": "28.0.0-rc.1" },
                { "name": "27" },
                { "name": "27.9.2" }
            ]
        });
        assert_eq!(highest_semver_tag(&json).as_deref(), Some("27.10.0"));
    }

    #[test]
    fn keeps_v_prefix_verbatim() {
        let json = serde_json::json!({
            "results": [{ "name": "v0.1.9" }, { "name": "v0.2.0" }, { "name": "main" }]
        });
        assert_eq!(highest_semver_tag(&json).as_deref(), Some("v0.2.0"));
    }

    #[test]
    fn returns_none_without_semver_tags() {
        let json = serde_json::json!({ "results": [{ "name": "latest" }, { "name": "edge" }] });
        assert_eq!(highest_semver_tag(&json), None);
        assert_eq!(
            highest_semver_tag(&serde_json::json!({ "detail": "not found" })),
            None
        );
    }
}
