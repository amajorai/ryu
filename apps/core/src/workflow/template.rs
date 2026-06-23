//! Minimal `{{...}}` template resolver for workflow node fields.
//!
//! Deliberately tiny: everything is a `String`, JSON passes through verbatim,
//! and there is no expression language or type system. The resolver scans for
//! `{{ token }}` spans (whitespace around the token is trimmed) and substitutes:
//!
//!   - `{{input}}`            — the current incoming value for the node.
//!   - `{{nodes.<id>}}`       — the output string of an upstream node.
//!   - `{{state.<key>}}`      — a value from the run's `state` map.
//!   - `{{trigger.<field>}}`  — a dotted JSON path into the trigger payload
//!                              (the run state's reserved `trigger` key, parsed
//!                              as JSON; e.g. `{{trigger.body.email}}`).
//!
//! Any unknown token, missing key, or path miss resolves to the empty string.
//!
//! Per the Core-vs-Gateway rule this is **Core**: it shapes *what runs* (the
//! concrete text a node acts on); it enforces no policy.

use std::collections::HashMap;

/// Inputs the resolver reads. Owns small cloned maps so the executor can keep a
/// mutable borrow of the run (e.g. `SetState` writes `run.state`) while a node's
/// fields are being resolved.
pub struct TemplateCtx {
    /// The current incoming value for the node being executed.
    pub input: String,
    /// Upstream node id → produced output string.
    pub nodes: HashMap<String, String>,
    /// Run state map (key → string value).
    pub state: HashMap<String, String>,
}

/// Resolve every `{{...}}` token in `template` against `ctx`. Unknown tokens and
/// missing keys become empty strings. Text outside `{{...}}` is copied verbatim.
pub fn resolve(template: &str, ctx: &TemplateCtx) -> String {
    let mut out = String::with_capacity(template.len());
    let bytes = template.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            if let Some(end) = find_close(template, i + 2) {
                let token = template[i + 2..end].trim();
                out.push_str(&resolve_token(token, ctx));
                i = end + 2;
                continue;
            }
        }
        // Not a token start (or unterminated): copy this char and advance by its
        // UTF-8 width so multi-byte characters stay intact.
        let ch = template[i..].chars().next().unwrap_or('\u{0}');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Find the byte index of the `}}` that closes a token opened at `from`.
fn find_close(s: &str, from: usize) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut j = from;
    while j + 1 < bytes.len() {
        if bytes[j] == b'}' && bytes[j + 1] == b'}' {
            return Some(j);
        }
        j += 1;
    }
    None
}

/// Resolve a single trimmed token (the text between `{{` and `}}`).
fn resolve_token(token: &str, ctx: &TemplateCtx) -> String {
    if token == "input" {
        return ctx.input.clone();
    }
    if let Some(id) = token.strip_prefix("nodes.") {
        return ctx.nodes.get(id).cloned().unwrap_or_default();
    }
    if let Some(key) = token.strip_prefix("state.") {
        return ctx.state.get(key).cloned().unwrap_or_default();
    }
    if let Some(path) = token.strip_prefix("trigger.") {
        return resolve_trigger(path, ctx);
    }
    // Unknown token kind → empty.
    String::new()
}

/// Parse `state["trigger"]` as JSON and index it with a dotted path. A string
/// leaf is returned unquoted; any other leaf is JSON-serialised. Missing key,
/// parse failure, or a path miss all yield the empty string.
fn resolve_trigger(path: &str, ctx: &TemplateCtx) -> String {
    let Some(raw) = ctx.state.get("trigger") else {
        return String::new();
    };
    let Ok(root) = serde_json::from_str::<serde_json::Value>(raw) else {
        return String::new();
    };
    let mut cur = &root;
    for segment in path.split('.') {
        if segment.is_empty() {
            return String::new();
        }
        match cur.get(segment) {
            Some(next) => cur = next,
            None => return String::new(),
        }
    }
    match cur {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> TemplateCtx {
        let mut nodes = HashMap::new();
        nodes.insert("classify".to_string(), "spam".to_string());
        let mut state = HashMap::new();
        state.insert("count".to_string(), "3".to_string());
        state.insert(
            "trigger".to_string(),
            r#"{"body":{"email":"a@b.com","n":7},"flag":true}"#.to_string(),
        );
        TemplateCtx {
            input: "hello".to_string(),
            nodes,
            state,
        }
    }

    #[test]
    fn resolves_input_token() {
        assert_eq!(resolve("say: {{input}}", &ctx()), "say: hello");
        // Whitespace inside the braces is trimmed.
        assert_eq!(resolve("{{ input }}", &ctx()), "hello");
    }

    #[test]
    fn resolves_node_output() {
        assert_eq!(
            resolve("verdict={{nodes.classify}}", &ctx()),
            "verdict=spam"
        );
    }

    #[test]
    fn resolves_state_key() {
        assert_eq!(resolve("n={{state.count}}", &ctx()), "n=3");
    }

    #[test]
    fn missing_keys_are_empty() {
        assert_eq!(resolve("[{{nodes.ghost}}]", &ctx()), "[]");
        assert_eq!(resolve("[{{state.nope}}]", &ctx()), "[]");
        assert_eq!(resolve("[{{unknown}}]", &ctx()), "[]");
        assert_eq!(resolve("[{{trigger.body.missing}}]", &ctx()), "[]");
    }

    #[test]
    fn resolves_trigger_json_path() {
        // String leaf comes back unquoted.
        assert_eq!(resolve("{{trigger.body.email}}", &ctx()), "a@b.com");
        // Non-string leaf is JSON-serialised.
        assert_eq!(resolve("{{trigger.body.n}}", &ctx()), "7");
        assert_eq!(resolve("{{trigger.flag}}", &ctx()), "true");
    }

    #[test]
    fn trigger_empty_when_no_payload() {
        let mut c = ctx();
        c.state.remove("trigger");
        assert_eq!(resolve("{{trigger.body.email}}", &c), "");
    }

    #[test]
    fn passes_through_non_tokens_and_unterminated() {
        assert_eq!(resolve("plain text", &ctx()), "plain text");
        // Unterminated `{{` is copied verbatim.
        assert_eq!(resolve("a {{ b", &ctx()), "a {{ b");
        // Multiple tokens in one string.
        assert_eq!(resolve("{{input}}/{{state.count}}", &ctx()), "hello/3");
    }
}
