//! Item request bodies, views and outcomes.
// test-exempt: moved verbatim out of vault/items/mod.rs; covered by items/tests.rs, cards_tests.rs and add_field_tests.rs.

use super::*;

/// Which stored values a `PUT` caller may have compared against the values it
/// supplies when the item already exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PutAccess {
    /// May see non-sensitive values (`use` or `read`).
    pub plain: bool,
    /// May see sensitive values (`read`).
    pub sensitive: bool,
}

impl PutAccess {
    /// Every value may be compared.
    pub const FULL: Self = Self {
        plain: true,
        sensitive: true,
    };

    pub(super) fn may_compare(self, def: &FieldDef) -> bool {
        if def.sensitive {
            self.sensitive
        } else {
            self.plain || self.sensitive
        }
    }
}

/// Constant-time equality over SHA-256 digests, so the comparison time does
/// not depend on the length or content of either value.
pub(super) fn digest_eq(left: &str, right: &str) -> bool {
    use sha2::{Digest, Sha256};
    let (left, right) = (
        Sha256::digest(left.as_bytes()),
        Sha256::digest(right.as_bytes()),
    );
    left.iter()
        .zip(right.iter())
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

/// Which events an item timeline read returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventScope {
    /// Only the item currently at the coordinates (none when there is none).
    CurrentItem,
    /// Every item that has lived at the coordinates, including deleted ones.
    History,
}

/// Create or confirm an item (`PUT`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemPut {
    #[serde(default)]
    pub environment: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    /// Free-form kind slug such as `login` or `api_client`; default `generic`.
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// The field schema. Omitted for `card` items, whose schema is fixed.
    #[serde(default)]
    pub fields: Vec<FieldDefInput>,
    /// Initial values by field name.
    #[serde(default)]
    pub values: BTreeMap<String, String>,
    /// Merchant host allowlist (`card` items only).
    #[serde(default)]
    pub merchants: Option<Vec<String>>,
}

/// Change values or the description (`PATCH`). Field definitions are
/// immutable; omitted fields keep their value and `null` clears one.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemPatch {
    #[serde(default)]
    pub environment: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    pub expected_version: i64,
    pub expected_id: String,
    /// Absent keeps it, `null` clears it.
    #[serde(default, deserialize_with = "present")]
    pub description: Option<Option<String>>,
    #[serde(default)]
    pub values: BTreeMap<String, Option<String>>,
    /// Replace the merchant host allowlist (`card` items only).
    #[serde(default)]
    pub merchants: Option<Vec<String>>,
}

/// Distinguish an explicit `null` from an absent key.
fn present<'de, D, T>(deserializer: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// One field in a read: its definition, whether it has a value, and the
/// value itself only for non-sensitive fields when the caller may see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldView {
    #[serde(flatten)]
    pub def: FieldDef,
    pub has_value: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

/// An item as returned by reads and writes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemView {
    pub id: String,
    pub environment: String,
    pub path: String,
    pub key: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub version: i64,
    pub status: ItemStatus,
    pub fields: Vec<FieldView>,
    /// Operations the item currently supports (`collect` while values are
    /// missing, `reveal` once any value is set).
    pub available_operations: Vec<&'static str>,
    /// Brand, last4, expiry, and merchants of a `card` item.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card: Option<cards::CardSummary>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A listing row (no values).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemSummary {
    pub id: String,
    pub environment: String,
    pub path: String,
    pub key: String,
    pub kind: String,
    pub version: i64,
    pub status: ItemStatus,
    pub field_count: usize,
    /// Brand, last4, expiry, and merchants of a `card` item.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card: Option<cards::CardSummary>,
    pub updated_at: i64,
}

/// One timeline entry. `data` carries field names, never values.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemEvent {
    pub seq: i64,
    pub item_id: String,
    pub name: String,
    pub version: i64,
    pub actor_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub data: Value,
    pub created_at: i64,
}

/// Result of a `PUT`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PutOutcome {
    Created,
    Unchanged,
}
