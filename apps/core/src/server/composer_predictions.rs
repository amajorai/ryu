//! Composer predictions: predict the user's *next message* in their own voice.
//!
//! Sibling of [`super::chat_suggestions`]. Where suggestions propose a few
//! generic follow-up chips, a prediction is a single draft of what this user
//! would most plausibly type next, matched to how they write (length, tone,
//! casing, language) from their own earlier turns in the thread. The desktop
//! renders it as ghost text in the empty composer; Tab moves it into the draft
//! for editing. Nothing is ever sent automatically.
//!
//! The model may abstain (`NONE`) when the next step is unclear, so a
//! prediction does not appear after every reply. It reads only this
//! conversation's recent turns — no memories, connected apps, or other threads.
//!
//! Model selection mirrors suggestions: the `composer-predictions-model`
//! preference (a cheap/fast side model through the Gateway, tagged
//! background) → the node-wide default selection → the resident local engine
//! called directly so the transcript stays on the machine.
//!
//! Endpoint: `POST /api/chat/prediction` `{ conversation_id }` →
//! `{ prediction: "..." | null }` (200; `null` on any failure so the UI simply
//! shows no ghost text). The prediction is derived from the conversation's
//! content, so a caller without read access to a known conversation gets the
//! same 403/404 as any other conversation read.

use axum::{extract::State, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};

use super::chat_suggestions::{build_transcript, side_generate, strip_think, SideCompletion};
use super::conversations::StoredMessage;
use super::ServerState;

/// Preference: optional cheap model for predictions. Empty → default chain.
const PREDICTIONS_MODEL_PREF: &str = "composer-predictions-model";
/// Preference: master toggle. Defaults on while an enabled plugin contributes it.
const PREDICTIONS_ENABLED_PREF: &str = "composer-predictions-enabled";

/// Recent turns fed to the model — enough to learn the user's voice.
const RECENT_TURNS: usize = 12;
/// Largest transcript slice (chars) handed to the model.
const MAX_INPUT_CHARS: usize = 6000;
/// How many of the user's own earlier messages are quoted as style samples.
const STYLE_SAMPLES: usize = 6;
/// Longest single style sample (chars) — a pasted log isn't a voice sample.
const MAX_STYLE_SAMPLE_CHARS: usize = 300;
/// Longest prediction we surface; anything longer is dropped, not truncated,
/// so the user never accepts a half-sentence.
const MAX_PREDICTION_CHARS: usize = 500;
/// Sentinel the model emits to abstain.
const ABSTAIN: &str = "NONE";

const SYSTEM_PROMPT: &str = "You predict the exact next message the USER will type to their AI assistant. Study how this user writes — length, tone, casing, punctuation, language, slang, typos — and write their next message the way THEY would write it, not the way an assistant would. Base it on where the conversation is heading after the assistant's latest reply. Rules: output only the message text; no quotes, no \"User:\" prefix, no explanations; usually one short line; never answer on the assistant's behalf. If the next message is not reasonably predictable, output exactly NONE.";

#[derive(Deserialize)]
pub struct PredictionRequest {
    pub conversation_id: String,
}

#[derive(Serialize)]
pub struct PredictionResponse {
    pub prediction: Option<String>,
}

/// `POST /api/chat/prediction` — best-effort next-message prediction. Any
/// generation failure (plugin/toggle off, no model, abstain) returns `null`; a
/// caller without read access to the conversation is refused before generation.
#[utoipa::path(
    post,
    path = "/api/chat/prediction",
    tag = "Chat",
    summary = "best-effort prediction of the user's next message",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 403, description = "Caller cannot read this conversation"),
        (status = 404, description = "Conversation not found")
    )
)]
pub async fn chat_prediction(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(req): Json<PredictionRequest>,
) -> axum::response::Response {
    // Per-resource ACL: the prediction is generated from this conversation's turns,
    // so it is a read of the conversation by another name.
    if let Err(resp) =
        super::require_conversation_access_if_known(&state, &caller, &req.conversation_id, false)
            .await
    {
        return resp;
    }
    let prediction = generate_prediction(&state, &req.conversation_id).await;
    Json(PredictionResponse { prediction }).into_response()
}

async fn generate_prediction(state: &ServerState, conversation_id: &str) -> Option<String> {
    if !predictions_contributed(state).await {
        return None;
    }
    if let Ok(Some(v)) = state.preferences.get(PREDICTIONS_ENABLED_PREF).await {
        if v.trim() == "false" {
            return None;
        }
    }

    let messages = state
        .conversations
        .get_recent_messages(conversation_id, RECENT_TURNS)
        .await
        .ok()?;
    let user_content = build_prompt(&messages)?;

    let raw = side_generate(
        state,
        SideCompletion {
            purpose: crate::sidecar::gateway::SidePurpose::ComposerPrediction,
            model_pref: PREDICTIONS_MODEL_PREF,
            system_prompt: SYSTEM_PROMPT,
            user_content: &user_content,
            max_tokens: 160,
        },
    )
    .await?;
    parse_prediction(&raw, last_user_message(&messages))
}

/// Whether an enabled plugin contributes the predictions toggle. The feature is
/// offered through that settings contribution rather than a pinned app id, so
/// Core holds no app-specific constant for it (see `app_boundary_guard`).
async fn predictions_contributed(state: &ServerState) -> bool {
    let Ok(records) = state.app_store.list().await else {
        return false;
    };
    let manifests = state.app_manifests.read().await;
    enabled_plugin_contributes(&records, &manifests)
}

/// Whether any installed-and-enabled record's manifest contributes the toggle.
/// An installed but disabled plugin does not gate predictions on.
fn enabled_plugin_contributes(
    records: &[crate::plugins::PluginRecord],
    manifests: &[crate::plugin_manifest::PluginManifest],
) -> bool {
    let enabled: std::collections::HashSet<&str> = records
        .iter()
        .filter(|record| record.enabled)
        .map(|record| record.id.as_str())
        .collect();
    manifests
        .iter()
        .any(|manifest| enabled.contains(manifest.id.as_str()) && contributes_toggle(manifest))
}

/// Whether `manifest` contributes a settings field bound to [`PREDICTIONS_ENABLED_PREF`].
fn contributes_toggle(manifest: &crate::plugin_manifest::PluginManifest) -> bool {
    manifest.contributes.as_ref().is_some_and(|contributes| {
        contributes.settings_tabs.iter().any(|tab| {
            tab.get("fields")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|fields| {
                    fields.iter().any(|field| {
                        field.get("pref_key").and_then(serde_json::Value::as_str)
                            == Some(PREDICTIONS_ENABLED_PREF)
                    })
                })
        })
    })
}

/// The model's user turn: the user's own style samples, then the transcript.
/// `None` unless the thread has a user turn followed by an assistant reply —
/// a prediction always answers "what would they say to *that*".
fn build_prompt(messages: &[StoredMessage]) -> Option<String> {
    let last_conversational = messages.iter().rev().find(|m| {
        matches!(m.role.as_str(), "user" | "assistant") && !m.content.trim().is_empty()
    })?;
    if last_conversational.role != "assistant" {
        return None;
    }
    let samples: Vec<&str> = messages
        .iter()
        .filter(|m| m.role == "user")
        .map(|m| m.content.trim())
        .filter(|c| !c.is_empty() && c.chars().count() <= MAX_STYLE_SAMPLE_CHARS)
        .rev()
        .take(STYLE_SAMPLES)
        .collect();
    if samples.is_empty() {
        return None;
    }
    let transcript = build_transcript(messages, MAX_INPUT_CHARS);
    if transcript.trim().is_empty() {
        return None;
    }

    let mut out =
        String::from("How this user writes (their own earlier messages, newest first):\n");
    for sample in samples {
        out.push_str("- ");
        out.push_str(&sample.replace('\n', " "));
        out.push('\n');
    }
    out.push_str("\nConversation so far:\n\n");
    out.push_str(&transcript);
    out.push_str("\nThe user's next message:");
    Some(out)
}

fn last_user_message(messages: &[StoredMessage]) -> Option<&str> {
    messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.trim())
}

/// Clean a raw model reply into one prediction. Strips `<think>` blocks, a
/// leading speaker label and wrapping quotes; drops abstentions, overlong
/// replies, and a verbatim repeat of the user's previous message.
pub fn parse_prediction(raw: &str, previous_user_message: Option<&str>) -> Option<String> {
    let text = strip_think(raw)?;
    let mut s = text.trim();
    for label in ["User:", "USER:", "user:"] {
        if let Some(rest) = s.strip_prefix(label) {
            s = rest.trim_start();
        }
    }
    let s = s
        .trim_matches(|c| c == '"' || c == '\'' || c == '`' || c == '“' || c == '”')
        .trim();
    if s.is_empty()
        || s.trim_end_matches('.').eq_ignore_ascii_case(ABSTAIN)
        || s.chars().count() > MAX_PREDICTION_CHARS
    {
        return None;
    }
    if previous_user_message.is_some_and(|prev| prev.eq_ignore_ascii_case(s)) {
        return None;
    }
    Some(s.to_string())
}

#[cfg(test)]
mod tests {
    use super::{build_prompt, contributes_toggle, enabled_plugin_contributes, parse_prediction};
    use crate::plugin_manifest::PluginManifest;
    use crate::plugins::PluginStore;
    use crate::server::conversations::StoredMessage;

    fn message(role: &str, content: &str) -> StoredMessage {
        serde_json::from_value(serde_json::json!({
            "id": format!("{role}-{content}"),
            "role": role,
            "content": content,
            "created_at": 0,
        }))
        .expect("stored message fixture")
    }

    #[test]
    fn the_shipped_plugin_contributes_the_toggle_that_gates_predictions() {
        let shipped: PluginManifest = serde_json::from_str(include_str!(
            "../../../../generated/ryu-runtime/plugins-store/plugins/composer-predictions/manifest.json"
        ))
        .expect("shipped composer-predictions manifest");
        assert!(contributes_toggle(&shipped));

        let mut bare = shipped.clone();
        bare.contributes = None;
        assert!(!contributes_toggle(&bare));

        let other: PluginManifest = serde_json::from_str(include_str!(
            "../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/manifest.json"
        ))
        .expect("shipped output-styles manifest");
        assert!(!contributes_toggle(&other));
    }

    #[tokio::test]
    async fn plugin_lifecycle_gates_predictions() {
        let plugin_id = "@ryu/composer-predictions";
        let shipped: PluginManifest = serde_json::from_str(include_str!(
            "../../../../generated/ryu-runtime/plugins-store/plugins/composer-predictions/manifest.json"
        ))
        .expect("shipped composer-predictions manifest");
        assert_eq!(shipped.id, plugin_id);
        let manifests = [shipped];
        let store = PluginStore::open_in_memory().expect("in-memory plugin store");
        let records = store.list().await.expect("list plugins");
        assert!(!enabled_plugin_contributes(&records, &manifests));
        store
            .insert(plugin_id, "0.1.0")
            .await
            .expect("install disabled");
        let records = store.list().await.expect("list plugins");
        assert!(!enabled_plugin_contributes(&records, &manifests));
        store
            .set_enabled(plugin_id, &[])
            .await
            .expect("enable plugin");
        let records = store.list().await.expect("list plugins");
        assert!(enabled_plugin_contributes(&records, &manifests));
    }

    #[test]
    fn prompt_requires_an_assistant_reply_after_a_user_turn() {
        assert!(build_prompt(&[]).is_none());
        assert!(build_prompt(&[message("user", "fix the build")]).is_none());
        assert!(build_prompt(&[message("assistant", "hi, how can I help?")]).is_none());

        let prompt = build_prompt(&[
            message("user", "fix the build pls"),
            message("assistant", "Fixed the missing import."),
        ])
        .expect("prompt");
        assert!(prompt.contains("- fix the build pls"));
        assert!(prompt.contains("Assistant: Fixed the missing import."));
        assert!(prompt.ends_with("The user's next message:"));
    }

    #[test]
    fn style_samples_skip_pastes_and_keep_newest_first() {
        let paste = "x".repeat(400);
        let prompt = build_prompt(&[
            message("user", "first one"),
            message("assistant", "ok"),
            message("user", &paste),
            message("assistant", "ok"),
            message("user", "second one"),
            message("assistant", "done"),
        ])
        .expect("prompt");
        let samples = prompt
            .split("Conversation so far")
            .next()
            .unwrap_or_default();
        assert!(!samples.contains(&paste));
        assert!(samples.find("second one") < samples.find("first one"));
    }

    #[test]
    fn parses_and_cleans_a_prediction() {
        assert_eq!(
            parse_prediction("User: \"now add tests for it\"", None).as_deref(),
            Some("now add tests for it")
        );
        assert_eq!(
            parse_prediction("<think>they want tests</think>\nship it", None).as_deref(),
            Some("ship it")
        );
    }

    #[test]
    fn abstains_and_rejects_unusable_replies() {
        assert!(parse_prediction("NONE", None).is_none());
        assert!(parse_prediction("none.", None).is_none());
        assert!(parse_prediction("", None).is_none());
        assert!(parse_prediction("<think>cut off", None).is_none());
        assert!(parse_prediction(&"word ".repeat(120), None).is_none());
        assert!(parse_prediction("Fix the build", Some("fix the build")).is_none());
    }
}

/// Both side-model endpoints derive their output from a conversation's turns, so
/// both must apply the same per-conversation read gate as any other read.
#[cfg(test)]
mod access_tests {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::routing::post;
    use axum::{Extension, Router};
    use tower::ServiceExt;

    use crate::identity_verify::{OrgRole, VerifiedCaller};

    fn caller(user_id: &str) -> VerifiedCaller {
        VerifiedCaller {
            user_id: user_id.to_owned(),
            email: None,
            email_verified: false,
            org_id: Some("org1".to_owned()),
            role: OrgRole::Member,
            teams: Vec::new(),
        }
    }

    async fn status_for(
        state: crate::server::ServerState,
        who: &str,
        path: &str,
        conversation_id: &str,
    ) -> StatusCode {
        let router = Router::new()
            .route(
                "/api/chat/suggestions",
                post(crate::server::chat_suggestions::chat_suggestions),
            )
            .route("/api/chat/prediction", post(super::chat_prediction))
            .layer(Extension(Some(caller(who))))
            .with_state(state);
        let body = serde_json::json!({ "conversation_id": conversation_id }).to_string();
        router
            .oneshot(
                Request::post(path)
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap()
            .status()
    }

    #[tokio::test]
    async fn suggestions_and_prediction_deny_a_non_owner_and_admit_the_owner() {
        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::workflow_version_revision_tests::handler_state(directory.path());
        state
            .conversations
            .claim_tenancy("alice-chat", "alice", Some("org1"))
            .await
            .unwrap();

        for path in ["/api/chat/suggestions", "/api/chat/prediction"] {
            assert_eq!(
                status_for(state.clone(), "bob", path, "alice-chat").await,
                StatusCode::FORBIDDEN,
                "{path} must not derive output from another user's conversation"
            );
            assert_eq!(
                status_for(state.clone(), "alice", path, "alice-chat").await,
                StatusCode::OK,
                "{path} must still serve the conversation's owner"
            );
        }
    }
}
