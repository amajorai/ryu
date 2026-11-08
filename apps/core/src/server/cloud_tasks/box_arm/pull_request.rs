//! The GitHub pull request a finish opens, and remembered finishes.

use super::*;

use super::finish::PullRequestPlan;

/// GitHub REST response size cap for the pull request call.
pub(super) const MAX_GITHUB_RESPONSE_BYTES: usize = 1_048_576;

pub(super) fn github_http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap_or_default()
    })
}

/// Open a pull request from Core (never from inside the Box) with the same
/// credential the push used, after Gateway approves `api.github.com`.
pub(super) async fn open_pull_request(
    token: &str,
    repository: &str,
    head: &str,
    base: &str,
    plan: &PullRequestPlan,
) -> std::result::Result<PullRequestRef, &'static str> {
    let approval = super::super::environments::approve_network_policy(
        &ryu_sandbox::governed::GovernedWorkspaceSpec {
            egress: ryu_sandbox::governed::EgressPolicy::AllowedHosts(
                vec!["api.github.com".into()],
            ),
            credentials: vec![],
        },
        false,
    )
    .await;
    if approval.is_err() {
        return Err("auth");
    }
    create_pull_request_at(
        github_http(),
        &crate::server::cloud_github_transport::base_url(),
        token,
        repository,
        head,
        base,
        plan,
    )
    .await
}

/// `POST {api_base}/repos/{repository}/pulls`. The API base is a parameter
/// only so tests can point it at a local fake; production passes the fixed
/// GitHub.com origin. Returns a stable error code and never the upstream body
/// or the token. The returned URL is built from `repository` and the number,
/// not taken from the response.
pub(in crate::server::cloud_tasks) async fn create_pull_request_at(
    client: &reqwest::Client,
    api_base: &str,
    token: &str,
    repository: &str,
    head: &str,
    base: &str,
    plan: &PullRequestPlan,
) -> std::result::Result<PullRequestRef, &'static str> {
    let mut authorization =
        reqwest::header::HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| "auth")?;
    authorization.set_sensitive(true);
    let response = client
        .post(format!(
            "{}/repos/{repository}/pulls",
            api_base.trim_end_matches('/')
        ))
        .header(reqwest::header::AUTHORIZATION, authorization)
        .header(reqwest::header::USER_AGENT, "Ryu-cloud-tasks")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(&json!({
            "title": plan.title,
            "head": head,
            "base": base,
            "body": plan.body,
            "draft": plan.draft,
        }))
        .send()
        .await
        .map_err(|_| "network")?;
    let status = response.status();
    let body = read_capped(response).await;
    pull_request_outcome(status.as_u16(), body.as_deref(), repository)
}

pub(super) async fn read_capped(mut response: reqwest::Response) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > MAX_GITHUB_RESPONSE_BYTES {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    Some(bytes)
}

/// Map a GitHub create-pull-request response to a ref or a stable code.
pub(in crate::server::cloud_tasks) fn pull_request_outcome(
    status: u16,
    body: Option<&[u8]>,
    repository: &str,
) -> std::result::Result<PullRequestRef, &'static str> {
    let parsed = body.and_then(|bytes| serde_json::from_slice::<Value>(bytes).ok());
    match status {
        200 | 201 => {
            let number = parsed
                .as_ref()
                .and_then(|value| value["number"].as_u64())
                .filter(|number| *number > 0)
                .ok_or("unknown")?;
            Ok(PullRequestRef {
                url: format!("https://github.com/{repository}/pull/{number}"),
                number,
            })
        }
        401 | 403 | 404 => Err("auth"),
        422 => {
            let already_exists = parsed.as_ref().is_some_and(|value| {
                let mentions = |text: &str| text.to_ascii_lowercase().contains("already exists");
                value["message"].as_str().is_some_and(mentions)
                    || value["errors"].as_array().is_some_and(|errors| {
                        errors
                            .iter()
                            .any(|error| error["message"].as_str().is_some_and(mentions))
                    })
            });
            Err(if already_exists {
                "already_exists"
            } else {
                "validation"
            })
        }
        _ => Err("unknown"),
    }
}

/// The default pull request title: the commit message's first non-empty
/// line, at most 256 characters.
pub(in crate::server::cloud_tasks) fn default_pull_request_title(commit_message: &str) -> String {
    commit_message
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Changes from a Ryu cloud task")
        .chars()
        .take(256)
        .collect()
}

/// Finish summaries outlive a destroyed task so status can still report them.
pub(super) fn finished() -> &'static Mutex<HashMap<(String, String), FinishSummary>> {
    static FINISHED: OnceLock<Mutex<HashMap<(String, String), FinishSummary>>> = OnceLock::new();
    FINISHED.get_or_init(|| Mutex::new(HashMap::new()))
}
pub(in crate::server::cloud_tasks) fn remember_finish(
    owner: &str,
    conversation_id: &str,
    summary: &FinishSummary,
) {
    if let Ok(mut map) = finished().lock() {
        if map.len() >= 10_000 {
            map.clear();
        }
        map.insert(
            (owner.to_owned(), conversation_id.to_owned()),
            summary.clone(),
        );
    }
}
pub(in crate::server::cloud_tasks) fn remembered_finish(
    owner: &str,
    conversation_id: &str,
) -> Option<FinishSummary> {
    finished()
        .lock()
        .ok()?
        .get(&(owner.to_owned(), conversation_id.to_owned()))
        .cloned()
}
