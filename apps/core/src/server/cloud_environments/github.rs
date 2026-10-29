//! Owner-scoped GitHub connection metadata. Only verified tokens are sealed;
//! API responses never contain token values or upstream error bodies.
use super::{
    error, load, owner, projection, update, ApiError, ResolvedAuthorization, ServerState, Snapshot,
    VaultEntry, STORE_LOCK,
};
use axum::{http::StatusCode, Extension, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schema(as=CloudGithubRepository)]
pub(super) struct Repository {
    full_name: String,
    private: bool,
}
#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as=CloudGithubConnection)]
pub(super) struct Connection {
    connected: bool,
    login: Option<String>,
    vault_key: Option<String>,
    repositories: Vec<Repository>,
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<Snapshot>,
}
#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
#[schema(as=CloudGithubConnectRequest)]
struct Connect {
    #[schema(write_only)]
    token: String,
    revision: u64,
}
fn disconnected() -> Connection {
    Connection {
        connected: false,
        login: None,
        vault_key: None,
        repositories: vec![],
        state: None,
    }
}
fn snapshot(identity: &str) -> Result<Snapshot, ApiError> {
    let _lock = STORE_LOCK.lock().map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "cloud_environment_store_unavailable",
            "The environment store is unavailable.",
        )
    })?;
    Ok(load()?.owners.remove(identity).unwrap_or_default())
}
async fn approve() -> Result<(), ApiError> {
    super::approve_network_policy(
        &ryu_sandbox::governed::GovernedWorkspaceSpec {
            egress: ryu_sandbox::governed::EgressPolicy::AllowedHosts(
                vec!["api.github.com".into()],
            ),
            credentials: vec![],
        },
        false,
    )
    .await
}
async fn api(client: &reqwest::Client, token: &str, path: &str) -> Result<Value, ApiError> {
    let invalid = || {
        error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "cloud_github_verification_failed",
            "GitHub token verification failed. Check access to your account and repositories.",
        )
    };
    let mut token = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| invalid())?;
    token.set_sensitive(true);
    let mut response = client
        .get(format!(
            "{}{path}",
            super::super::cloud_github_transport::base_url()
        ))
        .header(reqwest::header::AUTHORIZATION, token)
        .header(reqwest::header::USER_AGENT, "Ryu-cloud-environments")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|_| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "cloud_github_unavailable",
                "GitHub could not be reached.",
            )
        })?;
    if !response.status().is_success() {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| invalid())? {
        if bytes.len() + chunk.len() > 1_048_576 {
            return Err(invalid());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| invalid())
}
async fn verify(token: &str, vault_key: &str) -> Result<Connection, ApiError> {
    if token.is_empty() || token.len() > 65536 {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "cloud_github_invalid",
            "Enter a GitHub token.",
        ));
    }
    approve().await?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|_| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "cloud_github_unavailable",
                "GitHub transport is unavailable.",
            )
        })?;
    let user = api(&client, token, "/user").await?;
    let login = user["login"]
        .as_str()
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 100
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
        .ok_or_else(|| {
            error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "cloud_github_verification_failed",
                "GitHub returned invalid account metadata.",
            )
        })?
        .to_owned();
    if login.contains(token) {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "cloud_github_verification_failed",
            "GitHub returned invalid account metadata.",
        ));
    }
    let payload = api(&client, token, "/user/repos?per_page=100&sort=updated").await?;
    let entries = payload
        .as_array()
        .filter(|entries| entries.len() <= 100)
        .ok_or_else(|| {
            error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "cloud_github_verification_failed",
                "GitHub returned invalid repository metadata.",
            )
        })?;
    let mut repositories = Vec::new();
    let mut names = std::collections::BTreeSet::new();
    for entry in entries {
        let name = entry["full_name"]
            .as_str()
            .filter(|name| super::valid_repository(name))
            .ok_or_else(|| {
                error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "cloud_github_verification_failed",
                    "GitHub returned invalid repository metadata.",
                )
            })?;
        if name.contains(token) {
            return Err(error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "cloud_github_verification_failed",
                "GitHub returned invalid repository metadata.",
            ));
        }
        let private = entry["private"].as_bool().ok_or_else(|| {
            error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "cloud_github_verification_failed",
                "GitHub returned invalid repository metadata.",
            )
        })?;
        if names.insert(name) {
            repositories.push(Repository {
                full_name: name.to_owned(),
                private,
            });
        }
    }
    Ok(Connection {
        connected: true,
        login: Some(login),
        vault_key: Some(vault_key.into()),
        repositories,
        state: None,
    })
}
#[utoipa::path(get,path="/api/cloud-environments/github",operation_id="cloud_github_metadata",tag="Cloud environments",security(("bearerAuth"=[])),description="Read authenticated GitHub.com account and up to 100 repository names using this owner's sealed eligible GITHUB_TOKEN or GH_TOKEN. The token's domain scope must explicitly contain api.github.com. Gateway must approve that exact host before any fixed HTTPS request. Redirects are disabled. Token values and upstream error bodies are never returned.",responses((status=200,body=Connection),(status=403,description="Personal identity or Gateway host grant denied"),(status=422,description="GitHub rejected saved credentials or metadata"),(status=503,description="Store, vault or transport unavailable")))]
async fn metadata(
    Extension(auth): Extension<ResolvedAuthorization>,
) -> Result<Json<Connection>, ApiError> {
    let identity = owner(&auth)?;
    let state = snapshot(&identity)?;
    let entry = ["GITHUB_TOKEN", "GH_TOKEN"].into_iter().find_map(|key| {
        state.vault.iter().find(|entry| {
            entry.key == key
                && entry
                    .domains
                    .iter()
                    .any(|domain| domain == "api.github.com")
                && entry.value.is_some()
        })
    });
    let Some(entry) = entry else {
        return Ok(Json(disconnected()));
    };
    crate::crypto_host::install();
    let cipher = ryu_crypto::global_cipher().map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "cloud_environment_vault_unavailable",
            "The encrypted vault is unavailable.",
        )
    })?;
    let token = cipher.open(entry.value.as_ref().unwrap()).map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "cloud_environment_vault_unavailable",
            "The saved GitHub credential could not be opened.",
        )
    })?;
    Ok(Json(verify(&token, &entry.key).await?))
}
#[utoipa::path(post,path="/api/cloud-environments/github",operation_id="connect_cloud_github",tag="Cloud environments",security(("bearerAuth"=[])),request_body=Connect,description="Verify a GitHub.com token against fixed authenticated-account and repository endpoints before sealing it as GITHUB_TOKEN in the caller's personal vault. The encrypted network secret covers github.com and api.github.com; an existing GITHUB_TOKEN entry preserves its stable ID. Requires the current snapshot revision and exact api.github.com Gateway approval. Invalid credentials, redirects, oversized responses, or invalid repository metadata do not persist anything. Returns sanitized account/repository metadata and the updated redacted snapshot. Tasks must explicitly request the returned vaultKey.",responses((status=200,body=Connection),(status=400,description="Invalid request or protected credential alias"),(status=403,description="Personal identity or Gateway host grant denied"),(status=409,description="Revision conflict"),(status=422,description="GitHub rejected credentials or metadata"),(status=503,description="Store, vault or transport unavailable")))]
async fn connect(
    Extension(auth): Extension<ResolvedAuthorization>,
    Json(request): Json<Connect>,
) -> Result<Json<Connection>, ApiError> {
    let identity = owner(&auth)?;
    let mut state = snapshot(&identity)?;
    if request.revision != state.revision {
        return Err(error(
            StatusCode::CONFLICT,
            "cloud_environment_revision_conflict",
            "Settings changed. Reload before connecting GitHub.",
        ));
    }
    let token = request.token.trim();
    let mut connection = verify(token, "GITHUB_TOKEN").await?;
    state = projection(state);
    if let Some(entry) = state
        .vault
        .iter_mut()
        .find(|entry| entry.key == "GITHUB_TOKEN")
    {
        entry.kind = "networkSecret".into();
        entry.domains = vec!["github.com".into(), "api.github.com".into()];
        entry.value = Some(token.into());
    } else {
        state.vault.push(VaultEntry {
            id: uuid::Uuid::new_v4().to_string(),
            key: "GITHUB_TOKEN".into(),
            kind: "networkSecret".into(),
            environment_ids: vec![],
            domains: vec!["github.com".into(), "api.github.com".into()],
            has_value: false,
            value: Some(token.into()),
        });
    }
    // Vault-only change: the environments are the stored ones, so this save can
    // never newly select the box backend and needs no rollout check.
    connection.state = Some(update(&identity, state, true)?);
    Ok(Json(connection))
}
pub(super) fn routes() -> Router<ServerState> {
    Router::new().route(
        "/api/cloud-environments/github",
        axum::routing::get(metadata).post(connect),
    )
}
#[derive(utoipa::OpenApi)]
#[openapi(
    paths(metadata, connect),
    components(schemas(Connection, Repository, Connect))
)]
struct GithubApiDoc;
pub(super) fn openapi() -> utoipa::openapi::OpenApi {
    use utoipa::OpenApi;
    GithubApiDoc::openapi()
}
