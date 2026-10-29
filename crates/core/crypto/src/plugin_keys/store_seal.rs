//! [`StoreSeal`]: how one store seals, decided when it opens.

use anyhow::{anyhow, Result};

use super::COMPAT_HEALTH;
use crate::{ContentCipher, ContentContext};

/// How one store seals, decided when it opens.
#[derive(Clone)]
pub enum StoreSeal {
    /// A key is held and matches the store: seal on write, open on read.
    Sealing(ContentCipher),
    /// No key and the store was never sealed: plaintext as before phase 2.
    Compat,
    /// Sealed under a key this process does not hold, or sealed data and no
    /// key: writes are refused; legacy plaintext still reads.
    Unhealthy(String),
}

impl std::fmt::Debug for StoreSeal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.label())
    }
}

impl StoreSeal {
    pub(super) fn mismatch(store: &str) -> Self {
        tracing::error!(
            store = %store,
            "content store was sealed under a different key; refusing writes"
        );
        Self::Unhealthy(format!(
            "{store} is sealed under a different key than this process holds; writes are \
             refused to protect it"
        ))
    }

    /// A short state name for health output.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Sealing(_) => "ok",
            Self::Compat => "compat",
            Self::Unhealthy(_) => "unhealthy",
        }
    }

    /// The health item: `{state, detail?}`.
    pub fn health(&self) -> serde_json::Value {
        match self {
            Self::Sealing(_) => serde_json::json!({ "state": "ok" }),
            Self::Compat => serde_json::json!({ "state": "compat", "detail": COMPAT_HEALTH }),
            Self::Unhealthy(reason) => {
                serde_json::json!({ "state": "unhealthy", "detail": reason })
            }
        }
    }

    /// The cipher, when sealing.
    pub fn cipher(&self) -> Option<&ContentCipher> {
        match self {
            Self::Sealing(cipher) => Some(cipher),
            _ => None,
        }
    }

    /// Whether values are sealed on write.
    pub fn is_sealing(&self) -> bool {
        matches!(self, Self::Sealing(_))
    }

    /// Refuse a write on an unhealthy store.
    pub fn ensure_writable(&self) -> Result<()> {
        match self {
            Self::Unhealthy(reason) => Err(anyhow!("{reason}")),
            _ => Ok(()),
        }
    }

    /// Seal a TEXT value (compat: stored as is, except that a value starting
    /// with `encb:` gets the [`crate::COMPAT_ESCAPE`] prefix so an
    /// envelope lookalike stays readable and sealable later; unhealthy:
    /// refused).
    pub fn seal_text(&self, value: &str, context: &ContentContext) -> Result<String> {
        match self {
            Self::Sealing(cipher) => cipher.seal_text(value, context),
            Self::Compat if value.starts_with("encb:") => {
                Ok(format!("{}{value}", crate::COMPAT_ESCAPE))
            }
            Self::Compat => Ok(value.to_owned()),
            Self::Unhealthy(reason) => Err(anyhow!("{reason}")),
        }
    }

    /// [`Self::seal_text`] for an optional value.
    pub fn seal_opt(
        &self,
        value: Option<&str>,
        context: &ContentContext,
    ) -> Result<Option<String>> {
        value
            .map(|value| self.seal_text(value, context))
            .transpose()
    }

    /// Open a TEXT value, also reporting whether it should be written back
    /// sealed (legacy plaintext or a retired key).
    pub fn open_text_detailed(
        &self,
        stored: &str,
        context: &ContentContext,
    ) -> Result<(String, bool)> {
        // A compat-mode escape (`encb:raw:`) is legacy plaintext: strip it, and
        // write the inner value back sealed once a key is held.
        if let Some(inner) = stored.strip_prefix(crate::COMPAT_ESCAPE) {
            return Ok((inner.to_owned(), self.is_sealing()));
        }
        match self {
            Self::Sealing(cipher) => {
                let opened = cipher.open_text(stored, context)?;
                Ok((opened.value, opened.needs_reseal))
            }
            _ if ContentCipher::is_sealed_text(stored) => Err(anyhow!(
                "a sealed value cannot be opened: this process has no key for it"
            )),
            _ => Ok((stored.to_owned(), false)),
        }
    }

    /// Open a TEXT value.
    pub fn open_text(&self, stored: &str, context: &ContentContext) -> Result<String> {
        self.open_text_detailed(stored, context)
            .map(|(value, _)| value)
    }

    /// [`Self::open_text`] for an optional value.
    pub fn open_opt(
        &self,
        stored: Option<&str>,
        context: &ContentContext,
    ) -> Result<Option<String>> {
        stored
            .map(|stored| self.open_text(stored, context))
            .transpose()
    }

    /// Seal a BLOB value (compat: stored as is, but a value that starts with a
    /// Ryu envelope header is refused because it could never be read back;
    /// unhealthy: refused).
    pub fn seal_bytes(&self, value: &[u8], context: &ContentContext) -> Result<Vec<u8>> {
        match self {
            Self::Sealing(cipher) => cipher.seal_bytes(value, context),
            Self::Compat if ContentCipher::is_sealed_bytes(value) => Err(anyhow!(
                "a value that starts with a Ryu content envelope header cannot be stored \
                 without a key"
            )),
            Self::Compat => Ok(value.to_vec()),
            Self::Unhealthy(reason) => Err(anyhow!("{reason}")),
        }
    }

    /// Open a BLOB value.
    pub fn open_bytes(&self, stored: &[u8], context: &ContentContext) -> Result<Vec<u8>> {
        match self {
            Self::Sealing(cipher) => Ok(cipher.open_bytes(stored, context)?.value),
            _ if ContentCipher::is_sealed_bytes(stored) => Err(anyhow!(
                "a sealed value cannot be opened: this process has no key for it"
            )),
            _ => Ok(stored.to_vec()),
        }
    }
}
