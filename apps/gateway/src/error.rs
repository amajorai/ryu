use axum::{
    http::{HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

use crate::policy_alert::{PolicyAlert, POLICY_ALERT_HEADER};

/// The fixed message of `abuse_throttled`.
const ABUSE_THROTTLED_MESSAGE: &str =
    "Requests on this account are temporarily limited by Ryu's abuse protections. Please retry after a moment.";
/// The fixed message of `account_restricted`.
const ACCOUNT_RESTRICTED_MESSAGE: &str =
    "This account is restricted by Ryu's abuse protections, so this request is not available.";

#[derive(Debug, Error)]
pub enum GatewayError {
    #[error("Configuration revision conflict")]
    ConfigConflict(ryu_gw_credentials::ConfigRevision),
    #[error("Authentication failed: {0}")]
    Unauthorized(String),

    #[error("Rate limit exceeded")]
    RateLimited,

    /// The gateway's own inbound per-key limiter refused the request and the
    /// refusing policy is known. Same wire contract as [`Self::RateLimited`]
    /// (429 `rate_limit_exceeded`), plus `Retry-After`, the IETF `RateLimit` /
    /// `RateLimit-Policy` headers, and `error.retry_after` in the body.
    #[error("Rate limit exceeded")]
    RateLimitedBy(InboundRateLimit),

    /// A firewall / DLP inbound match blocked the request (403). Carries the
    /// optional [`PolicyAlert`] stamped when the matched firewall rule's `alert`
    /// tier is `>= Warn`, so `into_response` emits `x-ryu-policy-alert` on the
    /// error response (the F1 error-path stamp — this Response only exists here).
    #[error("Request blocked by firewall: {0}")]
    FirewallBlocked(String, Option<PolicyAlert>),

    #[error("Blocked by control-plane policy: {0}")]
    PolicyViolation(String),

    /// A platform refusal from the error catalogue with no tenant remedy
    /// (`feature_not_permitted`, `media_unscreenable`, ...). Renders 403 with
    /// `type: "policy_violation"` so Core keeps classifying it as a block, and
    /// carries the catalogue `code` and `layer: "platform"` separately. The
    /// message is fixed per call site and never echoes request content. A
    /// safety outcome, so it never counts against a provider's health.
    #[error("Refused by platform policy: {code}")]
    PlatformRefused {
        code: &'static str,
        message: &'static str,
    },

    /// A step the request must pass before dispatch could not run, so it is
    /// refused rather than sent unchecked (catalogue `screening_unavailable`,
    /// 503 with `Retry-After`). `reason` names the step for logs and the audit
    /// row only; the client sees a fixed message. A safety outcome, so it
    /// never counts against a provider's health.
    #[error("Screening unavailable: {reason}")]
    ScreeningUnavailable {
        reason: &'static str,
        retry_after_secs: u64,
    },

    /// A hazard screener verdict blocked the request or withheld its output
    /// (catalogue `platform_floor_blocked`, `platform_floor_output_blocked`,
    /// or `tenant_policy_blocked` for a self-hosted node's own screener).
    /// Renders 403 with `type: "policy_violation"`, a fixed message per
    /// code, the S-codes only and the `scr_` screening id: never a score,
    /// a backend id or matched text. A safety outcome.
    #[error("Content blocked: {}", .0.code())]
    ContentBlocked(Box<ContentBlock>),

    /// The screener is degraded and this org has used its degraded share
    /// (catalogue `screening_degraded_throttle`, 429 with `Retry-After`).
    /// A safety outcome.
    #[error("Screening degraded throttle")]
    ScreeningDegradedThrottle { retry_after_secs: u64 },

    /// The request carries more text than the hard-code screen can classify
    /// (catalogue `screening_capacity_exceeded`, 413). A safety outcome.
    #[error("Screening capacity exceeded")]
    ScreeningCapacityExceeded,

    /// The credential's platform standing refuses this request (spec 05.5):
    /// `org_suspended`, `user_banned` or `key_suspended_abuse`. Renders 403
    /// with `type: "policy_violation"`, `layer: "platform"`, `remedy:
    /// "appeal"` and the public appeal link. A safety outcome.
    #[error("Refused by account standing: {}", .0.code)]
    StandingRefused(Box<crate::standing::StandingRefusalDetail>),

    /// The control plane could not read the credential's standing, or sent
    /// one the Gateway cannot parse, so the request is refused rather than
    /// served on an unknown standing (catalogue `standing_unavailable`, 503
    /// with `Retry-After`). A safety outcome.
    #[error("Account standing unavailable")]
    StandingUnavailable,

    /// The abuse ladder throttles a subject of this request (spec 04.8.1
    /// L2): its narrowed rate or in-flight cap is used (catalogue
    /// `abuse_throttled`, 429 with `Retry-After`, `remedy: "appeal"`). A
    /// safety outcome.
    #[error("Throttled by the abuse ladder")]
    AbuseThrottled(Box<crate::enforcement::LadderRefusal>),

    /// The abuse ladder restricts a subject of this request (spec 04.8.1
    /// L3) and the request needs something L3 removes: media generation, an
    /// own-supply vendor slot, or a model off the floor's restricted list
    /// (catalogue `account_restricted`, 403, `remedy: "appeal"`). A safety
    /// outcome.
    #[error("Refused by the abuse ladder's restrict level")]
    AccountRestricted(Box<crate::enforcement::LadderRefusal>),

    /// A gateway key younger than a day used its tighter default rate or
    /// in-flight cap on the fleet (catalogue `new_key_rate_limited`, 429
    /// with `Retry-After`). Not an account action, so no appeal. A safety
    /// outcome.
    #[error("New key rate limited")]
    NewKeyRateLimited { retry_after_secs: u64 },

    // Never constructed since #218/#362 (f4e22a92) replaced the "no provider"
    // path with a structured degraded-mode 503; kept as the reserved public
    // error contract with its stable 404 `model_not_found` mapping below.
    #[allow(dead_code)]
    #[error("No provider available for model: {0}")]
    NoProvider(String),

    #[error("Provider error: {0}")]
    ProviderError(String),

    /// The upstream refused this request with a 4xx other than 402, 408 or
    /// 429 (`status` is the upstream code). Answers clients exactly like
    /// [`GatewayError::ProviderError`]. Apart from a refused credential (401)
    /// it never counts toward the provider's circuit breaker: the breaker is
    /// shared by every tenant, and one caller's refused requests must not open
    /// it. On the hosted fleet and on a managed node it also ends the request
    /// instead of moving it to another provider (see
    /// [`GatewayError::ends_hosted_attempt`]).
    ///
    /// `signal` is set when the body matched a row of the provider crate's
    /// safety-signal table. It changes nothing on its own: a dispatch site
    /// that knows the attempt spent a Ryu-held credential settles it into
    /// [`GatewayError::UpstreamSafetyRefused`]
    /// (`pipeline::upstream_signals::settle`). Every other path, a tenant's
    /// own key included, keeps it an ordinary rejection.
    #[error("Provider rejected the request: {message}")]
    ProviderRejected {
        status: u16,
        message: String,
        signal: Option<Box<UpstreamSignal>>,
    },

    /// The upstream refused a request that spent a Ryu-held credential for a
    /// safety reason (spec 03.5.2): it blocked the end user, refused the
    /// content, or warned the account. Renders 403 with `type:
    /// "policy_violation"`, `layer: "upstream"` and the vendor, with a fixed
    /// message: the upstream's own wording can echo the request. A safety
    /// outcome, so it is never retried on another vendor (D16), never counts
    /// toward a circuit and never cools an account.
    #[error("Refused upstream: {}", .0.code())]
    UpstreamSafetyRefused(Box<UpstreamRefusal>),

    /// HTTP transport failed before a provider response was available. An
    /// outbound proxy outage must not trip the upstream provider circuit.
    #[error("Provider transport error: {0}")]
    ProviderTransport(String),
    #[error("Provider delivery uncertain: {0}")]
    ProviderDeliveryUncertain(String),

    /// An upstream provider rejected the configured account with HTTP 402.
    /// Distinct from the managed Ryu wallet (`InsufficientCredits`).
    #[error("Provider payment required: {provider}: {message}")]
    ProviderPaymentRequired { provider: String, message: String },

    /// An upstream *provider* returned HTTP 429. Distinct from the gateway's own
    /// inbound [`GatewayError::RateLimited`]: this is a capacity signal the
    /// pipeline acts on — it demotes down the cost-tier fallback chain and rotates
    /// to the next account WITHOUT tripping the provider's circuit breaker (a
    /// rate-limit means "busy", not "broken"), and feeds `retry_after`/`reset_at`
    /// into the quota store. Stable code: `provider_rate_limited`.
    #[error("Provider rate limited: {provider}")]
    ProviderRateLimited {
        provider: String,
        retry_after: Option<u64>,
        reset_at: Option<u64>,
    },

    #[error("Circuit open for provider: {0}")]
    CircuitOpen(String),

    /// The local-engine admission queue is full — too many requests are already
    /// waiting for the resident model's batch slots. Retryable. Stable code:
    /// `engine_overloaded`.
    #[error("Engine overloaded: {0}")]
    Overloaded(String),

    /// A per-user / per-agent / per-session charged-spend budget (or the wallet-empty
    /// rule) hit `Stop` (402). Carries the optional [`PolicyAlert`] stamped when
    /// the matched rule's `alert` tier is `>= Warn`, so `into_response` emits
    /// `x-ryu-policy-alert` on the 402 (the F1 error-path stamp).
    #[error("Budget exceeded")]
    BudgetExceeded(Option<PolicyAlert>),

    /// A managed-inference org's credit balance is exhausted (pre-flight gate).
    /// Distinct from [`GatewayError::BudgetExceeded`] (charged-spend cap):
    /// this is the org wallet hitting zero. Stable code: `insufficient_credits`.
    #[error("Insufficient credits")]
    InsufficientCredits,

    /// The control plane cannot currently prove a managed request can be
    /// accounted for. This is distinct from an empty wallet: a transient
    /// accounting outage must stop provider spend without permanently marking
    /// the customer as out of funds.
    #[error("Credit accounting unavailable")]
    AccountingUnavailable,

    /// A wallet-billed tool call whose price the Gateway does not hold. The
    /// managed tier refuses it before it runs rather than serving it free.
    /// Stable code: `tool_unpriced` (403).
    #[error("Tool call is unpriced: {0}")]
    ToolUnpriced(String),

    /// A call the chosen provider cannot serve on the operator's credential,
    /// refused before it runs (so nothing is reserved or charged): a Treg
    /// endpoint the shared fleet token may not run (platform-blocked, or scoped
    /// to the caller's own account such as a user's Slack workspace), whichever
    /// way the provider was chosen, or any call a trusted caller marked
    /// `requireServable` that the routed provider cannot serve. The caller may
    /// run the call elsewhere. Stable code: `tool_not_servable` (403).
    #[error("Tool is not servable: {0}")]
    ToolNotServable(String),

    /// A wallet-billed tool call refused before it ran for a money reason, with
    /// the figures a caller needs to act: the balance it was judged against,
    /// the charged estimate, any per-call ceiling it set, and where to top up.
    /// Stable code: `insufficient_credits` or `max_cost_exceeded` (402).
    #[error("Tool call payment required: {}", .0.code())]
    ToolPaymentRequired(Box<ToolPaymentRequired>),

    /// The provider's response exceeded the Gateway's read cap. The provider
    /// already ran and metered the call, so it is charged like any other call;
    /// only the body is not delivered. `charged_micro_usd` is what the wallet
    /// was charged (after markup), when it was charged anything. Stable code:
    /// `provider_response_too_large`.
    #[error("Provider response too large: {provider} exceeded {limit_bytes} bytes")]
    ProviderResponseTooLarge {
        provider: String,
        limit_bytes: usize,
        charged_micro_usd: Option<u64>,
    },

    /// The provider's response headers arrived but its body could not be read to
    /// the end (the connection was cut). The provider already ran and metered the
    /// call, so it is charged like any other call; only the body is not
    /// delivered. `charged_micro_usd` is what the wallet was charged (after
    /// markup), when it was charged anything. Stable code:
    /// `provider_body_unreadable`.
    #[error("Provider response body unreadable: {provider}")]
    ProviderBodyUnreadable {
        provider: String,
        charged_micro_usd: Option<u64>,
    },

    /// The durable spend counters cannot be trusted (`spend.db` is sealed under
    /// another key, or this process holds no sealing key). A metered request is
    /// refused rather than counted from zero, which would let a capped caller
    /// spend past the cap. Stable code: `budget_store_unavailable`.
    #[error("Budget store unavailable: {0}")]
    BudgetStoreUnavailable(String),

    /// All providers in the fallback chain are unavailable (circuits open or
    /// provider calls failed). Stable code: `all_providers_unavailable`.
    #[error("All providers unavailable: {0}")]
    AllProvidersUnavailable(String),

    #[allow(dead_code)]
    #[error("Bad request: {0}")]
    BadRequest(String),

    /// A malformed request with a catalogue `code` of its own (for example
    /// `invalid_end_user`). Renders 400 with `type: "invalid_request_error"`
    /// and the specific `code`; the message is fixed per call site and never
    /// echoes request content.
    #[error("Invalid request: {code}")]
    InvalidRequest {
        code: &'static str,
        message: &'static str,
    },

    #[error("Internal error: {0}")]
    Internal(#[from] anyhow::Error),
}

impl GatewayError {
    /// Whether this error is a safety or policy outcome: a refusal the Gateway
    /// or its policy made about this request, not a statement about any
    /// provider's health. A safety outcome never opens a provider circuit,
    /// never quarantines an own-supply row, never cools an account or pool
    /// member, and never moves the request to another provider. The match is
    /// exhaustive so a new variant must be classified before it compiles.
    pub fn is_safety_outcome(&self) -> bool {
        match self {
            GatewayError::FirewallBlocked(..)
            | GatewayError::PolicyViolation(_)
            | GatewayError::PlatformRefused { .. }
            | GatewayError::ScreeningUnavailable { .. }
            | GatewayError::ContentBlocked(_)
            | GatewayError::ScreeningDegradedThrottle { .. }
            | GatewayError::ScreeningCapacityExceeded
            | GatewayError::StandingRefused(_)
            | GatewayError::StandingUnavailable
            | GatewayError::AbuseThrottled(_)
            | GatewayError::AccountRestricted(_)
            | GatewayError::NewKeyRateLimited { .. }
            | GatewayError::UpstreamSafetyRefused(_)
            | GatewayError::RateLimited
            | GatewayError::RateLimitedBy(_) => true,
            GatewayError::ConfigConflict(_)
            | GatewayError::Unauthorized(_)
            | GatewayError::NoProvider(_)
            | GatewayError::ProviderError(_)
            | GatewayError::ProviderRejected { .. }
            | GatewayError::ProviderTransport(_)
            | GatewayError::ProviderDeliveryUncertain(_)
            | GatewayError::ProviderPaymentRequired { .. }
            | GatewayError::ProviderRateLimited { .. }
            | GatewayError::CircuitOpen(_)
            | GatewayError::Overloaded(_)
            | GatewayError::BudgetExceeded(_)
            | GatewayError::BudgetStoreUnavailable(_)
            | GatewayError::InsufficientCredits
            | GatewayError::AccountingUnavailable
            | GatewayError::ToolUnpriced(_)
            | GatewayError::ToolNotServable(_)
            | GatewayError::ToolPaymentRequired(_)
            | GatewayError::ProviderResponseTooLarge { .. }
            | GatewayError::ProviderBodyUnreadable { .. }
            | GatewayError::AllProvidersUnavailable(_)
            | GatewayError::BadRequest(_)
            | GatewayError::InvalidRequest { .. }
            | GatewayError::Internal(_) => false,
        }
    }

    /// Whether this failure ends a request on the hosted fleet (or a managed
    /// node) instead of moving it to the next provider. Only a transport
    /// error, a 5xx, a 408 or a 429 may fall back there, so every other
    /// upstream 4xx is returned, never retried with another vendor, which
    /// would read as shopping for a provider that accepts what one refused.
    /// That includes a 402: its own variant keeps it out of the provider
    /// circuit, but it is still an upstream 4xx. Safety outcomes end the
    /// request on every custody.
    pub fn ends_hosted_attempt(&self) -> bool {
        self.is_safety_outcome()
            || matches!(
                self,
                GatewayError::ProviderRejected { .. }
                    | GatewayError::ProviderPaymentRequired { .. }
            )
    }
}

/// The fixed message of `upstream_identifier_blocked`.
const UPSTREAM_IDENTIFIER_MESSAGE: &str =
    "The model provider has blocked the end user this request was sent for.";
/// The fixed message of `upstream_content_refused`.
const UPSTREAM_CONTENT_MESSAGE: &str =
    "The model provider refused this request under its usage policy.";
/// The fixed message of an account-scope refusal (`principal_blocked`).
const UPSTREAM_ACCOUNT_MESSAGE: &str =
    "The model provider refused this request for the account it was sent on.";

/// An upstream safety refusal recognised from a provider error body (spec
/// 03.5.1). Carries no upstream message text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpstreamSignal {
    /// The provider registry id the attempt was bound to.
    pub provider: String,
    pub scope: ryu_gw_providers::SafetyScope,
    /// The safety-signal table row that matched.
    pub row: &'static str,
    /// The vendor code or type the row matched.
    pub code: Option<String>,
}

impl UpstreamSignal {
    /// The vendor a registry id belongs to, for the client and the event:
    /// Ryu's own supply slots are named after their vendor.
    pub fn vendor(&self) -> &str {
        vendor_of(&self.provider)
    }

    /// The taxonomy code this signal reports (spec 03.5.2).
    pub const fn category(&self) -> ryu_gw_screening::TaxonomyId {
        use ryu_gw_providers::SafetyScope;
        match self.scope {
            SafetyScope::Identifier => ryu_gw_screening::TaxonomyId::UPSTREAM_IDENTIFIER_BLOCKED,
            SafetyScope::Content => ryu_gw_screening::TaxonomyId::UPSTREAM_CONTENT_REFUSED,
            SafetyScope::Account => ryu_gw_screening::TaxonomyId::UPSTREAM_ACCOUNT_WARNING,
        }
    }
}

/// The vendor a provider registry id belongs to.
pub fn vendor_of(provider: &str) -> &str {
    match provider {
        crate::config::OPENAI_CREDITS_PROVIDER_ID => "openai",
        crate::config::ANTHROPIC_CREDITS_PROVIDER_ID => "anthropic",
        other => other,
    }
}

/// The typed body of [`GatewayError::UpstreamSafetyRefused`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpstreamRefusal {
    pub signal: UpstreamSignal,
    /// The upstream HTTP status, for logs.
    pub status: u16,
}

impl UpstreamRefusal {
    /// The catalogue code (spec 00.7). An account-scope refusal is
    /// `principal_blocked`, the code spec 03.5.2 gives that scope.
    pub const fn code(&self) -> &'static str {
        use ryu_gw_providers::SafetyScope;
        match self.signal.scope {
            SafetyScope::Identifier => "upstream_identifier_blocked",
            SafetyScope::Content => "upstream_content_refused",
            SafetyScope::Account => "principal_blocked",
        }
    }

    const fn message(&self) -> &'static str {
        use ryu_gw_providers::SafetyScope;
        match self.signal.scope {
            SafetyScope::Identifier => UPSTREAM_IDENTIFIER_MESSAGE,
            SafetyScope::Content => UPSTREAM_CONTENT_MESSAGE,
            SafetyScope::Account => UPSTREAM_ACCOUNT_MESSAGE,
        }
    }

    const fn remedy(&self) -> &'static str {
        use ryu_gw_providers::SafetyScope;
        match self.signal.scope {
            SafetyScope::Content => "report_false_positive",
            SafetyScope::Identifier | SafetyScope::Account => "appeal",
        }
    }

    /// The `error` object of the 00.7 envelope.
    pub fn error_object(&self) -> serde_json::Value {
        json!({
            "message": self.message(),
            "type": "policy_violation",
            "code": self.code(),
            "layer": "upstream",
            "provider": self.signal.vendor(),
            "remedy": self.remedy(),
        })
    }
}

/// Which layer a screener block belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContentBlockLayer {
    /// Ryu's platform floor (Fleet custody).
    Platform,
    /// A self-hosted node's own opt-in screener. Never Ryu's floor.
    Node,
}

/// The typed body of a screener block (spec 00.7). Built only by the
/// screening glue, which fills it from the floor matrix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentBlock {
    pub layer: ContentBlockLayer,
    /// Whether the response was withheld after the provider ran.
    pub output: bool,
    /// Short S-codes (`S9`) or taxonomy ids without a short form. Never a
    /// score, threshold, backend id or matched text.
    pub categories: Vec<&'static str>,
    /// `scr_` followed by a request-scoped id.
    pub screening_id: String,
    /// What the tokens already produced cost, when the output was withheld
    /// after the provider ran and the charge is known (D15).
    pub charged_micro_usd: Option<u64>,
}

impl ContentBlock {
    pub fn code(&self) -> &'static str {
        match (self.layer, self.output) {
            (ContentBlockLayer::Platform, false) => "platform_floor_blocked",
            (ContentBlockLayer::Platform, true) => "platform_floor_output_blocked",
            (ContentBlockLayer::Node, _) => "tenant_policy_blocked",
        }
    }

    fn message(&self) -> &'static str {
        match (self.layer, self.output) {
            (ContentBlockLayer::Platform, false) => {
                "This request was blocked by Ryu's platform safety policy."
            }
            (ContentBlockLayer::Platform, true) => {
                "This response was withheld by Ryu's platform safety policy."
            }
            (ContentBlockLayer::Node, false) => {
                "This request was blocked by this gateway's content policy."
            }
            (ContentBlockLayer::Node, true) => {
                "This response was withheld by this gateway's content policy."
            }
        }
    }

    const fn layer_str(&self) -> &'static str {
        match self.layer {
            ContentBlockLayer::Platform => "platform",
            ContentBlockLayer::Node => "node",
        }
    }

    const fn remedy(&self) -> &'static str {
        match self.layer {
            ContentBlockLayer::Platform => "report_false_positive",
            ContentBlockLayer::Node => "none",
        }
    }

    /// The `error` object of the 00.7 envelope, shared by the JSON response
    /// and the final SSE frame of a cut stream.
    pub fn error_object(&self) -> serde_json::Value {
        let mut error = json!({
            "message": self.message(),
            "type": "policy_violation",
            "code": self.code(),
            "layer": self.layer_str(),
            "categories": self.categories,
            "screening_id": self.screening_id,
            "remedy": self.remedy(),
        });
        // Only a known charge is stated: a withheld response the provider
        // already billed must never read as free.
        if let Some(charged) = self.charged_micro_usd.filter(|_| self.output) {
            error["charged_micro_usd"] = json!(charged);
        }
        error
    }
}

/// Why a wallet-billed tool call was refused before it ran.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolPaymentReason {
    /// The charged estimate does not fit the org's spendable headroom.
    InsufficientCredits,
    /// The charged estimate is above the caller's per-call ceiling.
    MaxCostExceeded,
}

/// The typed body of a tool call's pre-call `402`. Amounts are micro-USD after
/// Ryu's markup, the same unit the ledger debits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolPaymentRequired {
    pub reason: ToolPaymentReason,
    /// The spendable headroom the call was judged against, when known.
    pub balance_micro_usd: Option<i64>,
    /// What the call was estimated to charge.
    pub estimate_micro_usd: u64,
    /// The caller's per-call ceiling, when it set one.
    pub max_cost_micro_usd: Option<u64>,
    /// Where to add credit; `None` when the operator configured no link.
    pub top_up_url: Option<String>,
}

impl ToolPaymentRequired {
    pub fn code(&self) -> &'static str {
        match self.reason {
            ToolPaymentReason::InsufficientCredits => "insufficient_credits",
            ToolPaymentReason::MaxCostExceeded => "max_cost_exceeded",
        }
    }

    fn message(&self) -> &'static str {
        match self.reason {
            ToolPaymentReason::InsufficientCredits => {
                "organization credit balance does not cover this tool call"
            }
            ToolPaymentReason::MaxCostExceeded => {
                "this tool call is estimated to cost more than the caller's maximum"
            }
        }
    }
}

/// The inbound limiter policy behind a [`GatewayError::RateLimitedBy`], written
/// as IETF RateLimit header fields (draft-ietf-httpapi-ratelimit-headers, the
/// Structured Field form `apps/server/src/rate-limit-headers.ts` also uses):
/// `RateLimit-Policy: "<name>";q=<quota>;w=<window>` and
/// `RateLimit: "<name>";r=0;t=<seconds>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundRateLimit {
    /// Policy name: `requests` (per-key requests per minute) or `burst`
    /// (per-key requests per second).
    pub policy: &'static str,
    /// Requests the policy admits per window.
    pub quota: u64,
    /// Window length in seconds.
    pub window_secs: u64,
    /// Seconds until the token bucket admits one more request.
    pub retry_after_secs: u64,
}

impl InboundRateLimit {
    /// The per-key requests-per-minute token bucket. It refills continuously
    /// at `rpm / 60` per second, so one more request is admitted within
    /// `ceil(60 / rpm)` seconds. `None` for a zero ceiling, which never admits.
    pub fn requests_per_minute(rpm: u64) -> Option<Self> {
        (rpm > 0).then(|| Self {
            policy: "requests",
            quota: rpm,
            window_secs: 60,
            retry_after_secs: 60_u64.div_ceil(rpm).max(1),
        })
    }

    /// The per-key burst bucket (requests per second). `None` when disabled.
    pub fn burst_per_second(rps: u64) -> Option<Self> {
        (rps > 0).then(|| Self {
            policy: "burst",
            quota: rps,
            window_secs: 1,
            retry_after_secs: 1,
        })
    }

    fn policy_header(&self) -> String {
        format!(
            "\"{}\";q={};w={}",
            self.policy, self.quota, self.window_secs
        )
    }

    fn remaining_header(&self) -> String {
        format!("\"{}\";r=0;t={}", self.policy, self.retry_after_secs)
    }
}

impl GatewayError {
    /// The inbound 429 for a limiter refusal: carries the policy when the
    /// limiter can name it, otherwise the bare [`GatewayError::RateLimited`].
    pub fn rate_limited(policy: Option<InboundRateLimit>) -> Self {
        policy.map_or(GatewayError::RateLimited, GatewayError::RateLimitedBy)
    }
}

/// Header names of the IETF RateLimit fields.
const RATE_LIMIT_HEADER: &str = "ratelimit";
const RATE_LIMIT_POLICY_HEADER: &str = "ratelimit-policy";

/// The upstream HTTP status a provider failure message records, if any.
///
/// Upstream 4xx/5xx answers still reach clients as 502 `provider_error` (a
/// status change would break existing clients), so the original status is
/// added as `error.upstream_status`. Provider adapters build their messages as
/// `"<provider> error 400 Bad Request: …"`, `"… HTTP 400 …"`,
/// `"… returned 400 …"` or `"… failed: 400 …"`; the first such status wins, so
/// a number inside the provider's own text after the prefix is never read.
pub(crate) fn upstream_status(message: &str) -> Option<u16> {
    const MARKERS: [&str; 4] = ["HTTP ", "error ", "returned ", "failed: "];
    MARKERS
        .iter()
        .flat_map(|marker| {
            message
                .match_indices(marker)
                .map(move |(at, _)| at + marker.len())
        })
        .filter_map(|start| {
            let rest = message.get(start..)?;
            let digits = rest.get(..3)?;
            let next_is_digit = rest[3..].starts_with(|c: char| c.is_ascii_digit());
            if next_is_digit || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let status = digits.parse::<u16>().ok()?;
            (400..=599).contains(&status).then_some((start, status))
        })
        .min_by_key(|(start, _)| *start)
        .map(|(_, status)| status)
}

/// Map the provider-crate's boundary error 1:1 to the gateway error. The
/// providers (`ryu-gw-providers`) cannot name `GatewayError` (it carries
/// `PolicyAlert` → `budget`/`config` + the axum `IntoResponse` HTTP layer), so
/// the `Provider` trait returns a narrow [`ryu_gw_providers::ProviderError`] and
/// the pipeline converts at the call boundary. Doing it here — never by
/// inspecting `ProviderError` downstream — is what preserves the pipeline's
/// rate-limit-vs-fault distinction: `RateLimited` demotes tiers / rotates
/// accounts WITHOUT tripping the circuit breaker, `Provider` trips it.
impl From<ryu_gw_providers::ProviderError> for GatewayError {
    fn from(e: ryu_gw_providers::ProviderError) -> Self {
        match e {
            ryu_gw_providers::ProviderError::Provider(msg) => GatewayError::ProviderError(msg),
            ryu_gw_providers::ProviderError::Rejected { status, message } => {
                GatewayError::ProviderRejected {
                    status,
                    message,
                    signal: None,
                }
            }
            // Kept an ordinary rejection until a dispatch site that knows the
            // attempt's origin settles it, so a path that never does (and a
            // tenant's own key) behaves exactly as before.
            ryu_gw_providers::ProviderError::SafetyRefused {
                provider,
                status,
                scope,
                row,
                code,
                message,
            } => GatewayError::ProviderRejected {
                status,
                message,
                signal: Some(Box::new(UpstreamSignal {
                    provider,
                    scope,
                    row,
                    code,
                })),
            },
            ryu_gw_providers::ProviderError::Transport(msg) => GatewayError::ProviderTransport(msg),
            ryu_gw_providers::ProviderError::DeliveryUncertain(msg) => {
                GatewayError::ProviderDeliveryUncertain(msg)
            }
            ryu_gw_providers::ProviderError::PaymentRequired { provider, message } => {
                GatewayError::ProviderPaymentRequired { provider, message }
            }
            ryu_gw_providers::ProviderError::RateLimited {
                provider,
                retry_after,
                reset_at,
            } => GatewayError::ProviderRateLimited {
                provider,
                retry_after,
                reset_at,
            },
        }
    }
}

impl GatewayError {
    /// The HTTP status and catalogue `code` this error renders with: the same
    /// pair [`IntoResponse::into_response`] writes into the envelope, so the
    /// live traffic feed reports exactly what the client received.
    pub fn wire_status_and_code(&self) -> (StatusCode, &'static str) {
        let (status, type_str, _) = self.wire_parts();
        let code = match self {
            GatewayError::InvalidRequest { code, .. }
            | GatewayError::PlatformRefused { code, .. } => *code,
            GatewayError::StandingRefused(detail) => detail.code,
            GatewayError::StandingUnavailable => "standing_unavailable",
            GatewayError::AbuseThrottled(_) => "abuse_throttled",
            GatewayError::AccountRestricted(_) => "account_restricted",
            GatewayError::NewKeyRateLimited { .. } => "new_key_rate_limited",
            GatewayError::ScreeningUnavailable { .. } => "screening_unavailable",
            GatewayError::ContentBlocked(block) => block.code(),
            GatewayError::UpstreamSafetyRefused(refusal) => refusal.code(),
            GatewayError::ScreeningDegradedThrottle { .. } => "screening_degraded_throttle",
            GatewayError::ScreeningCapacityExceeded => "screening_capacity_exceeded",
            _ => type_str,
        };
        (status, code)
    }

    /// Status, `type` and client message for every variant.
    fn wire_parts(&self) -> (StatusCode, &'static str, &str) {
        match self {
            GatewayError::Unauthorized(msg) => {
                (StatusCode::UNAUTHORIZED, "invalid_api_key", msg.as_str())
            }
            GatewayError::RateLimited | GatewayError::RateLimitedBy(_) => (
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limit_exceeded",
                "Rate limit exceeded. Please retry after a moment.",
            ),
            GatewayError::FirewallBlocked(msg, _) => {
                (StatusCode::FORBIDDEN, "policy_violation", msg.as_str())
            }
            GatewayError::PolicyViolation(msg) => {
                (StatusCode::FORBIDDEN, "policy_violation", msg.as_str())
            }
            GatewayError::PlatformRefused { message, .. } => {
                (StatusCode::FORBIDDEN, "policy_violation", *message)
            }
            GatewayError::ScreeningUnavailable { .. } => (
                StatusCode::SERVICE_UNAVAILABLE,
                "service_unavailable",
                "Request screening is temporarily unavailable. Please retry shortly.",
            ),
            GatewayError::ContentBlocked(block) => {
                (StatusCode::FORBIDDEN, "policy_violation", block.message())
            }
            GatewayError::UpstreamSafetyRefused(refusal) => {
                (StatusCode::FORBIDDEN, "policy_violation", refusal.message())
            }
            GatewayError::ScreeningDegradedThrottle { .. } => (
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limit_exceeded",
                "Request screening is running in a reduced mode and this organization's share is used. Please retry after a moment.",
            ),
            GatewayError::ScreeningCapacityExceeded => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "request_too_large",
                "The request carries more content than platform screening can classify. Send a shorter request.",
            ),
            GatewayError::StandingRefused(detail) => {
                (StatusCode::FORBIDDEN, "policy_violation", detail.message)
            }
            GatewayError::StandingUnavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "service_unavailable",
                "Account standing is temporarily unavailable. Please retry shortly.",
            ),
            GatewayError::AbuseThrottled(_) => (
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limit_exceeded",
                ABUSE_THROTTLED_MESSAGE,
            ),
            GatewayError::AccountRestricted(_) => (
                StatusCode::FORBIDDEN,
                "policy_violation",
                ACCOUNT_RESTRICTED_MESSAGE,
            ),
            GatewayError::NewKeyRateLimited { .. } => (
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limit_exceeded",
                "This gateway key is new, so it has a lower request rate for its first day. Please retry after a moment.",
            ),
            GatewayError::NoProvider(msg) => {
                (StatusCode::NOT_FOUND, "model_not_found", msg.as_str())
            }
            GatewayError::ProviderError(_)
            | GatewayError::ProviderRejected { .. }
            | GatewayError::ProviderTransport(_)
            | GatewayError::ProviderDeliveryUncertain(_) => (
                StatusCode::BAD_GATEWAY,
                "provider_error",
                "Upstream provider request failed.",
            ),
            GatewayError::ProviderPaymentRequired { .. } => (
                StatusCode::PAYMENT_REQUIRED,
                "provider_payment_required",
                "Upstream provider payment is required.",
            ),
            GatewayError::ProviderRateLimited { .. } => (
                StatusCode::TOO_MANY_REQUESTS,
                "provider_rate_limited",
                "Upstream provider rate limit reached. Please retry after a moment.",
            ),
            GatewayError::CircuitOpen(provider) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "circuit_open",
                provider.as_str(),
            ),
            GatewayError::Overloaded(msg) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "engine_overloaded",
                msg.as_str(),
            ),
            GatewayError::BudgetExceeded(_) => (
                StatusCode::PAYMENT_REQUIRED,
                "budget_exceeded",
                "Charged spend budget exceeded for this period.",
            ),
            GatewayError::InsufficientCredits => (
                StatusCode::PAYMENT_REQUIRED,
                "insufficient_credits",
                "organization credit balance exhausted",
            ),
            GatewayError::AccountingUnavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "credit_accounting_unavailable",
                "credit accounting is temporarily unavailable",
            ),
            GatewayError::ToolUnpriced(msg) => {
                (StatusCode::FORBIDDEN, "tool_unpriced", msg.as_str())
            }
            GatewayError::ToolNotServable(msg) => {
                (StatusCode::FORBIDDEN, "tool_not_servable", msg.as_str())
            }
            GatewayError::ToolPaymentRequired(detail) => (
                StatusCode::PAYMENT_REQUIRED,
                detail.code(),
                detail.message(),
            ),
            GatewayError::ProviderResponseTooLarge { .. } => (
                StatusCode::BAD_GATEWAY,
                "provider_response_too_large",
                "Upstream provider response exceeded the Gateway read limit. The provider ran the call, so any cost it reported is charged; the response body is not delivered.",
            ),
            GatewayError::ProviderBodyUnreadable { .. } => (
                StatusCode::BAD_GATEWAY,
                "provider_body_unreadable",
                "Upstream provider response was cut before its body was read. The provider ran the call, so any cost it reported is charged; the response body is not delivered.",
            ),
            GatewayError::BudgetStoreUnavailable(reason) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "budget_store_unavailable",
                reason.as_str(),
            ),
            GatewayError::AllProvidersUnavailable(_) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "all_providers_unavailable",
                "All configured providers are currently unavailable.",
            ),
            GatewayError::BadRequest(msg) => (
                StatusCode::BAD_REQUEST,
                "invalid_request_error",
                msg.as_str(),
            ),
            GatewayError::InvalidRequest { message, .. } => {
                (StatusCode::BAD_REQUEST, "invalid_request_error", *message)
            }
            GatewayError::ConfigConflict(_) => (
                StatusCode::CONFLICT,
                "config_revision_conflict",
                "Configuration changed; refresh before saving.",
            ),
            GatewayError::Internal(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "An internal error occurred.",
            ),
        }
    }
}

impl IntoResponse for GatewayError {
    fn into_response(self) -> Response {
        let (status, type_str, message) = self.wire_parts();

        let mut body = json!({
            "error": {
                "message": message,
                "type": type_str,
                "code": type_str,
            }
        });
        if let GatewayError::ConfigConflict(revision) = &self {
            body["currentRevision"] = json!(revision);
        }
        if let GatewayError::InvalidRequest { code, .. } = &self {
            body["error"]["code"] = json!(code);
        }
        if let GatewayError::PlatformRefused { code, .. } = &self {
            body["error"]["code"] = json!(code);
            body["error"]["layer"] = json!("platform");
            body["error"]["remedy"] = json!("none");
        }
        match &self {
            GatewayError::StandingRefused(detail) => body = detail.envelope(),
            GatewayError::StandingUnavailable => body = crate::standing::unavailable_envelope(),
            GatewayError::AbuseThrottled(detail) => {
                body = json!({ "error": detail.error_object(
                    "abuse_throttled",
                    "rate_limit_exceeded",
                    ABUSE_THROTTLED_MESSAGE,
                ) });
            }
            GatewayError::AccountRestricted(detail) => {
                body = json!({ "error": detail.error_object(
                    "account_restricted",
                    "policy_violation",
                    ACCOUNT_RESTRICTED_MESSAGE,
                ) });
            }
            GatewayError::NewKeyRateLimited { retry_after_secs } => {
                body["error"]["code"] = json!("new_key_rate_limited");
                body["error"]["layer"] = json!("platform");
                body["error"]["remedy"] = json!("none");
                body["error"]["retry_after"] = json!(retry_after_secs);
            }
            GatewayError::ContentBlocked(block) => body = json!({ "error": block.error_object() }),
            GatewayError::UpstreamSafetyRefused(refusal) => {
                body = json!({ "error": refusal.error_object() });
            }
            GatewayError::ScreeningDegradedThrottle { retry_after_secs } => {
                body["error"]["code"] = json!("screening_degraded_throttle");
                body["error"]["layer"] = json!("platform");
                body["error"]["remedy"] = json!("none");
                body["error"]["retry_after"] = json!(retry_after_secs);
            }
            GatewayError::ScreeningCapacityExceeded => {
                body["error"]["code"] = json!("screening_capacity_exceeded");
                body["error"]["layer"] = json!("platform");
                body["error"]["remedy"] = json!("none");
            }
            _ => {}
        }
        if let GatewayError::ScreeningUnavailable {
            retry_after_secs, ..
        } = &self
        {
            body["error"]["code"] = json!("screening_unavailable");
            body["error"]["layer"] = json!("platform");
            body["error"]["remedy"] = json!("none");
            body["error"]["retry_after"] = json!(retry_after_secs);
        }
        match &self {
            GatewayError::ToolPaymentRequired(detail) => {
                body["error"]["estimate_micro_usd"] = json!(detail.estimate_micro_usd);
                if let Some(balance) = detail.balance_micro_usd {
                    body["error"]["balance_micro_usd"] = json!(balance);
                }
                if let Some(max_cost) = detail.max_cost_micro_usd {
                    body["error"]["max_cost_micro_usd"] = json!(max_cost);
                }
                if let Some(url) = detail.top_up_url.as_deref() {
                    body["error"]["top_up_url"] = json!(url);
                }
            }
            GatewayError::ProviderResponseTooLarge {
                limit_bytes,
                charged_micro_usd,
                ..
            } => {
                body["error"]["limit_bytes"] = json!(limit_bytes);
                let charged = charged_micro_usd.unwrap_or(0);
                body["error"]["charged"] = json!(charged > 0);
                body["error"]["charged_micro_usd"] = json!(charged);
            }
            GatewayError::ProviderBodyUnreadable {
                charged_micro_usd, ..
            } => {
                let charged = charged_micro_usd.unwrap_or(0);
                body["error"]["charged"] = json!(charged > 0);
                body["error"]["charged_micro_usd"] = json!(charged);
            }
            GatewayError::ProviderError(message) => {
                if let Some(status) = upstream_status(message) {
                    body["error"]["upstream_status"] = json!(status);
                }
            }
            // A rejection carries the upstream status itself; never read it
            // back out of the message text.
            GatewayError::ProviderRejected { status, .. } => {
                body["error"]["upstream_status"] = json!(status);
            }
            _ => {}
        }
        // Carry the provider's own reset signal so Core can park durable work
        // until the window reopens instead of failing it (see Core's
        // `workflow::limits`). `reset_at` is Unix seconds.
        let retry_after = match &self {
            GatewayError::ProviderRateLimited {
                retry_after,
                reset_at,
                ..
            } => {
                if let Some(seconds) = retry_after {
                    body["error"]["retry_after"] = json!(seconds);
                }
                if let Some(reset_at) = reset_at {
                    body["error"]["reset_at"] = json!(reset_at);
                }
                *retry_after
            }
            GatewayError::RateLimitedBy(limit) => {
                body["error"]["retry_after"] = json!(limit.retry_after_secs);
                Some(limit.retry_after_secs)
            }
            GatewayError::ScreeningUnavailable {
                retry_after_secs, ..
            }
            | GatewayError::ScreeningDegradedThrottle { retry_after_secs } => {
                Some(*retry_after_secs)
            }
            GatewayError::StandingUnavailable => Some(crate::standing::STANDING_RETRY_AFTER_SECS),
            GatewayError::AbuseThrottled(detail) => detail.retry_after_secs,
            GatewayError::NewKeyRateLimited { retry_after_secs } => Some(*retry_after_secs),
            // A bare inbound refusal (org limits, token-per-minute debt,
            // pluggable limiter backends, policy resolution busy) names no
            // wait: no `Retry-After`, as before, so callers keep their own
            // backoff (Core parks durable work for its default wait).
            _ => None,
        };

        let mut response = (status, Json(body)).into_response();
        if let Some(seconds) = retry_after {
            if let Ok(v) = HeaderValue::from_str(&seconds.to_string()) {
                response
                    .headers_mut()
                    .insert(axum::http::header::RETRY_AFTER, v);
            }
        }
        if let GatewayError::RateLimitedBy(limit) = &self {
            for (name, value) in [
                (RATE_LIMIT_POLICY_HEADER, limit.policy_header()),
                (RATE_LIMIT_HEADER, limit.remaining_header()),
            ] {
                if let Ok(v) = HeaderValue::from_str(&value) {
                    response.headers_mut().insert(name, v);
                }
            }
        }

        // F1 error-path stamp: budget-stop (402) and firewall-block (403) return
        // BEFORE any Ok Response exists, so the ONLY place their PolicyAlert can be
        // written onto the wire is here. Mirror the Ok-path `x-ryu-policy-alert`
        // header so a block-tier alert reaches Core on the error response too.
        let alert = match &self {
            GatewayError::BudgetExceeded(a) => a.as_ref(),
            GatewayError::FirewallBlocked(_, a) => a.as_ref(),
            _ => None,
        };
        if let Some(alert) = alert {
            if let Ok(v) = HeaderValue::from_str(&alert.to_header()) {
                response.headers_mut().insert(POLICY_ALERT_HEADER, v);
            }
        }

        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AlertTier;

    /// Read the JSON error envelope out of a `GatewayError` response.
    async fn body_json(err: GatewayError) -> (StatusCode, serde_json::Value) {
        let resp = err.into_response();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("error body must collect");
        let json: serde_json::Value =
            serde_json::from_slice(&bytes).expect("error body must be JSON");
        (status, json)
    }

    #[tokio::test]
    async fn provider_rate_limit_carries_reset_signal_on_the_wire() {
        let resp = GatewayError::ProviderRateLimited {
            provider: "anthropic".into(),
            retry_after: Some(42),
            reset_at: Some(1_900_000_000),
        }
        .into_response();
        assert_eq!(
            resp.headers()
                .get(axum::http::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok()),
            Some("42")
        );
        let (status, body) = body_json(GatewayError::ProviderRateLimited {
            provider: "anthropic".into(),
            retry_after: Some(42),
            reset_at: Some(1_900_000_000),
        })
        .await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(body["error"]["retry_after"], 42);
        assert_eq!(body["error"]["reset_at"], 1_900_000_000_u64);

        let (_, bare) = body_json(GatewayError::RateLimited).await;
        assert!(bare["error"].get("retry_after").is_none());
    }

    /// The `error.{type,code}` fields are the stable wire contract clients match
    /// on, so the full mapping is asserted per variant — status + type + code.
    #[tokio::test]
    async fn status_and_code_mapping_is_stable_per_variant() {
        let cases: Vec<(GatewayError, StatusCode, &str)> = vec![
            (
                GatewayError::Unauthorized("bad key".into()),
                StatusCode::UNAUTHORIZED,
                "invalid_api_key",
            ),
            (
                GatewayError::RateLimited,
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limit_exceeded",
            ),
            (
                GatewayError::FirewallBlocked("ssn".into(), None),
                StatusCode::FORBIDDEN,
                "policy_violation",
            ),
            (
                GatewayError::PolicyViolation("blocked".into()),
                StatusCode::FORBIDDEN,
                "policy_violation",
            ),
            (
                GatewayError::NoProvider("gpt-9".into()),
                StatusCode::NOT_FOUND,
                "model_not_found",
            ),
            (
                GatewayError::ProviderError("upstream 500".into()),
                StatusCode::BAD_GATEWAY,
                "provider_error",
            ),
            (
                GatewayError::ProviderTransport("proxy connect failed".into()),
                StatusCode::BAD_GATEWAY,
                "provider_error",
            ),
            (
                GatewayError::from(ryu_gw_providers::ProviderError::Rejected {
                    status: 400,
                    message: "openai error 400 Bad Request: bad max_tokens".into(),
                }),
                StatusCode::BAD_GATEWAY,
                "provider_error",
            ),
            (
                GatewayError::ProviderRateLimited {
                    provider: "openai".into(),
                    retry_after: Some(5),
                    reset_at: None,
                },
                StatusCode::TOO_MANY_REQUESTS,
                "provider_rate_limited",
            ),
            (
                GatewayError::from(ryu_gw_providers::ProviderError::PaymentRequired {
                    provider: "openrouter".into(),
                    message: "no credits".into(),
                }),
                StatusCode::PAYMENT_REQUIRED,
                "provider_payment_required",
            ),
            (
                GatewayError::CircuitOpen("openai".into()),
                StatusCode::SERVICE_UNAVAILABLE,
                "circuit_open",
            ),
            (
                GatewayError::Overloaded("queue full".into()),
                StatusCode::SERVICE_UNAVAILABLE,
                "engine_overloaded",
            ),
            (
                GatewayError::BudgetExceeded(None),
                StatusCode::PAYMENT_REQUIRED,
                "budget_exceeded",
            ),
            (
                GatewayError::InsufficientCredits,
                StatusCode::PAYMENT_REQUIRED,
                "insufficient_credits",
            ),
            (
                GatewayError::AccountingUnavailable,
                StatusCode::SERVICE_UNAVAILABLE,
                "credit_accounting_unavailable",
            ),
            (
                GatewayError::ToolUnpriced("no price".into()),
                StatusCode::FORBIDDEN,
                "tool_unpriced",
            ),
            (
                GatewayError::ToolNotServable("own account".into()),
                StatusCode::FORBIDDEN,
                "tool_not_servable",
            ),
            (
                GatewayError::ToolPaymentRequired(Box::new(ToolPaymentRequired {
                    reason: ToolPaymentReason::InsufficientCredits,
                    balance_micro_usd: Some(10),
                    estimate_micro_usd: 20,
                    max_cost_micro_usd: None,
                    top_up_url: None,
                })),
                StatusCode::PAYMENT_REQUIRED,
                "insufficient_credits",
            ),
            (
                GatewayError::ToolPaymentRequired(Box::new(ToolPaymentRequired {
                    reason: ToolPaymentReason::MaxCostExceeded,
                    balance_micro_usd: None,
                    estimate_micro_usd: 20,
                    max_cost_micro_usd: Some(10),
                    top_up_url: None,
                })),
                StatusCode::PAYMENT_REQUIRED,
                "max_cost_exceeded",
            ),
            (
                GatewayError::ProviderResponseTooLarge {
                    provider: "treg".into(),
                    limit_bytes: 32,
                    charged_micro_usd: None,
                },
                StatusCode::BAD_GATEWAY,
                "provider_response_too_large",
            ),
            (
                GatewayError::ProviderBodyUnreadable {
                    provider: "treg".into(),
                    charged_micro_usd: None,
                },
                StatusCode::BAD_GATEWAY,
                "provider_body_unreadable",
            ),
            (
                GatewayError::BudgetStoreUnavailable("budget store key mismatch".into()),
                StatusCode::SERVICE_UNAVAILABLE,
                "budget_store_unavailable",
            ),
            (
                GatewayError::AllProvidersUnavailable("all down".into()),
                StatusCode::SERVICE_UNAVAILABLE,
                "all_providers_unavailable",
            ),
            (
                GatewayError::BadRequest("nope".into()),
                StatusCode::BAD_REQUEST,
                "invalid_request_error",
            ),
            (
                GatewayError::Internal(anyhow::anyhow!("boom")),
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
            ),
        ];

        for (err, want_status, want_code) in cases {
            let (status, json) = body_json(err).await;
            assert_eq!(status, want_status, "status for code {want_code}");
            assert_eq!(json["error"]["type"], want_code, "type field");
            assert_eq!(json["error"]["code"], want_code, "code field");
            assert!(
                json["error"]["message"].is_string(),
                "message must be present for {want_code}"
            );
        }
    }

    #[tokio::test]
    async fn invalid_request_keeps_the_type_and_carries_its_own_code() {
        let (status, json) = body_json(GatewayError::InvalidRequest {
            code: "invalid_end_user",
            message: "fixed message",
        })
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["error"]["type"], "invalid_request_error");
        assert_eq!(json["error"]["code"], "invalid_end_user");
        assert_eq!(json["error"]["message"], "fixed message");
        assert!(!GatewayError::InvalidRequest {
            code: "invalid_end_user",
            message: "fixed message",
        }
        .is_safety_outcome());
    }

    fn floor_block(output: bool) -> GatewayError {
        GatewayError::ContentBlocked(Box::new(ContentBlock {
            layer: ContentBlockLayer::Platform,
            output,
            categories: vec!["S9"],
            screening_id: "scr_req-1".into(),
            charged_micro_usd: output.then_some(42),
        }))
    }

    /// Spec 00.7: the screener refusals keep their catalogue type, carry a
    /// specific code, and the block envelope names S-codes and the screening
    /// id only.
    #[tokio::test]
    async fn screener_refusals_render_the_catalogue_envelope() {
        let (status, json) = body_json(floor_block(false)).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(json["error"]["type"], "policy_violation");
        assert_eq!(json["error"]["code"], "platform_floor_blocked");
        assert_eq!(json["error"]["layer"], "platform");
        assert_eq!(json["error"]["remedy"], "report_false_positive");
        assert_eq!(json["error"]["categories"], json!(["S9"]));
        assert_eq!(json["error"]["screening_id"], "scr_req-1");
        assert_eq!(
            json["error"]["message"],
            "This request was blocked by Ryu's platform safety policy."
        );
        assert!(json["error"].get("charged_micro_usd").is_none());

        let (_, output) = body_json(floor_block(true)).await;
        assert_eq!(output["error"]["code"], "platform_floor_output_blocked");
        assert_eq!(output["error"]["charged_micro_usd"], 42);

        let node = GatewayError::ContentBlocked(Box::new(ContentBlock {
            layer: ContentBlockLayer::Node,
            output: false,
            categories: vec!["S1"],
            screening_id: "scr_req-2".into(),
            charged_micro_usd: None,
        }));
        let (_, node) = body_json(node).await;
        assert_eq!(node["error"]["code"], "tenant_policy_blocked");
        assert_eq!(node["error"]["layer"], "node");
        assert_eq!(node["error"]["remedy"], "none");

        let throttle = GatewayError::ScreeningDegradedThrottle {
            retry_after_secs: 7,
        };
        let response = GatewayError::ScreeningDegradedThrottle {
            retry_after_secs: 7,
        }
        .into_response();
        assert_eq!(
            response
                .headers()
                .get(axum::http::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok()),
            Some("7")
        );
        let (status, json) = body_json(throttle).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(json["error"]["type"], "rate_limit_exceeded");
        assert_eq!(json["error"]["code"], "screening_degraded_throttle");

        let (status, json) = body_json(GatewayError::ScreeningCapacityExceeded).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(json["error"]["type"], "request_too_large");
        assert_eq!(json["error"]["code"], "screening_capacity_exceeded");

        for error in [
            floor_block(false),
            floor_block(true),
            GatewayError::ScreeningDegradedThrottle {
                retry_after_secs: 1,
            },
            GatewayError::ScreeningCapacityExceeded,
        ] {
            assert!(error.is_safety_outcome(), "{error:?}");
            assert!(error.ends_hosted_attempt(), "{error:?}");
            let (_, code) = error.wire_status_and_code();
            assert_ne!(code, "policy_violation");
        }
    }

    #[tokio::test]
    async fn tool_payment_required_carries_balance_estimate_and_top_up_link() {
        let (status, json) = body_json(GatewayError::ToolPaymentRequired(Box::new(
            ToolPaymentRequired {
                reason: ToolPaymentReason::InsufficientCredits,
                balance_micro_usd: Some(1_200),
                estimate_micro_usd: 18_000,
                max_cost_micro_usd: Some(20_000),
                top_up_url: Some("https://ryuhq.com/organizations/billing".into()),
            },
        )))
        .await;
        assert_eq!(status, StatusCode::PAYMENT_REQUIRED);
        assert_eq!(json["error"]["code"], "insufficient_credits");
        assert_eq!(json["error"]["balance_micro_usd"], 1_200);
        assert_eq!(json["error"]["estimate_micro_usd"], 18_000);
        assert_eq!(json["error"]["max_cost_micro_usd"], 20_000);
        assert_eq!(
            json["error"]["top_up_url"],
            "https://ryuhq.com/organizations/billing"
        );

        let (_, bare) = body_json(GatewayError::ToolPaymentRequired(Box::new(
            ToolPaymentRequired {
                reason: ToolPaymentReason::MaxCostExceeded,
                balance_micro_usd: None,
                estimate_micro_usd: 18_000,
                max_cost_micro_usd: Some(10_000),
                top_up_url: None,
            },
        )))
        .await;
        assert_eq!(bare["error"]["code"], "max_cost_exceeded");
        assert!(bare["error"].get("balance_micro_usd").is_none());
        assert!(bare["error"].get("top_up_url").is_none());

        let (_, too_large) = body_json(GatewayError::ProviderResponseTooLarge {
            provider: "treg".into(),
            limit_bytes: 2_048,
            charged_micro_usd: None,
        })
        .await;
        assert_eq!(too_large["error"]["limit_bytes"], 2_048);
        assert_eq!(too_large["error"]["charged"], false);
        assert_eq!(too_large["error"]["charged_micro_usd"], 0);

        let (_, charged) = body_json(GatewayError::ProviderResponseTooLarge {
            provider: "treg".into(),
            limit_bytes: 2_048,
            charged_micro_usd: Some(2_200),
        })
        .await;
        assert_eq!(charged["error"]["charged"], true);
        assert_eq!(charged["error"]["charged_micro_usd"], 2_200);

        let (_, unreadable) = body_json(GatewayError::ProviderBodyUnreadable {
            provider: "treg".into(),
            charged_micro_usd: Some(1_100),
        })
        .await;
        assert_eq!(unreadable["error"]["charged"], true);
        assert_eq!(unreadable["error"]["charged_micro_usd"], 1_100);
    }

    #[tokio::test]
    async fn message_passthrough_uses_the_variant_string() {
        // Variants carrying a caller-facing string surface it verbatim in message.
        let (_, json) = body_json(GatewayError::Unauthorized("no header".into())).await;
        assert_eq!(json["error"]["message"], "no header");
    }

    #[tokio::test]
    async fn provider_error_messages_are_generic_at_the_client_boundary() {
        let secret = "gho_abcdefghijklmnopqrstuvwxyz0123456789";
        let (_, json) = body_json(GatewayError::ProviderError(format!(
            "upstream rejected request with {secret}"
        )))
        .await;
        assert!(!json["error"]["message"].as_str().unwrap().contains(secret));
        assert_eq!(
            json["error"]["message"],
            "Upstream provider request failed."
        );
    }

    #[tokio::test]
    async fn internal_error_does_not_leak_the_underlying_message() {
        // Internal(anyhow) must be redacted to a generic message, never echoing the
        // source error (which could carry secrets or internals).
        let (_, json) = body_json(GatewayError::Internal(anyhow::anyhow!(
            "db password=hunter2 leaked"
        )))
        .await;
        assert_eq!(json["error"]["message"], "An internal error occurred.");
    }

    #[test]
    fn from_provider_error_maps_generic_to_provider_error() {
        let e: GatewayError = ryu_gw_providers::ProviderError::Provider("boom".into()).into();
        match e {
            GatewayError::ProviderError(msg) => assert_eq!(msg, "boom"),
            other => panic!("expected ProviderError, got {other:?}"),
        }
    }

    #[test]
    fn from_provider_error_preserves_rate_limit_signal_fields() {
        // The rate-limit arm must survive intact so the pipeline can demote tiers /
        // rotate accounts WITHOUT tripping the circuit breaker.
        let e: GatewayError = ryu_gw_providers::ProviderError::RateLimited {
            provider: "anthropic".into(),
            retry_after: Some(12),
            reset_at: Some(99),
        }
        .into();
        match e {
            GatewayError::ProviderRateLimited {
                provider,
                retry_after,
                reset_at,
            } => {
                assert_eq!(provider, "anthropic");
                assert_eq!(retry_after, Some(12));
                assert_eq!(reset_at, Some(99));
            }
            other => panic!("expected ProviderRateLimited, got {other:?}"),
        }
    }

    #[test]
    fn transport_failure_keeps_the_existing_gateway_error_contract() {
        let error: GatewayError =
            ryu_gw_providers::ProviderError::Transport("openai connection failed".to_owned())
                .into();
        assert!(matches!(
            error,
            GatewayError::ProviderTransport(message) if message == "openai connection failed"
        ));
    }

    #[test]
    fn non_alert_variant_stamps_no_policy_alert_header() {
        // Only BudgetExceeded / FirewallBlocked carry a PolicyAlert; every other
        // variant must leave the header absent.
        let resp = GatewayError::ProviderError("x".into()).into_response();
        assert!(resp.headers().get(POLICY_ALERT_HEADER).is_none());
    }

    #[test]
    fn budget_exceeded_without_alert_stamps_no_header() {
        // A budget stop with no attached alert (tier below Warn) writes no header.
        let resp = GatewayError::BudgetExceeded(None).into_response();
        assert_eq!(resp.status(), StatusCode::PAYMENT_REQUIRED);
        assert!(resp.headers().get(POLICY_ALERT_HEADER).is_none());
    }

    #[tokio::test]
    async fn platform_refusal_renders_catalogue_code_and_layer() {
        let (status, body) = body_json(GatewayError::PlatformRefused {
            code: "feature_not_permitted",
            message: "This feature is not available on the hosted Gateway.",
        })
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"]["type"], "policy_violation");
        assert_eq!(body["error"]["code"], "feature_not_permitted");
        assert_eq!(body["error"]["layer"], "platform");
        assert_eq!(body["error"]["remedy"], "none");
        assert_eq!(
            body["error"]["message"],
            "This feature is not available on the hosted Gateway."
        );
    }

    #[test]
    fn upstream_status_reads_the_adapter_prefix_only() {
        let cases: [(&str, Option<u16>); 10] = [
            ("openai error 400 Bad Request: bad max_tokens", Some(400)),
            (
                "Anthropic stream error 422 Unprocessable Entity: x",
                Some(422),
            ),
            (
                "Cohere HTTP 404 Not Found: error response could not be decoded",
                Some(404),
            ),
            ("kiro broker rejected request (HTTP 413)", Some(413)),
            ("gemini upstream returned 400 Bad Request", Some(400)),
            (
                "Composio action GMAIL_SEND failed: 401 Unauthorized",
                Some(401),
            ),
            ("openai error 503 Service Unavailable: retry", Some(503)),
            // The provider's own text after the prefix is never read.
            ("openai error 400 Bad Request: HTTP 500 inside", Some(400)),
            ("openai response parse error: expected value", None),
            ("google-tts upstream rejected synthesis", None),
        ];
        for (message, want) in cases {
            assert_eq!(upstream_status(message), want, "{message}");
        }
        assert_eq!(upstream_status("error 4000 nope"), None);
        assert_eq!(upstream_status("error 200 OK"), None);
        assert_eq!(upstream_status("HTTP 4é"), None);
    }

    #[tokio::test]
    async fn upstream_4xx_stays_a_502_and_reports_the_upstream_status() {
        let (status, json) = body_json(GatewayError::from(
            ryu_gw_providers::ProviderError::Rejected {
                status: 400,
                message: "openai error 400 Bad Request: secret detail".into(),
            },
        ))
        .await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(json["error"]["code"], "provider_error");
        assert_eq!(json["error"]["upstream_status"], 400);
        assert_eq!(
            json["error"]["message"],
            "Upstream provider request failed."
        );

        let (_, auth) = body_json(GatewayError::ProviderError(
            "anthropic error 401 Unauthorized: invalid x-api-key".into(),
        ))
        .await;
        assert_eq!(auth["error"]["upstream_status"], 401);

        let (_, transport) =
            body_json(GatewayError::ProviderTransport("connect error 404".into())).await;
        assert!(transport["error"].get("upstream_status").is_none());
        let (_, unknown) = body_json(GatewayError::ProviderError("parse failure".into())).await;
        assert!(unknown["error"].get("upstream_status").is_none());
    }

    #[tokio::test]
    async fn inbound_rate_limit_with_policy_carries_ietf_headers() {
        let policy = InboundRateLimit::requests_per_minute(40).expect("non-zero rpm");
        assert_eq!(policy.retry_after_secs, 2);
        let resp = GatewayError::rate_limited(Some(policy.clone())).into_response();
        assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
        let header = |name: &str| {
            resp.headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        assert_eq!(header("retry-after").as_deref(), Some("2"));
        assert_eq!(
            header("ratelimit-policy").as_deref(),
            Some("\"requests\";q=40;w=60")
        );
        assert_eq!(header("ratelimit").as_deref(), Some("\"requests\";r=0;t=2"));
        let (_, json) = body_json(GatewayError::RateLimitedBy(policy)).await;
        assert_eq!(json["error"]["code"], "rate_limit_exceeded");
        assert_eq!(json["error"]["type"], "rate_limit_exceeded");
        assert_eq!(json["error"]["retry_after"], 2);

        let burst = InboundRateLimit::burst_per_second(10).expect("non-zero rps");
        let resp = GatewayError::RateLimitedBy(burst).into_response();
        assert_eq!(
            resp.headers().get("ratelimit-policy").unwrap(),
            "\"burst\";q=10;w=1"
        );
        assert_eq!(resp.headers().get("retry-after").unwrap(), "1");
    }

    #[test]
    fn inbound_rate_limit_policies_round_up_and_reject_zero() {
        assert_eq!(InboundRateLimit::requests_per_minute(0), None);
        assert_eq!(InboundRateLimit::burst_per_second(0), None);
        assert_eq!(
            InboundRateLimit::requests_per_minute(1)
                .unwrap()
                .retry_after_secs,
            60
        );
        assert_eq!(
            InboundRateLimit::requests_per_minute(7)
                .unwrap()
                .retry_after_secs,
            9
        );
        assert_eq!(
            InboundRateLimit::requests_per_minute(6000)
                .unwrap()
                .retry_after_secs,
            1
        );
        assert!(matches!(
            GatewayError::rate_limited(None),
            GatewayError::RateLimited
        ));
    }

    #[tokio::test]
    async fn bare_inbound_rate_limit_sends_no_retry_after_or_policy_headers() {
        let resp = GatewayError::RateLimited.into_response();
        assert!(resp.headers().get("retry-after").is_none());
        assert!(resp.headers().get("ratelimit").is_none());
        assert!(resp.headers().get("ratelimit-policy").is_none());
        let (status, json) = body_json(GatewayError::RateLimited).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(json["error"]["code"], "rate_limit_exceeded");
        assert!(json["error"].get("retry_after").is_none());
    }

    #[test]
    fn firewall_blocked_with_alert_stamps_header() {
        let alert = PolicyAlert::firewall("block", AlertTier::Warn, "org1");
        let resp = GatewayError::FirewallBlocked("blocked".into(), Some(alert)).into_response();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        assert!(resp.headers().get(POLICY_ALERT_HEADER).is_some());
    }

    #[test]
    fn safety_outcomes_are_classified_apart_from_upstream_health() {
        let safety = [
            GatewayError::FirewallBlocked("blocked".into(), None),
            GatewayError::PolicyViolation("blocked".into()),
            GatewayError::PlatformRefused {
                code: "media_unscreenable",
                message: "This media cannot be screened.",
            },
            GatewayError::RateLimited,
            GatewayError::UpstreamSafetyRefused(Box::new(UpstreamRefusal {
                signal: UpstreamSignal {
                    provider: "openai-credits".into(),
                    scope: ryu_gw_providers::SafetyScope::Identifier,
                    row: "test.row",
                    code: None,
                },
                status: 403,
            })),
        ];
        for error in &safety {
            assert!(error.is_safety_outcome(), "{error:?}");
            assert!(error.ends_hosted_attempt(), "{error:?}");
        }
        // A recognised signal is still an ordinary rejection until a dispatch
        // site on a Ryu-held credential settles it.
        let unsettled = GatewayError::from(ryu_gw_providers::ProviderError::SafetyRefused {
            provider: "openai".into(),
            status: 400,
            scope: ryu_gw_providers::SafetyScope::Content,
            row: "openai.invalid_prompt",
            code: Some("invalid_prompt".into()),
            message: "refused".into(),
        });
        assert!(!unsettled.is_safety_outcome());
        assert!(unsettled.ends_hosted_attempt());
        assert_eq!(
            unsettled.wire_status_and_code(),
            (StatusCode::BAD_GATEWAY, "provider_error")
        );
        // Transport, 5xx, 408 and 429 are health or capacity signals: none is
        // a safety outcome, and none ends a hosted attempt.
        let moves_on = [
            GatewayError::ProviderTransport("connection failed".into()),
            GatewayError::ProviderError("anthropic error 500".into()),
            GatewayError::from(ryu_gw_providers::ProviderError::Provider(
                "openai error 408".into(),
            )),
            GatewayError::ProviderRateLimited {
                provider: "openai".into(),
                retry_after: Some(1),
                reset_at: None,
            },
        ];
        for error in &moves_on {
            assert!(!error.is_safety_outcome(), "{error:?}");
            assert!(!error.ends_hosted_attempt(), "{error:?}");
        }
        // A 402 is account state, not a safety outcome, but it is an upstream
        // 4xx, so it ends a hosted attempt like any other.
        let payment = GatewayError::ProviderPaymentRequired {
            provider: "openrouter".into(),
            message: "no credits".into(),
        };
        assert!(!payment.is_safety_outcome());
        assert!(payment.ends_hosted_attempt());
        // An upstream refusal is not the Gateway's safety outcome, but it ends
        // a hosted attempt whatever its status.
        for status in [400, 401, 403, 404, 409, 422, 451] {
            let refusal = GatewayError::from(ryu_gw_providers::ProviderError::Rejected {
                status,
                message: "refused".into(),
            });
            assert!(!refusal.is_safety_outcome(), "{status}");
            assert!(refusal.ends_hosted_attempt(), "{status}");
        }
    }
}
