//! Item field types, coordinates and name rules.
// test-exempt: moved verbatim out of vault/items/mod.rs; covered by items/tests.rs, cards_tests.rs and add_field_tests.rs.

use super::*;

/// Field value type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldType {
    Text,
    Email,
    Url,
    Password,
    Totp,
    Note,
}

impl FieldType {
    /// Types whose values are always sensitive.
    pub(super) fn always_sensitive(self) -> bool {
        matches!(self, Self::Password | Self::Totp)
    }
}

/// One field definition as submitted.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldDefInput {
    pub name: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(rename = "type")]
    pub field_type: FieldType,
    #[serde(default)]
    pub required: bool,
    /// Defaults to `true` for `password`/`totp`, `false` otherwise.
    #[serde(default)]
    pub sensitive: Option<bool>,
}

/// One normalized, stored field definition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldDef {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(rename = "type")]
    pub field_type: FieldType,
    pub required: bool,
    pub sensitive: bool,
}

/// Item status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemStatus {
    PendingCollection,
    Ready,
}

impl ItemStatus {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::PendingCollection => "pending_collection",
            Self::Ready => "ready",
        }
    }

    pub(super) fn parse(value: &str) -> Self {
        if value == "ready" {
            Self::Ready
        } else {
            Self::PendingCollection
        }
    }
}

/// Where an item lives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemCoords {
    pub environment: String,
    pub path: String,
    pub key: String,
}

impl ItemCoords {
    /// Validate and normalize coordinates. `environment` defaults to
    /// `default` and `path` to the root folder.
    pub fn new(environment: Option<&str>, path: Option<&str>, key: &str) -> Result<Self> {
        let environment = environment
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(crate::vault::DEFAULT_ENVIRONMENT);
        if !is_valid_environment(environment) {
            return Err(VaultError::Invalid(format!("invalid environment `{environment}`")).into());
        }
        let path = normalize_path(path.unwrap_or(crate::vault::ROOT_PATH))
            .ok_or_else(|| VaultError::Invalid("invalid folder path".into()))?;
        if !is_valid_item_key(key) {
            return Err(VaultError::Invalid(
                "item keys are 1-255 characters of letters, digits, `.`, `_`, or `-`".into(),
            )
            .into());
        }
        Ok(Self {
            environment: environment.to_owned(),
            path,
            key: key.to_owned(),
        })
    }

    /// The reserved policy key for this item.
    pub fn policy_key(&self) -> String {
        policy_key(&self.environment, &self.path, &self.key)
    }
}

/// The policy key `sys/items/ENV/folder/KEY` (no slash before a root key).
pub fn policy_key(environment: &str, path: &str, key: &str) -> String {
    format!(
        "{}/items/{}",
        crate::vault::SYS_PREFIX,
        crate::vault::policy_key(environment, path, key)
    )
}

/// Whether `key` matches `^[a-zA-Z0-9._-]{1,255}$` and is not `.`/`..`.
pub fn is_valid_item_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= MAX_KEY_LEN
        && key != "."
        && key != ".."
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

pub(super) fn is_valid_field_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_FIELD_NAME_LEN
        && bytes[0].is_ascii_alphabetic()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

pub(super) fn is_valid_kind(kind: &str) -> bool {
    let bytes = kind.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_KIND_LEN
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-'))
}

pub(super) fn invalid(message: impl Into<String>) -> anyhow::Error {
    VaultError::Invalid(message.into()).into()
}
