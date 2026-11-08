//! Value metadata: generators, [`SecretMetadata`], and its patch rules.

use super::*;

/// Character set for generated values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Charset {
    Alphanumeric,
    Hex,
    Base64url,
    Symbols,
}

/// How the scheduler can produce a new value for rotation.
///
/// Wire form: `{ "kind": "random", "length", "charset" }` or
/// `{ "kind": "random", "policy": "<password policy>" }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "GeneratorWire", into = "GeneratorWire")]
pub enum Generator {
    /// A random string of `length` characters from `charset`.
    Random { length: u16, charset: Charset },
    /// A value from a named password policy ([`crate::vault::password_policy`]).
    Policy { policy: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GeneratorWire {
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    length: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    charset: Option<Charset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    policy: Option<String>,
}

impl TryFrom<GeneratorWire> for Generator {
    type Error = String;

    fn try_from(wire: GeneratorWire) -> std::result::Result<Self, Self::Error> {
        if wire.kind != "random" {
            return Err(format!("unknown generator kind `{}`", wire.kind));
        }
        match (wire.policy, wire.length, wire.charset) {
            (Some(policy), None, None) => Ok(Self::Policy { policy }),
            (Some(_), _, _) => Err("a policy generator takes no length or charset".into()),
            (None, Some(length), Some(charset)) => Ok(Self::Random { length, charset }),
            (None, _, _) => Err("a random generator needs length and charset, or policy".into()),
        }
    }
}

impl From<Generator> for GeneratorWire {
    fn from(generator: Generator) -> Self {
        let (length, charset, policy) = match generator {
            Generator::Random { length, charset } => (Some(length), Some(charset), None),
            Generator::Policy { policy } => (None, None, Some(policy)),
        };
        Self {
            kind: "random".into(),
            length,
            charset,
            policy,
        }
    }
}

impl Generator {
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Random { length, .. } => {
                if !(8..=256).contains(length) {
                    bail!("generated values must be 8 to 256 characters");
                }
            }
            Self::Policy { policy } => {
                if !crate::vault::password_policy::is_valid_name(policy) {
                    bail!("invalid password policy name");
                }
            }
        }
        Ok(())
    }

    /// The password policy this generator uses, if any.
    pub fn policy_name(&self) -> Option<&str> {
        match self {
            Self::Policy { policy } => Some(policy),
            Self::Random { .. } => None,
        }
    }

    /// Produce a fresh value, reading a named policy from `conn`.
    pub fn generate_with(&self, conn: &Connection) -> Result<String> {
        match self {
            Self::Policy { policy } => crate::vault::password_policy::generate_locked(conn, policy),
            Self::Random { .. } => Ok(self.generate()),
        }
    }

    /// Produce a fresh inline value. A policy generator needs the store
    /// ([`Self::generate_with`]); here it yields an empty string, which every
    /// write path rejects, so it fails closed.
    pub fn generate(&self) -> String {
        use rand::Rng;
        match self {
            Self::Policy { .. } => String::new(),
            Self::Random { length, charset } => {
                let alphabet: &[u8] = match charset {
                    Charset::Alphanumeric => {
                        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
                    }
                    Charset::Hex => b"0123456789abcdef",
                    Charset::Base64url => {
                        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
                    }
                    Charset::Symbols => {
                        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#%+-.:=@^_~"
                    }
                };
                let mut rng = rand::thread_rng();
                (0..*length)
                    .map(|_| alphabet[rng.gen_range(0..alphabet.len())] as char)
                    .collect()
            }
        }
    }
}

/// How sensitive a value is. Every type resolves at run time the same way;
/// the type only decides whether plaintext may leave the vault. `Sealed` is
/// use-only: never revealed or exported, and never changed back.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValueType {
    /// Plain configuration; may be shown.
    Config,
    /// Masked until revealed (the default, and every value written before
    /// types existed).
    #[default]
    Secret,
    /// Use-only.
    Sealed,
}

impl ValueType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Config => "config",
            Self::Secret => "secret",
            Self::Sealed => "sealed",
        }
    }

    /// The stored column. An unknown type (written by a newer binary) reads
    /// as `Sealed`, so it fails closed.
    pub fn from_column(value: &str) -> Self {
        match value {
            "config" => Self::Config,
            "secret" => Self::Secret,
            _ => Self::Sealed,
        }
    }

    /// Whether a value of this type may be revealed or exported.
    pub fn is_revealable(self) -> bool {
        self != Self::Sealed
    }
}

/// The refusal for a reveal or export of a sealed value.
pub const SEALED_USE_ONLY: &str = "sealed values are use-only and cannot be revealed or exported";

/// Non-secret metadata carried by a value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretMetadata {
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Epoch millis after which the value is not resolved.
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub rotation_period_secs: Option<i64>,
    #[serde(default)]
    pub generator: Option<Generator>,
    #[serde(default)]
    pub expand_references: bool,
    #[serde(default = "default_max_versions")]
    pub max_versions: u32,
    /// Non-secret key/value annotations (KV v2 `custom_metadata`).
    #[serde(default)]
    pub custom_metadata: BTreeMap<String, String>,
    /// Value writes must carry `expectedVersion` (KV v2 `cas_required`).
    #[serde(default)]
    pub cas_required: bool,
    /// Non-current versions older than this are soft-deleted by the scheduler
    /// (KV v2 `delete_version_after`).
    #[serde(default)]
    pub delete_version_after_secs: Option<i64>,
    /// How sensitive the value is; see [`ValueType`].
    #[serde(default)]
    pub value_type: ValueType,
}

pub(super) fn default_max_versions() -> u32 {
    DEFAULT_MAX_VERSIONS
}

impl Default for SecretMetadata {
    fn default() -> Self {
        Self {
            description: String::new(),
            tags: Vec::new(),
            expires_at: None,
            rotation_period_secs: None,
            generator: None,
            expand_references: false,
            max_versions: DEFAULT_MAX_VERSIONS,
            custom_metadata: BTreeMap::new(),
            cas_required: false,
            delete_version_after_secs: None,
            value_type: ValueType::Secret,
        }
    }
}

pub(super) fn double_option<'de, D, T>(
    deserializer: D,
) -> std::result::Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// A partial metadata update. A missing field is unchanged; an explicit
/// `null` on a nullable field clears it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretMetadataPatch {
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub expires_at: Option<Option<i64>>,
    #[serde(default, deserialize_with = "double_option")]
    pub rotation_period_secs: Option<Option<i64>>,
    #[serde(default, deserialize_with = "double_option")]
    pub generator: Option<Option<Generator>>,
    #[serde(default)]
    pub expand_references: Option<bool>,
    #[serde(default)]
    pub max_versions: Option<u32>,
    /// Replaces the whole map; use the metadata merge patch to edit keys.
    #[serde(default)]
    pub custom_metadata: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub cas_required: Option<bool>,
    #[serde(default, deserialize_with = "double_option")]
    pub delete_version_after_secs: Option<Option<i64>>,
    /// A sealed value refuses any other type.
    #[serde(default)]
    pub value_type: Option<ValueType>,
}

impl SecretMetadataPatch {
    /// A patch that sets every field to `metadata` (import/copy).
    pub fn from_metadata(metadata: &SecretMetadata) -> Self {
        Self {
            description: Some(metadata.description.clone()),
            tags: Some(metadata.tags.clone()),
            expires_at: Some(metadata.expires_at),
            rotation_period_secs: Some(metadata.rotation_period_secs),
            generator: Some(metadata.generator.clone()),
            expand_references: Some(metadata.expand_references),
            max_versions: Some(metadata.max_versions),
            custom_metadata: Some(metadata.custom_metadata.clone()),
            cas_required: Some(metadata.cas_required),
            delete_version_after_secs: Some(metadata.delete_version_after_secs),
            value_type: Some(metadata.value_type),
        }
    }

    /// Apply onto `base`, validating the result.
    pub fn apply(&self, base: &SecretMetadata) -> Result<SecretMetadata> {
        let mut out = base.clone();
        if let Some(description) = &self.description {
            out.description = description.trim().to_owned();
        }
        if let Some(tags) = &self.tags {
            let mut unique: Vec<String> = Vec::new();
            for tag in tags {
                let tag = tag.trim().to_owned();
                if !tag.is_empty() && !unique.contains(&tag) {
                    unique.push(tag);
                }
            }
            out.tags = unique;
        }
        if let Some(expires_at) = self.expires_at {
            out.expires_at = expires_at;
        }
        if let Some(period) = self.rotation_period_secs {
            out.rotation_period_secs = period;
        }
        if let Some(generator) = &self.generator {
            out.generator = generator.clone();
        }
        if let Some(expand) = self.expand_references {
            out.expand_references = expand;
        }
        if let Some(max) = self.max_versions {
            out.max_versions = max;
        }
        if let Some(custom) = &self.custom_metadata {
            out.custom_metadata = custom.clone();
        }
        if let Some(required) = self.cas_required {
            out.cas_required = required;
        }
        if let Some(after) = self.delete_version_after_secs {
            out.delete_version_after_secs = after;
        }
        if let Some(value_type) = self.value_type {
            if base.value_type == ValueType::Sealed && value_type != ValueType::Sealed {
                bail!("a sealed value stays sealed");
            }
            out.value_type = value_type;
        }
        validate_metadata(&out)?;
        Ok(out)
    }

    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

pub(in crate::plugin_secrets) fn validate_metadata(metadata: &SecretMetadata) -> Result<()> {
    if metadata.description.len() > MAX_DESCRIPTION_LEN {
        bail!("description is longer than {MAX_DESCRIPTION_LEN} characters");
    }
    if metadata.tags.len() > MAX_TAGS
        || metadata
            .tags
            .iter()
            .any(|tag| tag.len() > MAX_TAG_LEN || tag.chars().any(char::is_control))
    {
        bail!("at most {MAX_TAGS} tags of up to {MAX_TAG_LEN} characters are allowed");
    }
    if metadata
        .rotation_period_secs
        .is_some_and(|period| period < MIN_ROTATION_PERIOD_SECS)
    {
        bail!("rotation period must be at least {MIN_ROTATION_PERIOD_SECS} seconds");
    }
    if let Some(generator) = &metadata.generator {
        generator.validate()?;
    }
    if !(1..=MAX_MAX_VERSIONS).contains(&metadata.max_versions) {
        bail!("maxVersions must be between 1 and {MAX_MAX_VERSIONS}");
    }
    if metadata.custom_metadata.len() > MAX_CUSTOM_METADATA_KEYS {
        bail!("customMetadata holds at most {MAX_CUSTOM_METADATA_KEYS} keys");
    }
    for (key, value) in &metadata.custom_metadata {
        if key.is_empty()
            || key.len() > MAX_CUSTOM_METADATA_KEY_LEN
            || key.chars().any(char::is_control)
        {
            bail!(
                "customMetadata keys must be 1-{MAX_CUSTOM_METADATA_KEY_LEN} bytes without control characters"
            );
        }
        if value.len() > MAX_CUSTOM_METADATA_VALUE_LEN {
            bail!("customMetadata values are at most {MAX_CUSTOM_METADATA_VALUE_LEN} bytes");
        }
    }
    if metadata.delete_version_after_secs.is_some_and(|after| {
        !(MIN_DELETE_VERSION_AFTER_SECS..=MAX_DELETE_VERSION_AFTER_SECS).contains(&after)
    }) {
        bail!(
            "deleteVersionAfterSecs must be between {MIN_DELETE_VERSION_AFTER_SECS} and {MAX_DELETE_VERSION_AFTER_SECS}"
        );
    }
    Ok(())
}
