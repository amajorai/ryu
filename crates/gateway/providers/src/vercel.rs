//! Vercel AI Gateway lane (managed guardrails spec 08.1, 08.4 and decision D7).
//!
//! Vercel AI Gateway is an aggregator with 0% markup on its credits. Its terms
//! ban proxying, it runs no content guardrails, and a failing bring-your-own
//! key falls back to the account's own Vercel credits. So this lane is built
//! but stays off:
//!
//! - **Off unless written permission is recorded.** The registry builds this
//!   adapter only when [`ResalePermission::parse`] accepts the configured
//!   decision, which must read `approved:<written reference>`. Absent,
//!   `unreviewed`, `forbidden`, an empty reference or anything else keeps the
//!   slot unregistered and records why.
//! - **Fleet custody only.** The Gateway registers the lane only on a hosted
//!   fleet replica, which strips every caller identifier and stamps Ryu's own
//!   subject. A self-hosted Gateway or a managed node forwards the caller's
//!   `safety_identifier` untouched, so a caller could otherwise send one that
//!   looks like a Ryu subject. Off the fleet the slot stays unregistered and
//!   the registry records [`LaneRefusal::NotFleet`].
//! - **Every attempt spends Ryu's credit.** A Vercel slot's credential origin
//!   is always [`VERCEL_CREDENTIAL_ORIGIN`] (`ryu_fallback`), whatever key a
//!   tenant sends, so every attempt is floor-bound (spec 00.3).
//! - **Identity on every request.** The fleet stamps Ryu's hashed subject in
//!   `safety_identifier` (the identity table in `apps/gateway/src/identity.rs`).
//!   This adapter refuses to dispatch a body whose `safety_identifier` is not
//!   shaped like a Ryu subject (`ryu.<pv>.<32 lowercase hex>`), so a fleet call
//!   that skipped stamping (an auxiliary caller) never leaves anonymously on
//!   Ryu's account. The shape check is defence in depth, not authentication:
//!   a caller can write a well-formed subject, which is why custody, checked
//!   when the lane is registered, is what keeps the lane off other Gateways.
//! - **Zero data retention on every request.** The caller's `providerOptions`,
//!   the `provider` shorthand and top-level fallback `models` are dropped, and
//!   only `providerOptions.gateway.zeroDataRetention = true` is written.
//! - **No tenant BYOK through Vercel.** Vercel documents that a request-scoped
//!   `providerOptions.gateway.byok` credential that fails is retried with the
//!   account's system credentials, and documents no switch that turns that off
//!   (BYOK and ZDR pages, both updated 2026-09-22). Spec 08.4 gate 4 then says
//!   tenant BYOK on Vercel is not offered at all, so this adapter never writes
//!   a `byok` entry and removes any the caller sent. Forced ZDR also makes
//!   Vercel skip dashboard BYOK keys that are not marked ZDR.
//!
//! Two upstream shapes share one key: the OpenAI-compatible Chat Completions
//! API at [`VERCEL_CHAT_BASE_URL`] for every model, and the Anthropic-compatible
//! Messages API at [`VERCEL_MESSAGES_BASE_URL`] for `anthropic/*` models, so
//! Claude keeps its native prompt caching and tool shapes. The Messages leg
//! reuses [`AnthropicProvider`], whose body is an allowlist, so the lane hands
//! it the subject through the private `ryu_upstream_subject` field (sent as
//! `metadata.user_id`) and the ZDR option as an extra top-level field.

use std::fmt;
use std::pin::Pin;
use std::sync::Arc;

use axum::body::Body;
use serde_json::{json, Map, Value};

use crate::{
    error::ProviderError, quota::ProviderQuotas, AnthropicProvider, EgressClientPool,
    OpenAiProvider, Provider,
};

/// The registry id of the lane.
pub const VERCEL_PROVIDER_ID: &str = "vercel";
/// OpenAI-compatible Chat Completions base URL.
pub const VERCEL_CHAT_BASE_URL: &str = "https://ai-gateway.vercel.sh/v1";
/// Anthropic-compatible Messages base URL (the adapter appends `/v1/messages`).
pub const VERCEL_MESSAGES_BASE_URL: &str = "https://ai-gateway.vercel.sh";
/// The credential origin every Vercel attempt carries (spec 00.3 `RyuFallback`).
pub const VERCEL_CREDENTIAL_ORIGIN: &str = "ryu_fallback";
/// Models served through the Messages leg.
const MESSAGES_MODEL_PREFIX: &str = "anthropic/";
/// The prefix of every Ryu-derived upstream subject (`ryu.<pv>.<hex32>`).
const SUBJECT_PREFIX: &str = "ryu.";
/// Hex digits in a Ryu subject's digest segment.
const SUBJECT_DIGEST_LEN: usize = 32;
/// OpenAI's `safety_identifier` limit, which Ryu's subjects fit.
const MAX_SUBJECT_LEN: usize = 64;
/// The decision prefix that records written resale permission.
const APPROVED_PREFIX: &str = "approved:";
/// Longest accepted written reference, in bytes.
const MAX_REFERENCE_LEN: usize = 200;
/// Private field the Anthropic adapter copies into `metadata.user_id`.
const UPSTREAM_SUBJECT_FIELD: &str = "ryu_upstream_subject";
/// Caller fields the lane never forwards. `providerOptions` and the `provider`
/// shorthand could carry `byok`, turn ZDR off or reorder providers; `models`
/// would let Vercel fall back to models Ryu did not price or restrict; `user`,
/// `metadata` and the private subject field are identity the Gateway owns.
const DROPPED_FIELDS: &[&str] = &[
    "providerOptions",
    "provider",
    "models",
    "user",
    "metadata",
    UPSTREAM_SUBJECT_FIELD,
];

/// Why the lane is not registered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaneRefusal {
    /// No decision is configured. The default.
    NotRecorded,
    /// A decision other than `approved:<ref>` (for example `unreviewed`).
    NotApproved,
    /// `approved:` with an empty, padded-only or overlong reference.
    InvalidReference,
    /// This Gateway is not a hosted fleet replica. Only the fleet stamps
    /// Ryu's subject on every request, so the lane runs nowhere else.
    NotFleet,
}

impl fmt::Display for LaneRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let reason = match self {
            Self::NotRecorded => "no written resale permission is recorded",
            Self::NotApproved => "the recorded resale decision is not an approval",
            Self::InvalidReference => "the resale approval names no valid written reference",
            Self::NotFleet => "only a hosted fleet Gateway may carry it",
        };
        write!(formatter, "Vercel AI Gateway lane is off: {reason}")
    }
}

/// A recorded written resale permission (spec 08.2 `resale_permission =
/// approved:<written ref>`). The only way to build the lane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResalePermission {
    reference: String,
}

impl ResalePermission {
    /// Accept exactly `approved:<reference>`, where the reference is 1 to
    /// [`MAX_REFERENCE_LEN`] bytes of printable text after trimming. Every
    /// other value, an absent one included, keeps the lane off.
    pub fn parse(decision: Option<&str>) -> Result<Self, LaneRefusal> {
        let decision = decision.map(str::trim).unwrap_or_default();
        if decision.is_empty() {
            return Err(LaneRefusal::NotRecorded);
        }
        let Some(reference) = decision.strip_prefix(APPROVED_PREFIX) else {
            return Err(LaneRefusal::NotApproved);
        };
        let reference = reference.trim();
        let printable = reference.chars().all(|character| !character.is_control());
        if reference.is_empty() || reference.len() > MAX_REFERENCE_LEN || !printable {
            return Err(LaneRefusal::InvalidReference);
        }
        Ok(Self {
            reference: reference.to_owned(),
        })
    }

    /// The written reference, for logs and the posture report.
    pub fn reference(&self) -> &str {
        &self.reference
    }
}

/// The only `providerOptions` the lane sends.
fn lane_provider_options() -> Value {
    json!({ "gateway": { "zeroDataRetention": true } })
}

/// Whether `subject` has the exact shape the Gateway derives:
/// `ryu.<pepper version>.<32 lowercase hex>`, where the version is a decimal
/// `u32` without a leading zero.
fn is_ryu_subject(subject: &str) -> bool {
    if subject.len() > MAX_SUBJECT_LEN {
        return false;
    }
    let Some(rest) = subject.strip_prefix(SUBJECT_PREFIX) else {
        return false;
    };
    let Some((version, digest)) = rest.split_once('.') else {
        return false;
    };
    let version_ok = !version.is_empty()
        && version.bytes().all(|byte| byte.is_ascii_digit())
        && (version == "0" || !version.starts_with('0'))
        && version.parse::<u32>().is_ok();
    let digest_ok = digest.len() == SUBJECT_DIGEST_LEN
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    version_ok && digest_ok
}

/// The Ryu subject a body carries in `safety_identifier`, when it is one.
fn ryu_subject(body: &Map<String, Value>) -> Option<&str> {
    body.get("safety_identifier")
        .and_then(Value::as_str)
        .filter(|subject| is_ryu_subject(subject))
}

fn refusal(message: &str) -> ProviderError {
    ProviderError::Rejected {
        status: 400,
        message: message.to_owned(),
    }
}

/// The Chat Completions body for one lane attempt: the caller's body with the
/// fields in [`DROPPED_FIELDS`] removed and only the lane's ZDR option
/// written. Refused, before any byte leaves, when the body carries no
/// well-formed Ryu subject in `safety_identifier`.
pub fn lane_chat_body(body: &Value) -> Result<Value, ProviderError> {
    let Some(object) = body.as_object() else {
        return Err(refusal("the Vercel lane needs a JSON object body"));
    };
    if ryu_subject(object).is_none() {
        return Err(refusal(
            "the Vercel lane carries only attempts stamped with a Ryu upstream subject",
        ));
    }
    let mut lane = object.clone();
    for field in DROPPED_FIELDS {
        lane.remove(*field);
    }
    lane.insert("providerOptions".to_owned(), lane_provider_options());
    Ok(Value::Object(lane))
}

/// The body the Messages leg converts: the lane chat body with the subject
/// moved to the private field the Anthropic adapter sends as
/// `metadata.user_id`. The ZDR option travels as the adapter's extra field.
pub fn lane_messages_body(body: &Value) -> Result<Value, ProviderError> {
    let mut lane = lane_chat_body(body)?;
    if let Some(object) = lane.as_object_mut() {
        object.remove("providerOptions");
        if let Some(subject) = object.remove("safety_identifier") {
            object.insert(UPSTREAM_SUBJECT_FIELD.to_owned(), subject);
        }
    }
    Ok(lane)
}

/// Whether a model is served through the Messages leg.
pub fn uses_messages_leg(model: &str) -> bool {
    model.starts_with(MESSAGES_MODEL_PREFIX)
}

/// The Vercel AI Gateway provider. Build it only through the registry gate.
pub struct VercelProvider {
    chat: OpenAiProvider,
    messages: AnthropicProvider,
}

impl VercelProvider {
    /// Build the lane. `_permission` is required so no caller can construct
    /// the adapter without a recorded written approval.
    pub fn new_with_egress(
        _permission: &ResalePermission,
        client: reqwest::Client,
        egress: Option<Arc<EgressClientPool>>,
        keys: Vec<String>,
        chat_base_url: String,
        messages_base_url: String,
        quota: Arc<ProviderQuotas>,
    ) -> Self {
        let mut extra = Map::new();
        extra.insert("providerOptions".to_owned(), lane_provider_options());
        Self {
            chat: OpenAiProvider::new_named_with_egress(
                VERCEL_PROVIDER_ID,
                client.clone(),
                egress.clone(),
                keys.clone(),
                chat_base_url,
                Arc::clone(&quota),
            ),
            messages: AnthropicProvider::new_named_with_egress(
                VERCEL_PROVIDER_ID,
                client,
                egress,
                keys,
                messages_base_url,
                quota,
            )
            .with_extra_body(extra),
        }
    }
}

type ValueFuture<'a> =
    Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>>;
type BodyFuture<'a> =
    Pin<Box<dyn std::future::Future<Output = Result<Body, ProviderError>> + Send + 'a>>;

impl Provider for VercelProvider {
    fn name(&self) -> &'static str {
        VERCEL_PROVIDER_ID
    }

    fn configure_account_policies(&self, policies: &[crate::ProviderAccountPolicy]) {
        self.chat.configure_account_policies(policies);
        self.messages.configure_account_policies(policies);
    }

    fn configure_account_strategy(&self, strategy: crate::AccountSelectionStrategy) {
        self.chat.configure_account_strategy(strategy);
        self.messages.configure_account_strategy(strategy);
    }

    fn configure_fill_first_drain_percent(&self, percent: u8) {
        self.chat.configure_fill_first_drain_percent(percent);
        self.messages.configure_fill_first_drain_percent(percent);
    }

    fn has_rotating_accounts(&self) -> bool {
        self.chat.has_rotating_accounts() || self.messages.has_rotating_accounts()
    }

    fn discover_models<'a>(
        &'a self,
    ) -> Pin<Box<dyn std::future::Future<Output = Option<Vec<Value>>> + Send + 'a>> {
        self.chat.discover_models()
    }

    fn complete<'a>(&'a self, model: &'a str, body: &'a Value) -> ValueFuture<'a> {
        self.complete_for_session(model, body, None)
    }

    fn complete_for_session<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
        session: Option<&'a str>,
    ) -> ValueFuture<'a> {
        Box::pin(async move {
            if uses_messages_leg(model) {
                let lane = lane_messages_body(body)?;
                self.messages
                    .complete_for_session(model, &lane, session)
                    .await
            } else {
                let lane = lane_chat_body(body)?;
                self.chat.complete_for_session(model, &lane, session).await
            }
        })
    }

    fn complete_stream<'a>(&'a self, model: &'a str, body: &'a Value) -> BodyFuture<'a> {
        self.complete_stream_for_session(model, body, None)
    }

    fn complete_stream_for_session<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
        session: Option<&'a str>,
    ) -> BodyFuture<'a> {
        Box::pin(async move {
            if uses_messages_leg(model) {
                let lane = lane_messages_body(body)?;
                self.messages
                    .complete_stream_for_session(model, &lane, session)
                    .await
            } else {
                let lane = lane_chat_body(body)?;
                self.chat
                    .complete_stream_for_session(model, &lane, session)
                    .await
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A Ryu-format subject (`ryu.<pv>.<hex32>`) for fixtures.
    const SUBJECT: &str = "ryu.1.0123456789abcdef0123456789abcdef";
    /// Test sentinels (spec 00.9). None of them may reach the upstream.
    const TENANT_KEY: &str = "RYU_TEST_LEXICON-tenant-byok-key";
    const TENANT_USER: &str = "RYU_TEST_LEXICON-user";

    fn tenant_body(subject: Option<&str>) -> Value {
        let mut body = json!({
            "model": "openai/fixture-model",
            "messages": [{ "role": "user", "content": "Hi" }],
            "user": TENANT_USER,
            "metadata": { "user_id": TENANT_USER },
            "models": ["fixture/fallback-model"],
            "provider": { "zeroDataRetention": false, "sort": "cost" },
            "providerOptions": {
                "gateway": {
                    "zeroDataRetention": false,
                    "order": ["fixture"],
                    "byok": { "anthropic": [{ "apiKey": TENANT_KEY }] }
                },
                "anthropic": { "fixture": true }
            }
        });
        if let Some(subject) = subject {
            body["safety_identifier"] = json!(subject);
        }
        body
    }

    fn approved() -> ResalePermission {
        ResalePermission::parse(Some("approved:VERCEL-RESALE-FIXTURE-1")).unwrap()
    }

    #[test]
    fn the_lane_is_off_unless_written_approval_is_recorded() {
        assert_eq!(ResalePermission::parse(None), Err(LaneRefusal::NotRecorded));
        for blank in ["", "   ", "\n"] {
            assert_eq!(
                ResalePermission::parse(Some(blank)),
                Err(LaneRefusal::NotRecorded),
                "{blank:?}"
            );
        }
        for decision in [
            "unreviewed",
            "forbidden",
            "approved",
            "APPROVED:ref",
            "accepted_risk:ref",
            "pending:approved:ref",
        ] {
            assert_eq!(
                ResalePermission::parse(Some(decision)),
                Err(LaneRefusal::NotApproved),
                "{decision}"
            );
        }
        let overlong = format!("approved:{}", "r".repeat(MAX_REFERENCE_LEN + 1));
        for decision in [
            "approved:",
            "approved:   ",
            "approved:ref\u{0}x",
            overlong.as_str(),
        ] {
            assert_eq!(
                ResalePermission::parse(Some(decision)),
                Err(LaneRefusal::InvalidReference),
                "{decision:?}"
            );
        }
        let permission = ResalePermission::parse(Some("  approved: MSA-2026-07 §4  ")).unwrap();
        assert_eq!(permission.reference(), "MSA-2026-07 §4");
        assert!(LaneRefusal::NotRecorded.to_string().contains("off"));
        assert!(LaneRefusal::NotFleet.to_string().contains("lane is off"));
    }

    #[test]
    fn a_body_without_a_ryu_subject_is_refused_before_dispatch() {
        for body in [
            tenant_body(None),
            tenant_body(Some(TENANT_USER)),
            tenant_body(Some("")),
            tenant_body(Some(&format!("ryu.{}", "f".repeat(MAX_SUBJECT_LEN)))),
            json!("not an object"),
        ] {
            for prepared in [lane_chat_body(&body), lane_messages_body(&body)] {
                match prepared {
                    Err(ProviderError::Rejected { status: 400, .. }) => {}
                    other => panic!("expected a refusal for {body}: {other:?}"),
                }
            }
        }
        let mut wrong_type = tenant_body(None);
        wrong_type["safety_identifier"] = json!({ "nested": SUBJECT });
        assert!(lane_chat_body(&wrong_type).is_err());
    }

    #[test]
    fn only_the_exact_ryu_subject_shape_is_accepted() {
        let hex = "0123456789abcdef0123456789abcdef";
        for accepted in [
            SUBJECT.to_owned(),
            format!("ryu.0.{hex}"),
            format!("ryu.4294967295.{hex}"),
        ] {
            assert!(is_ryu_subject(&accepted), "{accepted}");
            assert!(lane_chat_body(&tenant_body(Some(&accepted))).is_ok());
        }
        for refused in [
            "ryu.anything".to_owned(),
            "ryu.".to_owned(),
            format!("ryu..{hex}"),
            format!("ryu.x.{hex}"),
            format!("ryu.01.{hex}"),
            format!("ryu.-1.{hex}"),
            format!("ryu.4294967296.{hex}"),
            format!("ryu.1.{}", &hex[..31]),
            format!("ryu.1.{hex}0"),
            format!("ryu.1.{}", hex.to_ascii_uppercase()),
            format!("ryu.1.{}g", &hex[..31]),
            format!("ryu.1.{hex}.extra"),
            format!("ryu.1.2.{hex}"),
            format!("RYU.1.{hex}"),
            format!(" ryu.1.{hex}"),
        ] {
            assert!(!is_ryu_subject(&refused), "{refused}");
            assert!(
                lane_chat_body(&tenant_body(Some(&refused))).is_err(),
                "{refused}"
            );
        }
    }

    #[test]
    fn the_chat_body_forces_zdr_and_never_carries_byok_or_tenant_fields() {
        let lane = lane_chat_body(&tenant_body(Some(SUBJECT))).unwrap();
        assert_eq!(lane["safety_identifier"], json!(SUBJECT));
        assert_eq!(
            lane["providerOptions"],
            json!({ "gateway": { "zeroDataRetention": true } })
        );
        for field in [
            "user",
            "metadata",
            "models",
            "provider",
            UPSTREAM_SUBJECT_FIELD,
        ] {
            assert!(lane.get(field).is_none(), "{field}: {lane}");
        }
        let wire = lane.to_string();
        assert!(!wire.contains("byok"), "{wire}");
        assert!(!wire.contains(TENANT_KEY), "{wire}");
        assert!(!wire.contains(TENANT_USER), "{wire}");
        assert_eq!(lane["messages"], tenant_body(None)["messages"]);
    }

    #[test]
    fn the_messages_body_moves_the_subject_to_the_private_field() {
        let lane = lane_messages_body(&tenant_body(Some(SUBJECT))).unwrap();
        assert_eq!(lane[UPSTREAM_SUBJECT_FIELD], json!(SUBJECT));
        assert!(lane.get("safety_identifier").is_none());
        assert!(lane.get("providerOptions").is_none());
        assert!(!lane.to_string().contains("byok"));
    }

    #[test]
    fn only_anthropic_models_use_the_messages_leg() {
        assert!(uses_messages_leg("anthropic/claude-fixture"));
        assert!(!uses_messages_leg("openai/fixture-model"));
        assert!(!uses_messages_leg("claude-fixture"));
    }

    // ── Wire tests against a local mock of both upstream shapes ─────────────

    #[derive(Clone, Debug)]
    struct Seen {
        path: String,
        authorization: Option<String>,
        api_key: Option<String>,
        body: Value,
    }

    async fn spawn_mock() -> (String, Arc<Mutex<Vec<Seen>>>, tokio::task::JoinHandle<()>) {
        use axum::{http::HeaderMap, http::Uri, Json, Router};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
        let captured = Arc::clone(&seen);
        let router = Router::new().fallback(
            move |uri: Uri, headers: HeaderMap, Json(body): Json<Value>| {
                let captured = Arc::clone(&captured);
                async move {
                    let header = |name: &str| {
                        headers
                            .get(name)
                            .and_then(|value| value.to_str().ok())
                            .map(str::to_owned)
                    };
                    let path = uri.path().to_owned();
                    let reply = if path.ends_with("/v1/messages") {
                        json!({
                            "id": "msg_fixture", "type": "message", "role": "assistant",
                            "model": "anthropic/claude-fixture",
                            "content": [{ "type": "text", "text": "ok" }],
                            "stop_reason": "end_turn",
                            "usage": { "input_tokens": 3, "output_tokens": 1 }
                        })
                    } else {
                        json!({
                            "id": "chatcmpl-fixture", "object": "chat.completion",
                            "model": "openai/fixture-model",
                            "choices": [{ "index": 0,
                                "message": { "role": "assistant", "content": "ok" },
                                "finish_reason": "stop" }],
                            "usage": { "prompt_tokens": 3, "completion_tokens": 1,
                                       "total_tokens": 4 }
                        })
                    };
                    captured.lock().unwrap().push(Seen {
                        path,
                        authorization: header("authorization"),
                        api_key: header("x-api-key"),
                        body,
                    });
                    Json(reply)
                }
            },
        );
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (base, seen, task)
    }

    fn provider(base: &str) -> VercelProvider {
        VercelProvider::new_with_egress(
            &approved(),
            reqwest::Client::new(),
            None,
            vec!["vercel-fixture-key".to_owned()],
            format!("{base}/v1"),
            base.to_owned(),
            Arc::new(ProviderQuotas::new()),
        )
    }

    #[tokio::test]
    async fn chat_leg_sends_the_subject_and_zdr_and_no_byok() {
        let (base, seen, task) = spawn_mock().await;
        let lane = provider(&base);
        assert_eq!(lane.name(), VERCEL_PROVIDER_ID);
        lane.complete("openai/fixture-model", &tenant_body(Some(SUBJECT)))
            .await
            .unwrap();
        let seen = seen.lock().unwrap().clone();
        task.abort();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].path, "/v1/chat/completions");
        assert_eq!(
            seen[0].authorization.as_deref(),
            Some("Bearer vercel-fixture-key")
        );
        let body = &seen[0].body;
        assert_eq!(body["model"], json!("openai/fixture-model"));
        assert_eq!(body["safety_identifier"], json!(SUBJECT));
        assert_eq!(
            body["providerOptions"]["gateway"]["zeroDataRetention"],
            json!(true)
        );
        let wire = body.to_string();
        assert!(
            !wire.contains("byok") && !wire.contains(TENANT_KEY),
            "{wire}"
        );
        assert!(!wire.contains(TENANT_USER), "{wire}");
    }

    #[tokio::test]
    async fn messages_leg_sends_metadata_user_id_and_zdr_and_no_byok() {
        let (base, seen, task) = spawn_mock().await;
        let lane = provider(&base);
        let reply = lane
            .complete("anthropic/claude-fixture", &tenant_body(Some(SUBJECT)))
            .await
            .unwrap();
        assert_eq!(reply["choices"][0]["message"]["content"], json!("ok"));
        let seen = seen.lock().unwrap().clone();
        task.abort();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].path, "/v1/messages");
        assert_eq!(seen[0].api_key.as_deref(), Some("vercel-fixture-key"));
        let body = &seen[0].body;
        assert_eq!(body["model"], json!("anthropic/claude-fixture"));
        assert_eq!(body["metadata"], json!({ "user_id": SUBJECT }));
        assert_eq!(
            body["providerOptions"],
            json!({ "gateway": { "zeroDataRetention": true } })
        );
        assert!(body.get("safety_identifier").is_none());
        assert!(body.get(UPSTREAM_SUBJECT_FIELD).is_none());
        let wire = body.to_string();
        assert!(
            !wire.contains("byok") && !wire.contains(TENANT_KEY),
            "{wire}"
        );
    }

    #[tokio::test]
    async fn an_unstamped_body_never_reaches_either_leg() {
        let (base, seen, task) = spawn_mock().await;
        let lane = provider(&base);
        for model in ["openai/fixture-model", "anthropic/claude-fixture"] {
            assert!(lane.complete(model, &tenant_body(None)).await.is_err());
            assert!(lane
                .complete_stream(model, &tenant_body(None))
                .await
                .is_err());
        }
        let count = seen.lock().unwrap().len();
        task.abort();
        assert_eq!(count, 0);
    }
}
