//! Violation events: the one verdict record (managed guardrails spec 03.4,
//! screener addendum section 11.1).
//!
//! A detection site describes what it found in a [`VerdictInput`] and hands
//! it to [`crate::state::AppState::record_violation`], which fills the
//! identity from the request context, redacts and bounds the excerpt, hashes
//! the evidence with the Gateway's keyed evidence hash, and writes the event
//! to the local outbox. The reporter (`reporter::violations`) drains the
//! outbox to `POST /api/abuse/ingest`.
//!
//! - `orgId` is the TENANT org from the request, never the reporting
//!   Gateway's. An event without one is kept locally and never sent, because
//!   the control plane cannot attribute it.
//! - `dedupeKey` is `{requestId}:{attempt}:{detectorId}:{category}`, built
//!   from the same values the event carries.
//! - `hazard.S4` never carries an excerpt; its evidence is the keyed hash
//!   only. A self-hosted node keeps no excerpt at all: its events reach the
//!   control plane only as a tenant-visible log, so no screened text leaves
//!   the node for them.
//! - `enforcement` is always `enforced`: Phase 2 has no shadow mode.

use std::sync::Arc;

use ryu_gw_firewall::taxonomy::evidence_excerpt_allowed;
use ryu_gw_screening::TaxonomyId;

use crate::audit::{
    dedupe_key, ActorKind, DetectorKind, DetectorRef, EnforcementAction, EnforcementMode, FailMode,
    PolicyLayer, PolicyRef, Severity, SpendOwner, ViolationDirection, ViolationEvent,
    ViolationOutbox,
};
use crate::custody::GatewayCustody;
use crate::firewall::DetectionKind;
use crate::identity::SubjectKind;
use crate::pipeline::RequestContext;

/// Longest text field the ingest route accepts for ids and hashes.
const MAX_ID_CHARS: usize = 128;
/// Longest agent, session, slot, model or request id the ingest route accepts.
const MAX_REF_CHARS: usize = 256;
/// Longest route tag the ingest route accepts.
const MAX_ROUTE_CHARS: usize = 64;
/// Most team ids one event carries.
const MAX_TEAMS: usize = 64;

/// Which attempt of a request a context screens (spec 00.5), stamped on the
/// violation events recorded under it: 0 and no provider for the primary's
/// inbound screen, the chain position and its bound provider for an output
/// screen, the round for a tool round. The inbound re-admission of a
/// fallback keeps 0, so the same body re-screened is one event, not two.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AttemptRef {
    pub index: u8,
    pub provider: Option<crate::config::ProviderId>,
}

impl AttemptRef {
    /// The attempt at chain position `index`, bound to `provider`.
    pub fn new(index: usize, provider: Option<crate::config::ProviderId>) -> Self {
        Self {
            index: u8::try_from(index).unwrap_or(u8::MAX),
            provider,
        }
    }
}

/// What a detection site found. Built with [`VerdictInput::classifier`] or
/// [`VerdictInput::regex`] and refined with the `with_*` methods.
#[derive(Debug, Clone)]
pub struct VerdictInput {
    /// 0 takes the request context's attempt (`RequestContext::violation_attempt`).
    pub attempt: u8,
    /// The provider the attempt was bound to, when the site knows it better
    /// than the context does.
    pub provider: Option<String>,
    pub category: TaxonomyId,
    pub detector: DetectorRef,
    pub confidence: Option<f32>,
    pub action: EnforcementAction,
    pub direction: ViolationDirection,
    pub layer: PolicyLayer,
    pub fail_mode: FailMode,
    pub screening_id: Option<String>,
    pub processor_id: Option<String>,
    /// The matched input. Never stored as given: it is hashed, and for a
    /// category that allows an excerpt it is redacted and cut to 2 KB first.
    pub evidence: Option<String>,
    /// The own-supply slot or vendor account the attempt spent, when known.
    pub slot_id: Option<String>,
    /// A severity the detection site sets itself, in place of the one the
    /// category and action imply (an upstream account warning is critical).
    pub severity: Option<Severity>,
}

impl VerdictInput {
    /// A hazard screener verdict from one backend.
    pub fn classifier(
        category: TaxonomyId,
        backend_id: &str,
        version: String,
        confidence: f32,
        action: EnforcementAction,
        direction: ViolationDirection,
        layer: PolicyLayer,
    ) -> Self {
        Self {
            attempt: 0,
            provider: None,
            category,
            detector: DetectorRef {
                kind: DetectorKind::Classifier,
                id: backend_id.to_owned(),
                version: Some(version),
            },
            confidence: Some(confidence.clamp(0.0, 1.0)),
            action,
            direction,
            layer,
            fail_mode: FailMode::ClassifierOk,
            screening_id: None,
            processor_id: None,
            evidence: None,
            slot_id: None,
            severity: None,
        }
    }

    /// A regex firewall match.
    pub fn regex(
        category: TaxonomyId,
        detector_id: &str,
        action: EnforcementAction,
        direction: ViolationDirection,
        layer: PolicyLayer,
    ) -> Self {
        Self {
            attempt: 0,
            provider: None,
            category,
            detector: DetectorRef {
                kind: DetectorKind::Regex,
                id: detector_id.to_owned(),
                version: None,
            },
            confidence: None,
            action,
            direction,
            layer,
            fail_mode: FailMode::NotApplicable,
            screening_id: None,
            processor_id: None,
            evidence: None,
            slot_id: None,
            severity: None,
        }
    }

    /// A model provider's own safety refusal of an attempt that spent a
    /// Ryu-held credential (spec 03.5.2). `row` is the safety-signal table
    /// row (or soft-signal id) that recognised it, so the detector id is
    /// stable and plain. The provider decided, so the layer is the platform
    /// and no excerpt is kept: the refused text stays with the request.
    pub fn upstream(
        category: TaxonomyId,
        row: &str,
        action: EnforcementAction,
        attempt: u8,
        provider: &str,
    ) -> Self {
        Self {
            attempt,
            provider: Some(provider.to_owned()),
            category,
            detector: DetectorRef {
                kind: DetectorKind::Upstream,
                id: row.to_owned(),
                version: None,
            },
            confidence: None,
            action,
            direction: ViolationDirection::Upstream,
            layer: PolicyLayer::Platform,
            fail_mode: FailMode::NotApplicable,
            screening_id: None,
            processor_id: None,
            evidence: None,
            slot_id: None,
            severity: None,
        }
    }

    pub fn with_slot(mut self, slot_id: Option<&str>) -> Self {
        self.slot_id = slot_id.map(str::to_owned);
        self
    }

    pub fn with_severity(mut self, severity: Severity) -> Self {
        self.severity = Some(severity);
        self
    }

    pub fn with_fail_mode(mut self, fail_mode: FailMode) -> Self {
        self.fail_mode = fail_mode;
        self
    }

    pub fn with_screening_id(mut self, screening_id: &str) -> Self {
        self.screening_id = (!screening_id.is_empty()).then(|| screening_id.to_owned());
        self
    }

    pub fn with_processor(mut self, processor_id: Option<&str>) -> Self {
        self.processor_id = processor_id.map(str::to_owned);
        self
    }

    pub fn with_evidence(mut self, text: &str) -> Self {
        self.evidence = (!text.trim().is_empty()).then(|| text.to_owned());
        self
    }
}

/// The taxonomy code for a regex firewall match (spec 03.4.1). A tenant
/// authored pattern is `content.custom_pattern` whatever kind it declares.
pub fn category_for_match(kind: &DetectionKind, tenant_pattern: bool) -> TaxonomyId {
    let custom = || TaxonomyId::parse("content.custom_pattern").unwrap_or(TaxonomyId::SECRET);
    if tenant_pattern {
        return custom();
    }
    let parsed = |id: &str| TaxonomyId::parse(id).unwrap_or_else(custom);
    match kind {
        DetectionKind::Pii => TaxonomyId::PII,
        DetectionKind::Secret => TaxonomyId::SECRET,
        DetectionKind::PromptInjection | DetectionKind::PromptAttack => {
            TaxonomyId::PROMPT_INJECTION
        }
        DetectionKind::CodeInjection => TaxonomyId::CODE_INJECTION,
        DetectionKind::Toxicity => TaxonomyId::TOXICITY,
        DetectionKind::Bias => parsed("content.bias"),
        DetectionKind::ExplicitImage => TaxonomyId::S12,
        DetectionKind::SensitiveImage => parsed("content.sensitive_image"),
        DetectionKind::Hazard(id) => *id,
    }
}

/// Record one inbound regex firewall match. A platform floor match names the
/// detection kind only (floor pattern names never leave Ryu); a tenant's own
/// pattern is `content.custom_pattern` under its pattern name. No excerpt is
/// captured: a regex match does not report the span it matched yet.
///
/// A floor match made while the classifier cannot decide the hard codes is
/// the section 6 degraded row, so its `failMode` is
/// `classifier_unavailable_regex_floor` (addendum 11.1). Returns the event id
/// the live feed verdict joins on.
pub(crate) fn record_firewall_match(
    state: &crate::state::AppState,
    ctx: &RequestContext,
    violation: &crate::firewall::FirewallMatch,
    layers: &crate::traffic::FirewallLayers,
    action: EnforcementAction,
) -> Option<String> {
    let decided_by = crate::traffic::firewall_layer(&violation.pattern_name, layers);
    let declared = |names: &[String]| names.iter().any(|name| *name == violation.pattern_name);
    let tenant_pattern = !declared(&layers.floor_patterns)
        && (declared(&layers.org_patterns)
            || declared(&layers.agent_patterns)
            || declared(&layers.node_patterns));
    let detector = if decided_by == crate::traffic::DecidedBy::PlatformFloor || !tenant_pattern {
        violation.kind.as_str()
    } else {
        violation.pattern_name.as_str()
    };
    let detector =
        bounded(Some(detector), MAX_ID_CHARS).unwrap_or_else(|| violation.kind.as_str().to_owned());
    let floor_degraded = decided_by == crate::traffic::DecidedBy::PlatformFloor
        && crate::screening::admit::floor_degraded(state);
    let fail_mode = if floor_degraded {
        FailMode::ClassifierUnavailableRegexFloor
    } else {
        FailMode::NotApplicable
    };
    state.record_violation(
        ctx,
        VerdictInput::regex(
            category_for_match(&violation.kind, tenant_pattern),
            &detector,
            action,
            ViolationDirection::Inbound,
            layer_for(decided_by),
        )
        .with_fail_mode(fail_mode),
    )
}

/// The event direction for a screened role direction.
pub const fn direction_of(direction: ryu_gw_screening::Direction) -> ViolationDirection {
    use ryu_gw_screening::Direction;
    match direction {
        Direction::Inbound => ViolationDirection::Inbound,
        Direction::Outbound => ViolationDirection::Outbound,
        Direction::ToolArgs => ViolationDirection::ToolArgs,
        Direction::ToolResult => ViolationDirection::ToolResult,
        Direction::MediaInput => ViolationDirection::MediaInput,
        Direction::MediaOutput => ViolationDirection::MediaOutput,
    }
}

/// The policy layer a traffic verdict was decided by.
pub fn layer_for(decided_by: crate::traffic::DecidedBy) -> PolicyLayer {
    use crate::traffic::DecidedBy;
    match decided_by {
        DecidedBy::PlatformFloor => PolicyLayer::Platform,
        DecidedBy::Org => PolicyLayer::Org,
        DecidedBy::Agent => PolicyLayer::Agent,
        _ => PolicyLayer::Node,
    }
}

/// Whose credential the attempt spent (spec 00.6).
///
/// Attempts do not carry a `CredentialOrigin` yet, so this follows custody
/// the way the live feed does: on the fleet every tenant attempt is floor
/// bound (decision D9) and spends Ryu's credentials, including one blocked
/// before an upstream was bound; the passthrough routes forward the caller's
/// own subscription. A managed node spends the keys Core injected. A
/// self-hosted node spends its operator's keys and is never bound by Ryu's
/// floor, so its events never count toward Ryu strikes.
pub fn spend_for(custody: GatewayCustody, route: Option<&str>) -> SpendOwner {
    if route.is_some_and(|route| route.starts_with("/passthrough/")) {
        return SpendOwner::Tenant;
    }
    match custody {
        GatewayCustody::Fleet | GatewayCustody::ManagedNode => SpendOwner::Ryu,
        GatewayCustody::SelfHosted => SpendOwner::Tenant,
    }
}

/// Whether excerpts are captured on `custody`. Only Ryu-run custody does:
/// its events feed Ryu's own enforcement and evidence review.
const fn keeps_excerpts(custody: GatewayCustody) -> bool {
    matches!(custody, GatewayCustody::Fleet | GatewayCustody::ManagedNode)
}

fn severity_for(category: TaxonomyId, action: EnforcementAction) -> Severity {
    if category == TaxonomyId::S4 {
        return Severity::Critical;
    }
    match action {
        EnforcementAction::Blocked
        | EnforcementAction::StreamTerminated
        | EnforcementAction::BlockedUpstream
        | EnforcementAction::LocalUpstreamBlock => Severity::High,
        EnforcementAction::Redacted
        | EnforcementAction::Throttled
        | EnforcementAction::RefusedUpstream => Severity::Medium,
        EnforcementAction::LoggedOnly => {
            if category.branch() == "hazard" {
                Severity::Medium
            } else {
                Severity::Low
            }
        }
    }
}

const fn actor_kind(kind: SubjectKind) -> ActorKind {
    match kind {
        SubjectKind::User => ActorKind::User,
        SubjectKind::ForwardedUser => ActorKind::ForwardedUser,
        SubjectKind::EndUser => ActorKind::EndUser,
        SubjectKind::Credential => ActorKind::Credential,
        SubjectKind::Org => ActorKind::Org,
        SubjectKind::Node => ActorKind::Node,
    }
}

/// A value the ingest route accepts in a bounded text field, or `None`.
fn bounded(value: Option<&str>, max: usize) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.chars().count() <= max)
        .map(str::to_owned)
}

/// The actor and its reference. The ingest route needs a non-empty
/// reference, so an identity whose actor has none falls back to the
/// credential, then the org, then the node.
fn actor_of(ctx: &RequestContext, credential_id: Option<&str>) -> (ActorKind, String) {
    if let Some(actor) = ctx.identity.as_ref().map(|identity| &identity.actor) {
        if let Some(subject) = bounded(Some(&actor.subject_ref), MAX_REF_CHARS) {
            return (actor_kind(actor.kind), subject);
        }
    }
    if let Some(credential) = credential_id {
        return (ActorKind::Credential, credential.to_owned());
    }
    if let Some(org) = bounded(ctx.org_id.as_deref(), MAX_REF_CHARS) {
        return (ActorKind::Org, org);
    }
    (ActorKind::Node, "node".to_owned())
}

/// Whitespace collapsed and lowercased, so trivially different spellings of
/// one input hash alike.
fn normalize(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Build the event and its excerpt for `input`. Pure apart from the clock and
/// the event id, so the identity and evidence rules are unit tested.
///
/// `route` is the matched route template the caller resolved: the handler's
/// while it is in scope, else the one the request noted before a stream it
/// returned is cut.
pub(crate) fn build_event(
    custody: GatewayCustody,
    keys: &crate::identity::IdentityKeys,
    redact: &dyn Fn(&str) -> String,
    ctx: &RequestContext,
    route: Option<String>,
    input: VerdictInput,
) -> (ViolationEvent, Option<String>) {
    let event_id = uuid::Uuid::now_v7().to_string();
    let category = input.category.as_str().to_owned();
    let request_id = ctx.request_id.clone();
    let identity = ctx.identity.as_deref();
    let credential = identity.and_then(|identity| identity.credential.as_deref());
    let credential_id = bounded(ctx.key_id().as_deref(), MAX_ID_CHARS);
    let (actor_kind, actor_ref) = actor_of(ctx, credential_id.as_deref());
    // Spec 00.5: the primary is attempt 0, a fallback or a tool round 1 and
    // up. A detection site that names no attempt takes the context's.
    let attempt = if input.attempt == 0 {
        ctx.violation_attempt.index
    } else {
        input.attempt
    };
    let provider = input
        .provider
        .as_deref()
        .or(ctx.violation_attempt.provider.as_ref().map(|p| p.as_str()))
        .or(ctx.slot_provider.as_ref().map(|p| p.as_str()));
    let teams: Vec<String> = ctx
        .org_limits
        .as_ref()
        .map(|limits| limits.team_ids.clone())
        .filter(|teams| !teams.is_empty())
        .or_else(|| ctx.team_id.clone().map(|team| vec![team]))
        .unwrap_or_default()
        .into_iter()
        .filter_map(|team| bounded(Some(&team), MAX_ID_CHARS))
        .take(MAX_TEAMS)
        .collect();
    let evidence_hmac = input
        .evidence
        .as_deref()
        .map(|text| keys.evidence_hmac(&normalize(text)));
    let excerpt = input
        .evidence
        .as_deref()
        .filter(|_| evidence_excerpt_allowed(input.category) && keeps_excerpts(custody))
        .map(|text| {
            crate::audit::violation::truncate_bytes(
                &redact(text),
                crate::audit::violation::MAX_EXCERPT_BYTES,
            )
            .to_owned()
        })
        .filter(|text| !text.trim().is_empty());
    let event = ViolationEvent {
        dedupe_key: dedupe_key(&request_id, attempt, &input.detector.id, &category),
        event_id,
        occurred_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        request_id,
        attempt,
        org_id: bounded(ctx.org_id.as_deref(), MAX_ID_CHARS),
        credential_id,
        custodian_user_id: credential
            .and_then(|c| c.owner_user_id.as_deref().or(c.created_by.as_deref()))
            .and_then(|id| bounded(Some(id), MAX_ID_CHARS)),
        actor_user_id: bounded(
            identity.and_then(|i| i.actor_user_id.as_deref()),
            MAX_ID_CHARS,
        ),
        forwarded_user_hash: bounded(
            identity.and_then(|i| i.forwarded_user_hash.as_deref()),
            MAX_ID_CHARS,
        ),
        end_user_hash: bounded(
            identity.and_then(|i| i.end_user_hash.as_deref()),
            MAX_ID_CHARS,
        ),
        previous_end_user_hash: None,
        actor_kind,
        actor_ref,
        upstream_subject: bounded(
            identity.and_then(|i| i.upstream_subject.as_deref()),
            MAX_ID_CHARS,
        ),
        team_ids: teams,
        agent_id: bounded(ctx.agent_id.as_deref(), MAX_REF_CHARS),
        session_id: bounded(ctx.session_id.as_deref(), MAX_REF_CHARS),
        route: bounded(route.as_deref(), MAX_ROUTE_CHARS).unwrap_or_else(|| "unknown".to_owned()),
        provider: bounded(provider, MAX_ID_CHARS),
        slot_id: bounded(input.slot_id.as_deref(), MAX_REF_CHARS),
        model: bounded(ctx.slot_model.as_deref(), MAX_REF_CHARS),
        upstream_request_id: None,
        spend: spend_for(custody, route.as_deref()),
        category,
        severity: input
            .severity
            .unwrap_or_else(|| severity_for(input.category, input.action)),
        confidence: input.confidence,
        action: input.action,
        direction: input.direction,
        policy: Some(PolicyRef {
            policy_id: None,
            assignment_id: None,
            layer: input.layer,
        }),
        fail_mode: input.fail_mode,
        enforcement: EnforcementMode::Enforced,
        impersonated_by: None,
        processor_id: bounded(input.processor_id.as_deref(), MAX_ID_CHARS),
        screening_id: bounded(input.screening_id.as_deref(), MAX_ID_CHARS),
        evidence_ref: None,
        evidence_hmac,
        detector: input.detector,
    };
    (event, excerpt)
}

/// How often the outbox expires excerpts and applies its caps.
pub const MAINTENANCE_EVERY: std::time::Duration = std::time::Duration::from_secs(600);

/// Run outbox upkeep on its own interval, whether or not a control plane
/// is configured, so excerpts expire and the caps hold on a node that never
/// reports.
pub fn spawn_maintenance(state: crate::state::SharedState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(MAINTENANCE_EVERY);
        loop {
            interval.tick().await;
            if let Err(error) = state.violations.maintain() {
                tracing::warn!("violation outbox maintenance failed: {error}");
            }
        }
    });
}

/// The outbox beside the audit database (`violations.db`), or in memory
/// when auditing is disabled and no data directory exists to sit in.
pub fn outbox_beside(audit_db_path: Option<&str>) -> Result<Arc<ViolationOutbox>, String> {
    let outbox = match audit_db_path {
        Some(path) => {
            ViolationOutbox::open(&std::path::Path::new(path).with_file_name("violations.db"))
        }
        None => ViolationOutbox::in_memory(),
    };
    outbox
        .map(Arc::new)
        .map_err(|error| format!("violation outbox initialization failed: {error}"))
}

/// A tenant request context for tests: a 24-hex org, a resolved credential
/// and a credential actor, as an `rgw_` request carries them.
#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::Arc;

    use crate::identity::{Actor, CredentialIdentity, RequestIdentity, SubjectKind};
    use crate::pipeline::RequestContext;

    pub const TENANT_ORG: &str = "6650c0a1b2c3d4e5f6a7b8c9";
    pub const TENANT_CREDENTIAL: &str = "6650c0a1b2c3d4e5f6a7b8d0";
    pub const CREDENTIAL_OWNER: &str = "6650c0a1b2c3d4e5f6a7b8d1";

    pub fn tenant_ctx(request_id: &str) -> RequestContext {
        let mut ctx = crate::pipeline::test_support::plain_request_context();
        ctx.request_id = request_id.to_owned();
        ctx.org_id = Some(TENANT_ORG.to_owned());
        let credential = Arc::new(CredentialIdentity {
            credential_id: TENANT_CREDENTIAL.to_owned(),
            node_id: None,
            team_id: None,
            owner_user_id: Some(CREDENTIAL_OWNER.to_owned()),
            created_by: None,
            service_account_id: None,
            serves_end_users: false,
            purpose: "gateway_relay".to_owned(),
        });
        let mut identity = RequestIdentity::from_credential(Some(credential), 1);
        identity.actor = Actor {
            kind: SubjectKind::Credential,
            subject_ref: TENANT_CREDENTIAL.to_owned(),
        };
        identity.end_user_hash = Some("eu1.1.0123456789abcdef0123456789abcdef".to_owned());
        ctx.identity = Some(Arc::new(identity));
        ctx
    }
}

#[cfg(test)]
#[path = "violations_tests.rs"]
mod tests;
