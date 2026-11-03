//! One admission screen: media pre-checks, the role calls, the decision
//! matrix, violation events and the section 6 fail rules.

use std::collections::BTreeMap;
use std::time::Instant;

use ryu_gw_screening::{
    BackendError, ChainVerdict, CodeSet, Direction, LeafClass, Role, ScreenItem, ScreenRequest,
    ScreenTier, SegmentKey, TaxonomyId,
};

use super::health::{mark, qualified_source, FailRule, Snapshot};
use super::items::{items_for, items_for_budget};
use super::{
    floor_unscreenable, new_screening_id, note, refuse, unavailable, MediaPart, ScreenInput,
    ScreenReport, Surface, MAX_ITEMS,
};
use crate::error::{ContentBlock, ContentBlockLayer, GatewayError};
use crate::pipeline::RequestContext;
use crate::screening::policy::CodeAction;
use crate::screening::{short_code, ActiveChain};
use crate::state::AppState;
use crate::traffic::{DecidedBy, VerdictAction};

/// Role items past this many are refused like [`MAX_ITEMS`] text items: a
/// role whose backends read smaller items cuts the same text finer.
const MAX_ROLE_ITEMS: usize = MAX_ITEMS * 8;

/// The highest composed score per code across verdicts.
fn scores_of(verdicts: &[&ChainVerdict]) -> BTreeMap<TaxonomyId, (f32, String)> {
    let mut scores: BTreeMap<TaxonomyId, (f32, String)> = BTreeMap::new();
    for verdict in verdicts {
        for item in &verdict.items {
            for (code, score) in &item.scores {
                let source = item.sources.get(code).cloned().unwrap_or_default();
                let slot = scores.entry(*code).or_insert((*score, source.clone()));
                if *score > slot.0 {
                    *slot = (*score, source);
                }
            }
        }
    }
    scores
}

/// The smallest item a `role` backend on this tier reads.
fn role_budget(active: &ActiveChain, role: Role) -> Option<u32> {
    active
        .chain
        .backends(role)
        .iter()
        .filter(|backend| backend.permits(active.tier))
        .map(|backend| backend.descriptor().max_item_tokens)
        .min()
}

fn timed_out(verdict: Option<&ChainVerdict>) -> bool {
    verdict.is_some_and(|v| {
        v.outcomes
            .iter()
            .any(|o| o.error == Some(BackendError::Timeout))
    })
}

pub(super) async fn run(
    state: &AppState,
    ctx: &RequestContext,
    surface: Surface,
    input: ScreenInput,
    active: &ActiveChain,
) -> Result<ScreenReport, GatewayError> {
    let runtime = &state.screening;
    let tier = active.tier;
    let floor = tier == ScreenTier::Floor;
    let screener = &active.screener;
    // Health as it was before this request's own calls (see `health`).
    let snapshot = Snapshot::now(active);
    let mut report = ScreenReport {
        tier: Some(if floor { "floor" } else { "node" }),
        screening_id: new_screening_id(),
        ..ScreenReport::default()
    };
    let (layer, decided_by) = if floor {
        (ContentBlockLayer::Platform, DecidedBy::PlatformFloor)
    } else {
        (ContentBlockLayer::Node, DecidedBy::Node)
    };
    let scope = runtime.scope_key(ctx.org_id.as_deref());
    // On the fleet one tenant's items queue on its own gate before the shared
    // one, so a request with hundreds of cache-miss items cannot hold every
    // permit and starve other tenants' screening into their deadlines.
    let share = floor.then(|| {
        runtime.scope_key(Some(
            &ctx.org_id
                .clone()
                .unwrap_or_else(|| crate::audit::credential_log_id(&ctx.api_key)),
        ))
    });
    let deadline = Instant::now() + surface.deadline(screener);

    // Media first, before any backend call: a permanent coverage gap is a
    // 403, an outage of a qualified vision backend a 503 (D11).
    let mut image_items = Vec::new();
    if !input.media.is_empty() {
        let unscreenable = input
            .media
            .iter()
            .any(|m| matches!(m, MediaPart::Unscreenable));
        if floor {
            if unscreenable || !qualified_source(active, Role::Vision, TaxonomyId::S4) {
                return Err(refuse(state, ctx, &report, floor_unscreenable()));
            }
            if !snapshot.healthy_source(active, Role::Vision, TaxonomyId::S4) {
                let error = unavailable("vision_unavailable");
                return Err(refuse(state, ctx, &report, error));
            }
        }
        for part in &input.media {
            if let MediaPart::Image(image) = part {
                let key = SegmentKey::for_image(&scope, LeafClass::User, &image.sha256);
                image_items.push(ScreenItem::image(key, LeafClass::User, image.clone()));
            }
        }
        if !floor && active.chain.backends(Role::Vision).is_empty() {
            report.degraded = Some("vision");
            image_items.clear();
        }
    }

    // Past the item limit the request is refused on both tiers: dropping
    // the tail would leave the newest turn and the decoded forms unread.
    // The text items are counted before the prompt-attack items are cut, so
    // an oversized request is refused before any further work.
    let items = items_for(&scope, &input);
    if items.len() > MAX_ITEMS {
        let error = GatewayError::ScreeningCapacityExceeded;
        return Err(refuse(state, ctx, &report, error));
    }
    let attack_items = match role_budget(active, Role::PromptAttack) {
        Some(budget) if !items.is_empty() => items_for_budget(&scope, &input, &items, budget),
        _ => Vec::new(),
    };
    if attack_items.len() > MAX_ROLE_ITEMS {
        let error = GatewayError::ScreeningCapacityExceeded;
        return Err(refuse(state, ctx, &report, error));
    }

    let hazards = CodeSet::hazards();
    let attack = CodeSet::from([TaxonomyId::PROMPT_INJECTION]);
    let correlation = ctx.request_id.as_str();
    let request = |items, wanted, direction, deadline| ScreenRequest {
        correlation_id: correlation,
        direction,
        tier,
        items,
        wanted,
        deadline,
    };
    let text_verdict = if items.is_empty() {
        None
    } else {
        let req = request(&items, &hazards, surface.direction(), deadline);
        Some(active.chain.screen_for(Role::TextHazard, &req, share).await)
    };
    // Prompt attack runs after the hazard role, so a backend that serves both
    // (the decision model) answers from the cache the first call filled.
    let attack_verdict = if attack_items.is_empty() {
        None
    } else {
        let req = request(&attack_items, &attack, surface.direction(), deadline);
        Some(
            active
                .chain
                .screen_for(Role::PromptAttack, &req, share)
                .await,
        )
    };
    // Vision has its own budget, started when the image call starts: a VLM
    // call cannot finish in what the text roles left of the chat deadline, and
    // an image the classifier never answered must not pass (section 6).
    let vision_deadline = Instant::now()
        + surface
            .deadline(screener)
            .max(Surface::Media.deadline(screener));
    let vision_verdict = if image_items.is_empty() {
        None
    } else {
        let req = request(
            &image_items,
            &hazards,
            Direction::MediaInput,
            vision_deadline,
        );
        Some(active.chain.screen_for(Role::Vision, &req, share).await)
    };
    let verdicts: Vec<&ChainVerdict> = [&text_verdict, &attack_verdict, &vision_verdict]
        .into_iter()
        .flatten()
        .collect();
    for verdict in &verdicts {
        for processor in &verdict.processors {
            if !report.processors.contains(processor) {
                report.processors.push(processor.clone());
            }
        }
    }

    // The matrix (spec 02.6.4): Block wins. At ladder L3 the matrix is
    // strict (spec 04.8.1): every flagged code blocks.
    let adult = screener.adult_permitted(input.model.as_deref());
    let strict = floor && crate::enforcement::is_restricted(ctx);
    // A forged chat-template turn in untrusted text scores prompt injection
    // whatever the classifier said: the classifier reads the same tokens.
    let mut scores = scores_of(&verdicts);
    super::template::score_forged_turns(surface, &input, &mut scores);
    let forged = super::template::forged_turn_detection(surface, &input, &scores);
    for (code, (score, source)) in scores {
        let rule = screener.rule(code);
        let action = crate::enforcement::strict(
            rule.decide(score, adult && code == TaxonomyId::S12),
            strict,
        );
        match action {
            CodeAction::Block => report.blocked.push(code),
            CodeAction::Flag => report.flagged.push(code),
            CodeAction::Allow => continue,
        }
        report.detections.push((code, source));
    }
    // One violation event per flagged or blocked code per detector (G5),
    // before any early return so a block still records the flags beside it.
    let mut blocked_event = false;
    for (verdict, scanned, direction) in [
        (&text_verdict, &items, surface.direction()),
        (&attack_verdict, &attack_items, surface.direction()),
        (&vision_verdict, &image_items, Direction::MediaInput),
    ] {
        let Some(verdict) = verdict else {
            continue;
        };
        let detections = super::super::detections_of(screener, verdict, scanned, adult);
        let recorded = super::super::record_detections(
            state,
            ctx,
            active,
            &detections,
            &report.blocked,
            crate::audit::EnforcementAction::Blocked,
            direction,
            &report.screening_id,
        );
        // A block outranks a flag recorded by an earlier role.
        let is_block = detections.iter().any(|d| report.blocked.contains(&d.code));
        if (report.event_id.is_none() || (is_block && !blocked_event)) && recorded.is_some() {
            report.event_id = recorded;
            blocked_event = is_block;
        }
    }
    // The template-token detector's own event, when its score decided.
    if let Some(detection) =
        forged.filter(|d| report.blocked.contains(&d.code) || report.flagged.contains(&d.code))
    {
        let recorded = super::super::record_detections(
            state,
            ctx,
            active,
            std::slice::from_ref(&detection),
            &report.blocked,
            crate::audit::EnforcementAction::Blocked,
            surface.direction(),
            &report.screening_id,
        );
        let is_block = report.blocked.contains(&detection.code);
        if (report.event_id.is_none() || (is_block && !blocked_event)) && recorded.is_some() {
            report.event_id = recorded;
        }
    }
    if !report.blocked.is_empty() {
        let block = ContentBlock {
            layer,
            output: false,
            categories: report.blocked.iter().map(|c| short_code(*c)).collect(),
            screening_id: report.screening_id.clone(),
            charged_micro_usd: None,
        };
        note(state, ctx, decided_by, VerdictAction::Block, &report);
        tracing::warn!(
            request_id = %ctx.request_id,
            categories = ?block.categories,
            tier = report.tier.unwrap_or(""),
            "screening: blocked before dispatch"
        );
        state.metrics.inc_firewall_blocked();
        return Err(GatewayError::ContentBlocked(Box::new(block)));
    }

    let rules = FailRule {
        state,
        ctx,
        surface,
        active,
        snapshot: &snapshot,
    };
    // An image a qualified vision backend left undecided (timeout, outage)
    // is never forwarded unscreened: the floor refuses it with a 503, since a
    // qualified source exists and failed this request (section 6). A node
    // that fails closed refuses it unless its vision engine is out. A hard
    // code no qualified vision backend covers is the pre-check's concern.
    if let Some(verdict) = &vision_verdict {
        let undecided: CodeSet = verdict
            .undecided_hard(active.policy())
            .iter()
            .filter(|code| qualified_source(active, Role::Vision, *code))
            .collect();
        if !undecided.is_empty() {
            report.degraded = Some("vision");
            let node_closed = !floor
                && state.config.screening.node_fails_closed()
                && !snapshot.outage_only(active, Role::Vision, verdict, &undecided);
            if floor || node_closed {
                let error = unavailable("vision_unavailable");
                return Err(refuse(state, ctx, &report, error));
            }
        }
    }

    // Undecided hard codes, hazards then prompt attack: the section 6 fail
    // rules. A soft code left undecided only marks the verdict degraded, so
    // the gap is visible on the feed (`t2` hazards, `t1` prompt attack).
    let hard = active.policy().hard_set();
    for (role, verdict, marker) in [
        (Role::TextHazard, &text_verdict, "t2"),
        (Role::PromptAttack, &attack_verdict, "t1"),
    ] {
        let Some(verdict) = verdict else {
            continue;
        };
        let undecided = verdict.undecided();
        let undecided_hard = undecided.intersection(&hard);
        rules.hard_undecided(role, verdict, &undecided_hard, &mut report, marker)?;
        if undecided_hard.is_empty() && !undecided.is_empty() {
            mark(&mut report, role, marker);
        }
    }
    let late = timed_out(text_verdict.as_ref()) || timed_out(attack_verdict.as_ref());
    if late && report.degraded.is_some() {
        report.degraded = Some("deadline");
    }

    let action = if report.flagged.is_empty() {
        VerdictAction::Allow
    } else {
        VerdictAction::Warn
    };
    if action > VerdictAction::Allow || report.degraded.is_some() {
        note(state, ctx, decided_by, action, &report);
    }
    Ok(report)
}
