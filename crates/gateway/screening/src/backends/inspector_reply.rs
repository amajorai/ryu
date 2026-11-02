//! Reading an LLM judge's reply: the balanced JSON scan, the verdict parser
//! and the classification of non-answers (part of [`super`]).
//!
//! Only a reply that states `flagged` is a verdict. A refusal, a content
//! filter stop, an empty or cut-off reply, a missing `flagged` key or a
//! verdict that contradicts itself is a non-answer, never a clean verdict, so
//! callers can fail closed or run a deterministic backstop.

use serde_json::Value;

/// The judge's parsed verdict.
#[derive(Debug, Clone, PartialEq)]
pub struct JudgeVerdict {
    pub flagged: bool,
    pub categories: Vec<String>,
    pub reason: String,
}

/// Why a reply holds no usable verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseFailure {
    /// No JSON object stating `flagged` (prose, `{}`, `{"reason": ...}`).
    NoVerdict,
    /// A flagged verdict naming only words outside the vocabulary: a small
    /// judge returning topic words (`birthday`) is summarising, not judging.
    OffVocabulary,
    /// A clean verdict that names an in-vocabulary category.
    Contradictory,
}

/// How a chat-completions reply from the judge reads.
#[derive(Debug, Clone, PartialEq)]
pub enum JudgeReply {
    Verdict(JudgeVerdict),
    /// The judge or its provider refused: a `message.refusal`, a
    /// `content_filter` stop, empty content, or refusal prose.
    Refused(&'static str),
    /// A verdict-shaped non-answer: a JSON object without `flagged`, a
    /// contradictory verdict, or a clean verdict cut off by `length`.
    Malformed(&'static str),
    /// Prose with no JSON object at all that does not read as a refusal.
    Unparseable,
    /// See [`ParseFailure::OffVocabulary`].
    OffVocabulary,
}

/// One JSON object from the reply, read leniently: small judges write
/// `"flagged": "true"`, `"categories": "pii"` or `"reason": null`, and a type
/// slip must not drop a flag (or turn a plain clean answer into a non-answer).
#[derive(Debug)]
struct RawVerdict {
    /// Required: a missing key (or a value that is not a yes/no) is no
    /// verdict, never `false`.
    flagged: Option<bool>,
    categories: Vec<String>,
    reason: String,
}

fn yes_no(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(flag) => Some(*flag),
        Value::String(word) => match word.trim().to_ascii_lowercase().as_str() {
            "true" | "yes" => Some(true),
            "false" | "no" => Some(false),
            _ => None,
        },
        Value::Number(n) => match n.as_u64() {
            Some(1) => Some(true),
            Some(0) => Some(false),
            _ => None,
        },
        _ => None,
    }
}

impl RawVerdict {
    fn read(object: &str) -> Option<Self> {
        let Value::Object(map) = serde_json::from_str::<Value>(object).ok()? else {
            return None;
        };
        let categories = match map.get("categories") {
            Some(Value::String(one)) => vec![one.clone()],
            Some(Value::Array(items)) => items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect(),
            _ => Vec::new(),
        };
        Some(Self {
            flagged: map.get("flagged").and_then(yes_no),
            categories,
            reason: map
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        })
    }
}

/// The vocabulary the built-in inspector prompt declares.
const KNOWN: [&str; 3] = ["injection", "pii", "secret"];
/// Labels judges use for the same thing (`jailbreak`, `prompt_attack`).
const ALIASES: [(&str, &str); 2] = [("jailbreak", "injection"), ("prompt", "injection")];

/// The canonical vocabulary word a category label names, if any. Compared
/// case-insensitively and by containment, so `PII`, `pii_leakage`,
/// `prompt-injection` and `jailbreak` all count.
pub fn canonical_category(c: &str) -> Option<&'static str> {
    let c = c.trim().to_ascii_lowercase();
    if c.is_empty() {
        return None;
    }
    KNOWN
        .into_iter()
        .find(|k| c.contains(k) || k.contains(c.as_str()))
        .or_else(|| {
            ALIASES
                .into_iter()
                .find(|(alias, _)| c.contains(alias))
                .map(|(_, word)| word)
        })
}

/// Whether a category label is in the declared vocabulary.
pub fn is_known_category(c: &str) -> bool {
    canonical_category(c).is_some()
}

/// Byte length of the balanced JSON object `s` starts with (`s` begins with
/// `{`), honouring strings and escapes. `None` when it never closes.
fn balanced_len(s: &str) -> Option<usize> {
    let (mut depth, mut in_string, mut escaped) = (0usize, false, false);
    for (i, ch) in s.char_indices() {
        if in_string {
            match (escaped, ch) {
                (true, _) => escaped = false,
                (false, '\\') => escaped = true,
                (false, '"') => in_string = false,
                _ => {}
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
    }
    None
}

/// Every balanced top-level `{...}` object in `s`, in order.
pub fn json_objects(s: &str) -> impl Iterator<Item = &str> {
    let mut pos = 0;
    std::iter::from_fn(move || loop {
        let start = pos + s.get(pos..)?.find('{')?;
        match balanced_len(&s[start..]) {
            Some(len) => {
                pos = start + len;
                return Some(&s[start..start + len]);
            }
            None => pos = start + 1,
        }
    })
}

/// The first balanced JSON object in `s`.
pub fn extract_json_object(s: &str) -> Option<&str> {
    json_objects(s).next()
}

/// Parse the judge's reply, saying why when it holds no verdict. Every
/// object that states `flagged` counts and a flag wins, so a clean object
/// echoed from the inspected text cannot mask the judge's own flag.
pub fn parse_verdict_detail(
    text: &str,
    restrict_categories: bool,
) -> Result<JudgeVerdict, ParseFailure> {
    let candidates: Vec<(bool, RawVerdict)> = json_objects(text)
        .filter_map(RawVerdict::read)
        .filter_map(|raw| raw.flagged.map(|flagged| (flagged, raw)))
        .collect();
    if candidates.is_empty() {
        return Err(ParseFailure::NoVerdict);
    }
    let mut flagged = candidates.iter().filter(|(f, _)| *f).peekable();
    if flagged.peek().is_some() {
        let mut categories: Vec<String> = Vec::new();
        let mut reason = String::new();
        for (_, raw) in flagged {
            for c in &raw.categories {
                if !categories.contains(c) {
                    categories.push(c.clone());
                }
            }
            if reason.is_empty() {
                reason.clone_from(&raw.reason);
            }
        }
        if restrict_categories
            && !categories.is_empty()
            && !categories.iter().any(|c| is_known_category(c))
        {
            return Err(ParseFailure::OffVocabulary);
        }
        return Ok(JudgeVerdict {
            flagged: true,
            categories,
            reason,
        });
    }
    if restrict_categories
        && candidates
            .iter()
            .any(|(_, raw)| raw.categories.iter().any(|c| is_known_category(c)))
    {
        return Err(ParseFailure::Contradictory);
    }
    let (_, first) = &candidates[0];
    Ok(JudgeVerdict {
        flagged: false,
        categories: first.categories.clone(),
        reason: first.reason.clone(),
    })
}

/// [`parse_verdict_detail`] without the reason.
pub fn parse_verdict(text: &str, restrict_categories: bool) -> Option<JudgeVerdict> {
    parse_verdict_detail(text, restrict_categories).ok()
}

/// Phrases of a refusal written as prose instead of a verdict.
const REFUSAL_MARKERS: [&str; 16] = [
    "can't",
    "can\u{2019}t",
    "cannot",
    "can not",
    "won't",
    "will not",
    "sorry",
    "unable to",
    "not able to",
    "as an ai",
    "decline",
    "refuse",
    "not comfortable",
    "against my",
    "not allowed",
    "not permitted",
];

fn looks_like_refusal(content: &str) -> bool {
    let head: String = content.chars().take(240).collect::<String>().to_lowercase();
    REFUSAL_MARKERS.iter().any(|marker| head.contains(marker))
}

/// Classify a chat-completions reply from the judge. Only a parsed verdict
/// is an answer; a refusal or an unusable reply is never clean.
pub fn classify_reply(response: &Value, restrict_categories: bool) -> JudgeReply {
    let choice = &response["choices"][0];
    if choice["message"]["refusal"]
        .as_str()
        .is_some_and(|r| !r.trim().is_empty())
    {
        return JudgeReply::Refused("refusal");
    }
    let finish = choice["finish_reason"].as_str().unwrap_or("");
    if finish == "content_filter" {
        return JudgeReply::Refused("content_filter");
    }
    let content = choice["message"]["content"].as_str().unwrap_or("");
    if content.trim().is_empty() {
        return JudgeReply::Refused("empty");
    }
    match parse_verdict_detail(content, restrict_categories) {
        Ok(verdict) if !verdict.flagged && finish == "length" => JudgeReply::Malformed("length"),
        Ok(verdict) => JudgeReply::Verdict(verdict),
        Err(ParseFailure::OffVocabulary) => JudgeReply::OffVocabulary,
        Err(ParseFailure::Contradictory) => JudgeReply::Malformed("contradictory"),
        Err(ParseFailure::NoVerdict) if looks_like_refusal(content) => {
            JudgeReply::Refused("refusal")
        }
        // A reply cut off by the token limit, or a JSON object that never
        // closes (padding steered the judge into a long reason until the
        // flag was cut), is a verdict-shaped non-answer, not plain prose.
        Err(ParseFailure::NoVerdict) if finish == "length" => JudgeReply::Malformed("length"),
        Err(ParseFailure::NoVerdict) if content.contains('{') => {
            JudgeReply::Malformed("no_verdict")
        }
        Err(ParseFailure::NoVerdict) => JudgeReply::Unparseable,
    }
}
