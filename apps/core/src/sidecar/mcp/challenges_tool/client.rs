//! The control-plane client behind the three tools.

use super::*;
use crate::server::sync::backend::{account_api_base, BackendError};

// ── Control-plane client ────────────────────────────────────────────────────

/// `{base}/api/challenges`, without doubling an operator-supplied `/api` mount.
pub(super) fn challenges_root(base: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    if base.ends_with("/api") {
        format!("{base}/challenges")
    } else {
        format!("{base}/api/challenges")
    }
}

pub(super) struct ChallengesApi {
    pub(super) root: String,
    pub(super) token: Option<String>,
    pub(super) http: reqwest::Client,
}

impl ChallengesApi {
    /// The client for this process. The control plane is the account backend:
    /// an explicit `RYU_CONTROL_PLANE_URL`, then `RYU_SERVER_URL`, then the
    /// backend the last device sign-in succeeded against (https only). There
    /// is no default address, because these calls carry the account's bearer.
    pub(super) fn from_environment() -> Result<Self> {
        Self::from_sources(account_api_base(), crate::auth::load_token())
    }

    /// [`Self::from_environment`] with its inputs passed in. Without a usable
    /// account backend no client is built, so no request can be made.
    pub(super) fn from_sources(
        base: Result<String, BackendError>,
        token: Option<String>,
    ) -> Result<Self> {
        let base = base.map_err(|error| anyhow!("Ryu Challenges is not available: {error}"))?;
        Self::new(&base, token)
    }

    pub(super) fn new(base: &str, token: Option<String>) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|error| anyhow!("could not build the Challenges HTTP client: {error}"))?;
        Ok(Self {
            root: challenges_root(base),
            token: token.filter(|token| !token.trim().is_empty()),
            http,
        })
    }

    pub(super) fn require_token(&self) -> Result<&str> {
        self.token
            .as_deref()
            .ok_or_else(|| anyhow!(SIGN_IN_MESSAGE))
    }

    pub(super) fn slug_url(&self, slug: &str, suffix: &str) -> String {
        format!("{}/{}{suffix}", self.root, urlencoding::encode(slug))
    }

    pub(super) async fn send(
        &self,
        request: reqwest::RequestBuilder,
        slug: Option<&str>,
    ) -> Result<(reqwest::StatusCode, Value)> {
        let response = request
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|error| anyhow!("could not reach Ryu Challenges: {error}"))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(api_error(status.as_u16(), &text, slug));
        }
        let body = serde_json::from_str(&text)
            .map_err(|_| anyhow!("Ryu Challenges returned an unreadable response ({status})"))?;
        Ok((status, body))
    }

    pub(super) async fn list(&self, input: &ListInput) -> Result<Value> {
        let mut query: Vec<(&str, &str)> = vec![("limit", "100")];
        match input.status {
            ListStatus::Open => {}
            ListStatus::Live => query.push(("status", "live")),
            ListStatus::Upcoming => query.push(("status", "upcoming")),
        }
        if let Some(kind) = input.kind.as_deref() {
            query.push(("kind", kind));
        }
        let (_, body) = self
            .send(self.http.get(&self.root).query(&query), None)
            .await?;
        let challenges: Vec<Value> = body
            .get("challenges")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter(|challenge| {
                let status = challenge.get("status").and_then(Value::as_str);
                matches!(status, Some("live" | "upcoming"))
            })
            .map(list_projection)
            .collect();
        Ok(json!({ "count": challenges.len(), "challenges": challenges }))
    }

    pub(super) async fn get(&self, slug: &str) -> Result<Value> {
        let (_, body) = self
            .send(self.http.get(self.slug_url(slug, "")), Some(slug))
            .await?;
        let challenge = body
            .get("challenge")
            .ok_or_else(|| anyhow!("Ryu Challenges returned no challenge for '{slug}'"))?;
        let mut result = json!({ "challenge": detail_projection(challenge) });
        match self.token.as_deref() {
            None => {
                result["signedIn"] = json!(false);
                result["myEntry"] = Value::Null;
            }
            Some(token) => match self.my_entry(token, slug).await {
                Ok(entry) => {
                    result["signedIn"] = json!(true);
                    result["myEntry"] = entry.map_or(Value::Null, |entry| entry_projection(&entry));
                }
                Err(error) => {
                    result["signedIn"] = json!(false);
                    result["myEntry"] = Value::Null;
                    result["myEntryError"] = json!(error.to_string());
                }
            },
        }
        Ok(result)
    }

    pub(super) async fn my_entry(&self, token: &str, slug: &str) -> Result<Option<Value>> {
        let (_, body) = self
            .send(
                self.http
                    .get(format!("{}/mine", self.root))
                    .bearer_auth(token),
                None,
            )
            .await?;
        Ok(body
            .get("entries")
            .and_then(Value::as_array)
            .and_then(|entries| {
                entries.iter().find(|row| {
                    row.pointer("/challenge/slug").and_then(Value::as_str) == Some(slug)
                })
            })
            .and_then(|row| row.get("entry").cloned()))
    }

    pub(super) async fn submit(&self, input: &SubmitInput) -> Result<Value> {
        let token = self.require_token()?;
        // Registration is idempotent server-side (201 new, 200 existing).
        let (join_status, _) = self
            .send(
                self.http
                    .post(self.slug_url(&input.slug, "/join"))
                    .bearer_auth(token),
                Some(&input.slug),
            )
            .await?;
        let (_, body) = self
            .send(
                self.http
                    .put(self.slug_url(&input.slug, "/entry"))
                    .bearer_auth(token)
                    .json(&input.entry_body()),
                Some(&input.slug),
            )
            .await?;
        let entry = body.get("entry").map_or(Value::Null, entry_projection);
        Ok(json!({
            "submitted": true,
            "slug": input.slug,
            "joinedNow": join_status == reqwest::StatusCode::CREATED,
            "entry": entry,
        }))
    }
}
