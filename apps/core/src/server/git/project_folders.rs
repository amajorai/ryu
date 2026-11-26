//! Project folder handlers: create an empty folder or clone a repository.

use super::*;

#[derive(Deserialize)]
pub struct NewFolderBody {
    name: String,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CloneFolderBody {
    /// HTTPS or SSH clone URL for a public Git host such as GitHub, GitLab,
    /// Azure DevOps, or a custom host. Credentials must be configured on the node.
    url: String,
    /// Optional destination folder name. Defaults to the repository name.
    #[serde(default)]
    name: Option<String>,
}

pub(crate) struct GitCloneSource {
    pub(crate) repository_name: String,
    pub(crate) host: String,
    pub(crate) port: u16,
}

fn git_repository_name_from_path(path: &str, host: &str) -> Result<String, String> {
    let path = path.trim_matches('/');
    if path.is_empty() {
        return Err("Repository URL must include a repository path".to_string());
    }
    let segments: Vec<&str> = path.split('/').collect();
    if segments.iter().any(|segment| {
        segment.is_empty()
            || *segment == "."
            || *segment == ".."
            || segment.chars().any(char::is_control)
    }) {
        return Err("Repository URL contains an invalid path".to_string());
    }
    if matches!(
        host.to_ascii_lowercase().as_str(),
        "github.com" | "www.github.com"
    ) && segments.len() != 2
    {
        return Err("GitHub clone URLs must identify exactly one repository".to_string());
    }

    let repository = segments.last().copied().unwrap_or_default();
    let repository = repository.strip_suffix(".git").unwrap_or(repository);
    if repository.is_empty() || repository == "." || repository == ".." {
        return Err("Repository URL must include a repository name".to_string());
    }
    Ok(repository.to_string())
}

/// Accept credential-free HTTPS and standard Git-user SSH clone URLs from any
/// Git host. The caller screens the extracted host before starting Git so this
/// authenticated clone endpoint cannot target local or cloud-metadata services.
pub(crate) fn parse_git_clone_url(raw: &str) -> Result<GitCloneSource, String> {
    let source = raw.trim();
    if source.is_empty() {
        return Err("A repository URL is required".to_string());
    }
    if source.len() > 2048 || source.chars().any(char::is_control) {
        return Err("That repository URL is not valid".to_string());
    }

    if let Some(scp_source) = source.strip_prefix("git@") {
        let (raw_host, path) = scp_source
            .split_once(':')
            .ok_or_else(|| "Use a Git HTTPS URL or an SSH clone URL".to_string())?;
        if raw_host.is_empty()
            || raw_host
                .chars()
                .any(|character| matches!(character, '/' | '@' | '?' | '#'))
            || path.contains('?')
            || path.contains('#')
        {
            return Err("That SSH clone URL is not valid".to_string());
        }
        let host = url::Host::parse(raw_host)
            .map_err(|_| "That SSH clone host is not valid".to_string())?
            .to_string();
        let repository_name = git_repository_name_from_path(path, &host)?;
        return Ok(GitCloneSource {
            repository_name,
            host,
            port: 22,
        });
    }

    let parsed = url::Url::parse(source).map_err(|_| {
        "Use a Git HTTPS URL or an SSH clone URL such as git@example.com:group/repo.git".to_string()
    })?;
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("Git clone URLs cannot contain a query or fragment".to_string());
    }
    let default_port = match parsed.scheme() {
        "https" => {
            if !parsed.username().is_empty() || parsed.password().is_some() {
                return Err("HTTPS clone URLs cannot contain credentials".to_string());
            }
            443
        }
        "ssh" => {
            if parsed.username() != "git" || parsed.password().is_some() {
                return Err("SSH clone URLs must use the git user without a password".to_string());
            }
            22
        }
        _ => {
            return Err("Only HTTPS and SSH Git clone URLs are supported".to_string());
        }
    };
    let host = parsed
        .host_str()
        .ok_or_else(|| "Repository URL has no host".to_string())?;
    let host = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host)
        .to_string();
    let port = parsed.port().unwrap_or(default_port);
    if port == 0 {
        return Err("Git clone URLs must use a valid port".to_string());
    }
    let path = parsed
        .path_segments()
        .map(|segments| segments.collect::<Vec<_>>().join("/"))
        .unwrap_or_default();
    let repository_name = git_repository_name_from_path(&path, &host)?;
    Ok(GitCloneSource {
        repository_name,
        host,
        port,
    })
}

/// `host:port:addr[,addr]` for Git's `http.curloptResolve`, pinning the clone
/// to the addresses the SSRF screen approved so Git cannot re-resolve the
/// host to a different (local) target. IP-literal hosts need no pinning.
fn git_clone_pinned_resolve(
    source: &GitCloneSource,
    approved: &[std::net::SocketAddr],
) -> Option<String> {
    let literal = source.host.trim_start_matches('[').trim_end_matches(']');
    if literal.parse::<std::net::IpAddr>().is_ok() || approved.is_empty() {
        return None;
    }
    let addresses = approved
        .iter()
        .map(|address| match address.ip() {
            std::net::IpAddr::V4(ip) => ip.to_string(),
            std::net::IpAddr::V6(ip) => format!("[{ip}]"),
        })
        .collect::<Vec<_>>()
        .join(",");
    Some(format!("{}:{}:{addresses}", source.host, source.port))
}

/// `POST /api/workspace/clone` `{ url, name? }`
///
/// Clone an HTTPS or SSH repository from GitHub, GitLab, Azure DevOps, or a
/// custom public Git host into `~/Documents/Ryu/<name>` on the node serving this
/// request. HTTPS credentials and SSH keys stay configured on that node; no
/// provider credential crosses the desktop boundary. The destination is
/// registered by the desktop only after this operation returns successfully.
#[utoipa::path(
    post,
    path = "/api/workspace/clone",
    tag = "Git",
    summary = "Clone a Git repository into a project folder",
    description = "Accepts credential-free HTTPS or SSH clone URLs from GitHub, GitLab, Azure DevOps, and custom public Git hosts. Configure HTTPS credentials or SSH keys on the active node. Local, private, loopback, and cloud-metadata host addresses are rejected.",
    request_body = CloneFolderBody,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn clone_project_folder(
    JsonBody(body): JsonBody<CloneFolderBody>,
) -> axum::response::Response {
    let url = body.url.trim().to_string();
    let source = match parse_git_clone_url(&url) {
        Ok(parsed) => parsed,
        Err(error) => return git_failure(StatusCode::BAD_REQUEST, error),
    };
    let name = body
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(&source.repository_name)
        .to_string();
    if let Err(error) = validate_folder_name(&name) {
        return git_failure(StatusCode::BAD_REQUEST, error);
    }

    let approved = match crate::server::resolve_guarded_host(&source.host, source.port).await {
        Ok(approved) => approved,
        Err(error) => return git_failure(StatusCode::BAD_GATEWAY, error),
    };
    let pinned_resolve = git_clone_pinned_resolve(&source, &approved);

    let Some(docs) = dirs::document_dir() else {
        return git_failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not resolve the Documents directory",
        );
    };
    let projects_root = docs.join("Ryu");
    if let Err(error) = std::fs::create_dir_all(&projects_root) {
        return git_failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to create the project folder: {error}"),
        );
    }
    let root_string = projects_root.to_string_lossy().into_owned();
    let projects_root = match canonical_remote_workspace(&root_string) {
        Ok(root) => root,
        Err(error) => return git_failure(StatusCode::FORBIDDEN, error),
    };
    let destination = projects_root.join(&name);
    if std::fs::symlink_metadata(&destination).is_ok() {
        return git_failure(
            StatusCode::CONFLICT,
            format!("A project folder named \"{name}\" already exists"),
        );
    }

    let clone_destination = destination.clone();
    let result = tokio::task::spawn_blocking(move || {
        clone_public_repository(&url, &clone_destination, pinned_resolve.as_deref())
    })
    .await;
    match result {
        Ok(Ok(())) => Json(json!({
            "success": true,
            "name": name,
            "path": destination.to_string_lossy(),
        }))
        .into_response(),
        Ok(Err(error)) => git_failure(StatusCode::CONFLICT, error),
        Err(error) => join_failure("clone_project_folder", error),
    }
}

pub(crate) async fn clone_project_folder_authorized(
    State(state): State<crate::server::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    JsonBody(body): JsonBody<CloneFolderBody>,
) -> axum::response::Response {
    if let Err(denied) = require_permission(&state, &caller, permissions::AGENT_EDIT).await {
        return denied;
    }
    clone_project_folder(JsonBody(body)).await
}

/// `POST /api/workspace/new-folder` `{ name }`
///
/// Create a fresh, empty project folder under `~/Documents/Ryu/<name>` and return
/// its absolute path so the desktop's "Start from scratch" flow can open it. This
/// is Core: it owns the local filesystem (the desktop's Tauri fs ACL is
/// intentionally narrow), so folder creation lives here rather than in the client.
/// `name` is validated to a single path segment — no separators, `..`, or control
/// characters — so it can never escape the Ryu projects root. Returns HTTP 409
/// when a folder of that name already exists (so the picker asks for another).
#[utoipa::path(
    post,
    path = "/api/workspace/new-folder",
    tag = "Git",
    summary = "{ name }",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn create_project_folder(
    JsonBody(body): JsonBody<NewFolderBody>,
) -> axum::response::Response {
    let name = body.name.trim().to_string();
    if let Err(msg) = validate_folder_name(&name) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response();
    }

    let Some(docs) = dirs::document_dir() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "could not resolve the Documents directory" })),
        )
            .into_response();
    };
    let target = docs.join("Ryu").join(&name);

    if target.exists() {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": format!("A folder named \"{name}\" already exists") })),
        )
            .into_response();
    }

    match std::fs::create_dir_all(&target) {
        Ok(()) => Json(json!({ "path": target.to_string_lossy() })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("failed to create folder: {e}") })),
        )
            .into_response(),
    }
}

/// Validate a project-folder name is a single, safe path segment.
pub(crate) fn validate_folder_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("A folder name is required".to_string());
    }
    if name.chars().count() > 120 {
        return Err("That name is too long".to_string());
    }
    if name == "." || name == ".." || name.contains("..") {
        return Err("That name is not allowed".to_string());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("A folder name cannot contain slashes".to_string());
    }
    if name.chars().any(char::is_control) {
        return Err("A folder name cannot contain control characters".to_string());
    }
    Ok(())
}

#[cfg(test)]
#[path = "project_folders_tests.rs"]
mod tests;
