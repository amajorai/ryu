//! Transit `batchInput`: many items through one operation, as Vault's
//! `batch_input`.
//!
//! Each item runs as its own call (same checks, same audit row, same
//! fail-closed behavior as the single operation) and gets its own result: the
//! output field, or `error` with the reason that item failed. One bad item
//! never fails the rest. A batch is refused as a whole only when it is empty,
//! longer than [`MAX_BATCH_ITEMS`], or the operation does not batch. An
//! item's `reference` is echoed back so callers can match results to inputs.

use super::*;

/// Most items one batch may carry.
pub const MAX_BATCH_ITEMS: usize = 1000;

/// One `batchInput` item. Fields an item leaves out fall back to the
/// request's top-level value (`context`, `associatedData`, `keyVersion`,
/// `signatureAlgorithm`, `macLength`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TransitBatchItem {
    pub plaintext: Option<String>,
    pub ciphertext: Option<String>,
    pub input: Option<String>,
    pub signature: Option<String>,
    pub hmac: Option<String>,
    pub cmac: Option<String>,
    pub context: Option<String>,
    pub associated_data: Option<String>,
    pub key_version: Option<u32>,
    pub signature_algorithm: Option<String>,
    pub mac_length: Option<u32>,
    /// Opaque caller value echoed in the item's result.
    pub reference: Option<String>,
}

/// One item's result: its output, or `error`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitBatchResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ciphertext: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plaintext: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hmac: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cmac: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl TransitBatchResult {
    /// Whether this item failed.
    pub fn is_error(&self) -> bool {
        self.error.is_some()
    }
}

/// Operations that accept `batchInput`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransitBatchOp {
    Encrypt,
    Decrypt,
    Rewrap,
    Sign,
    Verify,
    Hmac,
    Cmac,
    CmacVerify,
}

impl TransitBatchOp {
    /// The batchable operation named by a route segment.
    pub fn parse(op: &str) -> Option<Self> {
        Some(match op {
            "encrypt" => Self::Encrypt,
            "decrypt" => Self::Decrypt,
            "rewrap" => Self::Rewrap,
            "sign" => Self::Sign,
            "verify" => Self::Verify,
            "hmac" => Self::Hmac,
            "cmac" => Self::Cmac,
            "cmac-verify" => Self::CmacVerify,
            _ => return None,
        })
    }
}

/// The text an item's `error` carries: a typed vault refusal as the single
/// operation would report it, a storage failure without its details.
fn item_error(error: &anyhow::Error) -> String {
    if let Some(vault) = error.downcast_ref::<VaultError>() {
        return vault.to_string();
    }
    if error.downcast_ref::<rusqlite::Error>().is_some() {
        tracing::warn!("transit batch storage error: {error:#}");
        return "vault_internal: storage error".to_owned();
    }
    format!("vault_invalid_request: {error:#}")
}

fn required<'a>(value: &'a Option<String>, field: &str) -> Result<&'a str> {
    value
        .as_deref()
        .ok_or_else(|| invalid(format!("`{field}` is required")))
}

/// What one item produced.
enum Output {
    Ciphertext(String),
    Plaintext(String),
    Signature(String),
    Hmac(String),
    Cmac(String),
    Valid(bool),
}

impl PluginSecretStore {
    /// Run `op` once per item of a batch. `Err` only for a batch that is
    /// refused as a whole; per-item failures are in the results.
    pub async fn transit_batch(
        &self,
        name: &str,
        op: TransitBatchOp,
        items: &[TransitBatchItem],
        defaults: &TransitBatchItem,
        actor: &AuditActor,
    ) -> Result<Vec<TransitBatchResult>> {
        if items.is_empty() {
            return Err(invalid("batchInput must not be empty"));
        }
        if items.len() > MAX_BATCH_ITEMS {
            return Err(invalid(format!(
                "batchInput carries at most {MAX_BATCH_ITEMS} items"
            )));
        }
        let mut results = Vec::with_capacity(items.len());
        for item in items {
            let outcome = self
                .transit_batch_item(name, op, item, defaults, actor)
                .await;
            let mut result = TransitBatchResult {
                reference: item.reference.clone(),
                ..TransitBatchResult::default()
            };
            match outcome {
                Ok(Output::Ciphertext(value)) => result.ciphertext = Some(value),
                Ok(Output::Plaintext(value)) => result.plaintext = Some(value),
                Ok(Output::Signature(value)) => result.signature = Some(value),
                Ok(Output::Hmac(value)) => result.hmac = Some(value),
                Ok(Output::Cmac(value)) => result.cmac = Some(value),
                Ok(Output::Valid(value)) => result.valid = Some(value),
                Err(error) => result.error = Some(item_error(&error)),
            }
            results.push(result);
        }
        Ok(results)
    }

    async fn transit_batch_item(
        &self,
        name: &str,
        op: TransitBatchOp,
        item: &TransitBatchItem,
        defaults: &TransitBatchItem,
        actor: &AuditActor,
    ) -> Result<Output> {
        let options = TransitOpOptions {
            context: item.context.clone().or_else(|| defaults.context.clone()),
            associated_data: item
                .associated_data
                .clone()
                .or_else(|| defaults.associated_data.clone()),
            key_version: item.key_version.or(defaults.key_version),
            signature_algorithm: item
                .signature_algorithm
                .clone()
                .or_else(|| defaults.signature_algorithm.clone()),
        };
        Ok(match op {
            TransitBatchOp::Encrypt => Output::Ciphertext(
                self.transit_encrypt_with(
                    name,
                    required(&item.plaintext, "plaintext")?,
                    &options,
                    actor,
                )
                .await?,
            ),
            TransitBatchOp::Decrypt => Output::Plaintext(
                self.transit_decrypt_with(
                    name,
                    required(&item.ciphertext, "ciphertext")?,
                    &options,
                    actor,
                )
                .await?,
            ),
            TransitBatchOp::Rewrap => Output::Ciphertext(
                self.transit_rewrap_with(
                    name,
                    required(&item.ciphertext, "ciphertext")?,
                    &options,
                    actor,
                )
                .await?,
            ),
            TransitBatchOp::Sign => Output::Signature(
                self.transit_sign_with(name, required(&item.input, "input")?, &options, actor)
                    .await?,
            ),
            TransitBatchOp::Verify => {
                let input = required(&item.input, "input")?;
                Output::Valid(match (&item.signature, &item.hmac, &item.cmac) {
                    (Some(signature), None, None) => {
                        self.transit_verify_with(name, input, signature, &options, actor)
                            .await?
                    }
                    (None, Some(hmac), None) => {
                        self.transit_verify_hmac(name, input, hmac, actor).await?
                    }
                    (None, None, Some(cmac)) => {
                        self.transit_verify_cmac(name, input, cmac, actor).await?
                    }
                    _ => {
                        return Err(invalid(
                            "each item needs exactly one of signature, hmac, or cmac",
                        ))
                    }
                })
            }
            TransitBatchOp::Hmac => Output::Hmac(
                self.transit_hmac_with(name, required(&item.input, "input")?, &options, actor)
                    .await?,
            ),
            TransitBatchOp::Cmac => Output::Cmac(
                self.transit_cmac(
                    name,
                    required(&item.input, "input")?,
                    options.key_version,
                    item.mac_length.or(defaults.mac_length),
                    actor,
                )
                .await?,
            ),
            TransitBatchOp::CmacVerify => Output::Valid(
                self.transit_verify_cmac(
                    name,
                    required(&item.input, "input")?,
                    required(&item.cmac, "cmac")?,
                    actor,
                )
                .await?,
            ),
        })
    }
}
