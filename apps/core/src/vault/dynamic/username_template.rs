//! `usernameTemplate` for dynamic database credentials, a safe subset of
//! Vault's `username_template`.
//!
//! A template is literal text with `{{ … }}` actions. An action is a
//! pipeline: a value, then `| function args…` stages, each stage receiving the
//! previous value as its last argument (as Go templates do). Values are
//! `.RoleName`, `.DisplayName`, a quoted string, `random N` (N lowercase
//! letters and digits, 1–64), `uuid`, `unix_time`, and `unix_time_millis`.
//! Functions are `truncate N`, `lowercase`, `uppercase`, `replace "old"
//! "new"`, and `sha256` (hex). There are no conditionals, loops, variables, or
//! calls out: a template only ever produces a bounded string.
//!
//! Bounds: a template is at most 256 bytes with at most 16 actions, and every
//! intermediate value is at most 256 bytes. A template must include `random`
//! or `uuid` so two leases never collide on a name. The rendered name must
//! still satisfy the provider's own username rule (checked by the caller).

use anyhow::{bail, Result};
use sha2::{Digest, Sha256};

/// Longest template accepted.
pub const MAX_TEMPLATE_BYTES: usize = 256;
const MAX_ACTIONS: usize = 16;
const MAX_VALUE_BYTES: usize = 256;
const MAX_RANDOM: usize = 64;

/// What a template may refer to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TemplateContext {
    pub role_name: String,
    pub display_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    Field(String),
    Word(String),
    Number(usize),
    Text(String),
    Pipe,
}

fn tokenize(action: &str) -> Result<Vec<Token>> {
    let mut tokens = Vec::new();
    let mut chars = action.chars().peekable();
    while let Some(&ch) = chars.peek() {
        match ch {
            ' ' | '\t' => {
                chars.next();
            }
            '|' => {
                chars.next();
                tokens.push(Token::Pipe);
            }
            '"' => {
                chars.next();
                let mut text = String::new();
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') => match chars.next() {
                            Some(escaped @ ('"' | '\\')) => text.push(escaped),
                            _ => bail!("only \\\" and \\\\ escapes are allowed in strings"),
                        },
                        Some(other) => text.push(other),
                        None => bail!("unterminated string"),
                    }
                }
                tokens.push(Token::Text(text));
            }
            '.' | 'a'..='z' | 'A'..='Z' | '_' | '0'..='9' => {
                let mut word = String::new();
                while let Some(&next) = chars.peek() {
                    if next.is_ascii_alphanumeric() || next == '_' || next == '.' {
                        word.push(next);
                        chars.next();
                    } else {
                        break;
                    }
                }
                tokens.push(if let Some(field) = word.strip_prefix('.') {
                    Token::Field(field.to_owned())
                } else if word.bytes().all(|b| b.is_ascii_digit()) {
                    Token::Number(
                        word.parse()
                            .map_err(|_| anyhow::anyhow!("number too large"))?,
                    )
                } else {
                    Token::Word(word)
                });
            }
            other => bail!("unexpected `{other}` in a template action"),
        }
    }
    Ok(tokens)
}

fn bounded(value: String) -> Result<String> {
    if value.len() > MAX_VALUE_BYTES {
        bail!("a template value grew past {MAX_VALUE_BYTES} bytes");
    }
    Ok(value)
}

fn random_text(length: usize) -> String {
    use rand::Rng;
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..length)
        .map(|_| char::from(ALPHABET[rng.gen_range(0..ALPHABET.len())]))
        .collect()
}

/// Evaluate one stage. `input` is the previous stage's value (none for the
/// first). Returns the value and whether it drew on randomness.
fn stage(tokens: &[Token], input: Option<String>, ctx: &TemplateContext) -> Result<(String, bool)> {
    let (head, args) = tokens
        .split_first()
        .ok_or_else(|| anyhow::anyhow!("empty pipeline stage"))?;
    let number = |index: usize| match args.get(index) {
        Some(Token::Number(value)) => Ok(*value),
        _ => bail!("expected a number"),
    };
    let text = |index: usize| match args.get(index) {
        Some(Token::Text(value)) => Ok(value.clone()),
        _ => bail!("expected a quoted string"),
    };
    let piped = |arity: usize| -> Result<String> {
        if args.len() != arity {
            bail!("wrong number of arguments");
        }
        input
            .clone()
            .ok_or_else(|| anyhow::anyhow!("this function needs a piped value"))
    };
    let leaf = |arity: usize| -> Result<()> {
        if input.is_some() || args.len() != arity {
            bail!("this value takes {arity} argument(s) and no piped value");
        }
        Ok(())
    };
    let value = match head {
        Token::Field(name) => {
            leaf(0)?;
            match name.as_str() {
                "RoleName" => ctx.role_name.clone(),
                "DisplayName" => ctx.display_name.clone(),
                other => bail!("unknown field `.{other}` (use .RoleName or .DisplayName)"),
            }
        }
        Token::Text(value) => {
            leaf(0)?;
            value.clone()
        }
        Token::Word(word) => match word.as_str() {
            "random" => {
                leaf(1)?;
                let length = number(0)?;
                if !(1..=MAX_RANDOM).contains(&length) {
                    bail!("random takes a length from 1 to {MAX_RANDOM}");
                }
                return Ok((random_text(length), true));
            }
            "uuid" => {
                leaf(0)?;
                return Ok((uuid::Uuid::new_v4().to_string(), true));
            }
            "unix_time" => {
                leaf(0)?;
                (crate::vault::now_millis() / 1000).to_string()
            }
            "unix_time_millis" => {
                leaf(0)?;
                crate::vault::now_millis().to_string()
            }
            "truncate" => {
                let value = piped(1)?;
                let length = number(0)?;
                value.chars().take(length).collect()
            }
            "lowercase" => piped(0)?.to_lowercase(),
            "uppercase" => piped(0)?.to_uppercase(),
            "replace" => {
                let value = piped(2)?;
                let (old, new) = (text(0)?, text(1)?);
                if old.is_empty() {
                    bail!("replace needs a non-empty string to find");
                }
                value.replace(&old, &new)
            }
            "sha256" => hex::encode(Sha256::digest(piped(0)?.as_bytes())),
            other => bail!("unknown function `{other}`"),
        },
        Token::Number(_) | Token::Pipe => bail!("a stage must start with a value or function"),
    };
    Ok((bounded(value)?, false))
}

fn eval_action(action: &str, ctx: &TemplateContext) -> Result<(String, bool)> {
    let tokens = tokenize(action)?;
    let mut value = None;
    let mut random = false;
    for stage_tokens in tokens.split(|token| *token == Token::Pipe) {
        let (next, drew) = stage(stage_tokens, value.take(), ctx)?;
        random |= drew;
        value = Some(next);
    }
    value
        .ok_or_else(|| anyhow::anyhow!("empty action"))
        .map(|value| (value, random))
}

/// Render `template`. Errors name the problem but never echo values.
pub fn render(template: &str, ctx: &TemplateContext) -> Result<String> {
    if template.is_empty() || template.len() > MAX_TEMPLATE_BYTES {
        bail!("usernameTemplate must be 1-{MAX_TEMPLATE_BYTES} bytes");
    }
    let mut out = String::new();
    let mut rest = template;
    let mut actions = 0;
    let mut random = false;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after
            .find("}}")
            .ok_or_else(|| anyhow::anyhow!("unclosed `{{{{` in usernameTemplate"))?;
        actions += 1;
        if actions > MAX_ACTIONS {
            bail!("usernameTemplate has more than {MAX_ACTIONS} actions");
        }
        let (value, drew) = eval_action(&after[..end], ctx)
            .map_err(|error| anyhow::anyhow!("usernameTemplate: {error}"))?;
        random |= drew;
        out.push_str(&value);
        out = bounded(out)?;
        rest = &after[end + 2..];
    }
    if rest.contains("}}") {
        bail!("stray `}}}}` in usernameTemplate");
    }
    out.push_str(rest);
    if !random {
        bail!("usernameTemplate must include `random` or `uuid` so names stay unique");
    }
    bounded(out)
}

/// Render `template` and check the result against a provider's username
/// rule (`valid`) and length limit.
pub fn render_username(
    template: &str,
    ctx: &TemplateContext,
    max_len: usize,
    valid: impl Fn(&str) -> bool,
) -> Result<String> {
    let name = render(template, ctx)?;
    if name.is_empty() || name.len() > max_len {
        bail!(
            "usernameTemplate rendered a name of {} bytes (allowed 1-{max_len})",
            name.len()
        );
    }
    if !valid(&name) {
        bail!("usernameTemplate rendered a name with characters the provider does not allow");
    }
    Ok(name)
}
