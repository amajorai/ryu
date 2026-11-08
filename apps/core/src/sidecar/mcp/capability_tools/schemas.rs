//! Input schemas of the non-machine verbs (web, decision, verification,
//! memory), plus the shared empty schema.

use super::*;

pub(super) fn schema_search() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query": { "type": "string", "description": "The search query. Natural language or keywords." },
            "limit": { "type": "integer", "description": "Maximum number of results (default 10).", "minimum": 1, "maximum": 100 }
        },
        "required": ["query"]
    })
}

pub(super) fn schema_decision_predict() -> Value {
    json!({
        "type": "object",
        "properties": {
            "state": {
                "description": "The text, JSON object, or list to reason about.",
                "oneOf": [
                    { "type": "string" },
                    { "type": "object" },
                    { "type": "array" }
                ]
            },
            "questions": {
                "type": "object",
                "description": "Question ids mapped to typed choice, score, or yes/no definitions.",
                "additionalProperties": { "type": "object" }
            },
            "model": {
                "type": "string",
                "description": "Optional provider-specific model id. Omit to use the selected provider's default."
            }
        },
        "required": ["state", "questions"]
    })
}

pub(super) fn schema_decision_predict_multimodal() -> Value {
    json!({
        "type": "object",
        "properties": {
            "state": {
                "description": "The text, JSON object, or list to reason about.",
                "oneOf": [
                    { "type": "string" },
                    { "type": "object" },
                    { "type": "array" }
                ]
            },
            "questions": {
                "type": "object",
                "description": "Question ids mapped to typed choice, score, or yes/no definitions.",
                "additionalProperties": { "type": "object" }
            },
            "images": {
                "type": "array",
                "description": "Up to four embedded PNG, JPEG, or WebP images. Remote URLs are not accepted; use a data URL or {content_type, base64}.",
                "maxItems": 4,
                "items": {
                    "oneOf": [
                        {
                            "type": "string",
                            "pattern": "^[Dd][Aa][Tt][Aa]:image/(png|jpeg|webp);base64,"
                        },
                        {
                            "type": "object",
                            "properties": {
                                "content_type": { "type": "string", "enum": ["image/png", "image/jpeg", "image/webp"] },
                                "base64": { "type": "string" }
                            },
                            "required": ["content_type", "base64"]
                        }
                    ]
                }
            },
            "model": {
                "type": "string",
                "description": "Optional provider-specific model id. Omit to use the selected provider's default."
            }
        },
        "required": ["state", "questions"]
    })
}

/// The verification verdict vocabulary every `verify.claim` provider maps onto.
///
/// Five values, not pass/fail, for the same reason the reasoning solver has seven:
/// "the source does not settle it" and "this could not be checked" are different
/// situations from "this is false", and a checker that collapses them reports
/// unverified text as verified. `unverifiable` covers every case where no verdict
/// was reached for the whole claim (nothing formalizable, only part of it
/// formalizable, ambiguous readings, a budget ran out, no matching scope) and must
/// never be read as approval. `proved` means every part of the claim was checked
/// and entailed.
pub const VERIFY_VERDICTS: &[&str] = &[
    "proved",
    "refuted",
    "undecided",
    "inconsistent",
    "unverifiable",
];

pub(super) fn schema_verify_claim() -> Value {
    json!({
        "type": "object",
        "properties": {
            "claim": {
                "type": "string",
                "description": "The statement or answer to check, in plain language."
            },
            "question": {
                "type": "string",
                "description": "Optional: what was asked. Supplies the facts the claim is checked under."
            },
            "scope": {
                "type": "string",
                "description": "Optional: which source of truth to check against, as an id from verify.scopes. Omit when only one scope exists."
            }
        },
        "required": ["claim"]
    })
}

pub(super) fn schema_extract() -> Value {
    json!({
        "type": "object",
        "properties": {
            "url": { "type": "string", "description": "The URL whose main content should be extracted." },
            "format": { "type": "string", "description": "Preferred output format.", "enum": ["markdown", "text", "html"] }
        },
        "required": ["url"]
    })
}

pub(super) fn schema_crawl() -> Value {
    json!({
        "type": "object",
        "properties": {
            "url": { "type": "string", "description": "The start URL to crawl from." },
            "depth": { "type": "integer", "description": "Link hops to follow (0 = the start page only).", "minimum": 0, "maximum": 10 },
            "limit": { "type": "integer", "description": "Maximum pages to fetch (default 10).", "minimum": 1, "maximum": 500 }
        },
        "required": ["url"]
    })
}

pub(super) fn schema_empty() -> Value {
    json!({ "type": "object", "properties": {} })
}

pub(super) fn schema_memory_search() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query": { "type": "string", "description": "What to recall." },
            "scope": { "type": "string", "description": "Restrict to one scope level.", "enum": ["agent", "user", "node", "project", "org"] },
            "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
        },
        "required": ["query"]
    })
}

pub(super) fn schema_memory_store() -> Value {
    json!({
        "type": "object",
        "properties": {
            "content": { "type": "string", "description": "The durable fact to remember." },
            "scope": { "type": "string", "description": "How broadly the fact applies.", "enum": ["agent", "user", "node", "project", "org"] },
            "category": { "type": "string", "description": "What kind of fact this is." },
            "importance": { "type": "integer", "minimum": 1, "maximum": 5 },
            "when_to_use": { "type": "string", "description": "Hint describing when this fact is relevant." }
        },
        "required": ["content"]
    })
}

pub(super) fn schema_memory_context() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query": { "type": "string", "description": "What the current turn is about, so the provider can tailor the summary." }
        }
    })
}

pub(super) fn schema_memory_sync() -> Value {
    json!({
        "type": "object",
        "properties": {
            "content": { "type": "string", "description": "The raw conversation turn to hand over." },
            "role": { "type": "string", "description": "Who produced it.", "enum": ["user", "assistant"] }
        },
        "required": ["content"]
    })
}

pub(super) fn schema_memory_forget() -> Value {
    json!({
        "type": "object",
        "properties": { "id": { "type": "string", "description": "Id of the memory to delete." } },
        "required": ["id"]
    })
}
