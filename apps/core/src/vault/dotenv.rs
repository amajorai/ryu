//! `.env`, JSON, YAML, shell, and Kubernetes formats for import and export.
//!
//! Parsing follows the common dotenv dialect: `KEY=value`, optional `export `,
//! `#` comments, single quotes (literal), double quotes (with `\n`, `\t`,
//! `\"`, `\\` escapes and multi-line values), and inline `#` comments after
//! unquoted values.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Export format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Format {
    Dotenv,
    Json,
    Yaml,
    /// `export KEY='value'` lines for `eval`.
    Shell,
    /// A Kubernetes `Secret` manifest (`data` base64-encoded).
    K8sSecret,
}

impl Format {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "dotenv" | "env" => Some(Self::Dotenv),
            "json" => Some(Self::Json),
            "yaml" | "yml" => Some(Self::Yaml),
            "shell" | "sh" => Some(Self::Shell),
            "k8s-secret" | "k8s" | "kubernetes" => Some(Self::K8sSecret),
            _ => None,
        }
    }

    pub fn content_type(self) -> &'static str {
        match self {
            Self::Json => "application/json",
            Self::Yaml | Self::K8sSecret => "application/yaml",
            Self::Dotenv | Self::Shell => "text/plain",
        }
    }
}

/// Parse `.env` text into ordered pairs. Later duplicates win.
pub fn parse(text: &str) -> Result<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    let mut lines = text.lines().enumerate().peekable();
    while let Some((index, raw)) = lines.next() {
        let line = raw.trim_start();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, rest)) = line.split_once('=') else {
            bail!("line {}: expected KEY=value", index + 1);
        };
        let key = key.trim();
        if !crate::plugin_secrets::is_valid_vault_secret_name(key) {
            bail!("line {}: `{key}` is not a valid secret name", index + 1);
        }
        let rest = rest.trim_start();
        let value = if let Some(body) = rest.strip_prefix('\'') {
            let end = body
                .find('\'')
                .ok_or_else(|| anyhow!("line {}: unterminated single quote", index + 1))?;
            body[..end].to_owned()
        } else if let Some(body) = rest.strip_prefix('"') {
            let mut collected = body.to_owned();
            loop {
                if let Some(end) = closing_quote(&collected) {
                    collected.truncate(end);
                    break;
                }
                let Some((_, next)) = lines.next() else {
                    bail!("line {}: unterminated double quote", index + 1);
                };
                collected.push('\n');
                collected.push_str(next);
            }
            unescape(&collected)
        } else {
            let value = match rest.find(" #") {
                Some(at) => &rest[..at],
                None => rest,
            };
            value.trim_end().to_owned()
        };
        out.insert(key.to_owned(), value);
    }
    Ok(out)
}

fn closing_quote(text: &str) -> Option<usize> {
    let mut escaped = false;
    for (index, ch) in text.char_indices() {
        match ch {
            '\\' if !escaped => escaped = true,
            '"' if !escaped => return Some(index),
            _ => escaped = false,
        }
    }
    None
}

fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

/// Parse a JSON object of string values (numbers and booleans are stringified).
pub fn parse_json(text: &str) -> Result<BTreeMap<String, String>> {
    let value: Value = serde_json::from_str(text)?;
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("expected a JSON object"))?;
    let mut out = BTreeMap::new();
    for (key, value) in object {
        if !crate::plugin_secrets::is_valid_vault_secret_name(key) {
            bail!("`{key}` is not a valid secret name");
        }
        let value = match value {
            Value::String(text) => text.clone(),
            Value::Number(number) => number.to_string(),
            Value::Bool(flag) => flag.to_string(),
            _ => bail!("`{key}` must be a string, number, or boolean"),
        };
        out.insert(key.clone(), value);
    }
    Ok(out)
}

fn double_quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

fn single_quote_shell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Options for the Kubernetes manifest.
#[derive(Debug, Clone, Default)]
pub struct K8sOptions {
    pub name: Option<String>,
    pub namespace: Option<String>,
}

/// Serialize values in `format`.
pub fn serialize(
    values: &BTreeMap<String, String>,
    format: Format,
    k8s: &K8sOptions,
) -> Result<String> {
    Ok(match format {
        Format::Dotenv => values
            .iter()
            .map(|(key, value)| format!("{key}={}\n", double_quote(value)))
            .collect(),
        Format::Shell => values
            .iter()
            .map(|(key, value)| format!("export {key}={}\n", single_quote_shell(value)))
            .collect(),
        Format::Json => format!("{}\n", serde_json::to_string_pretty(values)?),
        Format::Yaml => values
            .iter()
            .map(|(key, value)| format!("{key}: {}\n", double_quote(value)))
            .collect(),
        Format::K8sSecret => {
            let name = k8s.name.as_deref().unwrap_or("ryu-secrets");
            let mut out = format!(
                "apiVersion: v1\nkind: Secret\nmetadata:\n  name: {}\n",
                double_quote(name)
            );
            if let Some(namespace) = &k8s.namespace {
                out.push_str(&format!("  namespace: {}\n", double_quote(namespace)));
            }
            out.push_str("type: Opaque\ndata:\n");
            for (key, value) in values {
                out.push_str(&format!(
                    "  {key}: {}\n",
                    base64::engine::general_purpose::STANDARD.encode(value)
                ));
            }
            out
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_common_dialect() {
        let text = r#"
# comment
export A=plain # trailing
B='single $literal'
C="line1\nline2 \"q\""
D="multi
line"
E=
"#;
        let parsed = parse(text).unwrap();
        assert_eq!(parsed["A"], "plain");
        assert_eq!(parsed["B"], "single $literal");
        assert_eq!(parsed["C"], "line1\nline2 \"q\"");
        assert_eq!(parsed["D"], "multi\nline");
        assert_eq!(parsed["E"], "");
        assert!(parse("lower-case=1").is_err());
        assert!(parse("A=\"open").is_err());
    }

    #[test]
    fn dotenv_round_trips() {
        let values = BTreeMap::from([
            ("A".to_owned(), "x \"y\"\nz\\".to_owned()),
            ("B".to_owned(), String::new()),
        ]);
        let text = serialize(&values, Format::Dotenv, &K8sOptions::default()).unwrap();
        assert_eq!(parse(&text).unwrap(), values);
    }

    #[test]
    fn shell_and_k8s_outputs_are_safe() {
        let values = BTreeMap::from([("A".to_owned(), "it's".to_owned())]);
        assert_eq!(
            serialize(&values, Format::Shell, &K8sOptions::default()).unwrap(),
            "export A='it'\\''s'\n"
        );
        let manifest = serialize(
            &values,
            Format::K8sSecret,
            &K8sOptions {
                name: Some("app".into()),
                namespace: Some("prod".into()),
            },
        )
        .unwrap();
        assert!(manifest.contains("kind: Secret"));
        assert!(manifest.contains("  A: aXQncw==\n"));
        assert!(manifest.contains("namespace: \"prod\""));
    }

    #[test]
    fn json_objects_parse_scalars() {
        let parsed = parse_json(r#"{"A":"x","B":2,"C":true}"#).unwrap();
        assert_eq!(parsed["B"], "2");
        assert!(parse_json(r#"{"A":{}}"#).is_err());
    }
}
