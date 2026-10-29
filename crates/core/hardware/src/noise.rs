//! Hand-written Noise (revision 34) `XX` handshake for `Noise_XX_25519_AESGCM_SHA256`
//! (RHP v1.1 design §4.3).
//!
//! This is the minimal Noise needed by the RHN secure layer ([`crate::secure`]):
//!
//! - DH is X25519 (RFC 7748). An all-zero shared secret is rejected, which covers
//!   every low-order point ([`NoiseError::LowOrder`]).
//! - The cipher is AES-256-GCM with the Noise nonce `00000000 || u64be(n)`. The AD is
//!   `h` during the handshake and empty in transport.
//! - The hash is SHA-256 and HKDF is the Noise HKDF over HMAC-SHA256.
//! - Rekey is `k' = AESGCM-Encrypt(k, nonce = 2^64-1, ad = "", pt = 32 zero bytes)[..32]`
//!   and leaves `n` unchanged.
//!
//! The device is the initiator ([`Initiator`]) and the node the responder
//! ([`Responder`]). [`Initiator::into_transport`] and [`Responder::into_transport`]
//! return the owned `(send, recv)` [`CipherState`] pair: the initiator sends with
//! `c1` and the responder with `c2`, so no `Arc<Mutex>` is needed to use the two
//! directions from two tasks.
//!
//! Every failure is terminal: a [`CipherState`] that failed once is poisoned and a
//! handshake that failed once refuses every later message. Secret material lives in
//! [`Zeroizing`] buffers or [`StaticSecret`] (which zeroizes on drop).
//!
//! We deliberately do not depend on `snow`: the primitives below are already in
//! `Cargo.lock`, and the committed vectors (cacophony plus the RHP vectors, which
//! snow 0.10.0 reproduced at design time) pin the behaviour.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

/// The full Noise protocol name, mixed into the initial `h` (zero-padded to 32 bytes).
pub const PROTOCOL_NAME: &str = "Noise_XX_25519_AESGCM_SHA256";
/// X25519 public key / shared secret length.
pub const DH_LEN: usize = 32;
/// SHA-256 output length (`HASHLEN`).
pub const HASH_LEN: usize = 32;
/// AES-GCM tag length.
pub const TAG_LEN: usize = 16;
/// Noise reserves `2^64 - 1` for rekey; a cipher state refuses to encrypt with it.
pub const MAX_NONCE: u64 = u64::MAX;

/// Length of XX message 1 with an empty payload (`e`).
pub const MSG1_LEN: usize = DH_LEN;
/// Length of XX message 2 for a payload of `payload_len` bytes (`e, ee, s, es`).
pub const fn msg2_len(payload_len: usize) -> usize {
    DH_LEN + DH_LEN + TAG_LEN + payload_len + TAG_LEN
}
/// Length of XX message 3 for a payload of `payload_len` bytes (`s, se`).
pub const fn msg3_len(payload_len: usize) -> usize {
    DH_LEN + TAG_LEN + payload_len + TAG_LEN
}

/// Why a Noise operation failed. Every error is terminal for the state it came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoiseError {
    /// AEAD authentication failed (wrong key, wrong AD, tampering, or replay).
    Decrypt,
    /// The DH output was all zero: the peer sent a low-order point.
    LowOrder,
    /// A message had the wrong length for its position in the pattern.
    BadLength,
    /// A message was written or read out of order for the XX pattern.
    State,
    /// The cipher state (or handshake) already failed once and is unusable.
    Poisoned,
    /// The nonce reached `2^64 - 1`, which Noise reserves.
    NonceExhausted,
}

impl std::fmt::Display for NoiseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            NoiseError::Decrypt => "noise: AEAD authentication failed",
            NoiseError::LowOrder => "noise: low-order public key (all-zero DH)",
            NoiseError::BadLength => "noise: message has the wrong length",
            NoiseError::State => "noise: message out of order for the XX pattern",
            NoiseError::Poisoned => "noise: state already failed",
            NoiseError::NonceExhausted => "noise: nonce exhausted",
        })
    }
}

impl std::error::Error for NoiseError {}

// ---------------------------------------------------------------------------
// Primitives (crate-internal; pair_crypto reuses them)
// ---------------------------------------------------------------------------

/// HMAC-SHA256 over the concatenation of `parts`.
pub(crate) fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC accepts any key length");
    for part in parts {
        mac.update(part);
    }
    mac.finalize().into_bytes().into()
}

/// SHA-256 over the concatenation of `parts`.
pub(crate) fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

/// X25519 with the RFC 7748 clamp; rejects an all-zero output (every low-order
/// point), as Noise and the RHP spec require.
pub(crate) fn x25519(
    secret: &StaticSecret,
    peer_public: &[u8; 32],
) -> Result<Zeroizing<[u8; 32]>, NoiseError> {
    let shared = secret.diffie_hellman(&PublicKey::from(*peer_public));
    if !shared.was_contributory() {
        return Err(NoiseError::LowOrder);
    }
    Ok(Zeroizing::new(*shared.as_bytes()))
}

/// The X25519 public key for a secret.
pub(crate) fn public_key(secret: &StaticSecret) -> [u8; 32] {
    PublicKey::from(secret).to_bytes()
}

/// The 12-byte AES-GCM nonce for Noise counter `n`.
fn nonce_bytes(n: u64) -> [u8; 12] {
    let mut nonce = [0u8; 12];
    nonce[4..].copy_from_slice(&n.to_be_bytes());
    nonce
}

fn aes_encrypt(key: &[u8; 32], n: u64, ad: &[u8], plaintext: &[u8]) -> Vec<u8> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes(n)),
            Payload {
                msg: plaintext,
                aad: ad,
            },
        )
        .expect("AES-GCM encryption of an in-memory buffer cannot fail")
}

fn aes_decrypt(
    key: &[u8; 32],
    n: u64,
    ad: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>, NoiseError> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .decrypt(
            Nonce::from_slice(&nonce_bytes(n)),
            Payload {
                msg: ciphertext,
                aad: ad,
            },
        )
        .map_err(|_| NoiseError::Decrypt)
}

/// Noise `HKDF(ck, ikm)` with two outputs.
fn hkdf2(ck: &[u8; 32], ikm: &[u8]) -> (Zeroizing<[u8; 32]>, Zeroizing<[u8; 32]>) {
    let temp = Zeroizing::new(hmac_sha256(ck, &[ikm]));
    let out1 = Zeroizing::new(hmac_sha256(temp.as_ref(), &[&[0x01]]));
    let out2 = Zeroizing::new(hmac_sha256(temp.as_ref(), &[out1.as_ref(), &[0x02]]));
    (out1, out2)
}

// ---------------------------------------------------------------------------
// CipherState
// ---------------------------------------------------------------------------

/// A Noise `CipherState`: a key, a 64-bit counter, and a poisoned flag.
///
/// Before a key is set (the start of the handshake) encryption is the identity, as
/// the Noise spec requires. Any failure poisons the state; a poisoned state refuses
/// every later operation.
pub struct CipherState {
    k: Option<Zeroizing<[u8; 32]>>,
    n: u64,
    poisoned: bool,
}

impl std::fmt::Debug for CipherState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CipherState")
            .field("has_key", &self.k.is_some())
            .field("n", &self.n)
            .field("poisoned", &self.poisoned)
            .finish()
    }
}

impl CipherState {
    fn empty() -> Self {
        Self {
            k: None,
            n: 0,
            poisoned: false,
        }
    }

    fn with_key(key: Zeroizing<[u8; 32]>) -> Self {
        Self {
            k: Some(key),
            n: 0,
            poisoned: false,
        }
    }

    /// The next nonce this state will use.
    pub fn nonce(&self) -> u64 {
        self.n
    }

    /// Whether a key is set.
    pub fn has_key(&self) -> bool {
        self.k.is_some()
    }

    /// Whether an earlier failure made this state unusable.
    pub fn is_poisoned(&self) -> bool {
        self.poisoned
    }

    /// Encrypt `plaintext` with associated data `ad`, returning `ciphertext || tag`.
    pub fn encrypt_with_ad(&mut self, ad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, NoiseError> {
        if self.poisoned {
            return Err(NoiseError::Poisoned);
        }
        let Some(key) = self.k.as_ref() else {
            return Ok(plaintext.to_vec());
        };
        if self.n == MAX_NONCE {
            self.poisoned = true;
            return Err(NoiseError::NonceExhausted);
        }
        let out = aes_encrypt(key, self.n, ad, plaintext);
        self.n += 1;
        Ok(out)
    }

    /// Decrypt `ciphertext || tag` with associated data `ad`. A failure poisons the
    /// state: there is no resync.
    pub fn decrypt_with_ad(&mut self, ad: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, NoiseError> {
        if self.poisoned {
            return Err(NoiseError::Poisoned);
        }
        let Some(key) = self.k.as_ref() else {
            return Ok(ciphertext.to_vec());
        };
        if self.n == MAX_NONCE {
            self.poisoned = true;
            return Err(NoiseError::NonceExhausted);
        }
        if ciphertext.len() < TAG_LEN {
            self.poisoned = true;
            return Err(NoiseError::Decrypt);
        }
        match aes_decrypt(key, self.n, ad, ciphertext) {
            Ok(plaintext) => {
                self.n += 1;
                Ok(plaintext)
            }
            Err(error) => {
                self.poisoned = true;
                Err(error)
            }
        }
    }

    /// Noise `Rekey()`: replace `k` with the first 32 bytes of
    /// `ENCRYPT(k, 2^64-1, "", zeros(32))`. `n` is not reset.
    pub fn rekey(&mut self) -> Result<(), NoiseError> {
        if self.poisoned {
            return Err(NoiseError::Poisoned);
        }
        let Some(key) = self.k.as_ref() else {
            self.poisoned = true;
            return Err(NoiseError::State);
        };
        let block = Zeroizing::new(aes_encrypt(key, MAX_NONCE, &[], &[0u8; 32]));
        let mut next = Zeroizing::new([0u8; 32]);
        next.copy_from_slice(&block[..32]);
        self.k = Some(next);
        Ok(())
    }

    /// Mark the state unusable (used by callers that detect a framing violation).
    pub fn poison(&mut self) {
        self.poisoned = true;
    }

    #[cfg(test)]
    pub(crate) fn key_bytes(&self) -> Option<[u8; 32]> {
        self.k.as_ref().map(|k| **k)
    }

    #[cfg(test)]
    pub(crate) fn set_nonce_for_tests(&mut self, n: u64) {
        self.n = n;
    }
}

// ---------------------------------------------------------------------------
// SymmetricState
// ---------------------------------------------------------------------------

struct SymmetricState {
    ck: Zeroizing<[u8; 32]>,
    h: [u8; 32],
    cs: CipherState,
}

impl SymmetricState {
    fn initialize(prologue: &[u8]) -> Self {
        // HASHLEN == 32 and the name is 28 bytes: h = name || zero padding.
        let mut h = [0u8; HASH_LEN];
        h[..PROTOCOL_NAME.len()].copy_from_slice(PROTOCOL_NAME.as_bytes());
        let mut state = Self {
            ck: Zeroizing::new(h),
            h,
            cs: CipherState::empty(),
        };
        state.mix_hash(prologue);
        state
    }

    fn mix_hash(&mut self, data: &[u8]) {
        self.h = sha256(&[&self.h, data]);
    }

    fn mix_key(&mut self, ikm: &[u8]) {
        let (ck, temp_k) = hkdf2(&self.ck, ikm);
        self.ck = ck;
        self.cs = CipherState::with_key(temp_k);
    }

    fn encrypt_and_hash(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let h = self.h;
        let ciphertext = self.cs.encrypt_with_ad(&h, plaintext)?;
        self.mix_hash(&ciphertext);
        Ok(ciphertext)
    }

    fn decrypt_and_hash(&mut self, ciphertext: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let h = self.h;
        let plaintext = self.cs.decrypt_with_ad(&h, ciphertext)?;
        self.mix_hash(ciphertext);
        Ok(plaintext)
    }

    /// Noise `Split()`: returns `(c1, c2)`.
    fn split(&self) -> (CipherState, CipherState) {
        let (k1, k2) = hkdf2(&self.ck, &[]);
        (CipherState::with_key(k1), CipherState::with_key(k2))
    }
}

// ---------------------------------------------------------------------------
// XX handshake
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Step {
    /// Initiator: write msg1. Responder: read msg1.
    Msg1,
    /// Initiator: read msg2. Responder: write msg2.
    Msg2,
    /// Initiator: write msg3. Responder: read msg3.
    Msg3,
    /// All three messages processed; only `into_transport` remains.
    Done,
    /// A failure made the handshake unusable.
    Failed,
}

struct Handshake {
    s: StaticSecret,
    e: StaticSecret,
    re: Option<[u8; 32]>,
    rs: Option<[u8; 32]>,
    ss: SymmetricState,
    step: Step,
}

impl Handshake {
    fn new(s: StaticSecret, e: StaticSecret, prologue: &[u8]) -> Self {
        Self {
            s,
            e,
            re: None,
            rs: None,
            ss: SymmetricState::initialize(prologue),
            step: Step::Msg1,
        }
    }

    fn expect(&self, step: Step) -> Result<(), NoiseError> {
        match self.step {
            Step::Failed => Err(NoiseError::Poisoned),
            current if current == step => Ok(()),
            _ => Err(NoiseError::State),
        }
    }

    /// Run `body`; on error the handshake is marked failed.
    fn guarded<T>(
        &mut self,
        step: Step,
        next: Step,
        body: impl FnOnce(&mut Self) -> Result<T, NoiseError>,
    ) -> Result<T, NoiseError> {
        self.expect(step)?;
        match body(self) {
            Ok(value) => {
                self.step = next;
                Ok(value)
            }
            Err(error) => {
                self.step = Step::Failed;
                Err(error)
            }
        }
    }

    fn dh(
        &self,
        secret: &StaticSecret,
        public: &[u8; 32],
    ) -> Result<Zeroizing<[u8; 32]>, NoiseError> {
        x25519(secret, public)
    }

    fn handshake_hash(&self) -> Option<[u8; 32]> {
        (self.step == Step::Done).then_some(self.ss.h)
    }
}

fn split_array(slice: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&slice[..32]);
    out
}

fn random_secret() -> StaticSecret {
    StaticSecret::random_from_rng(rand::rngs::OsRng)
}

/// The XX initiator (the device in RHP).
pub struct Initiator {
    hs: Handshake,
}

impl Initiator {
    /// A new initiator with static secret `static_secret` and a fresh random
    /// ephemeral key.
    pub fn new(static_secret: &[u8; 32], prologue: &[u8]) -> Self {
        Self {
            hs: Handshake::new(
                StaticSecret::from(*static_secret),
                random_secret(),
                prologue,
            ),
        }
    }

    /// Fixed-ephemeral constructor, for the golden vectors only.
    #[cfg(test)]
    pub(crate) fn with_ephemeral(
        static_secret: &[u8; 32],
        ephemeral_secret: &[u8; 32],
        prologue: &[u8],
    ) -> Self {
        Self {
            hs: Handshake::new(
                StaticSecret::from(*static_secret),
                StaticSecret::from(*ephemeral_secret),
                prologue,
            ),
        }
    }

    /// Write the next initiator message (msg1 `-> e`, then msg3 `-> s, se`).
    pub fn write_message(&mut self, payload: &[u8]) -> Result<Vec<u8>, NoiseError> {
        match self.hs.step {
            Step::Msg1 => self.hs.guarded(Step::Msg1, Step::Msg2, |hs| {
                let e_pub = public_key(&hs.e);
                hs.ss.mix_hash(&e_pub);
                let mut out = e_pub.to_vec();
                out.extend(hs.ss.encrypt_and_hash(payload)?);
                Ok(out)
            }),
            Step::Msg3 => self.hs.guarded(Step::Msg3, Step::Done, |hs| {
                let re = hs.re.ok_or(NoiseError::State)?;
                let s_pub = public_key(&hs.s);
                let mut out = hs.ss.encrypt_and_hash(&s_pub)?;
                let se = hs.dh(&hs.s, &re)?;
                hs.ss.mix_key(se.as_ref());
                out.extend(hs.ss.encrypt_and_hash(payload)?);
                Ok(out)
            }),
            Step::Failed => Err(NoiseError::Poisoned),
            _ => Err(NoiseError::State),
        }
    }

    /// Read msg2 (`<- e, ee, s, es`), returning its payload. After this,
    /// [`Initiator::remote_static`] holds the responder's static key, so the caller
    /// can check a pin BEFORE writing msg3 (which reveals the initiator's static key).
    pub fn read_message(&mut self, message: &[u8]) -> Result<Vec<u8>, NoiseError> {
        self.hs.guarded(Step::Msg2, Step::Msg3, |hs| {
            if message.len() < msg2_len(0) {
                return Err(NoiseError::BadLength);
            }
            let re = split_array(&message[..DH_LEN]);
            hs.ss.mix_hash(&re);
            let ee = hs.dh(&hs.e, &re)?;
            hs.ss.mix_key(ee.as_ref());
            let rs_bytes = hs
                .ss
                .decrypt_and_hash(&message[DH_LEN..DH_LEN + DH_LEN + TAG_LEN])?;
            let rs = split_array(&rs_bytes);
            let es = hs.dh(&hs.e, &rs)?;
            hs.ss.mix_key(es.as_ref());
            let payload = hs
                .ss
                .decrypt_and_hash(&message[DH_LEN + DH_LEN + TAG_LEN..])?;
            hs.re = Some(re);
            hs.rs = Some(rs);
            Ok(payload)
        })
    }

    /// The responder's static public key, once msg2 has been read.
    pub fn remote_static(&self) -> Option<[u8; 32]> {
        self.hs.rs
    }

    /// The final handshake hash `h`, once the handshake is complete.
    pub fn handshake_hash(&self) -> Option<[u8; 32]> {
        self.hs.handshake_hash()
    }

    /// Finish: the owned `(send, recv)` transport states (`c1`, `c2`).
    pub fn into_transport(self) -> Result<(CipherState, CipherState), NoiseError> {
        self.hs.expect(Step::Done)?;
        let (c1, c2) = self.hs.ss.split();
        Ok((c1, c2))
    }
}

/// The XX responder (the node in RHP).
pub struct Responder {
    hs: Handshake,
}

impl Responder {
    /// A new responder with static secret `static_secret` and a fresh random
    /// ephemeral key.
    pub fn new(static_secret: &[u8; 32], prologue: &[u8]) -> Self {
        Self {
            hs: Handshake::new(
                StaticSecret::from(*static_secret),
                random_secret(),
                prologue,
            ),
        }
    }

    pub(crate) fn from_secret(static_secret: StaticSecret, prologue: &[u8]) -> Self {
        Self {
            hs: Handshake::new(static_secret, random_secret(), prologue),
        }
    }

    /// Fixed-ephemeral constructor, for the golden vectors only.
    #[cfg(test)]
    pub(crate) fn with_ephemeral(
        static_secret: &[u8; 32],
        ephemeral_secret: &[u8; 32],
        prologue: &[u8],
    ) -> Self {
        Self {
            hs: Handshake::new(
                StaticSecret::from(*static_secret),
                StaticSecret::from(*ephemeral_secret),
                prologue,
            ),
        }
    }

    /// Read the next initiator message (msg1 `-> e`, then msg3 `-> s, se`),
    /// returning its payload.
    pub fn read_message(&mut self, message: &[u8]) -> Result<Vec<u8>, NoiseError> {
        match self.hs.step {
            Step::Msg1 => self.hs.guarded(Step::Msg1, Step::Msg2, |hs| {
                if message.len() < MSG1_LEN {
                    return Err(NoiseError::BadLength);
                }
                let re = split_array(&message[..DH_LEN]);
                hs.ss.mix_hash(&re);
                let payload = hs.ss.decrypt_and_hash(&message[DH_LEN..])?;
                hs.re = Some(re);
                Ok(payload)
            }),
            Step::Msg3 => self.hs.guarded(Step::Msg3, Step::Done, |hs| {
                if message.len() < msg3_len(0) {
                    return Err(NoiseError::BadLength);
                }
                let rs_bytes = hs.ss.decrypt_and_hash(&message[..DH_LEN + TAG_LEN])?;
                let rs = split_array(&rs_bytes);
                let se = hs.dh(&hs.e, &rs)?;
                hs.ss.mix_key(se.as_ref());
                let payload = hs.ss.decrypt_and_hash(&message[DH_LEN + TAG_LEN..])?;
                hs.rs = Some(rs);
                Ok(payload)
            }),
            Step::Failed => Err(NoiseError::Poisoned),
            _ => Err(NoiseError::State),
        }
    }

    /// Write msg2 (`<- e, ee, s, es`) with `payload`.
    pub fn write_message(&mut self, payload: &[u8]) -> Result<Vec<u8>, NoiseError> {
        self.hs.guarded(Step::Msg2, Step::Msg3, |hs| {
            let re = hs.re.ok_or(NoiseError::State)?;
            let e_pub = public_key(&hs.e);
            hs.ss.mix_hash(&e_pub);
            let ee = hs.dh(&hs.e, &re)?;
            hs.ss.mix_key(ee.as_ref());
            let s_pub = public_key(&hs.s);
            let mut out = e_pub.to_vec();
            out.extend(hs.ss.encrypt_and_hash(&s_pub)?);
            let es = hs.dh(&hs.s, &re)?;
            hs.ss.mix_key(es.as_ref());
            out.extend(hs.ss.encrypt_and_hash(payload)?);
            Ok(out)
        })
    }

    /// The initiator's static public key, once msg3 has been read.
    pub fn remote_static(&self) -> Option<[u8; 32]> {
        self.hs.rs
    }

    /// The final handshake hash `h`, once the handshake is complete.
    pub fn handshake_hash(&self) -> Option<[u8; 32]> {
        self.hs.handshake_hash()
    }

    /// Finish: the owned `(send, recv)` transport states (`c2`, `c1`).
    pub fn into_transport(self) -> Result<(CipherState, CipherState), NoiseError> {
        self.hs.expect(Step::Done)?;
        let (c1, c2) = self.hs.ss.split();
        Ok((c2, c1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const CACOPHONY: &str =
        include_str!("../tests/vectors/noise_cacophony_xx_25519_aesgcm_sha256.json");
    const RHP_NOISE: &str = include_str!("../tests/vectors/rhp_v1_1_noise.json");

    fn hex32(value: &Value) -> [u8; 32] {
        let bytes = hex::decode(value.as_str().expect("hex string")).expect("hex");
        bytes.try_into().expect("32 bytes")
    }

    fn bytes(value: &Value) -> Vec<u8> {
        hex::decode(value.as_str().expect("hex string")).expect("hex")
    }

    #[test]
    fn cacophony_xx_aesgcm_sha256() {
        let doc: Value = serde_json::from_str(CACOPHONY).unwrap();
        let vectors = doc["vectors"].as_array().unwrap();
        // Pin the subset itself so an emptied or edited file cannot pass silently.
        assert_eq!(
            vectors.len(),
            1,
            "exactly one {PROTOCOL_NAME} cacophony vector"
        );
        assert_eq!(vectors[0]["messages"].as_array().unwrap().len(), 6);
        assert_eq!(
            vectors[0]["handshake_hash"],
            "1b7aefb1125762aa21a252890d00af54519638b76437444538f9a52f21e2e0dc"
        );
        for v in vectors {
            assert_eq!(v["protocol_name"], PROTOCOL_NAME);
            let mut ini = Initiator::with_ephemeral(
                &hex32(&v["init_static"]),
                &hex32(&v["init_ephemeral"]),
                &bytes(&v["init_prologue"]),
            );
            let mut rsp = Responder::with_ephemeral(
                &hex32(&v["resp_static"]),
                &hex32(&v["resp_ephemeral"]),
                &bytes(&v["resp_prologue"]),
            );
            let msgs = v["messages"].as_array().unwrap();
            let payload = |i: usize| bytes(&msgs[i]["payload"]);
            let ciphertext = |i: usize| bytes(&msgs[i]["ciphertext"]);

            assert_eq!(ini.write_message(&payload(0)).unwrap(), ciphertext(0));
            assert_eq!(rsp.read_message(&ciphertext(0)).unwrap(), payload(0));
            assert_eq!(rsp.write_message(&payload(1)).unwrap(), ciphertext(1));
            assert_eq!(ini.read_message(&ciphertext(1)).unwrap(), payload(1));
            assert_eq!(ini.write_message(&payload(2)).unwrap(), ciphertext(2));
            assert_eq!(rsp.read_message(&ciphertext(2)).unwrap(), payload(2));

            let expected_hash = hex32(&v["handshake_hash"]);
            assert_eq!(ini.handshake_hash(), Some(expected_hash));
            assert_eq!(rsp.handshake_hash(), Some(expected_hash));
            assert_eq!(
                rsp.remote_static(),
                Some(public_key(&StaticSecret::from(hex32(&v["init_static"]))))
            );

            let (mut i_send, mut i_recv) = ini.into_transport().unwrap();
            let (mut r_send, mut r_recv) = rsp.into_transport().unwrap();
            for i in 3..msgs.len() {
                if i % 2 == 1 {
                    assert_eq!(
                        r_send.encrypt_with_ad(&[], &payload(i)).unwrap(),
                        ciphertext(i)
                    );
                    assert_eq!(
                        i_recv.decrypt_with_ad(&[], &ciphertext(i)).unwrap(),
                        payload(i)
                    );
                } else {
                    assert_eq!(
                        i_send.encrypt_with_ad(&[], &payload(i)).unwrap(),
                        ciphertext(i)
                    );
                    assert_eq!(
                        r_recv.decrypt_with_ad(&[], &ciphertext(i)).unwrap(),
                        payload(i)
                    );
                }
            }
        }
    }

    #[test]
    fn rhp_handshake_split_and_rekey_match_vectors() {
        let v: Value = serde_json::from_str(RHP_NOISE).unwrap();
        let keys = &v["keys"];
        let prologue = bytes(&v["prologue_hex"]);
        let mut ini = Initiator::with_ephemeral(
            &hex32(&keys["device_static_sk"]),
            &hex32(&keys["device_ephemeral_sk"]),
            &prologue,
        );
        let mut rsp = Responder::with_ephemeral(
            &hex32(&keys["node_static_sk"]),
            &hex32(&keys["node_ephemeral_sk"]),
            &prologue,
        );
        let hs1 = bytes(&v["hs1_hex"]);
        let hs2 = bytes(&v["hs2_hex"]);
        let hs3 = bytes(&v["hs3_hex"]);
        assert_eq!(ini.write_message(&[]).unwrap(), hs1[4..]);
        assert_eq!(rsp.read_message(&hs1[4..]).unwrap(), Vec::<u8>::new());
        let hs2_payload = bytes(&v["hs2_payload_hex"]);
        assert_eq!(rsp.write_message(&hs2_payload).unwrap(), hs2[1..]);
        assert_eq!(ini.read_message(&hs2[1..]).unwrap(), hs2_payload);
        assert_eq!(ini.remote_static(), Some(hex32(&keys["node_static_pub"])));
        let hello = v["hs3_payload_utf8"].as_str().unwrap().as_bytes();
        assert_eq!(ini.write_message(hello).unwrap(), hs3[1..]);
        assert_eq!(rsp.read_message(&hs3[1..]).unwrap(), hello);
        assert_eq!(rsp.remote_static(), Some(hex32(&keys["device_static_pub"])));
        let hash = hex32(&v["handshake_hash_hex"]);
        assert_eq!(ini.handshake_hash(), Some(hash));
        assert_eq!(rsp.handshake_hash(), Some(hash));

        let (mut d_send, d_recv) = ini.into_transport().unwrap();
        let (n_send, n_recv) = rsp.into_transport().unwrap();
        assert_eq!(
            d_send.key_bytes(),
            Some(hex32(&v["split"]["device_send_key"]))
        );
        assert_eq!(
            d_recv.key_bytes(),
            Some(hex32(&v["split"]["device_recv_key"]))
        );
        assert_eq!(n_recv.key_bytes(), d_send.key_bytes());
        assert_eq!(n_send.key_bytes(), d_recv.key_bytes());

        assert_eq!(
            d_send.key_bytes(),
            Some(hex32(&v["rekey"]["device_send_key_before"]))
        );
        d_send.rekey().unwrap();
        assert_eq!(
            d_send.key_bytes(),
            Some(hex32(&v["rekey"]["device_send_key_after"]))
        );
        assert_eq!(d_send.nonce(), 0, "rekey must not reset n");
    }

    #[test]
    fn low_order_and_tamper_poison() {
        let prologue = b"p";
        let mut rsp = Responder::new(&[7u8; 32], prologue);
        // An all-zero ephemeral is a low-order point: the responder fails on ee.
        rsp.read_message(&[0u8; 32]).unwrap();
        assert_eq!(rsp.write_message(&[]), Err(NoiseError::LowOrder));
        assert_eq!(rsp.write_message(&[]), Err(NoiseError::Poisoned));

        let mut ini = Initiator::new(&[1u8; 32], prologue);
        let mut rsp = Responder::new(&[2u8; 32], prologue);
        let m1 = ini.write_message(&[]).unwrap();
        rsp.read_message(&m1).unwrap();
        let mut m2 = rsp.write_message(b"x").unwrap();
        m2[40] ^= 1;
        assert_eq!(ini.read_message(&m2), Err(NoiseError::Decrypt));
        assert_eq!(ini.write_message(b"hello"), Err(NoiseError::Poisoned));
        assert!(ini.into_transport().is_err());
    }

    #[test]
    fn out_of_order_and_short_messages_fail() {
        let mut ini = Initiator::new(&[1u8; 32], b"");
        assert_eq!(ini.read_message(&[0u8; 96]), Err(NoiseError::State));
        let mut rsp = Responder::new(&[2u8; 32], b"");
        assert_eq!(rsp.write_message(&[]), Err(NoiseError::State));
        assert_eq!(rsp.read_message(&[0u8; 5]), Err(NoiseError::BadLength));
    }

    #[test]
    fn cipher_state_poisons_and_refuses_max_nonce() {
        let mut send = CipherState::with_key(Zeroizing::new([9u8; 32]));
        let mut recv = CipherState::with_key(Zeroizing::new([9u8; 32]));
        let ct = send.encrypt_with_ad(&[], b"one").unwrap();
        assert_eq!(recv.decrypt_with_ad(&[], &ct).unwrap(), b"one");
        // Replay of the same record fails (wrong nonce) and poisons.
        assert_eq!(recv.decrypt_with_ad(&[], &ct), Err(NoiseError::Decrypt));
        assert!(recv.is_poisoned());
        let ct2 = send.encrypt_with_ad(&[], b"two").unwrap();
        assert_eq!(recv.decrypt_with_ad(&[], &ct2), Err(NoiseError::Poisoned));

        send.set_nonce_for_tests(MAX_NONCE);
        assert_eq!(
            send.encrypt_with_ad(&[], b"x"),
            Err(NoiseError::NonceExhausted)
        );
        assert!(send.is_poisoned());
    }
}
