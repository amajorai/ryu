//! Plan limits that Core enforces on its own data.
//!
//! One limit today: how many accounts (sign-ins or keys) one provider may hold
//! on this node. It applies to each account list on its own: the sealed account
//! vault, the linked plan accounts and the Gateway key lists.
//!
//! The numbers belong to `KERNEL_QUOTAS.maxAccountsPerProvider` in
//! `packages/auth/src/lib/plan-quotas.ts`. Core cannot import that file, so the
//! free number is mirrored here, and
//! `packages/auth/src/lib/plan-quotas.core-drift.test.ts` fails when the two
//! differ. A paid plan or the desktop license raises the limit through the
//! signed `ryu_limits.accountsPerProvider` claim of the user's token
//! ([`note_verified_token`]); Core holds no second number for it.
//!
//! Only a new account is refused. Accounts that already exist keep working when
//! a node holds more than the limit, and replacing or signing in again to an
//! existing account is never refused. Core is open source, so this is a limit
//! for honest use, not a security boundary.

use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
#[cfg(not(test))]
use std::sync::{LazyLock, Mutex};

/// Accounts one provider may hold with no plan and no license.
pub(crate) const FREE_ACCOUNTS_PER_PROVIDER: usize = 10;

/// What a refused add tells the person. The same sentence for every list.
pub(crate) const ACCOUNT_LIMIT_MESSAGE: &str =
    "This provider already has the most accounts your plan allows. Remove one to add another.";

/// The `code` of a refused add. The same for every list.
pub(crate) const ACCOUNT_LIMIT_CODE: &str = "provider_account_limit";

/// How long a verified plan limit keeps applying after the last request that
/// carried it. A user token lives 15 minutes and a signed-in desktop sends one
/// with its requests, so a licensed user renews this all the time. After a
/// sign-out, a lapsed license or a stretch offline, the node is back on the
/// free limit within this window.
const CLAIM_SECONDS: u64 = 15 * 60;

/// The plan limit one user's newest verified token carried.
#[derive(Debug, Clone, Copy)]
struct Lift {
    limit: usize,
    /// When the token was seen, in seconds since the Unix epoch.
    seen: u64,
}

/// The limits verified tokens carried, by user id. A test thread has its own,
/// so tests never change the limit another test is counting against.
type Lifts = HashMap<String, Lift>;
#[cfg(not(test))]
static LIFTS: LazyLock<Mutex<Lifts>> = LazyLock::new(Mutex::default);
#[cfg(test)]
thread_local! {
    static LIFTS: RefCell<Lifts> = RefCell::default();
}

fn with_lifts<T>(apply: impl FnOnce(&mut Lifts) -> T) -> T {
    #[cfg(not(test))]
    return apply(
        &mut LIFTS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
    );
    #[cfg(test)]
    return LIFTS.with(|lifts| apply(&mut lifts.borrow_mut()));
}

/// `ryu_limits.accountsPerProvider` of a user token: the plan's number, signed
/// by the control plane (`planLimit(plan, "maxAccountsPerProvider")`).
///
/// The caller has ALREADY verified this token's signature, issuer, audience
/// and expiry (`identity_verify::verify_jwt_with_expiry`). This reads one more
/// field of the same signed payload, so it must never be given a token that
/// did not verify.
fn claimed_accounts_per_provider(verified_token: &str) -> Option<usize> {
    use base64::Engine as _;
    let payload = verified_token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    let limit = claims
        .get("ryu_limits")?
        .get("accountsPerProvider")?
        .as_u64()?;
    usize::try_from(limit).ok().filter(|limit| *limit > 0)
}

/// Remember the plan limit of a user token that just verified. Called where
/// Core verifies a request's user token, so the routes need no extra work and
/// a sign-in that finishes in the background still sees the limit.
///
/// `claim_org` is the org the token's plan claims were evaluated for. On a node
/// bound to an org, a claim evaluated for another org is ignored, as it is for
/// the Box limit. A token with no `accountsPerProvider` changes nothing.
pub(crate) fn note_verified_token(user_id: &str, claim_org: Option<&str>, verified_token: &str) {
    let node_org = crate::server::node_org_id();
    if let (Some(node_org), Some(claim_org)) = (node_org.as_deref(), claim_org) {
        if node_org != claim_org {
            return;
        }
    }
    let Some(limit) = claimed_accounts_per_provider(verified_token) else {
        return;
    };
    let now = crate::pairing::now_secs();
    with_lifts(|lifts| {
        lifts.retain(|_, lift| is_fresh(lift, now));
        lifts.insert(user_id.to_owned(), Lift { limit, seen: now });
    });
}

fn is_fresh(lift: &Lift, now: u64) -> bool {
    now.saturating_sub(lift.seen) < CLAIM_SECONDS
}

/// The most accounts one provider may hold on this node right now: the highest
/// limit a verified token carried in the last 15 minutes, and never less than
/// the free limit. With no such token (signed out, offline, a node that never
/// saw a user token) it is the free limit.
pub(crate) fn account_limit() -> usize {
    let now = crate::pairing::now_secs();
    with_lifts(|lifts| {
        lifts
            .values()
            .filter(|lift| is_fresh(lift, now))
            .map(|lift| lift.limit)
            .max()
    })
    .map_or(FREE_ACCOUNTS_PER_PROVIDER, |limit| {
        limit.max(FREE_ACCOUNTS_PER_PROVIDER)
    })
}

/// Forget every remembered limit, so a test starts from the free limit even
/// when the test runner reuses its thread.
#[cfg(test)]
pub(crate) fn forget_claims_for_test() {
    with_lifts(Lifts::clear);
}

/// Make every remembered limit look older than `seconds`.
#[cfg(test)]
pub(crate) fn age_claims_for_test(seconds: u64) {
    with_lifts(|lifts| {
        for lift in lifts.values_mut() {
            lift.seen = lift.seen.saturating_sub(seconds);
        }
    });
}

/// An unsigned token-shaped string whose payload is `claims`, for tests of the
/// code that runs after verification.
#[cfg(test)]
pub(crate) fn unsigned_token_for_test(claims: &Value) -> String {
    use base64::Engine as _;
    let encode =
        |value: &Value| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string());
    format!(
        "{}.{}.signature",
        encode(&json!({ "alg": "EdDSA" })),
        encode(claims)
    )
}

/// Whether a provider that holds `count` accounts may take one more.
pub(crate) fn has_room(count: usize) -> bool {
    count < account_limit()
}

/// A new account was refused: its provider already holds the most the plan
/// allows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AccountLimitReached {
    /// The provider as the refusing list names it: a vault scope key, a plan
    /// provider (`anthropic`, `openai`) or a Gateway provider id.
    pub(crate) provider: String,
    pub(crate) limit: usize,
    /// Accounts the provider held when the add was refused.
    pub(crate) count: usize,
}

impl std::fmt::Display for AccountLimitReached {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(ACCOUNT_LIMIT_MESSAGE)
    }
}

impl std::error::Error for AccountLimitReached {}

impl AccountLimitReached {
    /// `Err` when `provider`, which holds `count` accounts, has no room for one
    /// more.
    pub(crate) fn check(provider: &str, count: usize) -> Result<(), Self> {
        if has_room(count) {
            return Ok(());
        }
        Err(Self {
            provider: provider.to_owned(),
            limit: account_limit(),
            count,
        })
    }

    /// The refusal inside an error, whatever context wraps it.
    pub(crate) fn from_error(error: &anyhow::Error) -> Option<&Self> {
        error.chain().find_map(|cause| cause.downcast_ref::<Self>())
    }

    /// The fields every refusal carries beside its sentence.
    fn fields(&self) -> Value {
        json!({
            "code": ACCOUNT_LIMIT_CODE,
            "provider": self.provider,
            "limit": self.limit,
            "count": self.count,
        })
    }

    /// `409 {error, code, provider, limit, count}`: the flat shape of the
    /// provider, sign-in and Gateway routes.
    pub(crate) fn response(&self) -> (StatusCode, Json<Value>) {
        let mut body = self.fields();
        body["error"] = Value::from(ACCOUNT_LIMIT_MESSAGE);
        (StatusCode::CONFLICT, Json(body))
    }

    /// `409 {error: {code, message, provider, limit, count}}`: the nested shape
    /// of the plan account routes.
    pub(crate) fn nested_response(&self) -> (StatusCode, Json<Value>) {
        let mut error = self.fields();
        error["message"] = Value::from(ACCOUNT_LIMIT_MESSAGE);
        (StatusCode::CONFLICT, Json(json!({ "error": error })))
    }

    /// Record the refusal for the calling route ([`take_refusal`]) and return
    /// its sentence, for a list whose errors are plain strings.
    pub(crate) fn noted(self) -> String {
        note_refusal(&self);
        self.to_string()
    }
}

thread_local! {
    /// The last refusal on this thread that no route has read yet.
    static LAST_REFUSAL: RefCell<Option<AccountLimitReached>> = const { RefCell::new(None) };
}

/// Record a refusal for the route that is running on this thread. Some callers
/// between the account lists and the routes turn every failure into their own
/// sentence, which would hide why the add was refused.
pub(crate) fn note_refusal(refusal: &AccountLimitReached) {
    LAST_REFUSAL.with(|slot| *slot.borrow_mut() = Some(refusal.clone()));
}

/// The refusal recorded on this thread, if any. Reading it clears it. A route
/// calls this before the synchronous call it reports on (to drop an older
/// refusal nobody read) and again when that call fails.
pub(crate) fn take_refusal() -> Option<AccountLimitReached> {
    LAST_REFUSAL.with(|slot| slot.borrow_mut().take())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_provider_has_room_below_the_limit_only() {
        forget_claims_for_test();
        assert_eq!(account_limit(), FREE_ACCOUNTS_PER_PROVIDER);
        assert!(has_room(0));
        assert!(has_room(FREE_ACCOUNTS_PER_PROVIDER - 1));
        assert!(!has_room(FREE_ACCOUNTS_PER_PROVIDER));
        assert!(!has_room(FREE_ACCOUNTS_PER_PROVIDER + 1));
    }

    fn token(limits: Value) -> String {
        unsigned_token_for_test(&json!({ "id": "user-1", "ryu_limits": limits }))
    }

    fn licensed(limit: usize) -> String {
        token(json!({ "boxConcurrency": 2, "accountsPerProvider": limit }))
    }

    #[test]
    fn the_claim_is_read_only_as_a_whole_positive_number() {
        assert_eq!(claimed_accounts_per_provider(&licensed(50)), Some(50));
        for malformed in [
            json!({ "boxConcurrency": 2 }),
            json!({ "accountsPerProvider": 0 }),
            json!({ "accountsPerProvider": -5 }),
            json!({ "accountsPerProvider": 50.5 }),
            json!({ "accountsPerProvider": "50" }),
            json!({ "accountsPerProvider": null }),
            json!(50),
            Value::Null,
        ] {
            assert_eq!(
                claimed_accounts_per_provider(&token(malformed.clone())),
                None,
                "{malformed}"
            );
        }
        let no_claim = unsigned_token_for_test(&json!({ "id": "user-1" }));
        assert_eq!(claimed_accounts_per_provider(&no_claim), None);
        for garbage in ["", "not-a-token", "a.b.c", "a.!!!.c"] {
            assert_eq!(claimed_accounts_per_provider(garbage), None, "{garbage}");
        }
    }

    #[test]
    fn a_verified_plan_token_raises_the_limit_and_no_token_means_the_free_limit() {
        let free = FREE_ACCOUNTS_PER_PROVIDER;
        forget_claims_for_test();
        // Signed out, offline, or a node that never saw a user token.
        assert_eq!(account_limit(), free);
        assert!(!has_room(free));

        // A licensed user's token: the plan's number applies.
        note_verified_token("licensed-user", None, &licensed(50));
        assert_eq!(account_limit(), 50);
        assert!(has_room(free), "the 11th account now fits");
        assert!(has_room(49));
        assert!(!has_room(50), "licensed is a higher limit, not no limit");
        assert_eq!(
            AccountLimitReached::check("anthropic", 50)
                .unwrap_err()
                .limit,
            50
        );

        // A token without the claim, or a free user's token, does not lower it
        // for the licensed user who is still signed in on this node.
        let no_claim = unsigned_token_for_test(&json!({ "id": "other-user" }));
        note_verified_token("other-user", None, &no_claim);
        note_verified_token("free-user", None, &licensed(free));
        assert_eq!(account_limit(), 50);

        // The licensed user's own next token says free: the license lapsed.
        note_verified_token("licensed-user", None, &licensed(free));
        assert_eq!(account_limit(), free);
        forget_claims_for_test();
    }

    #[test]
    fn a_remembered_limit_expires_and_never_goes_below_the_free_limit() {
        let free = FREE_ACCOUNTS_PER_PROVIDER;
        forget_claims_for_test();
        note_verified_token("licensed-user", None, &licensed(50));
        age_claims_for_test(CLAIM_SECONDS - 60);
        assert_eq!(account_limit(), 50, "still inside the window");
        age_claims_for_test(60);
        assert_eq!(account_limit(), free, "no fresh token: back to free");

        // A claim below the free limit never takes accounts away from anyone.
        note_verified_token("odd-user", None, &licensed(3));
        assert_eq!(account_limit(), free);
        // Expired entries are dropped when the next token arrives.
        with_lifts(|lifts| assert_eq!(lifts.len(), 1));
        forget_claims_for_test();
    }

    #[test]
    fn a_refusal_names_the_provider_the_limit_and_the_count() {
        let limit = account_limit();
        assert_eq!(AccountLimitReached::check("anthropic", limit - 1), Ok(()));
        let refusal = AccountLimitReached::check("anthropic", limit + 2).unwrap_err();
        assert_eq!(refusal.to_string(), ACCOUNT_LIMIT_MESSAGE);

        let (status, Json(flat)) = refusal.response();
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            flat,
            json!({
                "error": ACCOUNT_LIMIT_MESSAGE,
                "code": "provider_account_limit",
                "provider": "anthropic",
                "limit": limit,
                "count": limit + 2,
            })
        );
        let (status, Json(nested)) = refusal.nested_response();
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(nested["error"]["code"], ACCOUNT_LIMIT_CODE);
        assert_eq!(nested["error"]["message"], ACCOUNT_LIMIT_MESSAGE);
        assert_eq!(nested["error"]["limit"], limit);
        assert_eq!(nested["error"]["count"], limit + 2);
    }

    #[test]
    fn a_refusal_is_found_under_added_context_and_read_back_once() {
        use anyhow::Context as _;
        let refusal = AccountLimitReached::check("openai", account_limit()).unwrap_err();
        let wrapped = Err::<(), _>(refusal.clone())
            .context("saving the account")
            .unwrap_err();
        assert_eq!(AccountLimitReached::from_error(&wrapped), Some(&refusal));
        let other = anyhow::anyhow!("the disk is full");
        assert_eq!(AccountLimitReached::from_error(&other), None);

        let _ = take_refusal();
        assert_eq!(refusal.clone().noted(), ACCOUNT_LIMIT_MESSAGE);
        assert_eq!(take_refusal(), Some(refusal));
        assert_eq!(take_refusal(), None);
    }
}
