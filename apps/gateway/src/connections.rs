//! The connections layer: managed connection providers behind one contract.
//!
//! A connection provider is an external service that holds third-party
//! accounts and executes operations against them on Ryu's behalf — Composio
//! (OAuth connected accounts and toolkit actions) and Treg (a metered tool-API
//! router) today. The routing layer chooses *which model router* serves an
//! inference call; this layer chooses *which connection provider* serves a tool
//! or account operation. They are deliberately separate layers with separate
//! selections (`backends.router` and `backends.connections`).
//!
//! Every provider implements [`ConnectionProvider`] and is registered in the
//! [`ConnectionRegistry`] by a stable id. `POST /v1/providers/call` dispatches
//! through the registry instead of matching provider names, so adding a provider
//! is one registration, not another branch in the endpoint. The credential stays
//! in Gateway; a caller names an operation, never a key.
//!
//! Selection follows the Toolkit ladder: a request that names its `provider`
//! always reaches that provider; an explicit `backends.connections` choice
//! answers every call that names none; `"builtin"` prefers Treg (billed at the
//! provider's cost price) and keeps Composio as the fallback. Under `"builtin"`
//! each call is routed on its own: a call Treg cannot serve (an account
//! operation, an endpoint its catalog does not list, or one it marks
//! platform-blocked) goes to Composio when Composio is configured. Swapping the
//! selection is live and rebuilds nothing. Tool ids and operations stay
//! provider-native: the selection picks who answers, it does not translate one
//! provider's tool ids into another's.
//!
//! Core also forwards two routing facts it alone decides, written after the
//! app's own fields so an app cannot set them: the user's per-brand provider
//! pin (`providerPin`) and `requireServable`. A Composio pin keeps the call on
//! Composio (refusing it when only Treg could answer); a Treg pin keeps the
//! `"builtin"` per-call fallback to Composio. `requireServable` makes even a
//! named provider refuse, before anything is reserved, a call it cannot serve.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    composio::ComposioTenantScope,
    error::GatewayError,
    pipeline::RequestContext,
    state::AppState,
    treg::{TregCallError, TregCallScope, TregEndpointStatus, TregPriceError, TregPriceSource},
};

/// Composio: OAuth connected accounts and toolkit actions.
pub const COMPOSIO: &str = "composio";
/// Treg: metered tool-API router with provider-reported cost.
pub const TREG: &str = "treg";

/// The selection value that defers to [`BUILTIN_ORDER`].
pub const BUILTIN: &str = "builtin";

/// Who answers under `"builtin"`, most preferred first: Treg (provider cost
/// price), then Composio. A call the first configured provider cannot serve
/// falls through to the next one that can.
pub const BUILTIN_ORDER: [&str; 2] = [TREG, COMPOSIO];

/// One managed provider operation, as `POST /v1/providers/call` accepts it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionCall {
    /// The connection provider id. Empty or absent means the selected provider.
    #[serde(default)]
    pub provider: String,
    pub tool_id: String,
    #[serde(default)]
    pub operation: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
    pub method: String,
    #[serde(default)]
    pub query: Vec<(String, String)>,
    #[serde(default)]
    pub body: Option<Value>,
    #[serde(default)]
    pub idempotency_key: Option<String>,
    pub request_id: String,
    #[serde(default)]
    pub fallback_cost_micro_usd: Option<u64>,
    #[serde(default)]
    pub task_label: Option<String>,
    #[serde(default)]
    pub org_id: Option<String>,
    /// Upstream timeout for a long-running `execute`, clamped to
    /// [`MAX_PROVIDER_OPERATION_TIMEOUT_MS`]. `None` keeps the client default.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// The app that made the call, set by Core from the authenticated sidecar
    /// (never by the app). It scopes provider-side idempotency, so two apps in
    /// one org that pick the same key never replay each other's results. Only
    /// trusted Core forwarders reach this endpoint.
    #[serde(default)]
    pub caller_id: Option<String>,
    /// The user's provider pin for the brand this call belongs to (`"treg"` or
    /// `"composio"`), decided by Core from its preferences and written after
    /// the app's fields, never taken from the app. See [`ProviderPin`].
    #[serde(default)]
    pub provider_pin: Option<String>,
    /// Refuse the call with `tool_not_servable` unless the routed provider can
    /// serve it on the operator's credential. Set by Core (never the app) when
    /// it would rather run the call elsewhere than reach a blocked endpoint.
    #[serde(default)]
    pub require_servable: bool,
    /// The agent, user and session Core runs the call for (agent tool calls),
    /// authenticated like `/v1/budget/charge`'s so the debit is attributed to
    /// them. Set by Core only; never taken from an app.
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
}

/// A user's managed-provider pin for one brand, as Core forwards it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderPin {
    /// Prefer Treg; `"builtin"` still falls back to Composio per call.
    Treg,
    /// Composio only: Treg never answers the call.
    Composio,
}

impl ProviderPin {
    /// The pin a call carries; an unknown value is a bad request rather than
    /// being read as "no pin".
    pub fn from_call(call: &ConnectionCall) -> Result<Option<Self>, GatewayError> {
        match call.provider_pin.as_deref().map(str::trim) {
            None | Some("") => Ok(None),
            Some(TREG) => Ok(Some(Self::Treg)),
            Some(COMPOSIO) => Ok(Some(Self::Composio)),
            Some(other) => Err(GatewayError::BadRequest(format!(
                "unsupported providerPin `{other}`; expected `{TREG}` or `{COMPOSIO}`"
            ))),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Treg => TREG,
            Self::Composio => COMPOSIO,
        }
    }
}

/// Ceiling on a caller-requested upstream operation timeout.
const MAX_PROVIDER_OPERATION_TIMEOUT_MS: u64 = 60 * 60 * 1000;

/// Staged-upload slots one organization may request per minute. A slot is a
/// presigned write into the platform's provider storage, so it is admitted like
/// spend even though staging itself is not metered upstream.
pub(crate) const FILE_UPLOAD_SLOTS_PER_MINUTE: u64 = 30;

/// Admission for operations that consume platform-paid provider resources
/// without being metered per call (a staged upload slot). It applies the
/// pre-flight checks a metered call is subject to, without debiting: a wallet
/// whose accounting is unavailable or that is flagged empty, the managed credit
/// gate, the org's request-rate caps, and a per-org staging quota.
fn admit_unmetered_provider_use(
    state: &AppState,
    ctx: &RequestContext,
    org_id: Option<&str>,
    quota_scope: &str,
    per_minute: u64,
) -> Result<(), GatewayError> {
    let org = org_id.filter(|value| !value.trim().is_empty());
    if let Some(org) = org {
        if state.wallet.is_org_accounting_unavailable(org) {
            return Err(GatewayError::AccountingUnavailable);
        }
        if state.wallet.is_org_empty(org) {
            return Err(GatewayError::InsufficientCredits);
        }
    }
    if ctx.managed_inference
        && ctx
            .remaining_budget_micro_usd
            .is_some_and(|remaining| remaining <= 0)
    {
        return Err(GatewayError::InsufficientCredits);
    }
    crate::org_limits::check_request(state, ctx)?;
    let bucket = format!("provider:{quota_scope}:{}", org.unwrap_or("local"));
    if !state.org_rate.check_request(&bucket, per_minute) {
        return Err(GatewayError::RateLimited);
    }
    Ok(())
}

/// The authenticated scope a connection call runs under. `org_id` is the
/// organization the wallet debit and any tenant scoping bind to.
pub struct ConnectionScope<'a> {
    pub ctx: &'a RequestContext,
    pub org_id: Option<&'a str>,
}

/// What a provider returned, in the provider-neutral shape the endpoint and the
/// wallet debit consume.
#[derive(Debug)]
pub struct ConnectionOutcome {
    pub ok: bool,
    pub status: u16,
    pub body: Value,
    /// Provider-reported cost, authoritative when present.
    pub cost_micro_usd: Option<u64>,
    /// Provider transaction id, kept as descriptive attribution.
    pub call_id: Option<String>,
    /// Whether the operation is billable (account management is not).
    pub chargeable: bool,
    /// Set when the provider ran (and metered) the call but its response body
    /// exceeded the Gateway's read cap, in bytes. The call is still charged;
    /// the endpoint then fails with `provider_response_too_large` instead of
    /// delivering a body.
    pub response_too_large: Option<usize>,
    /// Set when the provider ran (and metered) the call but its response body
    /// could not be read to the end (the connection was cut after the headers).
    /// The call is still charged; the endpoint then fails with
    /// `provider_body_unreadable` instead of delivering a body.
    pub body_unreadable: bool,
}

pub type ConnectionFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ConnectionOutcome, GatewayError>> + Send + 'a>>;

/// What a call will cost before it runs, as far as the Gateway knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolQuote {
    /// The operation is never billed (account management, capability listing).
    NotBillable,
    /// A raw per-call estimate in micro-USD, before Ryu markup.
    Priced {
        estimate_micro_usd: u64,
        source: PriceSource,
    },
    /// Billable, but the Gateway holds no price. The managed tier refuses it.
    Unpriced,
}

/// Where a pre-call estimate came from, reported on the call response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PriceSource {
    /// The operator's own price row (`[treg.prices]`).
    Operator,
    /// The provider's published catalog estimate.
    Catalog,
    /// A configured per-call rate (`credits.cost_per_tool_call_micro_usd`).
    ConfiguredRate,
}

impl PriceSource {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Operator => "operator",
            Self::Catalog => "catalog",
            Self::ConfiguredRate => "configured_rate",
        }
    }
}

pub type QuoteFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ToolQuote, GatewayError>> + Send + 'a>>;

/// Whether a provider can take one call, as far as it can tell before running
/// it. Only `"builtin"` routing reads this; a named or selected provider is
/// called regardless.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Serves {
    Yes,
    No,
    /// The provider could not tell (its catalog is unreachable). Not a reason
    /// to fall back on its own, only when a later provider answers [`Serves::Yes`].
    Unknown,
}

pub type ServesFuture<'a> = Pin<Box<dyn Future<Output = Serves> + Send + 'a>>;

/// The provider a call was routed to, and the provider it fell back from.
pub struct RoutedProvider {
    pub provider: Arc<dyn ConnectionProvider>,
    pub fell_back_from: Option<&'static str>,
}

/// A managed connection provider. Implementations read their client from
/// [`AppState`], so a provider's credentials keep their single owner.
pub trait ConnectionProvider: Send + Sync {
    /// Stable registry id (`"composio"`, `"treg"`).
    fn id(&self) -> &'static str;
    /// Whether this Gateway holds a usable credential for the provider.
    fn configured(&self, state: &AppState) -> bool;
    /// Price one operation before it runs. Wallet-billed calls are refused
    /// when this is [`ToolQuote::Unpriced`], so the default — for a provider
    /// that has not taught the Gateway its prices — is to refuse, never to
    /// serve free.
    fn quote<'a>(&'a self, _state: &'a AppState, _call: &'a ConnectionCall) -> QuoteFuture<'a> {
        Box::pin(async { Ok(ToolQuote::Unpriced) })
    }
    /// Whether this provider can serve `call`, for `"builtin"` routing. The
    /// default claims every call.
    fn serves<'a>(&'a self, _state: &'a AppState, _call: &'a ConnectionCall) -> ServesFuture<'a> {
        Box::pin(async { Serves::Yes })
    }
    /// Execute one operation for the authenticated scope.
    fn call<'a>(
        &'a self,
        state: &'a AppState,
        scope: ConnectionScope<'a>,
        call: &'a ConnectionCall,
    ) -> ConnectionFuture<'a>;
}

/// How long the first charge under a ledger reference is reused for a replay
/// of the same call. Matches the order of a provider's own replay window.
const CHARGE_MEMO_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// Bound on remembered charges; expired, then the oldest half, are dropped.
const CHARGE_MEMO_MAX_ENTRIES: usize = 16_384;

/// The first raw charge recorded under each ledger reference.
///
/// A managed call's ledger `refId` is deterministic, so a retry or a
/// provider-side replay lands on the same reference. What it would charge is
/// not: it depends on whether the provider reported a cost and on the
/// Gateway-held estimate, both of which can differ between attempts. The
/// ledger keeps the first amount under a reference (and the Polar authority
/// refuses a different one), so a replay must reuse the first charge rather
/// than recompute it, or the response would misstate what was charged.
#[derive(Default)]
pub struct ChargeMemo {
    entries: Mutex<HashMap<String, MemoEntry>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RememberedCharge {
    /// Raw provider cost before markup.
    pub raw_cost_micro_usd: u64,
    /// Whether the first charge used the Gateway's estimate.
    pub estimated: bool,
}

impl ChargeMemo {
    /// The charge to record under `ref_id`: the first positive charge already
    /// remembered for it, else this one (remembered when positive). A zero
    /// charge is not remembered, so a free failed attempt never makes a later
    /// successful attempt under the same reference free.
    pub fn first_charge(&self, ref_id: &str, charge: RememberedCharge) -> RememberedCharge {
        let mut entries = match self.entries.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(first) = entries
            .get(ref_id)
            .copied()
            .filter(|entry| entry.at.elapsed() < CHARGE_MEMO_TTL)
        {
            return first.charge;
        }
        if charge.raw_cost_micro_usd == 0 {
            return charge;
        }
        if entries.len() >= CHARGE_MEMO_MAX_ENTRIES {
            entries.retain(|_, entry| entry.at.elapsed() < CHARGE_MEMO_TTL);
        }
        if entries.len() >= CHARGE_MEMO_MAX_ENTRIES {
            let mut ages: Vec<(String, Instant)> = entries
                .iter()
                .map(|(key, entry)| (key.clone(), entry.at))
                .collect();
            ages.sort_by_key(|(_, at)| *at);
            for (key, _) in ages.into_iter().take(CHARGE_MEMO_MAX_ENTRIES / 2) {
                entries.remove(&key);
            }
        }
        entries.insert(
            ref_id.to_owned(),
            MemoEntry {
                charge,
                at: Instant::now(),
            },
        );
        charge
    }
}

#[derive(Clone, Copy)]
struct MemoEntry {
    charge: RememberedCharge,
    at: Instant,
}

/// Id-keyed registry of connection providers with a live selection.
pub struct ConnectionRegistry {
    providers: RwLock<Vec<Arc<dyn ConnectionProvider>>>,
    selected: RwLock<String>,
    /// First charge per ledger reference, so a replay is charged the same.
    pub charges: ChargeMemo,
}

impl Default for ConnectionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ConnectionRegistry {
    /// The shipped providers, with the selection deferring to configuration.
    pub fn new() -> Self {
        let providers: Vec<Arc<dyn ConnectionProvider>> =
            vec![Arc::new(ComposioConnection), Arc::new(TregConnection)];
        Self {
            providers: RwLock::new(providers),
            selected: RwLock::new(BUILTIN.to_owned()),
            charges: ChargeMemo::default(),
        }
    }

    /// Register a provider under its id (open extension point). Re-registering
    /// an id replaces it in place.
    #[allow(dead_code)]
    pub fn register(&self, provider: Arc<dyn ConnectionProvider>) {
        let mut providers = match self.providers.write() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        match providers.iter().position(|p| p.id() == provider.id()) {
            Some(index) => providers[index] = provider,
            None => providers.push(provider),
        }
    }

    fn snapshot(&self) -> Vec<Arc<dyn ConnectionProvider>> {
        match self.providers.read() {
            Ok(guard) => guard.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    /// The registered provider with this id.
    pub fn get(&self, id: &str) -> Option<Arc<dyn ConnectionProvider>> {
        self.snapshot().into_iter().find(|p| p.id() == id)
    }

    /// Valid `backends.connections` values: `"builtin"`, then every provider id.
    pub fn available(&self) -> Vec<String> {
        std::iter::once(BUILTIN.to_owned())
            .chain(self.snapshot().iter().map(|p| p.id().to_owned()))
            .collect()
    }

    /// The current `backends.connections` value.
    pub fn selected(&self) -> String {
        match self.selected.read() {
            Ok(guard) => guard.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    /// Select the provider that answers calls naming none. `false` (unchanged)
    /// for an unknown id.
    pub fn set_selected(&self, id: &str) -> bool {
        if !self.available().iter().any(|known| known == id) {
            return false;
        }
        let mut selected = match self.selected.write() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        *selected = id.to_owned();
        true
    }

    /// The configured providers in `"builtin"` order: [`BUILTIN_ORDER`] first,
    /// then any other registered provider in registration order.
    fn builtin_candidates(&self, state: &AppState) -> Vec<Arc<dyn ConnectionProvider>> {
        let mut providers = self.snapshot();
        providers.sort_by_key(|provider| {
            BUILTIN_ORDER
                .iter()
                .position(|id| *id == provider.id())
                .unwrap_or(BUILTIN_ORDER.len())
        });
        providers
            .into_iter()
            .filter(|provider| provider.configured(state))
            .collect()
    }

    /// The provider that answers a call naming none: the explicit selection,
    /// else the most preferred configured provider (Treg before Composio), else
    /// `None` when nothing is configured.
    pub fn active(&self, state: &AppState) -> Option<Arc<dyn ConnectionProvider>> {
        let selected = self.selected();
        if selected != BUILTIN {
            return self.get(&selected);
        }
        self.builtin_candidates(state).into_iter().next()
    }

    /// Route one call. A named provider or an explicit selection is used as
    /// is. Under `"builtin"` (an empty `provider`, or the literal `"builtin"`),
    /// the first configured provider in [`BUILTIN_ORDER`] that serves the call
    /// answers it; when none says it can, the most preferred one answers so its
    /// own refusal reaches the caller.
    ///
    /// The Core-forwarded [`ProviderPin`] narrows this: a Composio pin leaves
    /// Composio as the only candidate and refuses a call that only Treg could
    /// answer (`policy_violation`), and `requireServable` refuses, with
    /// `tool_not_servable`, a call the chosen provider cannot serve.
    pub async fn route(
        &self,
        state: &AppState,
        call: &ConnectionCall,
    ) -> Result<RoutedProvider, GatewayError> {
        let pin = ProviderPin::from_call(call)?;
        // Naming `builtin` opts into per-call routing: it is the selection value,
        // not a provider, so it counts as naming none. (Core always sends a
        // provider, so this is how an app asks for the Treg-then-Composio order.)
        let named = match call.provider.trim() {
            BUILTIN => "",
            other => other,
        };
        if !named.is_empty() || self.selected() != BUILTIN {
            let provider = self.resolve(state, named)?;
            if pin == Some(ProviderPin::Composio) && provider.id() != COMPOSIO {
                return Err(pinned_to_composio(provider.id()));
            }
            if call.require_servable && provider.serves(state, call).await != Serves::Yes {
                return Err(not_servable(provider.id(), call));
            }
            return Ok(RoutedProvider {
                provider,
                fell_back_from: None,
            });
        }
        let mut candidates = self.builtin_candidates(state);
        if pin == Some(ProviderPin::Composio) {
            candidates.retain(|provider| provider.id() == COMPOSIO);
            if candidates.is_empty() {
                // Without this refusal the empty-candidates path below would
                // resolve the active provider, which is Treg.
                return Err(GatewayError::PolicyViolation(
                    "this service is set to use Composio, which this Gateway does not configure"
                        .to_owned(),
                ));
            }
        }
        let Some(primary) = candidates.first().cloned() else {
            return self.resolve(state, "").map(|provider| RoutedProvider {
                provider,
                fell_back_from: None,
            });
        };
        for candidate in &candidates {
            if candidate.serves(state, call).await == Serves::Yes {
                let fell_back_from = (candidate.id() != primary.id()).then_some(primary.id());
                if let Some(from) = fell_back_from {
                    tracing::debug!(
                        tool_id = %call.tool_id,
                        from,
                        to = candidate.id(),
                        "connections: primary provider cannot serve this call; falling back"
                    );
                }
                return Ok(RoutedProvider {
                    provider: Arc::clone(candidate),
                    fell_back_from,
                });
            }
        }
        if call.require_servable {
            return Err(not_servable(primary.id(), call));
        }
        if pin == Some(ProviderPin::Composio) {
            // Only Treg could have answered this call, and the user chose
            // Composio for it: refuse rather than hand Composio a Treg id.
            return Err(pinned_to_composio(TREG));
        }
        Ok(RoutedProvider {
            provider: primary,
            fell_back_from: None,
        })
    }

    /// Resolve a request's provider: the named one, else the active one.
    pub fn resolve(
        &self,
        state: &AppState,
        requested: &str,
    ) -> Result<Arc<dyn ConnectionProvider>, GatewayError> {
        let requested = requested.trim();
        if !requested.is_empty() {
            return self.get(requested).ok_or_else(|| {
                // `builtin` is a selection value, not a nameable provider, so
                // only the ids `get` can resolve are listed.
                let known: Vec<String> = self
                    .snapshot()
                    .iter()
                    .map(|provider| provider.id().to_owned())
                    .collect();
                GatewayError::BadRequest(format!(
                    "unsupported managed provider `{requested}`; available: {}",
                    known.join(", ")
                ))
            });
        }
        self.active(state).ok_or_else(|| {
            GatewayError::BadRequest(
                "no connection provider is selected; name `provider` or set backends.connections"
                    .to_owned(),
            )
        })
    }

    /// The layer state for `GET /v1/providers`: selection, resolved provider,
    /// and each provider's presence. Never includes credentials.
    pub fn describe(&self, state: &AppState) -> Value {
        let providers: Vec<Value> = self
            .snapshot()
            .iter()
            .map(
                |provider| json!({ "id": provider.id(), "configured": provider.configured(state) }),
            )
            .collect();
        let order: Vec<&'static str> = self
            .builtin_candidates(state)
            .iter()
            .map(|provider| provider.id())
            .collect();
        // Per-call fallback applies only under `"builtin"`; an explicit
        // selection always answers itself.
        let fallback = (self.selected() == BUILTIN)
            .then(|| order.get(1).copied())
            .flatten();
        json!({
            "selected": self.selected(),
            "active": self.active(state).map(|provider| provider.id()),
            "order": order,
            "fallback": fallback,
            "providers": providers,
        })
    }
}

fn pinned_to_composio(provider: &str) -> GatewayError {
    GatewayError::PolicyViolation(format!(
        "this service is set to use Composio; `{provider}` may not answer it"
    ))
}

fn not_servable(provider: &str, call: &ConnectionCall) -> GatewayError {
    GatewayError::ToolNotServable(format!(
        "`{provider}` cannot serve `{}` on the operator credential",
        call.tool_id
    ))
}

/// Connected-account management, which only Composio offers.
fn is_account_operation(operation: Option<&str>) -> bool {
    matches!(operation, Some("capabilities" | "connect" | "disconnect"))
}

/// Treg has no connected accounts, so an account operation is never Treg's to
/// run. Refusing it keeps a Treg endpoint id from standing in for a Composio
/// toolkit and dodging that brand's Composio pin.
fn refuse_account_operation(call: &ConnectionCall) -> Result<(), GatewayError> {
    if is_account_operation(call.operation.as_deref()) {
        return Err(GatewayError::BadRequest(
            "Treg has no connected accounts; account operations are served by Composio".to_owned(),
        ));
    }
    Ok(())
}

/// Treg: every operation is a metered endpoint call; the response headers carry
/// the provider cost and transaction id.
struct TregConnection;

impl ConnectionProvider for TregConnection {
    fn id(&self) -> &'static str {
        TREG
    }

    fn configured(&self, state: &AppState) -> bool {
        state.treg.is_some()
    }

    /// Every Treg operation is a metered endpoint call. The Gateway prices it
    /// from the operator table, else Treg's catalog estimate. An endpoint the
    /// catalog does not know is unpriced (`403 tool_unpriced`), an invalid id is
    /// a `400`, and only a catalog that cannot be read is an accounting outage
    /// (retryable 503), never a price.
    fn quote<'a>(&'a self, state: &'a AppState, call: &'a ConnectionCall) -> QuoteFuture<'a> {
        Box::pin(async move {
            refuse_account_operation(call)?;
            let Some(treg) = state.treg.as_ref() else {
                return Ok(ToolQuote::Unpriced);
            };
            match treg.price_estimate(&call.tool_id).await {
                Ok(Some((estimate_micro_usd, source))) => Ok(ToolQuote::Priced {
                    estimate_micro_usd,
                    source: match source {
                        TregPriceSource::Operator => PriceSource::Operator,
                        TregPriceSource::Catalog => PriceSource::Catalog,
                    },
                }),
                Ok(None) => Ok(ToolQuote::Unpriced),
                Err(TregPriceError::InvalidEndpoint) => Err(GatewayError::BadRequest(
                    "tool_id is not a valid Treg endpoint id".to_owned(),
                )),
                Err(TregPriceError::Unavailable(error)) => {
                    tracing::warn!(
                        tool_id = %call.tool_id,
                        error = %format!("{error:#}"),
                        "treg: catalog price lookup failed; refusing the metered call"
                    );
                    Err(GatewayError::AccountingUnavailable)
                }
            }
        })
    }

    /// Treg serves metered endpoint calls only: no account operations, and
    /// only endpoints its catalog lists as callable on the fleet token (not
    /// platform-blocked, not scoped to the caller's own account).
    fn serves<'a>(&'a self, state: &'a AppState, call: &'a ConnectionCall) -> ServesFuture<'a> {
        Box::pin(async move {
            if is_account_operation(call.operation.as_deref()) {
                return Serves::No;
            }
            let Some(treg) = state.treg.as_ref() else {
                return Serves::No;
            };
            match treg.endpoint_status(&call.tool_id).await {
                Ok(TregEndpointStatus::Servable) => Serves::Yes,
                Ok(
                    TregEndpointStatus::Unknown
                    | TregEndpointStatus::Blocked
                    | TregEndpointStatus::OwnAccount,
                )
                | Err(TregPriceError::InvalidEndpoint) => Serves::No,
                Err(TregPriceError::Unavailable(_)) => Serves::Unknown,
            }
        })
    }

    fn call<'a>(
        &'a self,
        state: &'a AppState,
        scope: ConnectionScope<'a>,
        call: &'a ConnectionCall,
    ) -> ConnectionFuture<'a> {
        Box::pin(async move {
            // Checked here as well as in `quote`: Core's pin lookup reads a Treg
            // endpoint id by its own brand, so an account operation named
            // against one would otherwise dodge the brand's Composio pin.
            refuse_account_operation(call)?;
            // The guard admitted one of the allowed methods in any case; send
            // its canonical uppercase token, never an extension method.
            let method = Method::from_bytes(call.method.trim().to_ascii_uppercase().as_bytes())
                .map_err(|_| GatewayError::BadRequest("invalid provider method".to_owned()))?;
            let treg = state.treg.clone().ok_or_else(|| {
                GatewayError::ProviderError(
                    "Treg is not configured in the Gateway provider vault".to_owned(),
                )
            })?;
            // `route` only asks `serves` under builtin routing, so a caller that
            // names `treg` (Core's `treg.call`, the social app, Connect) would
            // otherwise run a platform-blocked or own-account endpoint as the
            // shared fleet account. The catalog decides here, ignoring any
            // operator price row. Refusing drops the admission, which releases
            // any credit reservation.
            match treg.catalog_status(&call.tool_id).await {
                Ok(TregEndpointStatus::Blocked | TregEndpointStatus::OwnAccount) => {
                    return Err(GatewayError::ToolNotServable(format!(
                        "`{}` is platform-blocked or scoped to the caller's own account, so it cannot run on the shared Treg token",
                        call.tool_id.trim()
                    )))
                }
                // `Unknown`: the quote already refuses an unpriced call when it is
                // wallet-billed, and an operator-priced unlisted endpoint is the
                // operator's choice.
                Ok(TregEndpointStatus::Servable | TregEndpointStatus::Unknown) => {}
                Err(TregPriceError::InvalidEndpoint) => {
                    return Err(GatewayError::BadRequest(
                        "tool_id is not a valid Treg endpoint id".to_owned(),
                    ))
                }
                Err(TregPriceError::Unavailable(error)) => {
                    tracing::warn!(
                        tool_id = %call.tool_id,
                        error = %format!("{error:#}"),
                        "treg: catalog status lookup failed; refusing the call"
                    );
                    return Err(GatewayError::AccountingUnavailable);
                }
            }
            let response = treg
                .call(
                    &call.tool_id,
                    method,
                    &call.query,
                    call.body.as_ref(),
                    TregCallScope {
                        org_id: scope.org_id,
                        caller_id: call.caller_id.as_deref(),
                        idempotency_key: call.idempotency_key.as_deref(),
                    },
                )
                .await;
            let response = match response {
                Ok(response) => response,
                Err(TregCallError::ResponseTooLarge {
                    limit_bytes,
                    status,
                    call_id,
                    cost_micro_usd,
                }) => {
                    // Treg has run and metered this call, and its side effects
                    // happened. It is charged like any other call; only the
                    // body is not delivered. Leaving it uncharged would let a
                    // caller that controls the response size run metered
                    // endpoints on the fleet token for free.
                    tracing::warn!(
                        tool_id = %call.tool_id,
                        treg_call_id = call_id.as_deref().unwrap_or("-"),
                        treg_cost_micro_usd = cost_micro_usd.unwrap_or(0),
                        limit_bytes,
                        "treg: response exceeded the read cap; charging the call, not delivering the body"
                    );
                    return Ok(ConnectionOutcome {
                        ok: status.is_success(),
                        status: status.as_u16(),
                        body: Value::Null,
                        cost_micro_usd,
                        call_id,
                        chargeable: true,
                        response_too_large: Some(limit_bytes),
                        body_unreadable: false,
                    });
                }
                Err(TregCallError::BodyUnreadable {
                    status,
                    call_id,
                    cost_micro_usd,
                    source,
                }) => {
                    // Same rule as an oversized body: Treg already ran and
                    // metered the call, so a cut body does not make it free. A
                    // non-success status with no reported cost stays uncharged.
                    tracing::warn!(
                        tool_id = %call.tool_id,
                        treg_call_id = call_id.as_deref().unwrap_or("-"),
                        treg_cost_micro_usd = cost_micro_usd.unwrap_or(0),
                        error = %format!("{source:#}"),
                        "treg: response body could not be read; charging the call, not delivering the body"
                    );
                    return Ok(ConnectionOutcome {
                        ok: status.is_success(),
                        status: status.as_u16(),
                        body: Value::Null,
                        cost_micro_usd,
                        call_id,
                        chargeable: true,
                        response_too_large: None,
                        body_unreadable: true,
                    });
                }
                Err(TregCallError::Request(error)) => {
                    return Err(GatewayError::ProviderError(format!("{error:#}")))
                }
            };
            Ok(ConnectionOutcome {
                ok: response.status.is_success(),
                status: response.status.as_u16(),
                body: response.body,
                cost_micro_usd: response.cost_micro_usd,
                call_id: response.call_id,
                chargeable: true,
                response_too_large: None,
                body_unreadable: false,
            })
        })
    }
}

/// Composio: capabilities, connect/disconnect, staged file uploads, and metered
/// execution against a tenant-scoped connected account.
struct ComposioConnection;

impl ConnectionProvider for ComposioConnection {
    fn id(&self) -> &'static str {
        COMPOSIO
    }

    fn configured(&self, state: &AppState) -> bool {
        state.composio.is_some()
    }

    /// Only `execute` is billed. Its estimate is the configured per-call rate;
    /// the settled charge still comes from Composio's own execution receipt.
    fn quote<'a>(&'a self, state: &'a AppState, call: &'a ConnectionCall) -> QuoteFuture<'a> {
        Box::pin(async move {
            Ok(match call.operation.as_deref() {
                Some("execute") => ToolQuote::Priced {
                    estimate_micro_usd: state.config.credits.tool_call_cost_micro_usd(1),
                    source: PriceSource::ConfiguredRate,
                },
                _ => ToolQuote::NotBillable,
            })
        })
    }

    /// Composio serves its own operations: account management and `execute`.
    fn serves<'a>(&'a self, state: &'a AppState, call: &'a ConnectionCall) -> ServesFuture<'a> {
        Box::pin(async move {
            let supported = is_account_operation(call.operation.as_deref())
                || call.operation.as_deref() == Some("execute");
            if supported && state.composio.is_some() {
                Serves::Yes
            } else {
                Serves::No
            }
        })
    }

    fn call<'a>(
        &'a self,
        state: &'a AppState,
        scope: ConnectionScope<'a>,
        call: &'a ConnectionCall,
    ) -> ConnectionFuture<'a> {
        Box::pin(async move {
            let ctx = scope.ctx;
            let org_id = scope.org_id;
            let composio = state.composio.as_ref().ok_or_else(|| {
                GatewayError::ProviderError(
                    "Composio is not configured in the Gateway provider vault".to_owned(),
                )
            })?;
            // The connected account id is an operation argument, not the
            // Composio entity/user identity. Keep those identities separate so
            // an Outpost publish does not accidentally send its connection id as
            // `user_id`/`entity_id` upstream.
            if call.operation.as_deref() != Some("capabilities")
                && state.resolve_cache.is_some()
                && org_id.is_none()
            {
                return Err(GatewayError::Unauthorized(
                    "managed Composio calls require an authenticated organization".to_owned(),
                ));
            }
            // Scope Composio to the same org the wallet will debit. A local
            // single-user Core using the master key still keeps its configured
            // entity when it forwards its registered org in the body.
            let composio_org_id = if state.resolve_cache.is_some() || ctx.org_id.is_some() {
                org_id
            } else {
                None
            };
            let tenant = composio_org_id.map(ComposioTenantScope::new).transpose()?;
            let entity_id = composio.entity_for_request(composio_org_id, ctx.user_id.as_deref())?;
            let (body, chargeable, cost_micro_usd, call_id) = match call.operation.as_deref() {
                Some("capabilities") => {
                    (composio.list_tools(&call.tool_id).await?, false, None, None)
                }
                Some("connect") => {
                    let connect_user = match (tenant.as_ref(), call.account_id.as_deref()) {
                        (Some(tenant), Some(account_id)) => tenant.account_user_id(account_id)?,
                        (Some(tenant), None) => tenant.default_user_id(),
                        (None, Some(account_id)) => account_id.to_owned(),
                        (None, None) => entity_id.clone(),
                    };
                    (
                        composio.connect(&call.tool_id, &connect_user).await?,
                        false,
                        None,
                        None,
                    )
                }
                Some("disconnect") => {
                    if let Some(tenant) = tenant.as_ref() {
                        composio
                            .connection_user_for_tenant(
                                &call.tool_id,
                                tenant,
                                ctx.user_id.as_deref(),
                            )
                            .await?;
                    }
                    (composio.disconnect(&call.tool_id).await?, false, None, None)
                }
                Some("file_upload") => {
                    // Stage one file for a tool's file parameter. The caller gets
                    // a presigned single-object write URL and the storage key,
                    // never the project key. Staging is free upstream; the tool
                    // execution that consumes the key is what gets metered. The
                    // slot still writes into platform-paid storage, so it passes
                    // the same pre-flight admission a metered call does, plus a
                    // per-org staging quota, before anything is requested
                    // upstream.
                    admit_unmetered_provider_use(
                        state,
                        ctx,
                        org_id,
                        "composio-file-upload",
                        FILE_UPLOAD_SLOTS_PER_MINUTE,
                    )?;
                    let file = call.body.clone().unwrap_or(Value::Null);
                    let slot = composio.request_file_upload(&call.tool_id, &file).await?;
                    tracing::info!(
                        target: "ryu_gateway::providers",
                        request_id = %call.request_id,
                        tool = %call.tool_id,
                        org = org_id.unwrap_or("local"),
                        "managed Composio file upload staged"
                    );
                    (slot, false, None, None)
                }
                Some("execute") => {
                    let account_user = match (tenant.as_ref(), call.account_id.as_deref()) {
                        (Some(tenant), Some(account_id)) => {
                            composio
                                .connection_user_for_tenant(
                                    account_id,
                                    tenant,
                                    ctx.user_id.as_deref(),
                                )
                                .await?
                        }
                        _ => entity_id,
                    };
                    let timeout = call.timeout_ms.filter(|ms| *ms > 0).map(|ms| {
                        std::time::Duration::from_millis(ms.min(MAX_PROVIDER_OPERATION_TIMEOUT_MS))
                    });
                    let execution = composio
                        .execute_metered_within(
                            &call.tool_id,
                            call.body.clone().unwrap_or(Value::Null),
                            &account_user,
                            call.account_id.as_deref(),
                            timeout,
                        )
                        .await;
                    if matches!(execution, Err(GatewayError::AccountingUnavailable)) {
                        if let Some(org_id) = org_id {
                            state.wallet.set_org_accounting_unavailable(org_id, true);
                        }
                    }
                    let (value, cost, transaction) = execution?;
                    (value, true, Some(cost), Some(transaction))
                }
                _ => {
                    return Err(GatewayError::BadRequest(
                        "Composio managed calls require a supported operation".to_owned(),
                    ));
                }
            };
            Ok(ConnectionOutcome {
                ok: true,
                status: 200,
                body,
                cost_micro_usd,
                call_id,
                chargeable,
                response_too_large: None,
                body_unreadable: false,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::treg::TregClient;

    fn state_with(composio: bool, treg: bool) -> AppState {
        let mut state = AppState::new_for_test_default();
        state.composio = composio.then(|| {
            let mut config = crate::config::ComposioConfig::default();
            config.enabled = true;
            config.api_key = Some("composio-fixture".to_owned());
            crate::composio::ComposioClient::new(config, reqwest::Client::new())
        });
        state.treg = treg.then(|| {
            let mut config = crate::config::TregConfig::default();
            config.token = Some("treg-fixture".to_owned());
            config.enabled = true;
            TregClient::from_config(&config, reqwest::Client::new()).expect("treg client")
        });
        state
    }

    #[test]
    fn builtin_selection_prefers_treg_then_composio() {
        let registry = ConnectionRegistry::new();
        let only_treg = state_with(false, true);
        assert_eq!(registry.active(&only_treg).map(|p| p.id()), Some(TREG));

        let only_composio = state_with(true, false);
        assert_eq!(
            registry.active(&only_composio).map(|p| p.id()),
            Some(COMPOSIO)
        );

        let neither = state_with(false, false);
        assert!(registry.active(&neither).is_none());

        let both = state_with(true, true);
        assert_eq!(
            registry.active(&both).map(|p| p.id()),
            Some(TREG),
            "Treg is the default when both are configured"
        );
    }

    #[test]
    fn explicit_selection_wins_and_swaps_live() {
        let registry = ConnectionRegistry::new();
        let both = state_with(true, true);
        assert!(registry.set_selected(COMPOSIO));
        assert_eq!(registry.active(&both).map(|p| p.id()), Some(COMPOSIO));
        assert!(registry.set_selected(TREG));
        assert_eq!(registry.active(&both).map(|p| p.id()), Some(TREG));
        assert!(!registry.set_selected("pipedream"));
        assert_eq!(registry.selected(), TREG);
    }

    #[test]
    fn a_named_provider_always_wins_over_the_selection() {
        let registry = ConnectionRegistry::new();
        let both = state_with(true, true);
        assert!(registry.set_selected(TREG));
        let named = registry
            .resolve(&both, " composio ")
            .expect("named provider");
        assert_eq!(named.id(), COMPOSIO);
        let defaulted = registry.resolve(&both, "").expect("selected provider");
        assert_eq!(defaulted.id(), TREG);
        let Err(GatewayError::BadRequest(message)) = registry.resolve(&both, "pipedream") else {
            panic!("an unknown named provider is a bad request");
        };
        assert_eq!(
            message,
            format!("unsupported managed provider `pipedream`; available: {COMPOSIO}, {TREG}")
        );
    }

    #[test]
    fn describe_reports_presence_without_credentials() {
        let registry = ConnectionRegistry::new();
        let state = state_with(false, true);
        let view = registry.describe(&state);
        assert_eq!(view["selected"], BUILTIN);
        assert_eq!(view["active"], TREG);
        assert_eq!(
            view["providers"],
            json!([
                { "id": COMPOSIO, "configured": false },
                { "id": TREG, "configured": true },
            ])
        );
        assert!(!view.to_string().contains("fixture"));
    }

    #[test]
    fn describe_reports_treg_first_with_composio_as_fallback() {
        let registry = ConnectionRegistry::new();
        let both = state_with(true, true);
        let view = registry.describe(&both);
        assert_eq!(view["active"], TREG);
        assert_eq!(view["order"], json!([TREG, COMPOSIO]));
        assert_eq!(view["fallback"], COMPOSIO);

        // An explicit selection answers every call itself: no fallback.
        assert!(registry.set_selected(COMPOSIO));
        let view = registry.describe(&both);
        assert_eq!(view["active"], COMPOSIO);
        assert_eq!(view["fallback"], Value::Null);

        let only_treg = state_with(false, true);
        assert!(registry.set_selected(BUILTIN));
        assert_eq!(registry.describe(&only_treg)["fallback"], Value::Null);
    }

    fn call_for(tool_id: &str, operation: Option<&str>) -> ConnectionCall {
        serde_json::from_value(json!({
            "toolId": tool_id,
            "operation": operation,
            "method": "POST",
            "requestId": "req-1",
        }))
        .expect("connection call")
    }

    /// Both providers configured, with Treg's catalog served by a local mock:
    /// `listed` is callable, `blocked` is platform-blocked, `slack.message.send`
    /// needs the user's own account, anything else (Gmail included) 404s.
    async fn both_with_treg_catalog() -> (AppState, tokio::task::JoinHandle<()>) {
        use axum::{response::IntoResponse, routing::get, Router};
        let router = Router::new().route(
            "/catalog/endpoints/:id",
            get(
                |axum::extract::Path(id): axum::extract::Path<String>| async move {
                    match id.as_str() {
                        "listed" => axum::Json(json!({"endpoint": {
                            "id": id, "cost": {"usd": 0.001, "unit": "call"}
                        }}))
                        .into_response(),
                        "blocked" => axum::Json(json!({"endpoint": {
                            "id": id, "platform_eligible": false,
                            "cost": {"usd": 0.001, "unit": "call"}
                        }}))
                        .into_response(),
                        // Treg lists Slack only as the caller's own account.
                        "slack.message.send" => axum::Json(json!({"endpoint": {
                            "id": id, "scope": "own_account",
                            "cost": {"usd": 0.001, "unit": "call"}
                        }}))
                        .into_response(),
                        _ => axum::http::StatusCode::NOT_FOUND.into_response(),
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.expect("serve");
        });
        let mut state = state_with(true, false);
        let config = crate::config::TregConfig {
            token: Some("treg-fixture".to_owned()),
            enabled: true,
            base_url: base,
            ..Default::default()
        };
        state.treg = TregClient::from_config(&config, reqwest::Client::new());
        (state, server)
    }

    #[tokio::test]
    async fn builtin_routes_each_call_to_treg_and_falls_back_to_composio() {
        let registry = ConnectionRegistry::new();
        let (state, server) = both_with_treg_catalog().await;

        let routed = registry
            .route(&state, &call_for("listed", None))
            .await
            .expect("route");
        assert_eq!(routed.provider.id(), TREG);
        assert_eq!(routed.fell_back_from, None);

        // Account operations exist only on Composio.
        for operation in ["connect", "disconnect", "capabilities"] {
            let routed = registry
                .route(&state, &call_for("github", Some(operation)))
                .await
                .expect("route");
            assert_eq!(routed.provider.id(), COMPOSIO, "{operation}");
            assert_eq!(routed.fell_back_from, Some(TREG));
        }

        // An action Treg's catalog does not list (Gmail is not on Treg at all),
        // one it marks platform-blocked, or one that needs the user's own
        // account: Composio keeps serving it exactly as before.
        for tool_id in [
            "GMAIL_SEND_EMAIL",
            "GITHUB_CREATE_ISSUE",
            "blocked",
            "slack.message.send",
        ] {
            let routed = registry
                .route(&state, &call_for(tool_id, Some("execute")))
                .await
                .expect("route");
            assert_eq!(routed.provider.id(), COMPOSIO, "{tool_id}");
        }

        // A Treg-shaped call neither provider can serve stays on Treg, so the
        // caller sees Treg's own refusal rather than Composio's.
        let routed = registry
            .route(&state, &call_for("unlisted", None))
            .await
            .expect("route");
        assert_eq!(routed.provider.id(), TREG);
        assert_eq!(routed.fell_back_from, None);
        server.abort();
    }

    #[tokio::test]
    async fn gmail_absent_from_treg_resolves_to_composio_with_both_configured() {
        let registry = ConnectionRegistry::new();
        let (state, server) = both_with_treg_catalog().await;
        // Connecting the user's Gmail and running a Gmail action both stay on
        // Composio: Treg's catalog has no Gmail, so configuring Treg never
        // takes an existing Composio integration away.
        for (tool_id, operation) in [
            ("gmail", Some("connect")),
            ("GMAIL_SEND_EMAIL", Some("execute")),
            ("GMAIL_FETCH_EMAILS", Some("execute")),
        ] {
            let routed = registry
                .route(&state, &call_for(tool_id, operation))
                .await
                .expect("route");
            assert_eq!(routed.provider.id(), COMPOSIO, "{tool_id}");
        }
        server.abort();
    }

    #[tokio::test]
    async fn a_call_naming_builtin_routes_per_call_like_an_unnamed_one() {
        let registry = ConnectionRegistry::new();
        let (state, server) = both_with_treg_catalog().await;

        let mut builtin = call_for("listed", None);
        builtin.provider = BUILTIN.to_owned();
        let routed = registry.route(&state, &builtin).await.expect("route");
        assert_eq!(routed.provider.id(), TREG);
        assert_eq!(routed.fell_back_from, None);

        let mut fallback = call_for("GMAIL_SEND_EMAIL", Some("execute"));
        fallback.provider = BUILTIN.to_owned();
        let routed = registry.route(&state, &fallback).await.expect("route");
        assert_eq!(routed.provider.id(), COMPOSIO);
        assert_eq!(routed.fell_back_from, Some(TREG));

        // Under an explicit selection `builtin` names nothing, so the selection
        // answers and never falls back.
        assert!(registry.set_selected(COMPOSIO));
        let routed = registry.route(&state, &builtin).await.expect("route");
        assert_eq!(routed.provider.id(), COMPOSIO);
        assert_eq!(routed.fell_back_from, None);
        server.abort();
    }

    #[tokio::test]
    async fn treg_refuses_account_operations_even_when_named() {
        let (state, server) = both_with_treg_catalog().await;
        let treg = TregConnection;
        for operation in ["connect", "disconnect", "capabilities"] {
            let call = call_for("listed", Some(operation));
            assert!(
                matches!(
                    treg.quote(&state, &call).await,
                    Err(GatewayError::BadRequest(_))
                ),
                "{operation}"
            );
        }
        // An ordinary metered call is unaffected.
        assert!(treg
            .quote(&state, &call_for("listed", Some("execute")))
            .await
            .is_ok());
        assert!(refuse_account_operation(&call_for("listed", None)).is_ok());
        server.abort();
    }

    #[tokio::test]
    async fn named_and_selected_providers_never_fall_back() {
        let registry = ConnectionRegistry::new();
        let (state, server) = both_with_treg_catalog().await;

        let mut named = call_for("github", Some("connect"));
        named.provider = TREG.to_owned();
        let routed = registry.route(&state, &named).await.expect("route");
        assert_eq!(routed.provider.id(), TREG);
        assert_eq!(routed.fell_back_from, None);

        assert!(registry.set_selected(TREG));
        let routed = registry
            .route(&state, &call_for("GITHUB_CREATE_ISSUE", Some("execute")))
            .await
            .expect("route");
        assert_eq!(routed.provider.id(), TREG);

        assert!(registry.set_selected(COMPOSIO));
        let routed = registry
            .route(&state, &call_for("listed", None))
            .await
            .expect("route");
        assert_eq!(routed.provider.id(), COMPOSIO);
        server.abort();
    }

    #[tokio::test]
    async fn builtin_with_only_composio_routes_everything_to_it() {
        let registry = ConnectionRegistry::new();
        let state = state_with(true, false);
        let routed = registry
            .route(&state, &call_for("GITHUB_CREATE_ISSUE", Some("execute")))
            .await
            .expect("route");
        assert_eq!(routed.provider.id(), COMPOSIO);
        assert_eq!(routed.fell_back_from, None);

        let neither = state_with(false, false);
        assert!(matches!(
            registry.route(&neither, &call_for("listed", None)).await,
            Err(GatewayError::BadRequest(_))
        ));
    }

    fn pinned_call(
        tool_id: &str,
        operation: Option<&str>,
        provider: &str,
        pin: Option<&str>,
        require_servable: bool,
    ) -> ConnectionCall {
        serde_json::from_value(json!({
            "provider": provider,
            "toolId": tool_id,
            "operation": operation,
            "method": "POST",
            "requestId": "req-1",
            "providerPin": pin,
            "requireServable": require_servable,
        }))
        .expect("connection call")
    }

    #[tokio::test]
    async fn literal_builtin_routes_like_an_empty_provider() {
        let registry = ConnectionRegistry::new();
        let (state, server) = both_with_treg_catalog().await;
        let routed = registry
            .route(&state, &pinned_call("listed", None, BUILTIN, None, false))
            .await
            .expect("route");
        assert_eq!(routed.provider.id(), TREG);
        let routed = registry
            .route(
                &state,
                &pinned_call("GMAIL_SEND_EMAIL", Some("execute"), BUILTIN, None, false),
            )
            .await
            .expect("route");
        assert_eq!(routed.provider.id(), COMPOSIO);
        assert_eq!(routed.fell_back_from, Some(TREG));
        // `builtin` stays a routing value, not a provider a caller resolves.
        assert!(matches!(
            registry.resolve(&state, BUILTIN),
            Err(GatewayError::BadRequest(_))
        ));
        server.abort();
    }

    #[tokio::test]
    async fn composio_pin_keeps_a_treg_servable_call_on_composio() {
        let registry = ConnectionRegistry::new();
        let (state, server) = both_with_treg_catalog().await;
        for provider in ["", BUILTIN] {
            let routed = registry
                .route(
                    &state,
                    &pinned_call("listed", Some("execute"), provider, Some(COMPOSIO), false),
                )
                .await
                .expect("route");
            assert_eq!(routed.provider.id(), COMPOSIO, "{provider:?}");
            // A pin is not a fallback: Treg was never a candidate.
            assert_eq!(routed.fell_back_from, None);
        }
        server.abort();
    }

    #[tokio::test]
    async fn treg_pin_still_falls_back_to_composio_for_actions_treg_lacks() {
        let registry = ConnectionRegistry::new();
        let (state, server) = both_with_treg_catalog().await;
        let routed = registry
            .route(
                &state,
                &pinned_call("listed", None, BUILTIN, Some(TREG), false),
            )
            .await
            .expect("route");
        assert_eq!(routed.provider.id(), TREG);
        for tool_id in ["GMAIL_SEND_EMAIL", "blocked", "slack.message.send"] {
            let routed = registry
                .route(
                    &state,
                    &pinned_call(tool_id, Some("execute"), BUILTIN, Some(TREG), false),
                )
                .await
                .expect("route");
            assert_eq!(routed.provider.id(), COMPOSIO, "{tool_id}");
            assert_eq!(routed.fell_back_from, Some(TREG), "{tool_id}");
        }
        server.abort();
    }

    #[tokio::test]
    async fn composio_pin_refuses_a_call_only_treg_could_answer() {
        let registry = ConnectionRegistry::new();
        let (state, server) = both_with_treg_catalog().await;
        // No operation: a Treg-shaped call that Composio does not serve.
        assert!(matches!(
            registry
                .route(
                    &state,
                    &pinned_call("listed", None, BUILTIN, Some(COMPOSIO), false)
                )
                .await,
            Err(GatewayError::PolicyViolation(_))
        ));
        server.abort();
    }

    #[tokio::test]
    async fn composio_pin_without_composio_is_refused_never_sent_to_treg() {
        let registry = ConnectionRegistry::new();
        let (mut state, server) = both_with_treg_catalog().await;
        state.composio = None;
        assert!(matches!(
            registry
                .route(
                    &state,
                    &pinned_call("listed", None, BUILTIN, Some(COMPOSIO), false)
                )
                .await,
            Err(GatewayError::PolicyViolation(_))
        ));
        server.abort();
    }

    #[tokio::test]
    async fn named_or_selected_treg_under_a_composio_pin_is_refused() {
        let registry = ConnectionRegistry::new();
        let (state, server) = both_with_treg_catalog().await;
        assert!(matches!(
            registry
                .route(
                    &state,
                    &pinned_call("listed", None, TREG, Some(COMPOSIO), false)
                )
                .await,
            Err(GatewayError::PolicyViolation(_))
        ));
        assert!(registry.set_selected(TREG));
        assert!(matches!(
            registry
                .route(
                    &state,
                    &pinned_call("listed", None, "", Some(COMPOSIO), false)
                )
                .await,
            Err(GatewayError::PolicyViolation(_))
        ));
        // A Treg pin never forbids Composio, named or selected.
        assert!(registry.set_selected(BUILTIN));
        let routed = registry
            .route(
                &state,
                &pinned_call(
                    "GMAIL_SEND_EMAIL",
                    Some("execute"),
                    COMPOSIO,
                    Some(TREG),
                    false,
                ),
            )
            .await
            .expect("route");
        assert_eq!(routed.provider.id(), COMPOSIO);
        server.abort();
    }

    #[tokio::test]
    async fn an_unknown_pin_is_a_bad_request() {
        let registry = ConnectionRegistry::new();
        let state = state_with(true, false);
        assert!(matches!(
            registry
                .route(
                    &state,
                    &pinned_call("listed", None, "", Some("openrouter"), false)
                )
                .await,
            Err(GatewayError::BadRequest(_))
        ));
    }

    #[tokio::test]
    async fn require_servable_refuses_what_treg_cannot_serve_on_the_fleet_token() {
        let registry = ConnectionRegistry::new();
        let (state, server) = both_with_treg_catalog().await;
        let routed = registry
            .route(&state, &pinned_call("listed", None, TREG, None, true))
            .await
            .expect("route");
        assert_eq!(routed.provider.id(), TREG);
        for tool_id in ["blocked", "slack.message.send", "unlisted"] {
            assert!(
                matches!(
                    registry
                        .route(&state, &pinned_call(tool_id, None, TREG, None, true))
                        .await,
                    Err(GatewayError::ToolNotServable(_))
                ),
                "{tool_id}"
            );
            // Without the flag a named provider is still called unscreened.
            let routed = registry
                .route(&state, &pinned_call(tool_id, None, TREG, None, false))
                .await
                .expect("route");
            assert_eq!(routed.provider.id(), TREG, "{tool_id}");
        }
        server.abort();
    }

    #[test]
    fn a_replay_reuses_the_first_positive_charge_under_its_reference() {
        let memo = ChargeMemo::default();
        let charge = |raw, estimated| RememberedCharge {
            raw_cost_micro_usd: raw,
            estimated,
        };
        // A free failed attempt is not remembered, so a later successful
        // attempt under the same reference is still charged.
        assert_eq!(
            memo.first_charge("call_a", charge(0, false)),
            charge(0, false)
        );
        assert_eq!(
            memo.first_charge("call_a", charge(5_000, false)),
            charge(5_000, false)
        );
        // A replay that reports no cost (or a different one) is charged what
        // the first attempt was, so the ledger never sees two amounts.
        assert_eq!(
            memo.first_charge("call_a", charge(2_000, true)),
            charge(5_000, false)
        );
        assert_eq!(
            memo.first_charge("call_a", charge(0, false)),
            charge(5_000, false)
        );
        assert_eq!(
            memo.first_charge("call_b", charge(2_000, true)),
            charge(2_000, true),
            "another reference is its own charge"
        );
    }

    #[test]
    fn available_lists_builtin_first() {
        assert_eq!(
            ConnectionRegistry::new().available(),
            vec![BUILTIN.to_owned(), COMPOSIO.to_owned(), TREG.to_owned()]
        );
    }
}
