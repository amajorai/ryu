//! Loopback peer proof: a challenge-response a client runs before it hands a
//! shared bearer to a loopback listener.
//!
//! Binding `127.0.0.1:<port>` proves nothing about who is listening. Any local
//! process (another OS user, a sandboxed helper) can take a well-known sidecar
//! port while the real sidecar is down and answer an unauthenticated `/health`
//! with `200`. A client that then sends `Authorization: Bearer <token>` has
//! handed the shared secret to that process.
//!
//! The proof closes that gap without revealing the token:
//!
//! 1. The client mints an unpredictable challenge ([`new_challenge`], 256 bits
//!    from the OS CSPRNG) and calls the server's unauthenticated health route
//!    with `?challenge=<challenge>` ([`CHALLENGE_QUERY_PARAM`]).
//! 2. A genuine server, which holds the same token, answers with
//!    `"proof": hex(HMAC-SHA256(token, DOMAIN || challenge))` ([`proof`],
//!    [`PROOF_FIELD`]).
//! 3. The client recomputes the proof and compares it in constant time
//!    ([`verify`]). Only a peer that proved it already holds the token is ever
//!    sent the token.
//!
//! The server answers any well-formed challenge, so it is an HMAC oracle.
//! That is safe because HMAC is a PRF keyed by the token: the oracle reveals
//! nothing about the token. It is also why challenges must be unpredictable. A
//! process that queried the real server earlier must not be able to replay a
//! proof for the challenge a client sends later.
//!
//! `DOMAIN` separates these proofs from every other use of the token, so a
//! proof can never double as a bearer, a signature, or a proof for another
//! protocol version.

use hmac::{Hmac, Mac};
use sha2::Sha256;

/// Query parameter that carries the client's challenge on the health route.
pub const CHALLENGE_QUERY_PARAM: &str = "challenge";

/// JSON field of the health response that carries the server's proof.
pub const PROOF_FIELD: &str = "proof";

/// Domain-separation prefix mixed into every proof. Bump the version to change
/// the construction; old and new proofs then never verify against each other.
const DOMAIN: &[u8] = b"ryu-loopback-peer-proof-v1\0";

/// Shortest accepted challenge. 32 characters of the accepted alphabet is
/// comfortably above 128 bits when minted by [`new_challenge`].
const MIN_CHALLENGE_LEN: usize = 32;

/// Longest accepted challenge, so the open health route cannot be made to MAC
/// arbitrarily large inputs.
const MAX_CHALLENGE_LEN: usize = 128;

/// Whether `challenge` is well-formed: 32 to 128 ASCII letters, digits, `-` or
/// `_`. A server answers only well-formed challenges; anything else gets a
/// plain health response with no proof.
#[must_use]
pub fn is_valid_challenge(challenge: &str) -> bool {
    (MIN_CHALLENGE_LEN..=MAX_CHALLENGE_LEN).contains(&challenge.len())
        && challenge
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// The proof a holder of `token` gives for `challenge`: lowercase hex of
/// `HMAC-SHA256(token, DOMAIN || challenge)`.
///
/// `None` when the token is empty (a server without a token must not answer;
/// the client then treats it as unverified) or the challenge is malformed.
#[must_use]
pub fn proof(token: &str, challenge: &str) -> Option<String> {
    if token.is_empty() || !is_valid_challenge(challenge) {
        return None;
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).ok()?;
    mac.update(DOMAIN);
    mac.update(challenge.as_bytes());
    Some(to_hex(&mac.finalize().into_bytes()))
}

/// Whether `provided` is the proof a holder of `token` gives for `challenge`.
/// Compared in constant time. Fails closed on an empty token or a malformed
/// challenge.
#[must_use]
pub fn verify(token: &str, challenge: &str, provided: &str) -> bool {
    let Some(expected) = proof(token, challenge) else {
        return false;
    };
    crate::constant_time_eq(
        expected.as_bytes(),
        provided.trim().to_ascii_lowercase().as_bytes(),
    )
}

fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    out
}

#[cfg(feature = "peer-probe")]
pub use probe::{
    new_challenge, peer_holds_token, pin_localhost, probe, send_with_verified_bearer, PeerProbe,
    ProofCache, VerifiedSendError,
};

#[cfg(feature = "peer-probe")]
mod probe {
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    use sha2::{Digest, Sha256};

    use super::{verify, CHALLENGE_QUERY_PARAM, PROOF_FIELD};

    /// Largest health body the probe reads. A real health response is tiny; an
    /// impostor streaming an endless body is cut off here.
    const MAX_HEALTH_BODY_BYTES: usize = 4 * 1024;

    /// A fresh, unpredictable challenge: 64 lowercase hex characters (two
    /// UUIDv4 values, 244 random bits from the OS CSPRNG).
    #[must_use]
    pub fn new_challenge() -> String {
        format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        )
    }

    /// What answered on the health route.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum PeerProbe {
        /// A 2xx health response carrying a valid proof: the peer holds the
        /// token.
        Proven,
        /// A 2xx health response with no proof: a server that predates the
        /// challenge, or one that does not hold a token, or an impostor.
        NoProof,
        /// A 2xx health response with a proof that does not verify: the peer
        /// does not hold this token.
        WrongProof,
        /// Nothing answered, or the answer was not a 2xx health response.
        Unreachable,
    }

    /// Challenge the health route at `<base_url>/health`. Never sends `token`;
    /// it is only used to check the proof. Give `client` a short timeout and no
    /// redirects so a hostile listener cannot stall or bounce the probe.
    pub async fn probe(client: &reqwest::Client, base_url: &str, token: &str) -> PeerProbe {
        let challenge = new_challenge();
        let url = format!(
            "{}/health?{CHALLENGE_QUERY_PARAM}={challenge}",
            base_url.trim_end_matches('/')
        );
        let Ok(mut response) = client.get(&url).send().await else {
            return PeerProbe::Unreachable;
        };
        if !response.status().is_success() {
            return PeerProbe::Unreachable;
        }
        let mut body = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    if body.len() + chunk.len() > MAX_HEALTH_BODY_BYTES {
                        return PeerProbe::NoProof;
                    }
                    body.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(_) => return PeerProbe::NoProof,
            }
        }
        let provided = serde_json::from_slice::<serde_json::Value>(&body)
            .ok()
            .and_then(|json| json.get(PROOF_FIELD)?.as_str().map(str::to_owned));
        match provided {
            None => PeerProbe::NoProof,
            Some(provided) if verify(token, &challenge, &provided) => PeerProbe::Proven,
            Some(_) => PeerProbe::WrongProof,
        }
    }

    /// Remembers one recent successful proof so a burst of requests does not
    /// re-challenge the peer each time. Keyed by base URL and a SHA-256 digest
    /// of the token, so a new URL or a rotated token always re-challenges.
    /// Only successes are cached; a failure clears the entry.
    pub struct ProofCache {
        ttl: Duration,
        entry: Mutex<Option<CachedProof>>,
    }

    struct CachedProof {
        base_url: String,
        token_digest: [u8; 32],
        proven_at: Instant,
    }

    impl ProofCache {
        /// A cache whose entries stay fresh for `ttl`.
        #[must_use]
        pub const fn new(ttl: Duration) -> Self {
            Self {
                ttl,
                entry: Mutex::new(None),
            }
        }

        /// Whether `base_url` proved it holds `token` within the TTL.
        #[must_use]
        pub fn is_fresh(&self, base_url: &str, token: &str) -> bool {
            let digest = token_digest(token);
            self.lock().as_ref().is_some_and(|entry| {
                entry.base_url == base_url
                    && crate::constant_time_eq(&entry.token_digest, &digest)
                    && entry.proven_at.elapsed() < self.ttl
            })
        }

        /// Record that `base_url` just proved it holds `token`.
        pub fn remember(&self, base_url: &str, token: &str) {
            *self.lock() = Some(CachedProof {
                base_url: base_url.to_owned(),
                token_digest: token_digest(token),
                proven_at: Instant::now(),
            });
        }

        /// Drop the cached proof (after a failed probe or a token rotation).
        pub fn forget(&self) {
            *self.lock() = None;
        }

        fn lock(&self) -> std::sync::MutexGuard<'_, Option<CachedProof>> {
            self.entry
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
        }
    }

    fn token_digest(token: &str) -> [u8; 32] {
        Sha256::digest(token.as_bytes()).into()
    }

    /// Point a URL whose host is the name `localhost` (or a `*.localhost` name,
    /// RFC 6761) at `127.0.0.1`, the address loopback sidecars bind. Returns
    /// whether it rewrote the host.
    ///
    /// The proof is not bound to a connection or an address. A name can resolve
    /// to `::1` first, where the sidecar does not listen and any local process
    /// can. That process could relay the challenge to the real server on
    /// `127.0.0.1`, pass the proof, and then receive the bearer. Pinning the
    /// name to one address makes the probe and the request reach the same
    /// listener.
    pub fn pin_localhost(url: &mut reqwest::Url) -> bool {
        let is_localhost = url.host_str().is_some_and(|host| {
            let host = host.trim_end_matches('.').to_ascii_lowercase();
            host == "localhost" || host.ends_with(".localhost")
        });
        is_localhost && url.set_host(Some("127.0.0.1")).is_ok()
    }

    /// Short-timeout, no-redirect client for [`send_with_verified_bearer`]'s
    /// probe, so a hostile listener can neither stall the caller nor bounce
    /// the probe to another host.
    fn probe_client() -> &'static reqwest::Client {
        static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
        CLIENT.get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(Duration::from_millis(500))
                .timeout(Duration::from_secs(2))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap_or_else(|_| reqwest::Client::new())
        })
    }

    /// Why [`send_with_verified_bearer`] returned no response.
    #[derive(Debug)]
    pub enum VerifiedSendError {
        /// The request could not be built.
        InvalidRequest(reqwest::Error),
        /// The token cannot be sent as a header value.
        InvalidToken,
        /// The listener at `origin` did not prove it holds the token, so
        /// neither the token nor the request was sent.
        Unverified { origin: String },
        /// The verified peer was sent the request, which then failed.
        Request(reqwest::Error),
    }

    impl std::fmt::Display for VerifiedSendError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                Self::InvalidRequest(error) => write!(f, "invalid request: {error}"),
                Self::InvalidToken => f.write_str("the API token is not a valid header value"),
                Self::Unverified { origin } => write!(
                    f,
                    "the listener at {origin} did not prove it is the expected server; nothing was sent"
                ),
                Self::Request(error) => write!(f, "{error}"),
            }
        }
    }

    impl std::error::Error for VerifiedSendError {}

    /// Send `builder` with `Authorization: Bearer <token>`, but only after the
    /// listener at the request's own origin proved it holds `token`. An
    /// unverified listener receives neither the token nor the request (its
    /// body may be as private as the token).
    pub async fn send_with_verified_bearer(
        builder: reqwest::RequestBuilder,
        token: &str,
        cache: &ProofCache,
    ) -> Result<reqwest::Response, VerifiedSendError> {
        let (client, request) = builder.build_split();
        let mut request = request.map_err(VerifiedSendError::InvalidRequest)?;
        // Probe and send to one address, so a relay on another address the
        // name resolves to cannot pass the proof and then take the bearer.
        pin_localhost(request.url_mut());
        let origin = request.url().origin().ascii_serialization();
        if !peer_holds_token(probe_client(), &origin, token, cache).await {
            return Err(VerifiedSendError::Unverified { origin });
        }
        let mut bearer = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| VerifiedSendError::InvalidToken)?;
        bearer.set_sensitive(true);
        request
            .headers_mut()
            .insert(reqwest::header::AUTHORIZATION, bearer);
        client
            .execute(request)
            .await
            .map_err(VerifiedSendError::Request)
    }

    /// Whether the peer at `base_url` holds `token`: a fresh cached proof, or a
    /// new [`probe`] that comes back [`PeerProbe::Proven`]. Attach the bearer
    /// only when this returns `true`.
    pub async fn peer_holds_token(
        client: &reqwest::Client,
        base_url: &str,
        token: &str,
        cache: &ProofCache,
    ) -> bool {
        if cache.is_fresh(base_url, token) {
            return true;
        }
        if probe(client, base_url, token).await == PeerProbe::Proven {
            cache.remember(base_url, token);
            true
        } else {
            cache.forget();
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use hmac::{Hmac, Mac};

    use super::{is_valid_challenge, proof, verify};

    const CHALLENGE: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn proof_is_a_stable_domain_separated_hmac() {
        let first = proof("token", CHALLENGE).expect("proof");
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(proof("token", CHALLENGE).as_deref(), Some(first.as_str()));
        // Domain separation: not the bare HMAC of the challenge.
        let mut bare = Hmac::<sha2::Sha256>::new_from_slice(b"token").unwrap();
        bare.update(CHALLENGE.as_bytes());
        assert_ne!(first, super::to_hex(&bare.finalize().into_bytes()));
        assert_ne!(proof("other", CHALLENGE), Some(first.clone()));
        let other_challenge = "fedcba9876543210fedcba9876543210";
        assert_ne!(proof("token", other_challenge), Some(first));
    }

    #[test]
    fn proof_matches_the_reference_hmac_construction() {
        let mut mac = Hmac::<sha2::Sha256>::new_from_slice(b"token").unwrap();
        mac.update(b"ryu-loopback-peer-proof-v1\0");
        mac.update(CHALLENGE.as_bytes());
        let expected: String = mac
            .finalize()
            .into_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(proof("token", CHALLENGE), Some(expected));
    }

    /// Pinned vector shared with Island's TypeScript twin
    /// (`apps/island/src/main/services/shadow-peer-proof.test.ts`), so the two
    /// implementations can never drift apart silently.
    #[test]
    fn proof_matches_the_cross_language_vector() {
        assert_eq!(
            proof("token", CHALLENGE).as_deref(),
            Some("c70e8b6b85ca22652a1636872ebe8403aef0a66d5ba962ab752afd1b2082e38f")
        );
    }

    #[test]
    fn verify_accepts_only_the_matching_proof() {
        let good = proof("token", CHALLENGE).unwrap();
        assert!(verify("token", CHALLENGE, &good));
        assert!(verify("token", CHALLENGE, &good.to_ascii_uppercase()));
        assert!(!verify("other", CHALLENGE, &good));
        assert!(!verify("token", CHALLENGE, &good[..63]));
        assert!(!verify("token", CHALLENGE, ""));
    }

    #[test]
    fn empty_tokens_and_malformed_challenges_fail_closed() {
        assert_eq!(proof("", CHALLENGE), None);
        assert!(!verify("", CHALLENGE, ""));
        assert_eq!(proof("token", "short"), None);
        assert_eq!(proof("token", &"a".repeat(129)), None);
        assert_eq!(proof("token", "0123456789abcdef0123456789abcde/"), None);
        assert!(is_valid_challenge(&"a".repeat(128)));
        assert!(is_valid_challenge("ABCDEFGHIJKLMNOPQRSTUVWXYZ-_abcd"));
    }

    #[cfg(feature = "peer-probe")]
    #[test]
    fn minted_challenges_are_valid_and_unique() {
        let first = super::new_challenge();
        assert!(is_valid_challenge(&first));
        assert_ne!(first, super::new_challenge());
    }

    #[cfg(feature = "peer-probe")]
    #[test]
    fn pin_localhost_rewrites_only_localhost_names() {
        let pinned = |raw: &str| {
            let mut url = reqwest::Url::parse(raw).unwrap();
            let rewritten = super::pin_localhost(&mut url);
            (rewritten, url.to_string())
        };
        assert_eq!(
            pinned("http://localhost:4030/clips?x=1"),
            (true, "http://127.0.0.1:4030/clips?x=1".to_owned())
        );
        assert_eq!(
            pinned("http://LOCALHOST.:4030"),
            (true, "http://127.0.0.1:4030/".to_owned())
        );
        assert_eq!(
            pinned("http://shadow.localhost:4030"),
            (true, "http://127.0.0.1:4030/".to_owned())
        );
        assert_eq!(
            pinned("http://127.0.0.1:4030"),
            (false, "http://127.0.0.1:4030/".to_owned())
        );
        assert_eq!(
            pinned("http://[::1]:4030"),
            (false, "http://[::1]:4030/".to_owned())
        );
        assert_eq!(
            pinned("http://notlocalhost:4030"),
            (false, "http://notlocalhost:4030/".to_owned())
        );
    }

    #[cfg(feature = "peer-probe")]
    #[test]
    fn proof_cache_is_keyed_by_url_and_token_and_expires() {
        use std::time::Duration;
        let cache = super::ProofCache::new(Duration::from_secs(60));
        assert!(!cache.is_fresh("http://127.0.0.1:1", "token"));
        cache.remember("http://127.0.0.1:1", "token");
        assert!(cache.is_fresh("http://127.0.0.1:1", "token"));
        assert!(!cache.is_fresh("http://127.0.0.1:2", "token"));
        assert!(!cache.is_fresh("http://127.0.0.1:1", "rotated"));
        cache.forget();
        assert!(!cache.is_fresh("http://127.0.0.1:1", "token"));

        let expired = super::ProofCache::new(Duration::ZERO);
        expired.remember("http://127.0.0.1:1", "token");
        assert!(!expired.is_fresh("http://127.0.0.1:1", "token"));
    }
}
