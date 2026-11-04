//! Channel command registry.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Channel command registry ─────────────────────────────────────────────────
//
// A channel bot is the same assistant reached over a different wire, so it must
// offer the same slash commands the desktop composer does — otherwise `/proof`
// works in the desktop and silently becomes a literal message in Telegram. The
// gateway's `channels::commands` module is the client of this endpoint; it
// normalises what we serve to the strictest platform menu rule and publishes it.
//
// Dispatch needs nothing new. Plugin commands are executed by the `pre_user_turn`
// hooks inside `run_reply_text`, which the channel path (`POST /api/channels/run`)
// already goes through; skills are selected by the model from the injected skill
// block. What was missing was never execution — it was DISCOVERY.

/// One row of the channel command registry, in the shape the gateway's
/// `channels::ChannelCommand` deserializes.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub(in crate::server) struct ChannelCommandEntry {
    /// Command name WITHOUT the leading slash. Left in Core's own casing/charset:
    /// the gateway coerces it to each platform's rule (Telegram is the strictest),
    /// and duplicating that coercion here would mean two places to keep in sync.
    pub(in crate::server) name: String,
    /// One-line description for the menu row.
    pub(in crate::server) description: String,
    /// `plugin` | `skill` — why the command is offered, so an operator reading the
    /// published menu can tell where to go to turn one off.
    pub(in crate::server) source: &'static str,
}

/// Build the command union Core publishes to channels.
///
/// Precedence is deliberate: plugin commands are emitted first and win a name
/// collision, because a plugin command has REAL dispatch (a `pre_user_turn` hook
/// that intercepts the text) while a skill command is only a hint the model may
/// act on. Shadowing the dispatching one with the advisory one would turn a
/// working command into a suggestion. The ordering is load-bearing a second time
/// downstream: the gateway de-duplicates AGAIN after coercing names to a platform
/// charset (`-`/`.`/space → `_`), so a skill `my-skill` and a plugin `/my_skill`
/// are distinct here but collide there — and its first-wins keeps whichever we
/// emitted first. Do not sort this output.
///
/// Ryu's own desktop "local" commands are deliberately absent — see
/// [`channel_commands`] for which were considered and why each was dropped.
///
/// Pure so the union rules are testable without a plugin store or a skills dir.
pub(in crate::server) fn build_channel_commands(
    plugin_commands: &[serde_json::Value],
    skills: &[ryu_skills::SkillRecord],
) -> Vec<ChannelCommandEntry> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<ChannelCommandEntry> = Vec::new();

    let mut push = |name: String, description: String, source: &'static str| {
        let name = name.trim().trim_start_matches('/').trim().to_string();
        if name.is_empty() {
            return;
        }
        if !seen.insert(name.clone()) {
            return;
        }
        out.push(ChannelCommandEntry {
            name,
            description: flatten_one_line(&description),
            source,
        });
    };

    // 1) Plugin contributions. The stored shape is `{ id, command: "/proof",
    //    description }`; `command` is the user-visible token, `id` is the plugin's
    //    internal handle and is NOT a command name, so an entry without `command`
    //    is skipped rather than guessed at.
    for value in plugin_commands {
        let Some(command) = value.get("command").and_then(|v| v.as_str()) else {
            continue;
        };
        let description = value
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        push(command.to_string(), description.to_string(), "plugin");
    }

    // 2) Installed skills, addressed by id (the id is the stable handle; the
    //    display `name` may contain spaces and capitals a command menu cannot
    //    express). A skill with no description falls back to its display name so
    //    the menu row is never blank.
    for skill in skills {
        let description = skill
            .description
            .clone()
            .unwrap_or_else(|| skill.name.clone());
        push(skill.id.clone(), description, "skill");
    }

    out
}

/// Collapse whitespace (including newlines) into single spaces so a multi-line
/// manifest/front-matter description renders as one menu row.
pub(in crate::server) fn flatten_one_line(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct BackgroundProcessQuery {
    pub(in crate::server) running_only: Option<bool>,
    pub(in crate::server) producer: Option<String>,
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct BackgroundProcessSyncBody {
    pub(in crate::server) process: crate::background_processes::BackgroundProcess,
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct BackgroundProcessIdBody {
    pub(in crate::server) process_id: String,
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct BackgroundProcessControlBody {
    #[serde(default)]
    pub(in crate::server) process_ids: Vec<String>,
}

#[utoipa::path(
    get,
    path = "/api/background/processes",
    tag = "Core",
    summary = "List background processes",
    params(
        ("running_only" = Option<bool>, Query, description = "Only processes that are still running"),
        ("producer" = Option<String>, Query, description = "Only processes from this producer")
    ),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_background_processes(
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Query(query): Query<BackgroundProcessQuery>,
) -> axum::response::Response {
    let owner = match crate::background_processes::owner_for_caller(caller.as_ref()) {
        Ok(owner) => owner,
        Err(error) => return json_error(StatusCode::FORBIDDEN, error),
    };
    let producer = query
        .producer
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    Json(json!({
        "processes": crate::background_processes::list(&owner, query.running_only.unwrap_or(true), producer),
    })).into_response()
}

pub(in crate::server) async fn sync_background_process(
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<BackgroundProcessSyncBody>,
) -> axum::response::Response {
    let owner = match crate::background_processes::owner_for_caller(caller.as_ref()) {
        Ok(owner) => owner,
        Err(error) => return json_error(StatusCode::FORBIDDEN, error),
    };
    match crate::background_processes::upsert(&owner, body.process) {
        Ok(process) => Json(json!({ "process": process })).into_response(),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error),
    }
}

pub(in crate::server) async fn release_background_process(
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<BackgroundProcessIdBody>,
) -> axum::response::Response {
    let owner = match crate::background_processes::owner_for_caller(caller.as_ref()) {
        Ok(owner) => owner,
        Err(error) => return json_error(StatusCode::FORBIDDEN, error),
    };
    let released = crate::background_processes::release(&owner, body.process_id.trim());
    Json(json!({ "ok": true, "released": released })).into_response()
}

pub(in crate::server) async fn control_background_processes(
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<BackgroundProcessControlBody>,
) -> axum::response::Response {
    let owner = match crate::background_processes::owner_for_caller(caller.as_ref()) {
        Ok(owner) => owner,
        Err(error) => return json_error(StatusCode::FORBIDDEN, error),
    };
    let process_ids = body
        .process_ids
        .into_iter()
        .map(|process_id| process_id.trim().to_string())
        .filter(|process_id| !process_id.is_empty())
        .take(512)
        .collect::<Vec<_>>();
    let stops = crate::background_processes::take_stop_requests(&owner, &process_ids)
        .into_iter()
        .map(|stop| json!({ "process_id": stop.process_id, "reason": stop.reason }))
        .collect::<Vec<_>>();
    Json(json!({ "stops": stops })).into_response()
}

#[utoipa::path(
    post,
    path = "/api/background/processes/{process_id}/stop",
    tag = "Core",
    summary = "Stop a background process",
    params(("process_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn stop_background_process(
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(process_id): Path<String>,
) -> axum::response::Response {
    let owner = match crate::background_processes::owner_for_caller(caller.as_ref()) {
        Ok(owner) => owner,
        Err(error) => return json_error(StatusCode::FORBIDDEN, error),
    };
    match crate::background_processes::request_stop(&owner, &process_id) {
        Ok(()) => Json(json!({
            "ok": true,
            "requested": true,
            "process_id": process_id,
        }))
        .into_response(),
        Err(error) => json_error(StatusCode::CONFLICT, error),
    }
}

/// `GET /api/channels/commands` — the slash commands a channel bot should publish.
///
/// The union of what the desktop composer offers, so the assistant reachable over
/// Telegram/Discord/Slack/WhatsApp/iMessage has the same vocabulary as the one in
/// the app:
///
/// - **plugin** commands, from the *enabled* plugins' `contributes.slash_commands`
///   (the same walk `GET /api/plugins/contributions` serves — a disabled plugin's
///   command is never published, or the bot would offer a command that does
///   nothing);
/// - **skill** commands, one per *enabled* installed skill. Disabled skills are
///   excluded for the same reason: they are not injected into the turn, so naming
///   one is a dead end.
///
/// Two things the desktop shows are deliberately NOT here:
///
/// - `/btw` — the desktop implements it entirely client-side (it calls the aside
///   endpoint and renders the answer in an overlay that never enters the chat).
///   Sent as literal text through `run_reply_text` it is just the word "btw", so
///   publishing it to a channel would advertise a feature the channel cannot run.
/// - `/goal` — not a Ryu built-in at all: it is contributed by the `goal` plugin
///   and therefore already arrives via the plugin source, correctly gated on that
///   plugin being enabled. Hardcoding it here would publish it even with the
///   plugin off — the exact failure the enabled filter exists to prevent.
///
/// Agent-advertised (ACP `available_commands_update`) commands are also absent:
/// they are per-agent and only known once a session is live, so there is nothing
/// server-side to enumerate. The kernel keeps an `agent` source for them anyway.
///
/// Auth: node-token only (`require_auth`), with no per-caller `VerifiedCaller`
/// check. That is the posture of both sources this endpoint unions
/// (`GET /api/plugins/contributions`, `GET /api/skills`), so the union is no more
/// open than its inputs. A coarse `enforce_permission` gate was considered and
/// rejected: it 403s a `None` caller on an org-bound node, and the only caller
/// here IS machine ingress with no user JWT — it would fail closed on exactly the
/// nodes that run bots. Unlike `channel_run` there is no conversation id and
/// nothing per-resource to scope to.
#[utoipa::path(
    get,
    path = "/api/channels/commands",
    tag = "Chat",
    summary = "List the slash commands a channel bot should publish",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn channel_commands(
    State(state): State<ServerState>,
) -> axum::response::Response {
    let enabled_records = match enabled_plugin_records(&state).await {
        Ok(records) => records,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let enabled_ids: std::collections::HashSet<String> = enabled_records.into_keys().collect();
    let manifests = state.app_manifests.read().await;
    // No surface filter: a channel bot is not one of the declared `Surface`s, and
    // an unknown surface means "do not filter" everywhere else in this file too.
    let mut plugin_commands = collect_plugin_slash_commands(&manifests, &enabled_ids, None);
    drop(manifests);
    // Imported user slash commands (Codex prompts) ride alongside the plugin set.
    plugin_commands.extend(read_user_slash_commands(&state.preferences).await);

    let skills = state.skills.enabled();
    let commands = build_channel_commands(&plugin_commands, &skills);
    Json(json!({ "commands": commands })).into_response()
}
