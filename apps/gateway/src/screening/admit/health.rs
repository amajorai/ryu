//! Backend health for the section 6 fail rules, and the rules themselves.
//!
//! Health is read once, before the request's own calls (a [`Snapshot`]), so a
//! request whose content derails a backend can never open that backend's
//! breaker mid-request and then be served in the degraded row it caused.

use std::collections::BTreeSet;

use ryu_gw_screening::{ChainVerdict, CodeSet, Role, ScreenTier, TaxonomyId};

use super::super::breaker::is_engine_outage;
use super::super::ActiveChain;
use super::{degraded_alert, floor_unscreenable, refuse, unavailable, ScreenReport, Surface};
use crate::error::GatewayError;
use crate::pipeline::RequestContext;
use crate::state::AppState;

/// Which backends' breakers were open when the request started.
#[derive(Debug, Clone, Default)]
pub(crate) struct Snapshot {
    open: BTreeSet<String>,
}

impl Snapshot {
    pub(crate) fn now(active: &ActiveChain) -> Self {
        Self {
            open: active
                .breakers
                .iter()
                .filter(|(_, backend)| !backend.breaker.allows())
                .map(|(id, _)| id.clone())
                .collect(),
        }
    }

    fn allows(&self, id: &str) -> bool {
        !self.open.contains(id)
    }

    /// Whether some backend in `role` covers `code`, may decide it under the
    /// active policy and had a closed breaker: a hard code it left undecided
    /// on this request is then a transient failure, not a coverage gap.
    pub(crate) fn healthy_source(
        &self,
        active: &ActiveChain,
        role: Role,
        code: TaxonomyId,
    ) -> bool {
        sources(active, role, code, false).any(|id| self.allows(id))
    }

    /// Whether every source of every code in `codes` was out for an engine
    /// outage: its breaker open before the request, or unreachable on it.
    /// A source that was healthy and still gave no verdict (a reply outside
    /// its grammar, a refusal, a timeout, a connection reset mid-request, an
    /// item too large to send) is not an outage: the content may have caused
    /// it.
    pub(crate) fn outage_only(
        &self,
        active: &ActiveChain,
        role: Role,
        verdict: &ChainVerdict,
        codes: &CodeSet,
    ) -> bool {
        codes.iter().all(|code| {
            sources(active, role, code, true).all(|id| {
                !self.allows(id)
                    || verdict
                        .outcomes
                        .iter()
                        .find(|outcome| outcome.backend.id == id)
                        .and_then(|outcome| outcome.error.as_ref())
                        .is_some_and(is_engine_outage)
            })
        })
    }
}

/// Ids of the backends in `role` that cover `code`, are permitted on the
/// tier and may decide `code` under the policy; with `reading`, only those
/// that read the role's items (text, or images for vision) at all.
fn sources<'a>(
    active: &'a ActiveChain,
    role: Role,
    code: TaxonomyId,
    reading: bool,
) -> impl Iterator<Item = &'a str> + 'a {
    active
        .chain
        .backends(role)
        .iter()
        .filter_map(move |backend| {
            let d = backend.descriptor();
            let reads = !reading
                || if role == Role::Vision {
                    d.images
                } else {
                    d.text
                };
            (reads
                && d.covers.contains(code)
                && backend.permits(active.tier)
                && active.policy().may_decide(&d.reference, code, active.tier))
            .then(|| d.id())
        })
}

/// Whether some backend in `role` may decide `code` at all (qualified at
/// floor tier), whatever its breaker says.
pub(super) fn qualified_source(active: &ActiveChain, role: Role, code: TaxonomyId) -> bool {
    active.chain.backends(role).iter().any(|backend| {
        let d = backend.descriptor();
        d.covers.contains(code)
            && backend.permits(active.tier)
            && active.policy().may_decide(&d.reference, code, active.tier)
    })
}

/// Whether the floor's degraded row decides this gateway's text right now:
/// floor tier, and some hard code has no healthy qualified text-hazard
/// backend (an open breaker, or no qualification record in the floor). The
/// regex floor then decides alone, plus the throttle (addendum section 6).
pub fn floor_degraded(state: &AppState) -> bool {
    if state.screening.tier(state.custody) != Some(ScreenTier::Floor) {
        return false;
    }
    let floor_screener = crate::platform_floor::binding_floor(state.custody, &state.platform_floor)
        .and_then(|floor| floor.screener.clone());
    let active = state.screening.active(ScreenTier::Floor, floor_screener);
    let snapshot = Snapshot::now(&active);
    active
        .policy()
        .hard_set()
        .iter()
        .any(|code| !snapshot.healthy_source(&active, Role::TextHazard, code))
}

/// Mark the verdict degraded. A hazard gap outranks a vision or prompt
/// attack marker; a prompt attack gap never hides another.
pub(super) fn mark(report: &mut ScreenReport, role: Role, marker: &'static str) {
    report.degraded = if role == Role::TextHazard {
        Some(marker)
    } else {
        report.degraded.or(Some(marker))
    };
}

/// What the fail rules need about the request.
pub(super) struct FailRule<'a> {
    pub state: &'a AppState,
    pub ctx: &'a RequestContext,
    pub surface: Surface,
    pub active: &'a ActiveChain,
    pub snapshot: &'a Snapshot,
}

impl FailRule<'_> {
    /// The section 6 rules for hard codes `role` left undecided. `marker` is
    /// the degraded marker the verdict carries (`t2` hazards, `t1` prompt
    /// attack). `Ok` serves the request in the degraded row.
    pub(super) fn hard_undecided(
        &self,
        role: Role,
        verdict: &ChainVerdict,
        undecided: &CodeSet,
        report: &mut ScreenReport,
        marker: &'static str,
    ) -> Result<(), GatewayError> {
        if undecided.is_empty() {
            return Ok(());
        }
        mark(report, role, marker);
        let (state, ctx, active) = (self.state, self.ctx, self.active);
        if active.tier != ScreenTier::Floor {
            // The node's own rule (`node_fail_mode`): only an outage of its
            // screener serves the request degraded when it fails closed.
            let closed = state.config.screening.node_fails_closed();
            if closed && !self.snapshot.outage_only(active, role, verdict, undecided) {
                return Err(refuse(
                    state,
                    ctx,
                    report,
                    unavailable("screener_incomplete"),
                ));
            }
            return Ok(());
        }
        let transient = undecided
            .iter()
            .any(|code| self.snapshot.healthy_source(active, role, code));
        if transient {
            return Err(refuse(
                state,
                ctx,
                report,
                unavailable("screener_incomplete"),
            ));
        }
        let none_qualified = !undecided
            .iter()
            .all(|code| qualified_source(active, role, code));
        degraded_alert(
            state,
            if none_qualified {
                "no_qualified_backend"
            } else {
                "breaker_open"
            },
        );
        // Media routes stay refused until a qualified backend is back (spec
        // 02.9): a permanent gap is a 403, an outage a 503.
        if self.surface.is_media() {
            let error = if none_qualified {
                floor_unscreenable()
            } else {
                unavailable("screener_degraded")
            };
            return Err(refuse(state, ctx, report, error));
        }
        // A subject above ladder Warn is refused outright in degraded mode,
        // never served at the degraded rate (spec 02.9).
        if crate::enforcement::is_above_warn(ctx) {
            return Err(refuse(state, ctx, report, unavailable("screener_degraded")));
        }
        let subject = ctx
            .org_id
            .clone()
            .unwrap_or_else(|| crate::audit::credential_log_id(&ctx.api_key));
        if let Err(retry_after_secs) = state.screening.throttle_request(&ctx.request_id, &subject) {
            return Err(refuse(
                state,
                ctx,
                report,
                GatewayError::ScreeningDegradedThrottle { retry_after_secs },
            ));
        }
        Ok(())
    }
}
