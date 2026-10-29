//! Phase-2 content sealing: user content and PII at rest, bound to where it
//! lives.
//!
//! Every store derives its own key from the root key its process already holds
//! (the master key in Core, a plugin subkey in a satellite, a component subkey in
//! the Gateway or Shadow):
//!
//! ```text
//! content key K_s   = HKDF-SHA256(root, salt "ryu-content-crypto-v1",
//!                                 info "ryu-content-crypto-v1:" || store)
//! sub key     K_sub = HKDF-SHA256(K_s, salt "ryu-content-sub-v1",
//!                                 info "ryu-content-sub-v1:" || label)
//! ```
//!
//! Values are sealed with ChaCha20-Poly1305 under `K_s` and the associated data
//! of a [`ContentContext`] (store, purpose, and the stable ids of the record),
//! so a value copied to another row, column or store does not open:
//!
//! * TEXT: `"encb:v1:" + base64(nonce12 || ciphertext || tag16)`;
//! * BLOB: `b"RYU-CB01" || nonce12 || ciphertext || tag16`.
//!
//! Reads accept legacy plaintext ([`Opened::needs_reseal`] is then true), refuse
//! unknown envelope versions, and fall back to retired root keys on an AEAD
//! failure (also flagged `needs_reseal`). The test vectors in
//! `tests/vectors/content-v1.json` pin every format.

use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use rand::RngCore;

use crate::{b64, Opened, KEY_LEN, NONCE_LEN};

/// TEXT envelope prefix for content sealed under a store's content key.
pub const CONTENT_TEXT_PREFIX: &str = "encb:v1:";
/// Prefix shared by every version of the content TEXT envelope; an unknown
/// version (`encb:v2:` ...) is refused, never passed through as plaintext.
const CONTENT_TEXT_FAMILY: &str = "encb:";
/// Escape a keyless (compat) store puts in front of a plaintext TEXT value that
/// starts with [`CONTENT_TEXT_FAMILY`], so a user-typed lookalike such as
/// `encb:v1:hello` is never mistaken for an envelope once a key arrives. It is
/// not a versioned envelope, so [`ContentCipher::open_text`] reads it as legacy
/// plaintext; the store layer strips it on read and the migration
/// ([`crate::content_sqlite::migrate_columns`]) strips it before sealing.
pub const COMPAT_ESCAPE: &str = "encb:raw:";
/// BLOB envelope magic for content sealed under a store's content key.
pub const CONTENT_BYTES_MAGIC: &[u8; 8] = b"RYU-CB01";
/// Magic of a write-once sealed file (see [`crate::sealed_file`]).
pub const SEALED_FILE_MAGIC: &[u8; 8] = b"RYU-SF01";
/// Magic of an append-only sealed log (see [`crate::sealed_log`]).
pub const SEALED_LOG_MAGIC: &[u8; 8] = b"RYU-SL01";
/// The magics no plaintext passed to [`ContentCipher::seal_bytes`] may start
/// with: a Ryu envelope is never sealed twice.
pub const RYU_MAGICS: [&[u8; 8]; 3] = [CONTENT_BYTES_MAGIC, SEALED_FILE_MAGIC, SEALED_LOG_MAGIC];

const TAG_LEN: usize = 16;
const CONTENT_KDF_SALT: &[u8] = b"ryu-content-crypto-v1";
const CONTENT_KDF_INFO_PREFIX: &[u8] = b"ryu-content-crypto-v1:";
const SUB_KDF_SALT: &[u8] = b"ryu-content-sub-v1";
const SUB_KDF_INFO_PREFIX: &[u8] = b"ryu-content-sub-v1:";
const CONTENT_AAD_LABEL: &[u8] = b"ryu-content-seal-v1";
const WEBVIEW_KDF_SALT: &[u8] = b"ryu-webview-key-v1";
const WEBVIEW_KDF_INFO_PREFIX: &[u8] = b"ryu-webview-key-v1:";

/// Why a content value was refused. Carries no key or plaintext material;
/// callers downcast an `anyhow::Error` to it to count unreadable rows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ContentSealError {
    /// The value carries a content envelope of a version this build does not
    /// know (`encb:v2:`, `RYU-CB02` ...).
    UnknownVersion,
    /// The envelope is well formed but does not open under the current or any
    /// retired key for this context (moved, altered, or another key).
    DoesNotOpen,
    /// The envelope is truncated or not valid base64.
    Malformed,
    /// [`ContentCipher::seal_bytes`] was given bytes that already start with a
    /// Ryu magic (`RYU-CB01`, `RYU-SF01`, `RYU-SL01`).
    AlreadyARyuEnvelope,
}

impl std::fmt::Display for ContentSealError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::UnknownVersion => {
                "sealed content uses an envelope version this build cannot read \
                 (written by a newer Ryu?)"
            }
            Self::DoesNotOpen => {
                "sealed content does not open for this store, record and key (it was \
                 moved, altered, or sealed under another key)"
            }
            Self::Malformed => "sealed content has a malformed envelope",
            Self::AlreadyARyuEnvelope => {
                "refusing to seal bytes that already start with a Ryu envelope magic"
            }
        })
    }
}

impl std::error::Error for ContentSealError {}

/// Whether `error` is a [`ContentSealError`] (a row that does not open, as
/// opposed to an infrastructure failure).
pub fn is_content_seal_error(error: &anyhow::Error) -> bool {
    error.downcast_ref::<ContentSealError>().is_some()
}

/// Where a sealed value lives: a purpose (`<table>.<column>`, `<collection>.<field>`,
/// `file`, `blob`, `log`, `snapshot`, or a record kind) plus labelled stable ids
/// of the record. Bound into the AEAD associated data together with the store.
///
/// Use stable logical ids only: an explicit TEXT/UUID id, an explicit
/// `INTEGER PRIMARY KEY`, a content address, a run or meeting id. Never an
/// implicit rowid, never a file path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContentContext {
    purpose: String,
    fields: Vec<(&'static str, String)>,
}

impl ContentContext {
    /// A context for one purpose.
    pub fn new(purpose: impl Into<String>) -> Self {
        Self {
            purpose: purpose.into(),
            fields: Vec::new(),
        }
    }

    /// Bind one more labelled id. Order is significant.
    #[must_use]
    pub fn with(mut self, label: &'static str, value: impl Into<String>) -> Self {
        self.fields.push((label, value.into()));
        self
    }

    /// Shorthand for `ContentContext::new(purpose).with("id", id)`.
    pub fn for_id(purpose: impl Into<String>, id: impl ToString) -> Self {
        Self::new(purpose).with("id", id.to_string())
    }

    /// The purpose.
    pub fn purpose(&self) -> &str {
        &self.purpose
    }

    /// The canonical associated data for this context in `store`: every part
    /// `u64 BE length || bytes`, so no two contexts encode to the same bytes.
    pub fn associated_data(&self, store: &str) -> Vec<u8> {
        let mut out = Vec::with_capacity(
            96 + store.len()
                + self.purpose.len()
                + self
                    .fields
                    .iter()
                    .map(|(label, value)| 16 + label.len() + value.len())
                    .sum::<usize>(),
        );
        push_part(&mut out, CONTENT_AAD_LABEL);
        push_part(&mut out, b"store");
        push_part(&mut out, store.as_bytes());
        push_part(&mut out, b"purpose");
        push_part(&mut out, self.purpose.as_bytes());
        for (label, value) in &self.fields {
            push_part(&mut out, label.as_bytes());
            push_part(&mut out, value.as_bytes());
        }
        out
    }
}

fn push_part(out: &mut Vec<u8>, part: &[u8]) {
    out.extend_from_slice(&(part.len() as u64).to_be_bytes());
    out.extend_from_slice(part);
}

/// A BLOB value opened from storage, plus whether it should be sealed again.
#[derive(Clone, PartialEq, Eq)]
pub struct OpenedBytes {
    /// The plaintext bytes.
    pub value: Vec<u8>,
    /// True when the stored form was legacy plaintext or sealed under a retired
    /// key: the caller should write the value back sealed.
    pub needs_reseal: bool,
}

impl std::fmt::Debug for OpenedBytes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenedBytes")
            .field(
                "value",
                &format_args!("<{} bytes redacted>", self.value.len()),
            )
            .field("needs_reseal", &self.needs_reseal)
            .finish()
    }
}

/// HKDF-SHA256 with a prefix-plus-id `info`, 32 bytes out.
pub(crate) fn hkdf32(ikm: &[u8], salt: &[u8], info_parts: &[&[u8]]) -> [u8; KEY_LEN] {
    let info: Vec<u8> = info_parts.concat();
    let mut out = [0u8; KEY_LEN];
    hkdf::Hkdf::<sha2::Sha256>::new(Some(salt), ikm)
        .expand(&info, &mut out)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    out
}

/// The content key of `store` under `root` (`K_s`).
pub(crate) fn derive_content_key(root: &[u8; KEY_LEN], store: &str) -> [u8; KEY_LEN] {
    hkdf32(
        root,
        CONTENT_KDF_SALT,
        &[CONTENT_KDF_INFO_PREFIX, store.as_bytes()],
    )
}

fn derive_sub_key(content_key: &[u8; KEY_LEN], label: &str) -> [u8; KEY_LEN] {
    hkdf32(
        content_key,
        SUB_KDF_SALT,
        &[SUB_KDF_INFO_PREFIX, label.as_bytes()],
    )
}

/// The key check value of a root key: `hex(HMAC-SHA256(root, "ryu-kcv-v1")[..16])`.
/// Identifies a key without revealing it; recorded next to sealed data so a
/// different key is detected instead of silently sealing under it.
pub fn key_check_value(root: &[u8; KEY_LEN]) -> String {
    use hmac::{Hmac, Mac};
    let mut mac =
        <Hmac<sha2::Sha256> as Mac>::new_from_slice(root).expect("HMAC accepts every key length");
    mac.update(b"ryu-kcv-v1");
    hex::encode(&mac.finalize().into_bytes()[..16])
}

/// One key a [`ContentCipher`] can open with.
pub(crate) struct ContentKey {
    pub(crate) key: [u8; KEY_LEN],
    aead: ChaCha20Poly1305,
    pub(crate) root_kcv: String,
}

impl ContentKey {
    fn new(key: [u8; KEY_LEN], root_kcv: String) -> Self {
        Self {
            aead: ChaCha20Poly1305::new(Key::from_slice(&key)),
            key,
            root_kcv,
        }
    }

    fn seal(&self, nonce: &[u8; NONCE_LEN], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
        self.aead
            .encrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: plaintext,
                    aad,
                },
            )
            .map_err(|_| anyhow!("content encryption failed"))
    }

    fn open(&self, nonce: &[u8], ciphertext: &[u8], aad: &[u8]) -> Option<Vec<u8>> {
        self.aead
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: ciphertext,
                    aad,
                },
            )
            .ok()
    }
}

struct CipherInner {
    store: String,
    /// Sub-cipher labels, outermost first (see [`ContentCipher::subcipher`]).
    labels: Vec<String>,
    current: ContentKey,
    retired: Vec<ContentKey>,
}

/// The content cipher of one store. Cheap to clone. Carries no accessor for key
/// material.
#[derive(Clone)]
pub struct ContentCipher {
    inner: Arc<CipherInner>,
}

impl std::fmt::Debug for ContentCipher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ContentCipher")
            .field("store", &self.inner.store)
            .field("label", &self.label())
            .field("kcv", &self.inner.current.root_kcv)
            .field("retired", &self.inner.retired.len())
            .finish()
    }
}

/// How a recorded key check value relates to a [`ContentCipher`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KcvMatch {
    /// The cipher's current root.
    Current,
    /// One of the cipher's retired roots (data opens; reseal lazily).
    Retired,
    /// Neither: the store was sealed under a key this process does not hold.
    Unknown,
}

fn store_name_ok(store: &str) -> bool {
    !store.is_empty() && store.len() <= 128 && store.bytes().all(|b| (0x21..0x7f).contains(&b))
}

fn validate_store(store: &str) {
    assert!(
        store_name_ok(store),
        "content store names are non-empty printable ASCII without spaces: {store:?}"
    );
}

/// [`validate_store`] as an error, for store names that come from a caller.
fn check_store_name(store: &str) -> Result<()> {
    if store_name_ok(store) {
        Ok(())
    } else {
        anyhow::bail!("content store names are non-empty printable ASCII without spaces")
    }
}

impl ContentCipher {
    /// The cipher of `store` under an explicit root key (Core's master key, a
    /// plugin or component subkey). Store names are registered constants (the
    /// database file name, `shadow-events`, ...) and must never be renamed: the
    /// name is KDF input. Panics on an empty or non-printable store name.
    pub fn from_root(root: &[u8; KEY_LEN], store: &str) -> Self {
        validate_store(store);
        Self {
            inner: Arc::new(CipherInner {
                store: store.to_owned(),
                labels: Vec::new(),
                current: ContentKey::new(derive_content_key(root, store), key_check_value(root)),
                retired: Vec::new(),
            }),
        }
    }

    /// The same cipher, also able to open values sealed under `roots` (retired
    /// master keys). Such values open with `needs_reseal = true`.
    #[must_use]
    pub fn with_retired_roots(self, roots: &[[u8; KEY_LEN]]) -> Self {
        let current_kcv = self.inner.current.root_kcv.clone();
        let mut retired: Vec<ContentKey> = Vec::new();
        for root in roots {
            let kcv = key_check_value(root);
            if kcv == current_kcv || retired.iter().any(|key| key.root_kcv == kcv) {
                continue;
            }
            // Level by level, exactly as `subcipher` derived the current key.
            let key = self
                .inner
                .labels
                .iter()
                .fold(derive_content_key(root, &self.inner.store), |key, label| {
                    derive_sub_key(&key, label)
                });
            retired.push(ContentKey::new(key, kcv));
        }
        Self {
            inner: Arc::new(CipherInner {
                store: self.inner.store.clone(),
                labels: self.inner.labels.clone(),
                current: ContentKey::new(self.inner.current.key, current_kcv),
                retired,
            }),
        }
    }

    /// A child cipher under `K_sub = HKDF(K_s, "ryu-content-sub-v1", label)`,
    /// for very high-rate stores that bound nonce volume per segment (Shadow
    /// uses one per hour). Same store name in the AAD; retired keys follow.
    pub fn subcipher(&self, label: &str) -> Self {
        let mut labels = self.inner.labels.clone();
        labels.push(label.to_owned());
        let derive = |key: &ContentKey| {
            ContentKey::new(derive_sub_key(&key.key, label), key.root_kcv.clone())
        };
        Self {
            inner: Arc::new(CipherInner {
                store: self.inner.store.clone(),
                labels,
                current: derive(&self.inner.current),
                retired: self.inner.retired.iter().map(derive).collect(),
            }),
        }
    }

    /// The sub-cipher path (`hour/segment`), `None` for the store cipher itself.
    fn label(&self) -> Option<String> {
        (!self.inner.labels.is_empty()).then(|| self.inner.labels.join("/"))
    }

    /// The registered store name.
    pub fn store(&self) -> &str {
        &self.inner.store
    }

    /// The key check value of the root this cipher seals under. Recorded per
    /// store (`ryu_content_seal.kcv`).
    pub fn kcv(&self) -> &str {
        &self.inner.current.root_kcv
    }

    /// The key check values of the retired roots this cipher can still open.
    pub fn retired_kcvs(&self) -> Vec<&str> {
        self.inner
            .retired
            .iter()
            .map(|key| key.root_kcv.as_str())
            .collect()
    }

    /// Classify a recorded key check value.
    pub fn match_kcv(&self, kcv: &str) -> KcvMatch {
        if kcv == self.inner.current.root_kcv {
            KcvMatch::Current
        } else if self.inner.retired.iter().any(|key| key.root_kcv == kcv) {
            KcvMatch::Retired
        } else {
            KcvMatch::Unknown
        }
    }

    pub(crate) fn current_key(&self) -> &ContentKey {
        &self.inner.current
    }

    /// The current key first, then retired keys, with a `retired` flag.
    pub(crate) fn candidate_keys(&self) -> impl Iterator<Item = (&ContentKey, bool)> {
        std::iter::once((&self.inner.current, false))
            .chain(self.inner.retired.iter().map(|key| (key, true)))
    }

    fn aad(&self, context: &ContentContext) -> Vec<u8> {
        context.associated_data(&self.inner.store)
    }

    /// Seal a TEXT value into `encb:v1:`. Any string can be sealed (user text may
    /// contain anything, including something that looks like an envelope).
    pub fn seal_text(&self, plaintext: &str, context: &ContentContext) -> Result<String> {
        let mut nonce = [0u8; NONCE_LEN];
        rand::thread_rng().fill_bytes(&mut nonce);
        self.seal_text_with_nonce(plaintext, context, &nonce)
    }

    pub(crate) fn seal_text_with_nonce(
        &self,
        plaintext: &str,
        context: &ContentContext,
        nonce: &[u8; NONCE_LEN],
    ) -> Result<String> {
        let ciphertext =
            self.inner
                .current
                .seal(nonce, plaintext.as_bytes(), &self.aad(context))?;
        let mut blob = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        blob.extend_from_slice(nonce);
        blob.extend_from_slice(&ciphertext);
        Ok(format!("{CONTENT_TEXT_PREFIX}{}", b64().encode(blob)))
    }

    /// Open a TEXT value.
    ///
    /// * `encb:v1:` → decrypt under the current key, then each retired key
    ///   (`needs_reseal = true` on a retired success); no key opens it →
    ///   [`ContentSealError::DoesNotOpen`];
    /// * `encb:<other>:` → [`ContentSealError::UnknownVersion`];
    /// * anything else (including other Ryu envelopes such as an app's own
    ///   `encp:v1:` value) → legacy plaintext, returned verbatim with
    ///   `needs_reseal = true` (false for the empty string).
    pub fn open_text(&self, stored: &str, context: &ContentContext) -> Result<Opened> {
        let Some(encoded) = stored.strip_prefix(CONTENT_TEXT_PREFIX) else {
            if stored.starts_with(CONTENT_TEXT_FAMILY) && is_versioned_family(stored) {
                return Err(ContentSealError::UnknownVersion.into());
            }
            return Ok(Opened {
                value: stored.to_owned(),
                needs_reseal: !stored.is_empty(),
            });
        };
        let blob = b64()
            .decode(encoded.trim())
            .map_err(|_| ContentSealError::Malformed)?;
        if blob.len() < NONCE_LEN + TAG_LEN {
            return Err(ContentSealError::Malformed.into());
        }
        let (plain, retired) = self.open_blob(&blob, context)?;
        let value = String::from_utf8(plain).map_err(|_| ContentSealError::Malformed)?;
        Ok(Opened {
            value,
            needs_reseal: retired,
        })
    }

    fn open_blob(&self, blob: &[u8], context: &ContentContext) -> Result<(Vec<u8>, bool)> {
        let (nonce, ciphertext) = blob.split_at(NONCE_LEN);
        let aad = self.aad(context);
        for (key, retired) in self.candidate_keys() {
            if let Some(plain) = key.open(nonce, ciphertext, &aad) {
                return Ok((plain, retired));
            }
        }
        Err(ContentSealError::DoesNotOpen.into())
    }

    /// Seal a BLOB value into `RYU-CB01 || nonce || ct || tag`. Refuses bytes
    /// that already start with a Ryu magic (no legitimate content does).
    pub fn seal_bytes(&self, plaintext: &[u8], context: &ContentContext) -> Result<Vec<u8>> {
        let mut nonce = [0u8; NONCE_LEN];
        rand::thread_rng().fill_bytes(&mut nonce);
        self.seal_bytes_with_nonce(plaintext, context, &nonce)
    }

    pub(crate) fn seal_bytes_with_nonce(
        &self,
        plaintext: &[u8],
        context: &ContentContext,
        nonce: &[u8; NONCE_LEN],
    ) -> Result<Vec<u8>> {
        if RYU_MAGICS.iter().any(|magic| plaintext.starts_with(*magic)) {
            return Err(ContentSealError::AlreadyARyuEnvelope.into());
        }
        let ciphertext = self
            .inner
            .current
            .seal(nonce, plaintext, &self.aad(context))?;
        let mut out = Vec::with_capacity(8 + NONCE_LEN + ciphertext.len());
        out.extend_from_slice(CONTENT_BYTES_MAGIC);
        out.extend_from_slice(nonce);
        out.extend_from_slice(&ciphertext);
        Ok(out)
    }

    /// Open a BLOB value: `RYU-CB01` is decrypted (current, then retired keys);
    /// another `RYU-CB` version, or a file/log magic, is refused; anything else
    /// is legacy plaintext (`needs_reseal = true`, false when empty).
    pub fn open_bytes(&self, stored: &[u8], context: &ContentContext) -> Result<OpenedBytes> {
        if let Some(blob) = stored.strip_prefix(CONTENT_BYTES_MAGIC.as_slice()) {
            if blob.len() < NONCE_LEN + TAG_LEN {
                return Err(ContentSealError::Malformed.into());
            }
            let (value, retired) = self.open_blob(blob, context)?;
            return Ok(OpenedBytes {
                value,
                needs_reseal: retired,
            });
        }
        if stored.len() >= 8 && stored.starts_with(b"RYU-") && looks_like_ryu_magic(&stored[..8]) {
            return Err(ContentSealError::UnknownVersion.into());
        }
        Ok(OpenedBytes {
            value: stored.to_vec(),
            needs_reseal: !stored.is_empty(),
        })
    }

    /// Whether a TEXT value carries the content envelope (any version).
    pub fn is_sealed_text(stored: &str) -> bool {
        stored.starts_with(CONTENT_TEXT_PREFIX)
    }

    /// Whether a BLOB value carries the content envelope.
    pub fn is_sealed_bytes(stored: &[u8]) -> bool {
        stored.starts_with(CONTENT_BYTES_MAGIC)
    }
}

/// `encb:` followed by `v<digits>:`: a content envelope of some version.
fn is_versioned_family(stored: &str) -> bool {
    let rest = &stored[CONTENT_TEXT_FAMILY.len()..];
    let Some(rest) = rest.strip_prefix('v') else {
        return false;
    };
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    digits > 0 && rest.as_bytes().get(digits) == Some(&b':')
}

/// `RYU-` + two uppercase letters + two digits (`RYU-CB02`, `RYU-SF01`).
fn looks_like_ryu_magic(magic: &[u8]) -> bool {
    magic.len() == 8
        && magic[4].is_ascii_uppercase()
        && magic[5].is_ascii_uppercase()
        && magic[6].is_ascii_digit()
        && magic[7].is_ascii_digit()
}

// ── Process constructors ─────────────────────────────────────────────────────

/// A process-ephemeral random root for kernel-crate unit tests that construct
/// sealing stores without a host (feature `test-ephemeral-host`, debug builds
/// only). Never persisted; logged at error so it is never mistaken for custody.
#[cfg(all(feature = "test-ephemeral-host", debug_assertions))]
fn ephemeral_test_root() -> [u8; KEY_LEN] {
    static ROOT: std::sync::OnceLock<[u8; KEY_LEN]> = std::sync::OnceLock::new();
    *ROOT.get_or_init(|| {
        tracing::error!(
            "ryu-crypto: no CryptoHost installed; using a process-ephemeral content root \
             (feature test-ephemeral-host). Nothing sealed by this process can be read again."
        );
        let mut root = [0u8; KEY_LEN];
        rand::thread_rng().fill_bytes(&mut root);
        root
    })
}

/// The root and retired roots of a process that holds the master key: the
/// installed host's resolution, else `RYU_MASTER_KEY`, else (test builds with
/// `test-ephemeral-host` only) an ephemeral root.
pub(crate) fn process_root_and_retired() -> Result<([u8; KEY_LEN], Vec<[u8; KEY_LEN]>)> {
    if crate::host_slot().get().is_some() {
        return crate::resolved_master_and_retired();
    }
    if let Some(root) = crate::process_keys::env_master_key()? {
        return Ok((root, Vec::new()));
    }
    match ephemeral_fallback() {
        Some(root) => Ok((root, Vec::new())),
        None => Err(anyhow!(
            "no content key: install a CryptoHost (Core does at boot) or set RYU_MASTER_KEY"
        )),
    }
}

#[cfg(all(feature = "test-ephemeral-host", debug_assertions))]
fn ephemeral_fallback() -> Option<[u8; KEY_LEN]> {
    Some(ephemeral_test_root())
}

#[cfg(not(all(feature = "test-ephemeral-host", debug_assertions)))]
fn ephemeral_fallback() -> Option<[u8; KEY_LEN]> {
    None
}

/// The content cipher of `store` in a process that holds the master key (Core;
/// a CLI or desktop process with a standalone host). Can open values sealed under
/// retired master keys. Fails closed without a key.
pub fn content_cipher(store: &str) -> Result<ContentCipher> {
    let (root, retired) = process_root_and_retired().context("resolving the content root key")?;
    crate::custody::note_content_use();
    Ok(ContentCipher::from_root(&root, store).with_retired_roots(&retired))
}

/// The content cipher Core uses to seal one plugin's rows (plugin KV): rooted at
/// that plugin's subkey, also opening rows sealed under subkeys of retired master
/// keys. `plugin_id` is the canonical id.
pub fn plugin_content_cipher(plugin_id: &str, store: &str) -> Result<ContentCipher> {
    let plugin_id = plugin_id.trim();
    if plugin_id.is_empty() {
        anyhow::bail!("a plugin content key cannot be derived for an empty plugin id");
    }
    let (root, retired) = process_root_and_retired()?;
    let derive = |master: &[u8; KEY_LEN]| crate::process_keys::derive_plugin_key(master, plugin_id);
    let retired: Vec<[u8; KEY_LEN]> = retired.iter().map(derive).collect();
    Ok(ContentCipher::from_root(&derive(&root), store).with_retired_roots(&retired))
}

/// The content cipher of `store` for a plugin or app satellite's own process,
/// rooted at its plugin subkey (delivered by Core in `RYU_SEAL_KEY`, or derived
/// from the master key a standalone process resolves). Fails closed.
pub fn plugin_content_cipher_for_process(plugin_id: &str, store: &str) -> Result<ContentCipher> {
    Ok(crate::plugin_cipher_for_process(plugin_id)?.content_cipher(store))
}

/// The content cipher of `store` for a first-party component's own process
/// (Gateway, Shadow, Ghost), rooted at its component subkey. Fails closed.
pub fn component_content_cipher_for_process(component: &str, store: &str) -> Result<ContentCipher> {
    Ok(crate::component_cipher_for_process(component)?.content_cipher(store))
}

/// The content cipher of `store` under an app-owned key slot (see
/// [`crate::app_keys`]), e.g. the desktop shell's own stores.
pub fn app_content_cipher(slot: &str, store: &str) -> Result<ContentCipher> {
    let (root, retired) = crate::app_key::app_key_bytes(slot)?;
    Ok(ContentCipher::from_root(&root, store).with_retired_roots(&retired))
}

/// The key the desktop webview seals its own `store` with, derived from an
/// app-owned key slot (see [`crate::app_keys`]) for a process that cannot hold
/// the app key itself. Handed over once per session; host-only: never log it.
///
/// `HKDF-SHA256(app key, salt "ryu-webview-key-v1", info "ryu-webview-key-v1:" || store)`.
/// The crate owns the whole `info`, under a salt no other derivation uses, so no
/// store name a webview asks for can yield a content, sub or blind-index key of
/// the shell's own stores. Errors on an empty or non-printable store name.
pub fn app_webview_key_bytes(slot: &str, store: &str) -> Result<[u8; KEY_LEN]> {
    app_webview_keys(slot, store).map(|keys| keys.current)
}

/// The webview keys of `store`: the one derived from the slot's current app
/// key, which seals, and the ones derived from each key the slot used earlier
/// (see [`crate::app_cipher`]), which only open what they sealed. Same
/// derivation and store-name rules as [`app_webview_key_bytes`]. Host-only:
/// never log them.
pub fn app_webview_keys(slot: &str, store: &str) -> Result<WebviewKeys> {
    check_store_name(store)?;
    let (root, retired) = crate::app_key::app_key_bytes(slot)?;
    Ok(webview_keys_from(&root, &retired, store))
}

/// The keys [`app_webview_keys`] hands a webview store. No `Debug`: key
/// material.
#[derive(Clone, PartialEq, Eq)]
pub struct WebviewKeys {
    /// Derived from the current app key: seals and opens.
    pub current: [u8; KEY_LEN],
    /// Derived from the slot's earlier app keys: open only. Never contains
    /// `current`.
    pub retired: Vec<[u8; KEY_LEN]>,
}

pub(crate) fn webview_keys_from(
    root: &[u8; KEY_LEN],
    retired_roots: &[[u8; KEY_LEN]],
    store: &str,
) -> WebviewKeys {
    let current = derive_webview_key(root, store);
    let mut retired: Vec<[u8; KEY_LEN]> = Vec::with_capacity(retired_roots.len());
    for key in retired_roots
        .iter()
        .map(|retired_root| derive_webview_key(retired_root, store))
    {
        if key != current && !retired.contains(&key) {
            retired.push(key);
        }
    }
    WebviewKeys { current, retired }
}

pub(crate) fn derive_webview_key(app_key: &[u8; KEY_LEN], store: &str) -> [u8; KEY_LEN] {
    hkdf32(
        app_key,
        WEBVIEW_KDF_SALT,
        &[WEBVIEW_KDF_INFO_PREFIX, store.as_bytes()],
    )
}

impl crate::PluginCipher {
    /// The content cipher of `store` rooted at this plugin's subkey. A satellite
    /// and Core derive the same key for the same plugin store.
    /// Also opens values sealed under this scope's retired subkeys.
    pub fn content_cipher(&self, store: &str) -> ContentCipher {
        ContentCipher::from_root(&self.subkey, store).with_retired_roots(&self.retired)
    }

    /// The blind index of `(store, field)` rooted at this plugin's subkey.
    pub fn blind_index(&self, store: &str, field: &str) -> crate::BlindIndex {
        crate::BlindIndex::from_root(&self.subkey, store, field)
    }

    /// The key check value of this plugin's subkey (recorded per store).
    pub fn kcv(&self) -> String {
        key_check_value(&self.subkey)
    }
}

impl crate::ComponentCipher {
    /// The content cipher of `store` rooted at this component's subkey.
    /// Also opens values sealed under this scope's retired subkeys.
    pub fn content_cipher(&self, store: &str) -> ContentCipher {
        ContentCipher::from_root(&self.subkey, store).with_retired_roots(&self.retired)
    }

    /// The blind index of `(store, field)` rooted at this component's subkey.
    pub fn blind_index(&self, store: &str, field: &str) -> crate::BlindIndex {
        crate::BlindIndex::from_root(&self.subkey, store, field)
    }

    /// The key check value of this component's subkey (recorded per store).
    pub fn kcv(&self) -> String {
        key_check_value(&self.subkey)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cipher(n: u8) -> ContentCipher {
        ContentCipher::from_root(&[n; KEY_LEN], "test.db")
    }

    fn row(id: &str) -> ContentContext {
        ContentContext::for_id("items.body", id)
    }

    #[test]
    fn webview_keys_refuse_store_names_that_are_not_printable_ascii() {
        for bad in ["", "two words", "tab\there", &"x".repeat(129)] {
            let error = app_webview_key_bytes(crate::app_keys::DESKTOP, bad).unwrap_err();
            assert!(
                error.to_string().contains("store names"),
                "{bad:?}: {error}"
            );
        }
    }

    #[test]
    fn webview_keys_of_retired_roots_are_derived_the_same_way() {
        let root = [1u8; KEY_LEN];
        let earlier = [2u8; KEY_LEN];
        let keys = webview_keys_from(&root, &[earlier, root, earlier], "desktop-webview:x");
        assert_eq!(keys.current, derive_webview_key(&root, "desktop-webview:x"));
        assert_eq!(
            keys.retired,
            vec![derive_webview_key(&earlier, "desktop-webview:x")],
            "the current key and duplicates are not handed out as retired"
        );
        assert!(webview_keys_from(&root, &[], "desktop-webview:x")
            .retired
            .is_empty());
        for bad in ["", "two words"] {
            assert!(app_webview_keys(crate::app_keys::DESKTOP, bad).is_err());
        }
    }

    #[test]
    fn text_round_trips_and_is_not_plaintext() {
        let c = cipher(1);
        let sealed = c.seal_text("hello world", &row("1")).unwrap();
        assert!(sealed.starts_with(CONTENT_TEXT_PREFIX));
        assert!(!sealed.contains("hello"));
        let opened = c.open_text(&sealed, &row("1")).unwrap();
        assert_eq!(opened.value, "hello world");
        assert!(!opened.needs_reseal);
        assert_ne!(sealed, c.seal_text("hello world", &row("1")).unwrap());
    }

    #[test]
    fn a_value_moved_to_another_row_column_or_store_does_not_open() {
        let c = cipher(1);
        let sealed = c.seal_text("secret", &row("1")).unwrap();
        for (other, ctx) in [
            (c.clone(), row("2")),
            (c.clone(), ContentContext::for_id("items.title", "1")),
            (
                ContentCipher::from_root(&[1; KEY_LEN], "other.db"),
                row("1"),
            ),
            (cipher(2), row("1")),
        ] {
            let error = other.open_text(&sealed, &ctx).unwrap_err();
            assert_eq!(
                error.downcast_ref::<ContentSealError>(),
                Some(&ContentSealError::DoesNotOpen)
            );
        }
    }

    #[test]
    fn legacy_plaintext_passes_through_and_unknown_versions_are_refused() {
        let c = cipher(1);
        let opened = c.open_text("plain", &row("1")).unwrap();
        assert_eq!(opened.value, "plain");
        assert!(opened.needs_reseal);
        assert!(!c.open_text("", &row("1")).unwrap().needs_reseal);
        // Other Ryu envelopes (an app's own encp:v1 value) are content to us.
        assert_eq!(
            c.open_text("encp:v1:abcd", &row("1")).unwrap().value,
            "encp:v1:abcd"
        );
        let error = c.open_text("encb:v2:AAAA", &row("1")).unwrap_err();
        assert_eq!(
            error.downcast_ref::<ContentSealError>(),
            Some(&ContentSealError::UnknownVersion)
        );
        // A legacy plaintext that merely starts with the v1 prefix is unreadable,
        // never passed through or double-sealed.
        assert!(c.open_text("encb:v1:not base64!", &row("1")).is_err());
        // "encb:" prose that is not a version tag stays plaintext.
        assert!(c.open_text("encb: notes", &row("1")).unwrap().needs_reseal);
    }

    #[test]
    fn bytes_round_trip_and_refuse_ryu_magics() {
        let c = cipher(1);
        let sealed = c.seal_bytes(b"\x00\x01binary", &row("1")).unwrap();
        assert!(sealed.starts_with(CONTENT_BYTES_MAGIC));
        let opened = c.open_bytes(&sealed, &row("1")).unwrap();
        assert_eq!(opened.value, b"\x00\x01binary");
        assert!(!opened.needs_reseal);
        for magic in RYU_MAGICS {
            let mut input = magic.to_vec();
            input.extend_from_slice(b"rest");
            let error = c.seal_bytes(&input, &row("1")).unwrap_err();
            assert_eq!(
                error.downcast_ref::<ContentSealError>(),
                Some(&ContentSealError::AlreadyARyuEnvelope)
            );
        }
        assert!(c
            .open_bytes(b"RYU-CB02xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", &row("1"))
            .is_err());
        assert!(c
            .open_bytes(b"RYU-SF01xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", &row("1"))
            .is_err());
        let legacy = c.open_bytes(b"legacy", &row("1")).unwrap();
        assert!(legacy.needs_reseal);
        assert!(c.open_bytes(&sealed, &row("2")).is_err());
    }

    #[test]
    fn retired_roots_open_with_needs_reseal_and_new_seals_use_the_current_root() {
        let old = cipher(1);
        let sealed_text = old.seal_text("old text", &row("1")).unwrap();
        let sealed_bytes = old.seal_bytes(b"old bytes", &row("1")).unwrap();
        let current = cipher(2).with_retired_roots(&[[1; KEY_LEN]]);
        let opened = current.open_text(&sealed_text, &row("1")).unwrap();
        assert_eq!(opened.value, "old text");
        assert!(opened.needs_reseal);
        let opened = current.open_bytes(&sealed_bytes, &row("1")).unwrap();
        assert_eq!(opened.value, b"old bytes");
        assert!(opened.needs_reseal);
        let resealed = current.seal_text("old text", &row("1")).unwrap();
        assert!(
            !current
                .open_text(&resealed, &row("1"))
                .unwrap()
                .needs_reseal
        );
        assert!(old.open_text(&resealed, &row("1")).is_err());
        assert_eq!(
            current.match_kcv(&key_check_value(&[1; KEY_LEN])),
            KcvMatch::Retired
        );
        assert_eq!(current.match_kcv(current.kcv()), KcvMatch::Current);
        assert_eq!(current.match_kcv("00"), KcvMatch::Unknown);
        // Sub-ciphers keep the retired fallback.
        let old_sub = old.subcipher("seg");
        let sealed = old_sub.seal_text("x", &row("1")).unwrap();
        assert!(
            current
                .subcipher("seg")
                .open_text(&sealed, &row("1"))
                .unwrap()
                .needs_reseal
        );
    }

    #[test]
    fn retired_roots_added_to_a_nested_subcipher_derive_level_by_level() {
        let old = cipher(1).subcipher("2026-10-19").subcipher("09");
        let sealed = old.seal_text("nested", &row("1")).unwrap();
        // Retired roots attached AFTER the nesting must still open it.
        let current = cipher(2)
            .subcipher("2026-10-19")
            .subcipher("09")
            .with_retired_roots(&[[1; KEY_LEN]]);
        let opened = current.open_text(&sealed, &row("1")).unwrap();
        assert_eq!(opened.value, "nested");
        assert!(opened.needs_reseal);
        // And it agrees with attaching them before the nesting.
        let before = cipher(2)
            .with_retired_roots(&[[1; KEY_LEN]])
            .subcipher("2026-10-19")
            .subcipher("09");
        assert!(before.open_text(&sealed, &row("1")).unwrap().needs_reseal);
        assert!(format!("{current:?}").contains("2026-10-19/09"));
    }

    #[test]
    fn subciphers_are_separate_keys() {
        let c = cipher(1);
        let a = c.subcipher("2026-10-19/09");
        let b = c.subcipher("2026-10-19/10");
        let sealed = a.seal_text("event", &row("1")).unwrap();
        assert_eq!(a.open_text(&sealed, &row("1")).unwrap().value, "event");
        assert!(b.open_text(&sealed, &row("1")).is_err());
        assert!(c.open_text(&sealed, &row("1")).is_err());
        assert_eq!(a.kcv(), c.kcv());
    }

    #[test]
    fn plugin_and_component_content_keys_follow_their_subkeys() {
        let master = [7u8; KEY_LEN];
        let plugin = crate::derive_plugin_cipher(&master, "@ryu/mail").unwrap();
        let delivered = crate::PluginCipher::from_subkey_b64(
            "@ryu/mail",
            &b64().encode(crate::process_keys::derive_plugin_key(&master, "@ryu/mail")),
        )
        .unwrap();
        let sealed = plugin
            .content_cipher("mail.db")
            .seal_text("subject", &row("m1"))
            .unwrap();
        assert_eq!(
            delivered
                .content_cipher("mail.db")
                .open_text(&sealed, &row("m1"))
                .unwrap()
                .value,
            "subject"
        );
        assert_eq!(plugin.kcv(), delivered.kcv());
        assert_ne!(plugin.kcv(), key_check_value(&master));
        // The master's content key for the same store is different.
        assert!(ContentCipher::from_root(&master, "mail.db")
            .open_text(&sealed, &row("m1"))
            .is_err());
    }

    #[test]
    #[should_panic(expected = "content store names")]
    fn store_names_are_validated() {
        let _ = ContentCipher::from_root(&[1; KEY_LEN], "has space");
    }
}
