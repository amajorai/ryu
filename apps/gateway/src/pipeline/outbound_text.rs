//! Universal outbound text extraction for the inbound screens.
//!
//! The chat visitors in `pipeline/prompt_text.rs` (`visit_conversation_strings` and
//! `visit_definition_strings`) and the multimodal text keys in
//! `inference_governance` name the fields the Sanitize policy can rewrite.
//! Providers forward far more than those fields: Replicate and Fal pass a
//! nested `input` object verbatim (`build_input`), the OpenRouter image
//! provider forwards `messages`, every top-level speech field reaches a
//! Replicate or Fal model, and a chat body can carry a top-level `prompt` with
//! no `messages` at all. This module walks every string leaf of the exact body
//! that is dispatched upstream and returns what the named fields do not
//! already show the screens (the *residual*), so the regex firewall and the
//! locked guardrails screen it as well.
//!
//! The residual has three parts:
//! - the *uncovered* leaves, which no other screen reads, plus their decoded
//!   forms;
//! - the *decoded* forms of the covered leaves. Stringified JSON (tool-call
//!   arguments, Anthropic `tool_use.input`, Responses `function_call`
//!   arguments) is parsed best-effort and every string inside it is screened,
//!   because an escaped payload (`\n` between words, `\u0049gnore`) never
//!   spells itself out in the raw string the conversation scan reads;
//! - the *secrets-only* leaves (see below), plus their decoded forms.
//!
//! The residual screen is detection-only. It never rewrites the body, so it
//! cannot disturb provider prompt caching. Sanitize can only redact the fields
//! it owns, so an uncovered or secrets-only match under Block or Sanitize is
//! refused with a 403. A decoded form of a covered leaf is screened after
//! Sanitize ran, with the rule Sanitize applies to its own fields: a secret or
//! PII match that survived redaction is refused, anything else is forwarded
//! with a warning. WarnAndContinue warns. Message content keeps its existing
//! redaction.
//!
//! How each top-level key is read:
//! - [`DEFINITION_KEYS`] (`tools`, `functions`, `tool_choice`): every leaf is
//!   secrets-only, the rule the definition pass applies to function
//!   definitions, because schema wording matches the injection patterns and
//!   schema examples match the PII patterns. The leaves the definition pass
//!   already reads (`tools[].function` and `functions[]` descriptions and
//!   parameters) are skipped on the chat routes, but their decoded forms are
//!   screened here. Custom tools, extra tool fields and tool choice have no
//!   other screen, and the multimodal routes run no definition pass at all.
//! - [`CONTROL_KEYS`]: routing, sampling, output-shape and end-user identifier
//!   fields. A whitespace-free string (`"hd"`, `"alloy"`, a `user` id) is
//!   secrets-only, so an email in `user` still dispatches but a credential in
//!   `quality` or `prompt_cache_key` does not. A string with whitespace, an
//!   array or an object (`metadata`, a `response_format` JSON schema) is fully
//!   screened: passthrough providers forward top-level fields as model input,
//!   and a JSON schema is model-visible.
//! - Anything else is fully screened, at every depth.
//!
//! Object keys are screened too below [`KEYED_KEYS`] (the definition keys and
//! `response_format`), in the zone of the object that holds them: a tool
//! parameter name reads secrets-only and a JSON-schema property name is fully
//! screened, since both are model-visible text the provider forwards as
//! written. Other chat keys are wire structure and are not screened.
//!
//! What the walk skips:
//! - Encoded media under a media key (see [`is_media_key`]) or any of its
//!   descendants: a URL, a base64 `data:` URI or a long whitespace-free run of
//!   the base64 alphabet. Regexes find nothing meaningful in encoded bytes,
//!   random base64 trips the secret patterns, and a presigned URL trips the
//!   token patterns. Any other string under a media key (a caption, a
//!   `data:,text` file) is screened. A plain-text `data:` URI under any key is
//!   also screened percent-decoded.
//! - Base64 `data:` URIs under any key. A long base64-alphabet run outside a
//!   media key is screened, since a secret padded with letters fits the
//!   alphabet.
//!
//! Audio, image and video bytes are out of scope: only text is screened.
//!
//! Managed provider calls ([`action_residual_text`]) read stricter. Their body
//! keys are arbitrary action arguments that the provider forwards as written,
//! so none of the chat skips apply: there is no media zone, no string counts as
//! encoded media, and every object key is screened like a value, at every
//! depth and inside stringified JSON. Every string is also screened with its
//! `%XX` escapes decoded, and a base64 `data:` URI payload or a base64-alphabet
//! token that decodes to UTF-8 text is screened decoded as well.
//!
//! Leaves are joined with [`SEPARATOR`], which no built-in pattern can span, so
//! two adjacent leaves (`"action":"ignore"`, `"target":"rules"`) never form a
//! phrase neither contains. Object keys are walked in sorted order whatever
//! serde_json's `preserve_order` feature says (`sorted_entries`), so extraction
//! is deterministic in every build. Nothing is ever
//! truncated: past [`MAX_SCREENED_BYTES`] of residual text the request is
//! refused, so a long benign field cannot push a payload out of the screen.
use std::collections::HashSet;

use serde_json::Value;
use tracing::warn;

use crate::{
    config::FirewallPolicy,
    error::GatewayError,
    firewall::{FirewallBackend, FirewallMatch},
    policy_alert::PolicyAlert,
    state::AppState,
};

use super::RequestContext;

/// Ceiling on the residual text one request may carry, in bytes, across every
/// part. Real non-message text (image prompts, speech text, transcription
/// hints, request options, decoded tool arguments) is far smaller; a request
/// over it is refused rather than screened in part. Chat bodies are bounded at
/// 2 MiB on the wire, so their residual (raw plus decoded) always fits.
pub(crate) const MAX_SCREENED_BYTES: usize = 4 << 20;

/// Joins residual leaves. Neither `\s` nor `\w` matches NUL, and
/// `normalize_for_scan` keeps it, so no built-in pattern spans two leaves.
const SEPARATOR: &str = "\n\0\n";

/// URL and encoded-media keys that do not name their modality: chat `file`
/// parts, Responses `file_data`, image `b64_json`, and the Replicate / Fal
/// `mask`, `mask_url` and `url` inputs. See [`is_media_key`].
const MEDIA_KEYS: &[&str] = &["file", "file_data", "b64_json", "mask", "mask_url", "url"];

/// Key fragments that name a media field: chat `image_url` and `input_audio`
/// parts, and the Replicate / Fal media inputs (`image`, `init_image`,
/// `image_input`, `audio_url`, `video_url`, ...).
const MEDIA_KEY_PARTS: &[&str] = &["image", "audio", "video"];

/// Top-level tool definition and tool choice keys, screened secrets-only.
const DEFINITION_KEYS: &[&str] = &["tools", "functions", "tool_choice"];

/// Top-level keys whose subtree object keys are model-visible: a tool
/// parameter or JSON-schema property name is text the model reads, and the
/// provider forwards it as written. Their keys are screened in the zone of the
/// object that holds them, so `tools` keys read secrets-only and
/// `response_format` keys are fully screened.
const KEYED_KEYS: &[&str] = &["tools", "functions", "tool_choice", "response_format"];

/// Top-level keys that are not prompt content when they hold a control token:
/// - routing and sampling controls: `model`, `models`, `provider`, `n`, `seed`,
///   `size`, `width`, `height`, `aspect_ratio`, `steps`, `guidance`,
///   `guidance_scale`, `num_inference_steps`, `quality`, `response_format`,
///   `voice`, `speed`, `stream`, `temperature`, `top_p`, `max_tokens`;
/// - end-user identifiers and request metadata: `user`, `safety_identifier`,
///   `prompt_cache_key`, `metadata`.
const CONTROL_KEYS: &[&str] = &[
    "model",
    "models",
    "provider",
    "n",
    "seed",
    "size",
    "width",
    "height",
    "aspect_ratio",
    "steps",
    "guidance",
    "guidance_scale",
    "num_inference_steps",
    "quality",
    "response_format",
    "voice",
    "speed",
    "stream",
    "temperature",
    "top_p",
    "max_tokens",
    "user",
    "safety_identifier",
    "prompt_cache_key",
    "metadata",
];

/// Shortest whitespace-free base64-alphabet run under a media key treated as
/// encoded bytes.
const BLOB_MIN_LEN: usize = 512;

/// How deep stringified JSON nested inside stringified JSON is parsed.
const MAX_EMBEDDED_DEPTH: usize = 4;

/// The residual text exceeded [`MAX_SCREENED_BYTES`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ResidualTooLarge;

/// The residual text of a request (see the module docs).
#[derive(Debug, Default)]
pub(crate) struct Residual {
    /// Leaves no other screen reads, plus their decoded forms.
    uncovered: String,
    /// Decoded forms of the leaves another screen reads.
    decoded: String,
    /// Tool definitions and control tokens, plus their decoded forms.
    secrets_only: String,
    over_limit: bool,
    /// Read as managed provider action arguments (see the module docs).
    action_arguments: bool,
    /// Read as content a tool loop appends (see [`tool_loop_residual_text`]).
    tool_loop: bool,
}

/// The residual parts, borrowed (see [`Residual`]).
struct Parts<'a> {
    uncovered: &'a str,
    decoded: &'a str,
    secrets_only: &'a str,
}

#[derive(Clone, Copy)]
enum Part {
    Uncovered,
    Decoded,
    SecretsOnly,
}

/// How the walk reads the strings below a key (see the module docs).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Zone {
    /// Every pattern applies.
    Content,
    /// Only the secret patterns apply.
    SecretsOnly,
    /// Encoded media is skipped; any other string is screened like content.
    Media,
}

impl Residual {
    fn parts(&self) -> Result<Parts<'_>, ResidualTooLarge> {
        if self.over_limit {
            Err(ResidualTooLarge)
        } else {
            Ok(Parts {
                uncovered: &self.uncovered,
                decoded: &self.decoded,
                secrets_only: &self.secrets_only,
            })
        }
    }

    fn push(&mut self, part: Part, text: &str) {
        if self.over_limit || text.is_empty() {
            return;
        }
        let total = self.uncovered.len() + self.decoded.len() + self.secrets_only.len();
        let buffer = match part {
            Part::Uncovered => &mut self.uncovered,
            Part::Decoded => &mut self.decoded,
            Part::SecretsOnly => &mut self.secrets_only,
        };
        let separator = if buffer.is_empty() { "" } else { SEPARATOR };
        if total + separator.len() + text.len() > MAX_SCREENED_BYTES {
            self.over_limit = true;
            return;
        }
        buffer.push_str(separator);
        buffer.push_str(text);
    }

    /// The text the hazard screener reads beside the projected conversation:
    /// the leaves no other screen reads and every decoded form. `None` when
    /// the residual is over its limit (the regex floor refuses it then).
    pub(crate) fn screened_text(&self) -> Option<String> {
        if self.over_limit {
            return None;
        }
        let text = [self.uncovered.as_str(), self.decoded.as_str()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        (!text.is_empty()).then_some(text)
    }

    /// Add a caller-supplied value that replaces a body control field on
    /// dispatch without being in the body, such as the model a
    /// `x-ryu-slot-<modality>-model` header names. It reads like the body
    /// field it replaces: a whitespace-free token is secrets-only, anything
    /// else is fully screened, and its decoded forms are screened too.
    pub(crate) fn with_control_token(mut self, token: Option<&str>) -> Self {
        let Some(token) = token.filter(|token| !token.is_empty()) else {
            return self;
        };
        let part = if token.chars().any(char::is_whitespace) {
            Part::Uncovered
        } else {
            Part::SecretsOnly
        };
        self.push(part, token);
        push_decoded(token, part, 0, &mut self);
        self
    }
}

/// The residual of `body`. `covered` visits the leaves another screen already
/// reads (and Sanitize may rewrite), by reference into `body`, so each raw leaf
/// is screened once and the sanitize mapping stays unchanged.
pub(crate) fn residual_text(body: &Value, covered: impl FnOnce(&mut dyn FnMut(&str))) -> Residual {
    let mut owned: HashSet<usize> = HashSet::new();
    covered(&mut |text| {
        if !text.is_empty() {
            owned.insert(text.as_ptr() as usize);
        }
    });
    let mut out = Residual::default();
    walk_wire(body, Zone::Content, true, false, &owned, &mut out);
    out
}

/// The residual of a managed provider call. `wire` holds every string the
/// provider receives. No key reads with the chat root-key or media rules, keys
/// are screened like values, and nothing is skipped as encoded media (see the
/// module docs).
pub(crate) fn action_residual_text(wire: &Value) -> Residual {
    let mut out = Residual {
        action_arguments: true,
        ..Residual::default()
    };
    walk_wire(wire, Zone::Content, false, true, &HashSet::new(), &mut out);
    out
}

/// The residual of one item a tool loop appends: a model turn or a raw tool
/// result. It reads like the chat walk with two differences. Every object key
/// is screened like a value, at every depth and inside stringified JSON, since
/// a tool result's keys reach the model as text. A URL under a media key is
/// screened too: a tool result or a model's call arguments is text the
/// provider receives, not a media input it fetches. Base64 `data:` URIs and
/// long base64 runs under a media key stay skipped, so a tool that returns an
/// encoded image is not refused for its bytes.
pub(crate) fn tool_loop_residual_text(wire: &Value) -> Residual {
    let mut out = Residual {
        tool_loop: true,
        ..Residual::default()
    };
    walk_wire(wire, Zone::Content, false, true, &HashSet::new(), &mut out);
    out
}

/// The residual of tool definitions a tool loop injects itself (from
/// `tool_search` or capability hints). They are read with the rule the
/// definition pass applies to the caller's own definitions: every leaf is
/// secrets-only, because schema wording matches the injection patterns and
/// schema examples match the PII patterns.
pub(crate) fn tool_definitions_residual_text(definitions: &[Value]) -> Residual {
    let wire = serde_json::json!({ "tools": definitions });
    residual_text(&wire, |_| {})
}

mod decode;
mod screen;
mod walk;

pub(crate) use decode::*;
pub(crate) use screen::*;
pub(crate) use walk::*;

#[cfg(test)]
mod tests;
