//! Verification of the Box service's signed minimum waivers.
//!
//! A Box resume onto the Box's own parked VM inside the provider hour its last
//! charged start there already paid for owes no new five-minute minimum. The
//! Box service decides that, and signs it: `PublicBox.billing.waiver` is
//! `bw1.<payload>.<signature>` (both base64url without padding), where the
//! signature is Ed25519 over the ASCII bytes `bw1.<payload>` and the payload
//! is JSON `{ "boxId", "tenant", "startedAtMs", "paidHourEndsAtMs" }`.
//!
//! Core forwards the token on each tick of that run (`minimum_waiver`). The
//! Gateway honours it only when the token verifies under the configured
//! public key (`GATEWAY_BOX_MINIMUM_WAIVER_PUBLIC_KEY`) and names the tick's
//! own Box and org, and the run began at the waived start: within the skew
//! allowance either side of `startedAtMs`. `paidHourEndsAtMs` is not an upper
//! bound on when the run may begin: the waiver was decided at `startedAtMs`, so
//! a resume signed just before the hour ends is still honoured when Core's first
//! metered second lands after it. So a forwarder key alone cannot skip a minimum
//! the Box service did not waive, and a waiver cannot be reused for another
//! start of the same Box, even one that begins before the paid hour ends (a
//! later start onto a different VM is charged its own minimum and signs no
//! waiver).

use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;

/// Token version prefix.
const PREFIX: &str = "bw1";
/// Longest token accepted (a payload of ids and two timestamps is ~200 bytes).
const MAX_TOKEN_CHARS: usize = 1024;
/// How long before the Box service's recorded start a run may appear to begin:
/// Core's run total counts whole seconds per tick and the clocks may skew.
pub(super) const START_SKEW_MS: i64 = 120_000;

/// The signed claims of one waiver.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WaiverClaims {
    pub box_id: String,
    pub tenant: String,
    pub started_at_ms: i64,
    pub paid_hour_ends_at_ms: i64,
}

/// Why a waiver was not honoured (logged at debug; the tick pays the minimum).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum WaiverRejection {
    NoKey,
    BadKey,
    Malformed,
    BadSignature,
    OtherBox,
    OtherOrg,
    OutsideStart,
}

/// Decode the configured base64 (standard or url-safe, padding optional)
/// 32-byte Ed25519 public key.
pub(super) fn parse_public_key(raw: &str) -> Option<VerifyingKey> {
    let raw = raw.trim();
    let bytes = [
        &base64::engine::general_purpose::STANDARD,
        &base64::engine::general_purpose::STANDARD_NO_PAD,
        &base64::engine::general_purpose::URL_SAFE,
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
    ]
    .into_iter()
    .find_map(|engine| engine.decode(raw).ok())?;
    let bytes: [u8; 32] = bytes.try_into().ok()?;
    VerifyingKey::from_bytes(&bytes).ok()
}

/// Check `token`'s signature and decode its claims.
pub(super) fn decode(key: &VerifyingKey, token: &str) -> Result<WaiverClaims, WaiverRejection> {
    if token.len() > MAX_TOKEN_CHARS {
        return Err(WaiverRejection::Malformed);
    }
    let mut parts = token.split('.');
    let (Some(PREFIX), Some(payload), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(WaiverRejection::Malformed);
    };
    let engine = &base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let signature: [u8; 64] = engine
        .decode(signature)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(WaiverRejection::Malformed)?;
    let signed = &token[..PREFIX.len() + 1 + payload.len()];
    key.verify_strict(signed.as_bytes(), &Signature::from_bytes(&signature))
        .map_err(|_| WaiverRejection::BadSignature)?;
    let payload = engine
        .decode(payload)
        .map_err(|_| WaiverRejection::Malformed)?;
    serde_json::from_slice(&payload).map_err(|_| WaiverRejection::Malformed)
}

/// What a tick says about the run the waiver is offered for.
pub(super) struct WaiverRun<'a> {
    pub box_id: Option<&'a str>,
    pub org_id: Option<&'a str>,
    /// The run's metered seconds after this tick (`elapsed_seconds_total`).
    pub elapsed_seconds_total: Option<u64>,
    /// Wall clock now, in Unix milliseconds.
    pub now_ms: i64,
}

/// Whether `token` waives the per-start minimum of the run `run`, under the
/// configured public key `raw_key`.
pub(super) fn verify(
    raw_key: Option<&str>,
    token: &str,
    run: &WaiverRun<'_>,
) -> Result<WaiverClaims, WaiverRejection> {
    let raw_key = raw_key.ok_or(WaiverRejection::NoKey)?;
    let key = parse_public_key(raw_key).ok_or(WaiverRejection::BadKey)?;
    let claims = decode(&key, token)?;
    // A paid hour that ends before the start it was signed for is not a claim
    // the Box service makes.
    if claims.paid_hour_ends_at_ms < claims.started_at_ms {
        return Err(WaiverRejection::Malformed);
    }
    if run.box_id != Some(claims.box_id.as_str()) {
        return Err(WaiverRejection::OtherBox);
    }
    let Some(org_id) = run.org_id else {
        return Err(WaiverRejection::OtherOrg);
    };
    if claims.tenant.strip_prefix("core:") != Some(org_id) {
        return Err(WaiverRejection::OtherOrg);
    }
    // When the run began, by its own metered seconds: a waiver holds for the
    // run that the waived start began, not for another start of the Box. Bound
    // on both sides of the signed start, not by the end of the paid hour.
    let total_ms = run
        .elapsed_seconds_total
        .ok_or(WaiverRejection::OutsideStart)?
        .saturating_mul(1000);
    let run_began_ms = run
        .now_ms
        .saturating_sub(i64::try_from(total_ms).unwrap_or(i64::MAX));
    if run_began_ms < claims.started_at_ms.saturating_sub(START_SKEW_MS)
        || run_began_ms > claims.started_at_ms.saturating_add(START_SKEW_MS)
    {
        return Err(WaiverRejection::OutsideStart);
    }
    Ok(claims)
}

#[cfg(test)]
pub(super) mod testing {
    use base64::Engine as _;
    use ed25519_dalek::{Signer as _, SigningKey};

    /// A fixed test signing key and its base64 public key.
    pub fn keypair(seed: u8) -> (SigningKey, String) {
        let signing = SigningKey::from_bytes(&[seed; 32]);
        let public =
            base64::engine::general_purpose::STANDARD.encode(signing.verifying_key().to_bytes());
        (signing, public)
    }

    /// A `bw1` token over `payload`, as the Box service signs it.
    pub fn sign(key: &SigningKey, payload: &serde_json::Value) -> String {
        let engine = &base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let signed = format!("bw1.{}", engine.encode(payload.to_string()));
        let signature = key.sign(signed.as_bytes());
        format!("{signed}.{}", engine.encode(signature.to_bytes()))
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{keypair, sign};
    use super::{verify, WaiverRejection, WaiverRun, START_SKEW_MS};
    use serde_json::json;

    const BOX: &str = "bx_0123456789abcdef0123456789abcdef";
    const STARTED: i64 = 1_792_490_400_000;
    const HOUR_ENDS: i64 = STARTED + 40 * 60 * 1000;

    fn claims() -> serde_json::Value {
        json!({
            "boxId": BOX,
            "tenant": "core:org_box",
            "startedAtMs": STARTED,
            "paidHourEndsAtMs": HOUR_ENDS,
        })
    }

    fn run(total: u64, now_ms: i64) -> WaiverRun<'static> {
        WaiverRun {
            box_id: Some(BOX),
            org_id: Some("org_box"),
            elapsed_seconds_total: Some(total),
            now_ms,
        }
    }

    #[test]
    fn a_waiver_signed_by_the_box_service_verifies_for_its_own_run() {
        let (key, public) = keypair(7);
        let token = sign(&key, &claims());
        let claims = verify(Some(&public), &token, &run(20, STARTED + 25_000)).expect("verifies");
        assert_eq!(claims.box_id, BOX);
        assert_eq!(claims.paid_hour_ends_at_ms, HOUR_ENDS);
        // A long run keeps its waiver on every later tick.
        assert!(verify(Some(&public), &token, &run(7200, STARTED + 7_205_000)).is_ok());
        // A url-safe or unpadded key spelling is the same key.
        let unpadded = public
            .trim_end_matches('=')
            .replace('+', "-")
            .replace('/', "_");
        assert!(verify(Some(&unpadded), &token, &run(20, STARTED + 25_000)).is_ok());
    }

    #[test]
    fn a_forged_or_misapplied_waiver_is_refused() {
        let (key, public) = keypair(7);
        let (other_key, _) = keypair(9);
        let token = sign(&key, &claims());
        let at = run(20, STARTED + 25_000);
        assert_eq!(verify(None, &token, &at), Err(WaiverRejection::NoKey));
        assert_eq!(
            verify(Some("not-a-key"), &token, &at),
            Err(WaiverRejection::BadKey)
        );
        // Signed by anyone but the Box service.
        assert_eq!(
            verify(Some(&public), &sign(&other_key, &claims()), &at),
            Err(WaiverRejection::BadSignature)
        );
        // A payload edited after signing.
        let (head, signature) = token.rsplit_once('.').expect("token");
        let mut forged_claims = claims();
        forged_claims["paidHourEndsAtMs"] = json!(HOUR_ENDS + 3_600_000);
        let forged_payload = sign(&other_key, &forged_claims);
        let forged_head = forged_payload.rsplit_once('.').expect("token").0;
        assert_ne!(head, forged_head);
        assert_eq!(
            verify(Some(&public), &format!("{forged_head}.{signature}"), &at),
            Err(WaiverRejection::BadSignature)
        );
        for malformed in ["", "bw1", "bw1.a", "bw2.a.b", "bw1.a.b.c", "bw1.!!.??"] {
            assert_eq!(
                verify(Some(&public), malformed, &at),
                Err(WaiverRejection::Malformed),
                "{malformed:?}"
            );
        }
        assert_eq!(
            verify(Some(&public), &"x".repeat(2000), &at),
            Err(WaiverRejection::Malformed)
        );
        // Another Box's waiver, or another org's.
        let other_box = WaiverRun {
            box_id: Some("bx_other"),
            ..run(20, STARTED + 25_000)
        };
        assert_eq!(
            verify(Some(&public), &token, &other_box),
            Err(WaiverRejection::OtherBox)
        );
        let no_box = WaiverRun {
            box_id: None,
            ..run(20, STARTED + 25_000)
        };
        assert_eq!(
            verify(Some(&public), &token, &no_box),
            Err(WaiverRejection::OtherBox)
        );
        let other_org = WaiverRun {
            org_id: Some("org_other"),
            ..run(20, STARTED + 25_000)
        };
        assert_eq!(
            verify(Some(&public), &token, &other_org),
            Err(WaiverRejection::OtherOrg)
        );
        let no_org = WaiverRun {
            org_id: None,
            ..run(20, STARTED + 25_000)
        };
        assert_eq!(
            verify(Some(&public), &token, &no_org),
            Err(WaiverRejection::OtherOrg)
        );
        let mut org_tenant = claims();
        org_tenant["tenant"] = json!("org:org_box");
        assert_eq!(
            verify(Some(&public), &sign(&key, &org_tenant), &at),
            Err(WaiverRejection::OtherOrg)
        );
    }

    #[test]
    fn a_waived_resume_just_before_the_hour_ends_still_verifies_after_it() {
        let (key, public) = keypair(7);
        // The Box service waived a resume 20 s before the paid hour ended; Core
        // registers the run and its first metered second a few seconds after.
        let mut late = claims();
        late["startedAtMs"] = json!(HOUR_ENDS - 20_000);
        let token = sign(&key, &late);
        assert!(verify(Some(&public), &token, &run(5, HOUR_ENDS + 5_000)).is_ok());
        // Later ticks of the same run keep the waiver.
        assert!(verify(Some(&public), &token, &run(600, HOUR_ENDS + 580_000)).is_ok());
    }

    #[test]
    fn a_waiver_holds_only_for_the_start_it_was_signed_for() {
        let (key, public) = keypair(7);
        let token = sign(&key, &claims());
        // A later start of the same Box, after the paid hour ended: the run
        // began at the hour's end, so it pays its minimum.
        assert_eq!(
            verify(Some(&public), &token, &run(10, HOUR_ENDS + 10_000)),
            Err(WaiverRejection::OutsideStart)
        );
        // Another start of the same Box inside the paid hour (a resume onto a
        // different VM): it began minutes after the signed start, so a forwarder
        // replaying the first token does not waive its minimum.
        assert_eq!(
            verify(
                Some(&public),
                &token,
                &run(30, STARTED + 10 * 60 * 1000 + 30_000)
            ),
            Err(WaiverRejection::OutsideStart)
        );
        // A run that claims to have begun well before the waived start.
        assert_eq!(
            verify(
                Some(&public),
                &token,
                &run(600, STARTED + 600_000 - START_SKEW_MS - 1_000)
            ),
            Err(WaiverRejection::OutsideStart)
        );
        // Inside the skew allowance is fine.
        assert!(verify(Some(&public), &token, &run(30, STARTED + 30_000 - 60_000)).is_ok());
        // A tick without the run total cannot be placed, so it pays.
        let untotalled = WaiverRun {
            elapsed_seconds_total: None,
            ..run(20, STARTED + 25_000)
        };
        assert_eq!(
            verify(Some(&public), &token, &untotalled),
            Err(WaiverRejection::OutsideStart)
        );
    }
}
