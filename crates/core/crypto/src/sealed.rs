//! Store-facing helpers built on the ciphers: one [`SecretSealer`] trait over
//! every cipher, master-key conveniences ([`seal_str`], [`open_str`]), the
//! [`SealedString`] serde newtype for config structs, the
//! [`StandaloneCryptoHost`] for processes that are not Core, and the
//! [`redact`] helpers for HTTP surfaces.
//!
//! Migration contract, the same for every store: reads accept legacy plaintext
//! and sealed values; writes always seal and fail closed without a key; a store
//! that can cheaply rewrite itself reseals legacy plaintext once on open
//! ([`SecretSealer::reseal_if_plaintext`]).

use std::marker::PhantomData;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;

use crate::{
    component_cipher_for_process, components, global_cipher, looks_sealed, ComponentCipher,
    CryptoHost, FieldCipher, PluginCipher,
};

/// A value opened from storage, plus whether it should be sealed again.
#[derive(Clone, PartialEq, Eq)]
pub struct Opened {
    /// The plaintext.
    pub value: String,
    /// True when the stored form was legacy plaintext: the caller should write
    /// the value back sealed.
    pub needs_reseal: bool,
}

impl std::fmt::Debug for Opened {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Opened")
            .field("value", &"<redacted>")
            .field("needs_reseal", &self.needs_reseal)
            .finish()
    }
}

/// One interface over [`FieldCipher`] (`enc:v1:`), [`PluginCipher`]
/// (`encp:v1:`) and [`ComponentCipher`] (`encc:v1:`), so store code is written
/// once whichever key a process holds.
pub trait SecretSealer: Send + Sync {
    /// Seal a plaintext into this cipher's envelope.
    fn seal(&self, plaintext: &str) -> Result<String>;
    /// Open a stored value; legacy plaintext is returned verbatim.
    fn open(&self, stored: &str) -> Result<String>;
    /// Whether `stored` carries THIS cipher's envelope.
    fn is_sealed(&self, stored: &str) -> bool;

    /// [`Self::open`], also reporting whether the stored form was plaintext.
    fn open_tracking(&self, stored: &str) -> Result<Opened> {
        Ok(Opened {
            value: self.open(stored)?,
            needs_reseal: !stored.is_empty() && !self.is_sealed(stored),
        })
    }

    /// The sealed form of a stored value that is still legacy plaintext, or
    /// `None` when it is already sealed (or empty). Idempotent, so a store can
    /// run it over every row on open.
    fn reseal_if_plaintext(&self, stored: &str) -> Result<Option<String>> {
        if stored.is_empty() || self.is_sealed(stored) {
            return Ok(None);
        }
        // Never wrap another scheme's envelope: open() refuses it, so fail here.
        let plaintext = self.open(stored)?;
        self.seal(&plaintext).map(Some)
    }
}

impl SecretSealer for FieldCipher {
    fn seal(&self, plaintext: &str) -> Result<String> {
        FieldCipher::seal(self, plaintext)
    }
    fn open(&self, stored: &str) -> Result<String> {
        if !FieldCipher::is_sealed(stored) && looks_sealed(stored) {
            anyhow::bail!("value is sealed under a subkey, not the master key");
        }
        FieldCipher::open(self, stored)
    }
    fn is_sealed(&self, stored: &str) -> bool {
        FieldCipher::is_sealed(stored)
    }
    /// Also reports `needs_reseal` for a value only a retired key opened.
    fn open_tracking(&self, stored: &str) -> Result<Opened> {
        if !FieldCipher::is_sealed(stored) && looks_sealed(stored) {
            anyhow::bail!("value is sealed under a subkey, not the master key");
        }
        self.open_detailed(stored)
    }
}

impl SecretSealer for PluginCipher {
    fn seal(&self, plaintext: &str) -> Result<String> {
        PluginCipher::seal(self, plaintext)
    }
    fn open(&self, stored: &str) -> Result<String> {
        if !PluginCipher::is_sealed(stored) && looks_sealed(stored) {
            anyhow::bail!(
                "value is sealed under another key scheme, not plugin '{}''s subkey",
                self.plugin_id()
            );
        }
        PluginCipher::open(self, stored)
    }
    fn is_sealed(&self, stored: &str) -> bool {
        PluginCipher::is_sealed(stored)
    }
}

impl SecretSealer for ComponentCipher {
    fn seal(&self, plaintext: &str) -> Result<String> {
        ComponentCipher::seal(self, plaintext)
    }
    fn open(&self, stored: &str) -> Result<String> {
        ComponentCipher::open(self, stored)
    }
    fn is_sealed(&self, stored: &str) -> bool {
        ComponentCipher::is_sealed(stored)
    }
}

// ── Master-key conveniences (processes that hold the master key) ─────────────

/// Seal with the process master key (`enc:v1:`). Fails closed without a key.
pub fn seal_str(plaintext: &str) -> Result<String> {
    global_cipher()?.seal(plaintext)
}

/// Open a value sealed by [`seal_str`]. Legacy plaintext is returned without
/// resolving the key at all, so readers of not-yet-migrated stores keep working
/// on a host whose key is unavailable; a sealed value without a key is an error.
pub fn open_str(stored: &str) -> Result<String> {
    open_str_tracking(stored).map(|opened| opened.value)
}

/// [`open_str`], also reporting whether the stored form was legacy plaintext.
pub fn open_str_tracking(stored: &str) -> Result<Opened> {
    if !looks_sealed(stored) {
        return Ok(Opened {
            value: stored.to_owned(),
            needs_reseal: !stored.is_empty(),
        });
    }
    SecretSealer::open_tracking(&global_cipher()?, stored)
}

// ── Serde newtype ─────────────────────────────────────────────────────────────

/// Which key a [`SealedString`] seals with. Implement it for a new store scope
/// with one function; [`MasterScope`] and [`GatewayScope`] are provided.
pub trait SealScope {
    /// The sealer for this scope. Errors when no key is available.
    fn sealer() -> Result<Arc<dyn SecretSealer>>;
}

/// The process master key (`enc:v1:`): Core, desktop, CLI tools.
pub struct MasterScope;

impl SealScope for MasterScope {
    fn sealer() -> Result<Arc<dyn SecretSealer>> {
        Ok(Arc::new(global_cipher()?))
    }
}

/// The Gateway's component subkey (`encc:v1:`), however the Gateway process
/// got it (delivered by Core, or derived by a standalone Gateway).
pub struct GatewayScope;

impl SealScope for GatewayScope {
    fn sealer() -> Result<Arc<dyn SecretSealer>> {
        Ok(Arc::new(component_cipher_for_process(components::GATEWAY)?))
    }
}

/// A secret string field that is sealed when serialized and opened when
/// deserialized, for config structs (`toml`, `serde_json`).
///
/// * Serializing seals with `S`'s key (a fresh nonce each time) and fails
///   closed when the key is unavailable. An empty string stays empty, so
///   "unset" keeps its meaning.
/// * Deserializing accepts the sealed form and legacy plaintext. Plaintext needs
///   no key and marks the value [`Self::needs_reseal`]; the next save seals it.
/// * `Debug` never prints the value; there is no `Display`.
pub struct SealedString<S: SealScope = MasterScope> {
    value: String,
    needs_reseal: bool,
    scope: PhantomData<fn() -> S>,
}

impl<S: SealScope> SealedString<S> {
    /// Wrap a plaintext secret.
    pub fn new(value: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            needs_reseal: false,
            scope: PhantomData,
        }
    }

    /// The plaintext. Named so every read of a secret is easy to find.
    pub fn expose_secret(&self) -> &str {
        &self.value
    }

    /// Consume into the plaintext.
    pub fn into_secret(self) -> String {
        self.value
    }

    /// Whether the value is empty ("unset").
    pub fn is_empty(&self) -> bool {
        self.value.is_empty()
    }

    /// True when this value was read from legacy plaintext, so the file holding
    /// it should be saved again (which seals it).
    pub fn needs_reseal(&self) -> bool {
        self.needs_reseal
    }

    /// The HTTP-safe view: [`redact::REDACTED`] when set, `""` when unset.
    pub fn redacted(&self) -> &'static str {
        redact::redact(&self.value)
    }
}

impl<S: SealScope> Clone for SealedString<S> {
    fn clone(&self) -> Self {
        Self {
            value: self.value.clone(),
            needs_reseal: self.needs_reseal,
            scope: PhantomData,
        }
    }
}

impl<S: SealScope> Default for SealedString<S> {
    fn default() -> Self {
        Self::new(String::new())
    }
}

impl<S: SealScope> PartialEq for SealedString<S> {
    fn eq(&self, other: &Self) -> bool {
        self.value == other.value
    }
}

impl<S: SealScope> Eq for SealedString<S> {}

impl<S: SealScope> std::fmt::Debug for SealedString<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.value.is_empty() {
            f.write_str("SealedString(<empty>)")
        } else {
            f.write_str("SealedString(<redacted>)")
        }
    }
}

impl<S: SealScope> From<String> for SealedString<S> {
    fn from(value: String) -> Self {
        Self::new(value)
    }
}

impl<S: SealScope> From<&str> for SealedString<S> {
    fn from(value: &str) -> Self {
        Self::new(value)
    }
}

impl<S: SealScope> serde::Serialize for SealedString<S> {
    fn serialize<Ser: serde::Serializer>(&self, serializer: Ser) -> Result<Ser::Ok, Ser::Error> {
        if self.value.is_empty() {
            return serializer.serialize_str("");
        }
        let sealed = S::sealer()
            .and_then(|sealer| sealer.seal(&self.value))
            .map_err(|error| {
                serde::ser::Error::custom(format!("refusing to write a secret unsealed: {error}"))
            })?;
        serializer.serialize_str(&sealed)
    }
}

impl<'de, S: SealScope> serde::Deserialize<'de> for SealedString<S> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let stored = String::deserialize(deserializer)?;
        if !looks_sealed(&stored) {
            return Ok(Self {
                needs_reseal: !stored.is_empty(),
                value: stored,
                scope: PhantomData,
            });
        }
        let value = S::sealer()
            .and_then(|sealer| sealer.open(&stored))
            .map_err(|error| {
                serde::de::Error::custom(format!("opening a sealed secret: {error}"))
            })?;
        Ok(Self {
            value,
            needs_reseal: false,
            scope: PhantomData,
        })
    }
}

// ── Standalone host ───────────────────────────────────────────────────────────

/// A [`CryptoHost`] for a Ryu process that is not Core (a standalone Gateway,
/// the desktop shell, a CLI tool, a satellite run by hand). It resolves the SAME
/// profile-scoped keychain slot (`master-key{suffix}`) and data dir Core uses,
/// so it reads what Core sealed.
pub struct StandaloneCryptoHost {
    ryu_dir: PathBuf,
    suffix: String,
}

impl StandaloneCryptoHost {
    /// Profile from `RYU_PROFILE`, data dir from `RYU_DIR` / the data-path
    /// pointer / `~/.ryu{suffix}` (the same resolution Core's children use).
    pub fn from_env() -> Self {
        Self::with_dir(ryu_sidecar_runtime::ryu_dir())
    }

    /// An explicit data dir (the desktop resolves its own); profile from
    /// `RYU_PROFILE`.
    pub fn with_dir(ryu_dir: PathBuf) -> Self {
        Self {
            ryu_dir,
            suffix: ryu_sidecar_runtime::active_profile_suffix(),
        }
    }

    /// An explicit data dir AND keychain-account suffix, for a process whose
    /// profile resolution is richer than `RYU_PROFILE` (the desktop also honors
    /// its `dev-variant` build and its version's channel).
    pub fn with_dir_and_suffix(ryu_dir: PathBuf, suffix: String) -> Self {
        Self { ryu_dir, suffix }
    }
}

impl CryptoHost for StandaloneCryptoHost {
    fn keyring_account_suffix(&self) -> String {
        self.suffix.clone()
    }

    fn ryu_dir(&self) -> PathBuf {
        self.ryu_dir.clone()
    }
}

/// Install [`StandaloneCryptoHost::from_env`] as the process host. A no-op when
/// a host is already installed (Core's own host always wins in-process).
pub fn install_standalone_host() {
    crate::set_global_host(Arc::new(StandaloneCryptoHost::from_env()));
}

// ── Redaction for HTTP surfaces ───────────────────────────────────────────────

/// Never return a stored secret to an HTTP client. A GET answers with
/// [`REDACTED`](redact::REDACTED); a PUT that sends a placeholder back keeps the
/// stored value ([`keep_if_redacted`](redact::keep_if_redacted)).
pub mod redact {
    /// The placeholder a GET returns for a set secret. Matches the existing
    /// MCP-server mask, so clients need to recognize only one.
    pub const REDACTED: &str = "••••••";

    /// The GET view of a secret: [`REDACTED`] when set, `""` when unset.
    pub fn redact(value: &str) -> &'static str {
        if value.is_empty() {
            ""
        } else {
            REDACTED
        }
    }

    /// The GET view of an optional secret.
    pub fn redact_opt(value: Option<&str>) -> Option<&'static str> {
        value.filter(|value| !value.is_empty()).map(|_| REDACTED)
    }

    /// Whether a client sent a placeholder rather than a new value: a non-empty
    /// string made only of `•` and `*` (covers [`REDACTED`], `***`, `********`).
    pub fn is_placeholder(value: &str) -> bool {
        let value = value.trim();
        !value.is_empty() && value.chars().all(|c| c == '•' || c == '*')
    }

    /// Merge a PUT: a placeholder keeps `current`; anything else replaces it.
    /// Whether an empty string clears the secret is the caller's decision.
    pub fn keep_if_redacted(incoming: String, current: Option<&str>) -> Option<String> {
        if is_placeholder(&incoming) {
            current.map(str::to_owned)
        } else {
            Some(incoming)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [3u8; 32];

    /// A scope with a fixed test key, so these tests never resolve the process
    /// master key or touch a keychain.
    struct TestScope;
    impl SealScope for TestScope {
        fn sealer() -> Result<Arc<dyn SecretSealer>> {
            Ok(Arc::new(FieldCipher::new(&KEY)))
        }
    }

    /// A scope whose key is unavailable.
    struct NoKeyScope;
    impl SealScope for NoKeyScope {
        fn sealer() -> Result<Arc<dyn SecretSealer>> {
            anyhow::bail!("no key")
        }
    }

    #[derive(serde::Serialize, serde::Deserialize)]
    struct Config {
        name: String,
        #[serde(default, skip_serializing_if = "SealedString::is_empty")]
        api_key: SealedString<TestScope>,
        #[serde(default)]
        token: Option<SealedString<TestScope>>,
    }

    #[test]
    fn sealed_string_round_trips_and_keeps_the_secret_off_disk() {
        let config = Config {
            name: "openai".into(),
            api_key: "sk-live-abc123".into(),
            token: Some("tok-xyz".into()),
        };
        let toml = toml::to_string(&config).unwrap();
        assert!(!toml.contains("sk-live-abc123"));
        assert!(!toml.contains("tok-xyz"));
        assert!(toml.contains("enc:v1:"));
        let back: Config = toml::from_str(&toml).unwrap();
        assert_eq!(back.api_key.expose_secret(), "sk-live-abc123");
        assert_eq!(back.token.unwrap().expose_secret(), "tok-xyz");
        assert!(!back.api_key.needs_reseal());
    }

    #[test]
    fn sealed_string_reads_legacy_plaintext_and_flags_it_for_reseal() {
        let legacy = "name = \"openai\"\napi_key = \"sk-legacy\"\n";
        let config: Config = toml::from_str(legacy).unwrap();
        assert_eq!(config.api_key.expose_secret(), "sk-legacy");
        assert!(config.api_key.needs_reseal());
        // Saving again seals it (the migration write).
        let migrated = toml::to_string(&config).unwrap();
        assert!(!migrated.contains("sk-legacy"));
        let reread: Config = toml::from_str(&migrated).unwrap();
        assert_eq!(reread.api_key.expose_secret(), "sk-legacy");
        assert!(!reread.api_key.needs_reseal());
    }

    #[test]
    fn sealed_string_fails_closed_without_a_key_and_keeps_empty_unset() {
        let secret: SealedString<NoKeyScope> = "sk".into();
        assert!(serde_json::to_string(&secret).is_err());
        let empty: SealedString<NoKeyScope> = SealedString::default();
        assert_eq!(serde_json::to_string(&empty).unwrap(), "\"\"");
        // A legacy plaintext read needs no key; a sealed one does.
        let legacy: SealedString<NoKeyScope> = serde_json::from_str("\"plain\"").unwrap();
        assert_eq!(legacy.expose_secret(), "plain");
        let sealed = serde_json::to_string(&FieldCipher::new(&KEY).seal("x").unwrap()).unwrap();
        // An unset field is omitted entirely and reads back as unset.
        let unset = Config {
            name: "n".into(),
            api_key: SealedString::default(),
            token: None,
        };
        let written = toml::to_string(&unset).unwrap();
        assert!(!written.contains("api_key"));
        assert!(toml::from_str::<Config>(&written)
            .unwrap()
            .api_key
            .is_empty());
        assert!(serde_json::from_str::<SealedString<NoKeyScope>>(&sealed).is_err());
    }

    #[test]
    fn sealed_string_debug_and_redacted_never_show_the_value() {
        let secret: SealedString<TestScope> = "sk-live-abc123".into();
        assert!(!format!("{secret:?}").contains("sk-live"));
        assert_eq!(secret.redacted(), redact::REDACTED);
        assert_eq!(SealedString::<TestScope>::default().redacted(), "");
    }

    #[test]
    fn reseal_if_plaintext_is_idempotent_and_never_double_wraps() {
        let cipher = FieldCipher::new(&KEY);
        let sealed = cipher.reseal_if_plaintext("legacy").unwrap().unwrap();
        assert_eq!(SecretSealer::open(&cipher, &sealed).unwrap(), "legacy");
        assert!(cipher.reseal_if_plaintext(&sealed).unwrap().is_none());
        assert!(cipher.reseal_if_plaintext("").unwrap().is_none());
        // Another scheme's envelope is refused rather than sealed as text.
        assert!(cipher.reseal_if_plaintext("encc:v1:AAAA").is_err());
        let opened = cipher.open_tracking("legacy").unwrap();
        assert!(opened.needs_reseal);
        assert!(!cipher.open_tracking(&sealed).unwrap().needs_reseal);
        assert!(!format!("{opened:?}").contains("legacy"));
    }

    #[test]
    fn open_str_passes_legacy_plaintext_through_without_a_key() {
        // No host is installed in this test binary for this path: plaintext must
        // not need one.
        let opened = open_str_tracking("plain-token").unwrap();
        assert_eq!(opened.value, "plain-token");
        assert!(opened.needs_reseal);
        assert!(!open_str_tracking("").unwrap().needs_reseal);
    }

    #[test]
    fn redaction_masks_gets_and_keeps_stored_values_on_placeholder_puts() {
        assert_eq!(redact::redact("sk-abc"), redact::REDACTED);
        assert_eq!(redact::redact(""), "");
        assert_eq!(redact::redact_opt(Some("x")), Some(redact::REDACTED));
        assert_eq!(redact::redact_opt(Some("")), None);
        for placeholder in [redact::REDACTED, "***", "********", " •••• "] {
            assert!(redact::is_placeholder(placeholder));
            assert_eq!(
                redact::keep_if_redacted(placeholder.into(), Some("stored")),
                Some("stored".into())
            );
        }
        assert!(!redact::is_placeholder(""));
        assert!(!redact::is_placeholder("sk-*"));
        assert_eq!(
            redact::keep_if_redacted("sk-new".into(), Some("stored")),
            Some("sk-new".into())
        );
    }

    #[test]
    fn standalone_host_uses_the_explicit_dir() {
        let dir = std::env::temp_dir().join("ryu-standalone-host-test");
        let host = StandaloneCryptoHost::with_dir(dir.clone());
        assert_eq!(host.ryu_dir(), dir);
        assert!(host.allow_file_key());
    }
}
