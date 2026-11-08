//! Service auth rules: how the broker authenticates a matched request.
//! test-exempt: moved out of services.rs; services/tests.rs and proxy_tests.rs cover parsing, validation, and injection of every auth type.

use std::collections::BTreeMap;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use super::MAX_CUSTOM_HEADERS;
use crate::vault::broker::oauth::OAuthBinding;
use crate::vault::broker::substitute;

/// How the broker authenticates a matched request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServiceAuth {
    /// `Authorization: Bearer <token>`.
    Bearer { token: String },
    /// `Authorization: Basic base64(username:password)`; the username may be a
    /// literal or a reference.
    Basic { username: String, password: String },
    /// `<header>: <prefix><value>`.
    ApiKey {
        header: String,
        value: String,
        #[serde(default)]
        prefix: String,
    },
    /// Header templates with `{{secret:REF}}` tokens.
    Custom { headers: BTreeMap<String, String> },
    /// No injection; the request is forwarded as sent (placeholders still
    /// substitute).
    Passthrough,
    /// `Authorization: Bearer <access token>` from a connected MCP OAuth
    /// binding, refreshed before it expires.
    #[serde(rename = "oauth")]
    OAuth(OAuthBinding),
}

impl ServiceAuth {
    /// Short kind name for listings and discovery.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Bearer { .. } => "bearer",
            Self::Basic { .. } => "basic",
            Self::ApiKey { .. } => "api_key",
            Self::Custom { .. } => "custom",
            Self::Passthrough => "passthrough",
            Self::OAuth(_) => "oauth",
        }
    }

    /// Every `secret:` reference the rule uses.
    pub fn refs(&self) -> Vec<String> {
        match self {
            Self::Bearer { token } => vec![token.clone()],
            Self::Basic { username, password } => {
                let mut refs = vec![password.clone()];
                if substitute::is_credential_ref(username) {
                    refs.push(username.clone());
                }
                refs
            }
            Self::ApiKey { value, .. } => vec![value.clone()],
            Self::Custom { headers } => headers
                .values()
                .flat_map(|template| substitute::parse_template(template).unwrap_or_default())
                .filter_map(|segment| match segment {
                    substitute::Segment::Ref(reference) => Some(reference),
                    substitute::Segment::Literal(_) => None,
                })
                .collect(),
            Self::Passthrough | Self::OAuth(_) => Vec::new(),
        }
    }

    /// The OAuth binding, for an OAuth rule.
    pub fn oauth(&self) -> Option<&OAuthBinding> {
        match self {
            Self::OAuth(binding) => Some(binding),
            _ => None,
        }
    }

    /// Replace every reference that is a key of `map` with its value.
    pub fn replace_refs(&mut self, map: &BTreeMap<String, String>) {
        let swap = |reference: &mut String| {
            if let Some(replacement) = map.get(reference.as_str()) {
                reference.clone_from(replacement);
            }
        };
        match self {
            Self::Bearer { token } => swap(token),
            Self::Basic { username, password } => {
                swap(password);
                if substitute::is_credential_ref(username) {
                    swap(username);
                }
            }
            Self::ApiKey { value, .. } => swap(value),
            Self::Custom { headers } => {
                for template in headers.values_mut() {
                    let Ok(segments) = substitute::parse_template(template) else {
                        continue;
                    };
                    if !segments.iter().any(|segment| {
                        matches!(segment, substitute::Segment::Ref(r) if map.contains_key(r))
                    }) {
                        continue;
                    }
                    *template = segments
                        .into_iter()
                        .map(|segment| match segment {
                            substitute::Segment::Literal(text) => text,
                            substitute::Segment::Ref(reference) => {
                                format!("{{{{{}}}}}", map.get(&reference).unwrap_or(&reference))
                            }
                        })
                        .collect();
                }
            }
            Self::Passthrough | Self::OAuth(_) => {}
        }
    }

    /// Header names this rule sets (lowercase).
    pub fn header_names(&self) -> Vec<String> {
        match self {
            Self::Bearer { .. } | Self::Basic { .. } | Self::OAuth(_) => {
                vec!["authorization".to_owned()]
            }
            Self::ApiKey { header, .. } => vec![header.to_ascii_lowercase()],
            Self::Custom { headers } => headers.keys().map(|h| h.to_ascii_lowercase()).collect(),
            Self::Passthrough => Vec::new(),
        }
    }

    pub(super) fn validate(&self) -> Result<()> {
        match self {
            Self::Bearer { token } => substitute::validate_ref(token),
            Self::Basic { username, password } => {
                substitute::validate_ref(password)?;
                if substitute::is_credential_ref(username) {
                    substitute::validate_ref(username)
                } else if username.contains(':') || !substitute::is_safe_header_value(username) {
                    bail!("basic username must not contain `:` or control characters")
                } else {
                    Ok(())
                }
            }
            Self::ApiKey {
                header,
                value,
                prefix,
            } => {
                validate_header_name(header)?;
                if !substitute::is_safe_header_value(prefix) || prefix.len() > 64 {
                    bail!("api key prefix is invalid");
                }
                substitute::validate_ref(value)
            }
            Self::Custom { headers } => {
                if headers.is_empty() || headers.len() > MAX_CUSTOM_HEADERS {
                    bail!("custom auth needs 1-{MAX_CUSTOM_HEADERS} headers");
                }
                for (name, template) in headers {
                    validate_header_name(name)?;
                    if !substitute::is_safe_header_value(template) || template.len() > 1024 {
                        bail!("header template for `{name}` is invalid");
                    }
                    substitute::parse_template(template)?;
                }
                Ok(())
            }
            Self::Passthrough => Ok(()),
            Self::OAuth(binding) => binding.validate(),
        }
    }
}

/// Headers the broker owns or that are connection-scoped; a rule cannot set
/// them.
pub const RESERVED_HEADERS: &[&str] = &[
    "host",
    "connection",
    "proxy-authorization",
    "proxy-authenticate",
    "proxy-connection",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
];

fn validate_header_name(name: &str) -> Result<()> {
    let lower = name.to_ascii_lowercase();
    if hyper::header::HeaderName::from_bytes(lower.as_bytes()).is_err()
        || RESERVED_HEADERS.contains(&lower.as_str())
    {
        bail!("header `{name}` cannot be set by a broker service");
    }
    Ok(())
}
