//! Built-in Ryu Challenges tools (`challenges.list`, `challenges.get`,
//! `challenges.submit`).
//!
//! The control plane's `/api/challenges` router owns the challenge catalogue,
//! entries, and the `ryu_agent` submission channel. A challenge on that channel
//! accepts a submission only from a session issued through a Ryu agent client's
//! device flow — exactly the session Core holds after the user signs in from Ryu
//! Desktop or the CLI. This module is the agent-facing projection over those
//! routes, so "agent-only" challenges work end to end from a chat.
//!
//! Credentials stay inside Core: the bearer comes from the sealed account store
//! ([`crate::auth::load_token`]) per call and is never placed in tool arguments,
//! results, or logs. Account identity and display name are always derived by the
//! server from that session, never from the arguments.
//!
//! `challenges.submit` writes under the user's identity, so it is never
//! read-only. The registry's approval gate
//! ([`crate::approvals::policy::should_require_approval_local`]) queues every
//! submit call for the user's confirmation before this module is reached; the
//! module itself performs no confirmation of its own and must not be called
//! around that gate.

use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::{json, Map, Value};

use super::RegistryTool;

/// Reserved registry server for Ryu Challenges.
pub const SERVER_NAME: &str = "challenges";

/// List open (live or upcoming) published challenges.
pub const LIST_TOOL_ID: &str = "challenges.list";

/// Read one challenge's brief, rules, prizes, and the caller's entry status.
pub const GET_TOOL_ID: &str = "challenges.get";

/// Join (if needed) and submit or update the caller's project entry.
pub const SUBMIT_TOOL_ID: &str = "challenges.submit";

const MAX_SLUG_CHARS: usize = 80;
const MIN_PROJECT_NAME_CHARS: usize = 2;
const MAX_PROJECT_NAME_CHARS: usize = 120;
const MAX_PROJECT_URL_CHARS: usize = 500;
const MIN_PITCH_CHARS: usize = 20;
const MAX_PITCH_CHARS: usize = 3000;
const MAX_TEAM_NAME_CHARS: usize = 100;
const MAX_ERROR_MESSAGE_CHARS: usize = 500;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

const SIGN_IN_MESSAGE: &str =
    "You are not signed in to Ryu. Sign in to Ryu from Ryu Desktop or the CLI, then ask again.";

fn list_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "status": {
                "type": "string",
                "enum": ["open", "live", "upcoming"],
                "description": "Which challenges to list. `open` (default) returns live and upcoming challenges."
            },
            "kind": {
                "type": "string",
                "enum": ["challenge", "hackathon", "event"],
                "description": "Optional kind filter."
            }
        },
        "additionalProperties": false
    })
}

fn slug_property() -> Value {
    json!({
        "type": "string",
        "description": "Challenge slug, as returned by challenges.list.",
        "minLength": 1,
        "maxLength": MAX_SLUG_CHARS,
        "pattern": "^[a-z0-9][a-z0-9-]*$"
    })
}

fn get_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "slug": slug_property() },
        "required": ["slug"],
        "additionalProperties": false
    })
}

fn submit_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "slug": slug_property(),
            "projectName": {
                "type": "string",
                "description": "Project name shown to reviewers.",
                "minLength": MIN_PROJECT_NAME_CHARS,
                "maxLength": MAX_PROJECT_NAME_CHARS
            },
            "projectUrl": {
                "type": "string",
                "description": "Public http(s) link to the project (repository, demo, or page).",
                "minLength": 1,
                "maxLength": MAX_PROJECT_URL_CHARS,
                "format": "uri"
            },
            "pitch": {
                "type": "string",
                "description": "What the project does and why it fits the brief.",
                "minLength": MIN_PITCH_CHARS,
                "maxLength": MAX_PITCH_CHARS
            },
            "allowPublicDisplay": {
                "type": "boolean",
                "description": "Whether the user agreed to show their name and project link publicly if they win. Ask the user; never assume."
            },
            "teamName": {
                "type": "string",
                "description": "Optional team name.",
                "maxLength": MAX_TEAM_NAME_CHARS
            }
        },
        "required": ["slug", "projectName", "projectUrl", "pitch", "allowPublicDisplay"],
        "additionalProperties": false
    })
}

fn read_only_annotations() -> Value {
    json!({
        "readOnlyHint": true,
        "destructiveHint": false,
        "openWorldHint": false
    })
}

fn submit_annotations() -> Value {
    json!({
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
    })
}

/// The Challenges tools exposed through the unified catalog.
pub fn tools() -> Vec<RegistryTool> {
    vec![
        RegistryTool {
            id: LIST_TOOL_ID.to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "list".to_owned(),
            description: Some(
                "List open Ryu Challenges (live and upcoming) with slug, title, dates, and \
                 submission channel. `agentOnly: true` means the challenge accepts submissions \
                 only from the user's Ryu agent via challenges.submit."
                    .to_owned(),
            ),
            input_schema: Some(list_schema()),
            annotations: Some(read_only_annotations()),
            ..Default::default()
        },
        RegistryTool {
            id: GET_TOOL_ID.to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "get".to_owned(),
            description: Some(
                "Read one Ryu Challenge by slug: brief, rules, judging criteria, prizes, dates, \
                 and — when the user is signed in to Ryu — the user's own entry status."
                    .to_owned(),
            ),
            input_schema: Some(get_schema()),
            annotations: Some(read_only_annotations()),
            ..Default::default()
        },
        RegistryTool {
            id: SUBMIT_TOOL_ID.to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "submit".to_owned(),
            description: Some(
                "Submit (or update) the user's project to a live Ryu Challenge as the signed-in \
                 user, joining the challenge first if needed. Confirm the project name, link, \
                 pitch, and public-display choice with the user before calling; the call always \
                 waits for the user's approval."
                    .to_owned(),
            ),
            input_schema: Some(submit_schema()),
            annotations: Some(submit_annotations()),
            ..Default::default()
        },
    ]
}

/// Dispatch a `challenges` tool call against the configured control plane with
/// the signed-in account's session.
pub async fn dispatch(tool: &str, arguments: Value) -> Result<Value> {
    let api = ChallengesApi::from_environment()?;
    dispatch_with(&api, tool, arguments).await
}

async fn dispatch_with(api: &ChallengesApi, tool: &str, arguments: Value) -> Result<Value> {
    match tool {
        "list" => {
            let input = ListInput::parse(&arguments)?;
            api.list(&input).await
        }
        "get" => {
            let object = object_arguments(&arguments)?;
            reject_unknown_keys(object, &["slug"])?;
            let slug = required_slug(object)?;
            api.get(&slug).await
        }
        "submit" => {
            let input = SubmitInput::parse(&arguments)?;
            api.submit(&input).await
        }
        other => Err(anyhow!("unknown challenges tool '{other}'")),
    }
}

// ── Input validation ────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
struct ListInput {
    status: ListStatus,
    kind: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ListStatus {
    Open,
    Live,
    Upcoming,
}

impl ListInput {
    fn parse(arguments: &Value) -> Result<Self> {
        let object = object_arguments(arguments)?;
        reject_unknown_keys(object, &["status", "kind"])?;
        let status = match optional_str(object, "status")? {
            None | Some("open") => ListStatus::Open,
            Some("live") => ListStatus::Live,
            Some("upcoming") => ListStatus::Upcoming,
            Some(other) => {
                return Err(anyhow!(
                    "challenges.list 'status' must be open, live, or upcoming (got '{other}')"
                ))
            }
        };
        let kind = match optional_str(object, "kind")? {
            None => None,
            Some(kind @ ("challenge" | "hackathon" | "event")) => Some(kind.to_owned()),
            Some(other) => {
                return Err(anyhow!(
                    "challenges.list 'kind' must be challenge, hackathon, or event (got '{other}')"
                ))
            }
        };
        Ok(Self { status, kind })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SubmitInput {
    slug: String,
    project_name: String,
    project_url: String,
    pitch: String,
    allow_public_display: bool,
    team_name: Option<String>,
}

impl SubmitInput {
    fn parse(arguments: &Value) -> Result<Self> {
        let object = object_arguments(arguments)?;
        reject_unknown_keys(
            object,
            &[
                "slug",
                "projectName",
                "projectUrl",
                "pitch",
                "allowPublicDisplay",
                "teamName",
            ],
        )?;
        let slug = required_slug(object)?;
        let project_name = bounded_text(
            object,
            "projectName",
            MIN_PROJECT_NAME_CHARS,
            MAX_PROJECT_NAME_CHARS,
        )?;
        let project_url = bounded_text(object, "projectUrl", 1, MAX_PROJECT_URL_CHARS)?;
        validate_http_url(&project_url)?;
        let pitch = bounded_text(object, "pitch", MIN_PITCH_CHARS, MAX_PITCH_CHARS)?;
        let allow_public_display = object
            .get("allowPublicDisplay")
            .and_then(Value::as_bool)
            .ok_or_else(|| anyhow!("challenges.submit requires a boolean 'allowPublicDisplay'"))?;
        let team_name = match optional_str(object, "teamName")? {
            None => None,
            Some(raw) => {
                let trimmed = raw.trim();
                if trimmed.chars().count() > MAX_TEAM_NAME_CHARS {
                    return Err(anyhow!(
                        "challenges.submit 'teamName' must be at most {MAX_TEAM_NAME_CHARS} characters"
                    ));
                }
                (!trimmed.is_empty()).then(|| trimmed.to_owned())
            }
        };
        Ok(Self {
            slug,
            project_name,
            project_url,
            pitch,
            allow_public_display,
            team_name,
        })
    }

    /// The exact `PUT /:slug/entry` body (the server's strict submission schema).
    fn entry_body(&self) -> Value {
        let mut body = json!({
            "projectName": self.project_name,
            "projectUrl": self.project_url,
            "pitch": self.pitch,
            "allowPublicDisplay": self.allow_public_display,
        });
        if let Some(team) = &self.team_name {
            body["teamName"] = Value::String(team.clone());
        }
        body
    }
}

fn object_arguments(arguments: &Value) -> Result<&Map<String, Value>> {
    arguments
        .as_object()
        .ok_or_else(|| anyhow!("challenges tool arguments must be a JSON object"))
}

fn reject_unknown_keys(object: &Map<String, Value>, allowed: &[&str]) -> Result<()> {
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(anyhow!("unknown challenges tool argument '{key}'"));
    }
    Ok(())
}

fn optional_str<'a>(object: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_str()
            .map(Some)
            .ok_or_else(|| anyhow!("challenges tool argument '{key}' must be a string")),
    }
}

fn required_slug(object: &Map<String, Value>) -> Result<String> {
    let slug = object
        .get("slug")
        .and_then(Value::as_str)
        .map(str::trim)
        .ok_or_else(|| anyhow!("a string 'slug' is required"))?;
    let valid = !slug.is_empty()
        && slug.len() <= MAX_SLUG_CHARS
        && slug
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !slug.starts_with('-');
    if !valid {
        return Err(anyhow!(
            "'slug' must be a challenge slug from challenges.list (lowercase letters, digits, and hyphens)"
        ));
    }
    Ok(slug.to_owned())
}

fn bounded_text(object: &Map<String, Value>, key: &str, min: usize, max: usize) -> Result<String> {
    let value = object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("challenges.submit requires a string '{key}'"))?
        .trim();
    let length = value.chars().count();
    if length < min || length > max {
        return Err(anyhow!(
            "challenges.submit '{key}' must be {min}–{max} characters (got {length})"
        ));
    }
    Ok(value.to_owned())
}

fn validate_http_url(raw: &str) -> Result<()> {
    let parsed = url::Url::parse(raw)
        .map_err(|_| anyhow!("challenges.submit 'projectUrl' must be a valid http(s) URL"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(anyhow!(
            "challenges.submit 'projectUrl' must use http or https (got '{}')",
            parsed.scheme()
        ));
    }
    Ok(())
}

// ── Control-plane client ────────────────────────────────────────────────────

/// Base URL of the control plane that serves `/api/challenges`, following the
/// precedence Core uses for the same server elsewhere: an explicit
/// `RYU_CONTROL_PLANE_URL`, then `RYU_SERVER_URL`, then the enrolled/default
/// control plane.
pub(crate) fn control_plane_base() -> String {
    let non_empty = |name: &str| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    if non_empty("RYU_CONTROL_PLANE_URL").is_some() {
        return crate::sidecar::control_plane::control_plane_url();
    }
    non_empty("RYU_SERVER_URL").unwrap_or_else(crate::sidecar::control_plane::control_plane_url)
}

/// `{base}/api/challenges`, without doubling an operator-supplied `/api` mount.
fn challenges_root(base: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    if base.ends_with("/api") {
        format!("{base}/challenges")
    } else {
        format!("{base}/api/challenges")
    }
}

struct ChallengesApi {
    root: String,
    token: Option<String>,
    http: reqwest::Client,
}

impl ChallengesApi {
    fn from_environment() -> Result<Self> {
        Self::new(&control_plane_base(), crate::auth::load_token())
    }

    fn new(base: &str, token: Option<String>) -> Result<Self> {
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

    fn require_token(&self) -> Result<&str> {
        self.token
            .as_deref()
            .ok_or_else(|| anyhow!(SIGN_IN_MESSAGE))
    }

    fn slug_url(&self, slug: &str, suffix: &str) -> String {
        format!("{}/{}{suffix}", self.root, urlencoding::encode(slug))
    }

    async fn send(
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

    async fn list(&self, input: &ListInput) -> Result<Value> {
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

    async fn get(&self, slug: &str) -> Result<Value> {
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

    async fn my_entry(&self, token: &str, slug: &str) -> Result<Option<Value>> {
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

    async fn submit(&self, input: &SubmitInput) -> Result<Value> {
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

/// Map a non-2xx Challenges response to the message the agent relays.
fn api_error(status: u16, body: &str, slug: Option<&str>) -> anyhow::Error {
    let message = server_message(body);
    match status {
        401 => anyhow!(SIGN_IN_MESSAGE),
        403 => anyhow!(message.unwrap_or_else(|| {
            "Ryu Challenges refused this request for the signed-in account.".to_owned()
        })),
        404 => match slug {
            Some(slug) => {
                anyhow!("Unknown challenge '{slug}'. Use challenges.list to see open challenges.")
            }
            None => anyhow!("Ryu Challenges is not available on this Ryu server."),
        },
        _ => match message {
            Some(message) => anyhow!("Ryu Challenges request failed ({status}): {message}"),
            None => anyhow!("Ryu Challenges request failed ({status})"),
        },
    }
}

/// The human-readable reason in an error body: the server's `{ "error": … }`
/// envelope, a `message` field, or Hono's plain-text exception body.
fn server_message(body: &str) -> Option<String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return None;
    }
    let message = match serde_json::from_str::<Value>(trimmed) {
        Ok(value) => value
            .get("error")
            .or_else(|| value.get("message"))
            .and_then(Value::as_str)
            .map(str::to_owned)?,
        Err(_) if trimmed.starts_with('<') => return None,
        Err(_) => trimmed.to_owned(),
    };
    let message: String = message.chars().take(MAX_ERROR_MESSAGE_CHARS).collect();
    (!message.trim().is_empty()).then_some(message)
}

fn pick(source: &Value, keys: &[&str]) -> Value {
    let mut out = Map::new();
    for key in keys {
        if let Some(value) = source.get(*key) {
            out.insert((*key).to_owned(), value.clone());
        }
    }
    Value::Object(out)
}

fn list_projection(challenge: &Value) -> Value {
    let mut row = pick(
        challenge,
        &[
            "slug",
            "title",
            "summary",
            "kind",
            "status",
            "startsAt",
            "endsAt",
            "submissionChannel",
            "prizeSummary",
        ],
    );
    row["agentOnly"] =
        json!(challenge.get("submissionChannel").and_then(Value::as_str) == Some("ryu_agent"));
    row
}

fn detail_projection(challenge: &Value) -> Value {
    let mut detail = pick(
        challenge,
        &[
            "slug",
            "title",
            "summary",
            "brief",
            "rules",
            "judgingCriteria",
            "prizeSummary",
            "kind",
            "format",
            "status",
            "startsAt",
            "endsAt",
            "timezone",
            "hostName",
            "submissionChannel",
            "participantCount",
            "submissionCount",
        ],
    );
    if let Some(tiers) = challenge.get("prizeTiers").and_then(Value::as_array) {
        detail["prizeTiers"] = Value::Array(tiers.iter().map(prize_tier_projection).collect());
    }
    detail["agentOnly"] =
        json!(challenge.get("submissionChannel").and_then(Value::as_str) == Some("ryu_agent"));
    detail
}

/// One prize tier as the agent may see it. A credit pool id is an internal
/// supplier slot name, so the raw `pool` field is never forwarded; a credits
/// tier is described by the user-facing `description` the API serializes
/// (for example "$50 in Ryu Frontier credits"), or by its amount alone when an
/// older API omits that description.
fn prize_tier_projection(tier: &Value) -> Value {
    let mut out = pick(
        tier,
        &[
            "place",
            "label",
            "kind",
            "points",
            "amountMicroUsd",
            "description",
        ],
    );
    let is_credits = tier.get("kind").and_then(Value::as_str) == Some("credits");
    let has_description = tier
        .get("description")
        .and_then(Value::as_str)
        .is_some_and(|text| !text.trim().is_empty());
    if is_credits && !has_description {
        let micro_usd = tier
            .get("amountMicroUsd")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        out["description"] = json!(format!("{} in Ryu credits", format_usd(micro_usd)));
    }
    out
}

fn format_usd(micro_usd: u64) -> String {
    let cents = (micro_usd + 5_000) / 10_000;
    let (dollars, rem) = (cents / 100, cents % 100);
    if rem == 0 {
        format!("${dollars}")
    } else {
        format!("${dollars}.{rem:02}")
    }
}

fn entry_projection(entry: &Value) -> Value {
    pick(
        entry,
        &[
            "status",
            "registeredAt",
            "submittedAt",
            "projectName",
            "projectUrl",
            "teamName",
            "allowPublicDisplay",
            "reviewNote",
            "awardPlace",
            "awardStatus",
            "prizeLabel",
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    use axum::{
        body::Bytes,
        extract::State,
        http::{HeaderMap, Method, StatusCode, Uri},
        response::IntoResponse,
        Router,
    };
    use tokio::net::TcpListener;

    fn valid_submit() -> Value {
        json!({
            "slug": "agent-build-week",
            "projectName": "Tide",
            "projectUrl": "https://github.com/example/tide",
            "pitch": "A local-first tide planner built entirely by my Ryu agent.",
            "allowPublicDisplay": true
        })
    }

    #[test]
    fn lists_three_tools_with_strict_bounded_schemas() {
        let tools = tools();
        let ids: Vec<&str> = tools.iter().map(|tool| tool.id.as_str()).collect();
        assert_eq!(ids, vec![LIST_TOOL_ID, GET_TOOL_ID, SUBMIT_TOOL_ID]);
        for tool in &tools {
            assert_eq!(tool.server, SERVER_NAME);
            let schema = tool.input_schema.as_ref().unwrap();
            assert_eq!(schema["type"], "object");
            assert_eq!(schema["additionalProperties"], false, "{}", tool.id);
            for (name, property) in schema["properties"].as_object().unwrap() {
                if property["type"] == "string" && property.get("enum").is_none() {
                    assert!(
                        property.get("maxLength").is_some(),
                        "{}.{name} needs a maxLength",
                        tool.id
                    );
                }
            }
        }
        let submit = tools[2].input_schema.as_ref().unwrap();
        assert_eq!(
            submit["required"],
            json!([
                "slug",
                "projectName",
                "projectUrl",
                "pitch",
                "allowPublicDisplay"
            ])
        );
        // The schema never lets the model choose the identity it submits as.
        for field in ["userId", "email", "displayName", "token"] {
            assert!(submit["properties"].get(field).is_none());
        }
    }

    #[test]
    fn reads_are_read_only_and_submit_is_a_non_destructive_write() {
        let tools = tools();
        for tool in &tools[..2] {
            assert_eq!(tool.annotations.as_ref().unwrap()["readOnlyHint"], true);
        }
        let submit = tools[2].annotations.as_ref().unwrap();
        assert_eq!(submit["readOnlyHint"], false);
        assert_eq!(submit["destructiveHint"], false);
        assert!(!crate::agent_execution::classify_tool_with_metadata(
            SUBMIT_TOOL_ID,
            Some(submit),
            None
        )
        .is_read_only());
    }

    #[test]
    fn submit_rejects_non_http_urls_and_bad_lengths() {
        for url in [
            "ftp://example.com/x",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,hi",
            "not a url",
            "mailto:me@example.com",
        ] {
            let mut args = valid_submit();
            args["projectUrl"] = json!(url);
            let error = SubmitInput::parse(&args).unwrap_err().to_string();
            assert!(error.contains("projectUrl"), "{url}: {error}");
        }
        let mut short_pitch = valid_submit();
        short_pitch["pitch"] = json!("too short");
        assert!(SubmitInput::parse(&short_pitch).is_err());
        let mut long_name = valid_submit();
        long_name["projectName"] = json!("x".repeat(MAX_PROJECT_NAME_CHARS + 1));
        assert!(SubmitInput::parse(&long_name).is_err());
        let mut extra = valid_submit();
        extra["userId"] = json!("someone-else");
        assert!(SubmitInput::parse(&extra).is_err());
        let mut missing = valid_submit();
        missing
            .as_object_mut()
            .unwrap()
            .remove("allowPublicDisplay");
        assert!(SubmitInput::parse(&missing).is_err());
        let mut bad_slug = valid_submit();
        bad_slug["slug"] = json!("../admin");
        assert!(SubmitInput::parse(&bad_slug).is_err());

        let parsed = SubmitInput::parse(&valid_submit()).unwrap();
        assert_eq!(parsed.project_url, "https://github.com/example/tide");
        assert!(parsed.team_name.is_none());
    }

    #[test]
    fn list_rejects_unknown_arguments() {
        assert!(ListInput::parse(&json!({ "limit": 5 })).is_err());
        assert!(ListInput::parse(&json!({ "status": "closed" })).is_err());
        assert_eq!(
            ListInput::parse(&json!({})).unwrap().status,
            ListStatus::Open
        );
    }

    #[test]
    fn detail_never_forwards_a_credit_pool_id() {
        let challenge = json!({
            "slug": "agent-build-week",
            "title": "Agent build week",
            "submissionChannel": "ryu_agent",
            "prizeTiers": [
                {"place":1,"label":"First place","kind":"credits","points":0,
                 "amountMicroUsd":50_000_000,"description":"$50 in Ryu Frontier credits",
                 "pool":"bedrock"},
                {"place":2,"label":"Second place","kind":"credits","points":0,
                 "amountMicroUsd":12_500_000,"description":null,"pool":"anthropic-credits"},
                {"place":3,"label":"Third place","kind":"merch","points":0,
                 "amountMicroUsd":null,"description":"Ryu hoodie","pool":null}
            ]
        });
        let detail = detail_projection(&challenge);
        let text = detail.to_string();
        for slot in ["bedrock", "anthropic-credits", "\"pool\""] {
            assert!(!text.contains(slot), "leaked {slot}: {text}");
        }
        let tiers = detail["prizeTiers"].as_array().unwrap();
        assert_eq!(tiers[0]["description"], "$50 in Ryu Frontier credits");
        assert_eq!(tiers[1]["description"], "$12.50 in Ryu credits");
        assert_eq!(tiers[2]["description"], "Ryu hoodie");
        assert_eq!(tiers[0]["place"], 1);
        assert_eq!(detail["agentOnly"], true);
    }

    #[test]
    fn challenges_root_does_not_double_the_api_mount() {
        assert_eq!(
            challenges_root("https://ryu.example/"),
            "https://ryu.example/api/challenges"
        );
        assert_eq!(
            challenges_root("https://ryu.example/api"),
            "https://ryu.example/api/challenges"
        );
    }

    #[test]
    fn error_mapping_surfaces_server_reasons() {
        let forbidden = api_error(
            403,
            r#"{"error":"This challenge accepts submissions only from your Ryu agent."}"#,
            Some("x"),
        );
        assert_eq!(
            forbidden.to_string(),
            "This challenge accepts submissions only from your Ryu agent."
        );
        assert_eq!(
            api_error(403, "plain text reason", Some("x")).to_string(),
            "plain text reason"
        );
        assert!(api_error(401, "", Some("x"))
            .to_string()
            .contains("Sign in to Ryu"));
        assert!(
            api_error(404, r#"{"error":"Challenge not found"}"#, Some("nope"))
                .to_string()
                .contains("Unknown challenge 'nope'")
        );
        assert!(api_error(
            409,
            r#"{"error":"Registration is closed for this event."}"#,
            None
        )
        .to_string()
        .contains("Registration is closed"));
    }

    #[tokio::test]
    async fn submit_without_a_session_asks_the_user_to_sign_in() {
        let api = ChallengesApi::new("http://127.0.0.1:9", None).unwrap();
        let error = dispatch_with(&api, "submit", valid_submit())
            .await
            .unwrap_err();
        assert!(error.to_string().contains("Sign in to Ryu"));
    }

    #[derive(Debug, Clone)]
    struct Recorded {
        method: Method,
        path: String,
        query: Option<String>,
        authorization: Option<String>,
        body: Value,
    }

    type Log = Arc<Mutex<Vec<Recorded>>>;

    async fn record(
        State((log, entry_status)): State<(Log, StatusCode)>,
        method: Method,
        uri: Uri,
        headers: HeaderMap,
        body: Bytes,
    ) -> axum::response::Response {
        log.lock().unwrap().push(Recorded {
            method: method.clone(),
            path: uri.path().to_owned(),
            query: uri.query().map(str::to_owned),
            authorization: headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned),
            body: serde_json::from_slice(&body).unwrap_or(Value::Null),
        });
        let path = uri.path();
        if path == "/api/challenges/missing" || path.starts_with("/api/challenges/missing/") {
            return (
                StatusCode::NOT_FOUND,
                axum::Json(json!({"error":"Challenge not found"})),
            )
                .into_response();
        }
        match (method.as_str(), path) {
            ("GET", "/api/challenges") => axum::Json(json!({
                "challenges": [
                    {"slug":"agent-build-week","title":"Agent build week","status":"live","endsAt":"2026-11-01T00:00:00.000Z","submissionChannel":"ryu_agent","brief":"long"},
                    {"slug":"old","title":"Old","status":"closed","submissionChannel":"any"}
                ],
                "total": 2
            }))
            .into_response(),
            ("GET", "/api/challenges/mine") => axum::Json(json!({
                "entries": [{"challenge":{"slug":"agent-build-week"},"entry":{"status":"registered","email":"private@example.com"}}]
            }))
            .into_response(),
            ("GET", "/api/challenges/agent-build-week") => axum::Json(json!({
                "challenge": {"slug":"agent-build-week","title":"Agent build week","brief":"Build it","rules":["Be kind"],"prizeSummary":"Credits","status":"live","submissionChannel":"ryu_agent"}
            }))
            .into_response(),
            ("POST", "/api/challenges/agent-build-week/join") => {
                (StatusCode::CREATED, axum::Json(json!({"entry":{"status":"registered"}})))
                    .into_response()
            }
            ("PUT", "/api/challenges/agent-build-week/entry") => (
                entry_status,
                axum::Json(if entry_status.is_success() {
                    json!({"entry":{"status":"submitted","projectName":"Tide","email":"private@example.com"}})
                } else {
                    json!({"error":"This challenge accepts submissions only from your Ryu agent. Ask your agent in Ryu Desktop, the CLI, or MCP to submit the project for you."})
                }),
            )
                .into_response(),
            _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
        }
    }

    async fn mock_server(entry_status: StatusCode) -> (String, Log, tokio::task::JoinHandle<()>) {
        let log: Log = Arc::default();
        let app = Router::new()
            .fallback(record)
            .with_state((Arc::clone(&log), entry_status));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}"), log, server)
    }

    #[tokio::test]
    async fn submit_joins_then_puts_the_entry_with_the_session_bearer() {
        let (base, log, server) = mock_server(StatusCode::OK).await;
        let api = ChallengesApi::new(&base, Some("session-token".into())).unwrap();
        let mut args = valid_submit();
        args["teamName"] = json!("  Tide crew  ");
        let result = dispatch_with(&api, "submit", args).await.unwrap();
        server.abort();

        assert_eq!(result["submitted"], true);
        assert_eq!(result["joinedNow"], true);
        assert_eq!(result["entry"]["status"], "submitted");
        assert!(
            result["entry"].get("email").is_none(),
            "private entry fields are not projected"
        );

        let calls = log.lock().unwrap().clone();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].method, Method::POST);
        assert_eq!(calls[0].path, "/api/challenges/agent-build-week/join");
        assert_eq!(
            calls[0].authorization.as_deref(),
            Some("Bearer session-token")
        );
        assert_eq!(calls[1].method, Method::PUT);
        assert_eq!(calls[1].path, "/api/challenges/agent-build-week/entry");
        assert_eq!(
            calls[1].authorization.as_deref(),
            Some("Bearer session-token")
        );
        assert_eq!(
            calls[1].body,
            json!({
                "projectName": "Tide",
                "projectUrl": "https://github.com/example/tide",
                "pitch": "A local-first tide planner built entirely by my Ryu agent.",
                "allowPublicDisplay": true,
                "teamName": "Tide crew"
            })
        );
    }

    #[tokio::test]
    async fn submit_surfaces_the_server_403_message() {
        let (base, _log, server) = mock_server(StatusCode::FORBIDDEN).await;
        let api = ChallengesApi::new(&base, Some("browser-session".into())).unwrap();
        let error = dispatch_with(&api, "submit", valid_submit())
            .await
            .unwrap_err();
        server.abort();
        assert!(error
            .to_string()
            .starts_with("This challenge accepts submissions only from your Ryu agent."));
    }

    #[tokio::test]
    async fn unknown_slug_is_reported_as_an_unknown_challenge() {
        let (base, _log, server) = mock_server(StatusCode::OK).await;
        let api = ChallengesApi::new(&base, Some("t".into())).unwrap();
        let error = dispatch_with(&api, "get", json!({ "slug": "missing" }))
            .await
            .unwrap_err();
        server.abort();
        assert!(error.to_string().contains("Unknown challenge 'missing'"));
    }

    #[tokio::test]
    async fn list_filters_to_open_challenges_without_sending_credentials() {
        let (base, log, server) = mock_server(StatusCode::OK).await;
        let api = ChallengesApi::new(&base, Some("t".into())).unwrap();
        let result = dispatch_with(&api, "list", json!({ "kind": "challenge" }))
            .await
            .unwrap();
        server.abort();
        assert_eq!(result["count"], 1);
        let row = &result["challenges"][0];
        assert_eq!(row["slug"], "agent-build-week");
        assert_eq!(row["agentOnly"], true);
        assert!(row.get("brief").is_none());
        let calls = log.lock().unwrap().clone();
        assert_eq!(calls[0].method, Method::GET);
        assert_eq!(calls[0].path, "/api/challenges");
        assert_eq!(calls[0].query.as_deref(), Some("limit=100&kind=challenge"));
        assert!(calls[0].authorization.is_none());
    }

    #[tokio::test]
    async fn get_includes_the_callers_entry_status() {
        let (base, log, server) = mock_server(StatusCode::OK).await;
        let api = ChallengesApi::new(&base, Some("t".into())).unwrap();
        let result = dispatch_with(&api, "get", json!({ "slug": "agent-build-week" }))
            .await
            .unwrap();
        server.abort();
        assert_eq!(result["challenge"]["brief"], "Build it");
        assert_eq!(result["challenge"]["agentOnly"], true);
        assert_eq!(result["signedIn"], true);
        assert_eq!(result["myEntry"]["status"], "registered");
        assert!(result["myEntry"].get("email").is_none());
        let calls = log.lock().unwrap().clone();
        assert_eq!(calls[1].path, "/api/challenges/mine");
        assert_eq!(calls[1].authorization.as_deref(), Some("Bearer t"));
    }

    #[tokio::test]
    async fn get_without_a_session_still_reads_the_public_challenge() {
        let (base, log, server) = mock_server(StatusCode::OK).await;
        let api = ChallengesApi::new(&base, None).unwrap();
        let result = dispatch_with(&api, "get", json!({ "slug": "agent-build-week" }))
            .await
            .unwrap();
        server.abort();
        assert_eq!(result["signedIn"], false);
        assert!(result["myEntry"].is_null());
        assert_eq!(log.lock().unwrap().len(), 1);
    }
}
