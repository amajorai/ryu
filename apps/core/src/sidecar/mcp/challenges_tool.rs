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
//! server from that session, never from the arguments. The bearer is sent only
//! to the account backend: an explicit `RYU_CONTROL_PLANE_URL`, then
//! `RYU_SERVER_URL`, then the backend the last device sign-in succeeded against
//! (https only). With none of them the tools say so and make no request.
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

mod client;
mod input;
mod responses;

use client::*;
use input::*;
use responses::*;

#[cfg(test)]
mod tests;
