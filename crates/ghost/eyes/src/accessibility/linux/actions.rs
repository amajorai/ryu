// Portions adapted from vercel-labs/agent-desktop (Apache-2.0); modified.
//! Semantic element actions over AT-SPI. Never synthesizes input.
//!
//! The ladder is planned up front (`actions_state::plan`) and run here as an async
//! loop over `ChainState`: `before_step`, the rung, then `record`, and `finish`
//! when the rungs are exhausted.

use std::future::Future;
use std::ops::ControlFlow;
use std::time::{Duration, Instant};

use ::atspi::proxy::action::ActionProxy;
use ::atspi::proxy::component::ComponentProxy;
use ::atspi::proxy::editable_text::EditableTextProxy;
use ::atspi::proxy::selection::SelectionProxy;
use ::atspi::proxy::value::ValueProxy;
use ::atspi::zbus;
use ::atspi::{ObjectRefOwned, ScrollType};
use serde_json::{json, Value};

use super::super::chain::{ChainResult, ChainState};
use super::super::{
    ActionOptions, ActionOutcome, ElementAction, ElementLocator, ElementState, RendererA11y,
    StepOutcome, Verification, VerificationScope,
};
use super::actions_state::{
    pick_verb, plan, read_back_value, read_state, write_verdict, Expect, Rung, Verb,
};
use super::conn::{
    accessible, call_timed_out, element_gone, fault_of, proxy, verdict, within, Fault, Verdict,
};
use super::nav::resolve_live;
use crate::contract::{Delivery, ErrorCode, GhostError};

use StepOutcome::{DeliveredUnverified, DeliveredVerified, DeliveredWithoutEffect, NotDelivered};

const POLL_EVERY: Duration = Duration::from_millis(25);
const SETTLE: Duration = Duration::from_millis(300);
const TOGGLE_SETTLE: Duration = Duration::from_millis(600);
const FOCUS_SETTLE: Duration = Duration::from_millis(500);

/// Everything a rung needs about the resolved target.
struct Ctx<'a> {
    conn: &'a zbus::Connection,
    obj: &'a ObjectRefOwned,
    role: &'a str,
    secure: bool,
    verify: bool,
    deadline: Instant,
    before: &'a ElementState,
}

type Step = Result<StepOutcome, GhostError>;

fn unaddressable() -> GhostError {
    GhostError::internal("the element could not be addressed on the accessibility bus")
}

/// One `UnknownObject` follow-up: `GetRole` tells a vanished element from one that
/// merely lacks the interface.
async fn confirm_alive(c: &Ctx<'_>) -> Result<(), GhostError> {
    let proxy = accessible(c.conn, c.obj)
        .await
        .map_err(|_| element_gone())?;
    match within(c.deadline, proxy.get_role()).await {
        Some(Ok(_)) => Ok(()),
        Some(Err(e)) if matches!(fault_of(&e), Fault::UnknownObject | Fault::AppGone) => {
            Err(element_gone())
        }
        _ => Err(GhostError::timeout(
            "could not confirm that the element still exists",
            Delivery::NotDelivered,
        )),
    }
}

/// Runs a mutating call: `Some(v)` delivered, `None` not delivered (fall through),
/// `Err` per the fault table. A timeout after sending is uncertain delivery.
async fn act<T>(
    c: &Ctx<'_>,
    method: &'static str,
    fut: impl Future<Output = zbus::Result<T>>,
) -> Result<Option<T>, GhostError> {
    let Some(reply) = within(c.deadline, fut).await else {
        return Err(call_timed_out(method));
    };
    match reply {
        Ok(v) => Ok(Some(v)),
        Err(e) => match verdict(fault_of(&e), method) {
            Verdict::FallThrough => Ok(None),
            Verdict::Confirm => confirm_alive(c).await.map(|()| None),
            Verdict::Fail(err) => Err(err),
        },
    }
}

/// Polls the element state until `pred` holds or `window` (capped by the deadline) ends.
async fn wait_for(c: &Ctx<'_>, window: Duration, pred: impl Fn(&ElementState) -> bool) -> bool {
    let until = (Instant::now() + window).min(c.deadline);
    loop {
        let state = read_state(c.conn, c.obj, c.role, c.secure, c.deadline).await;
        if state.as_ref().is_some_and(&pred) {
            return true;
        }
        let now = Instant::now();
        if now >= until {
            return false;
        }
        tokio::time::sleep(POLL_EVERY.min(until - now)).await;
    }
}

/// Verified when `expect` shows up in time, else `DeliveredWithoutEffect`.
async fn settle(c: &Ctx<'_>, expect: Expect) -> StepOutcome {
    if !c.verify {
        return DeliveredUnverified;
    }
    let reached = match expect {
        Expect::Nothing => return DeliveredUnverified,
        Expect::Checked(t) => wait_for(c, TOGGLE_SETTLE, |s| s.checked == Some(t)).await,
        Expect::Expanded(t) => wait_for(c, SETTLE, |s| s.expanded == Some(t)).await,
        Expect::Selected => wait_for(c, SETTLE, |s| s.selected == Some(true)).await,
    };
    if reached {
        DeliveredVerified
    } else {
        DeliveredWithoutEffect
    }
}

/// At most this many actions are listed per element.
const MAX_ACTIONS: i32 = 32;

/// The machine (non-localized) action names, by index. `GetActions` carries the
/// localized display names ("Klicken"), which never match the machine verbs on a
/// non-English desktop, so each name comes from `GetName(i)`. An unreadable name
/// stays an empty slot so indices keep matching `DoAction`. `None` on timeout.
async fn machine_names(c: &Ctx<'_>, p: &ActionProxy<'_>) -> Option<zbus::Result<Vec<String>>> {
    let count = match within(c.deadline, p.n_actions()).await? {
        Ok(count) => count.clamp(0, MAX_ACTIONS),
        Err(e) => return Some(Err(e)),
    };
    let mut names = Vec::with_capacity(usize::try_from(count).unwrap_or(0));
    for index in 0..count {
        names.push(
            within(c.deadline, p.get_name(index))
                .await?
                .unwrap_or_default(),
        );
    }
    Some(Ok(names))
}

async fn verb(c: &Ctx<'_>, verbs: &'static [Verb], expect: Expect) -> (&'static str, Step) {
    const M: &str = "atspi.action";
    let Ok(p) = proxy::<ActionProxy<'_>>(c.conn, c.obj).await else {
        return (M, Err(unaddressable()));
    };
    let names: Vec<String> = match machine_names(c, &p).await {
        Some(Ok(names)) => names,
        Some(Err(e)) if matches!(fault_of(&e), Fault::UnknownObject | Fault::AppGone) => {
            if let Err(err) = confirm_alive(c).await {
                return (M, Err(err));
            }
            vec![]
        }
        Some(Err(_)) => vec![],
        None => {
            let err = GhostError::timeout(
                "listing the element's actions timed out",
                Delivery::NotDelivered,
            );
            return (M, Err(err));
        }
    };
    let Some((index, verb)) = pick_verb(&names, verbs) else {
        return (M, Ok(NotDelivered));
    };
    let step = match act(c, verb.method, p.do_action(index)).await {
        Ok(Some(true)) => Ok(settle(c, expect).await),
        Ok(_) => Ok(NotDelivered),
        Err(e) => Err(e),
    };
    (verb.method, step)
}

async fn grab_focus(c: &Ctx<'_>) -> Step {
    const M: &str = "atspi.Component.GrabFocus";
    let p = proxy::<ComponentProxy<'_>>(c.conn, c.obj)
        .await
        .map_err(|_| unaddressable())?;
    if act(c, M, p.grab_focus()).await? != Some(true) {
        return Ok(NotDelivered);
    }
    if c.verify && wait_for(c, FOCUS_SETTLE, |s| s.focused == Some(true)).await {
        return Ok(DeliveredVerified);
    }
    Ok(DeliveredUnverified)
}

/// Decides a delivered write by polling the value back (never for secure fields).
async fn read_back(c: &Ctx<'_>, requested: &str) -> StepOutcome {
    if c.secure || !c.verify {
        return DeliveredUnverified;
    }
    let before = c.before.value.as_deref();
    let until = (Instant::now() + SETTLE).min(c.deadline);
    loop {
        let after = read_back_value(c.conn, c.obj, c.role, requested, c.deadline).await;
        let verdict = write_verdict(c.role, requested, before, after.as_deref());
        let now = Instant::now();
        if verdict == DeliveredVerified || now >= until {
            return verdict;
        }
        tokio::time::sleep(POLL_EVERY.min(until - now)).await;
    }
}

async fn set_text(c: &Ctx<'_>, text: &str) -> Step {
    const M: &str = "atspi.EditableText.SetTextContents";
    let Ok(p) = proxy::<EditableTextProxy<'_>>(c.conn, c.obj).await else {
        return Ok(NotDelivered);
    };
    if act(c, M, p.set_text_contents(text)).await? != Some(true) {
        return Ok(NotDelivered);
    }
    Ok(read_back(c, text).await)
}

async fn set_number(c: &Ctx<'_>, text: &str) -> Step {
    const M: &str = "atspi.Value.SetCurrentValue";
    let Some(number) = text.trim().parse::<f64>().ok().filter(|n| n.is_finite()) else {
        return Ok(NotDelivered);
    };
    let Ok(p) = proxy::<ValueProxy<'_>>(c.conn, c.obj).await else {
        return Ok(NotDelivered);
    };
    if act(c, M, p.set_current_value(number)).await?.is_none() {
        return Ok(NotDelivered);
    }
    Ok(read_back(c, text).await)
}

async fn select_child(c: &Ctx<'_>, stateful: bool) -> Step {
    const M: &str = "atspi.Selection.SelectChild";
    let me = accessible(c.conn, c.obj)
        .await
        .map_err(|_| unaddressable())?;
    let (Some(Ok(parent)), Some(Ok(index))) = (
        within(c.deadline, me.parent()).await,
        within(c.deadline, me.get_index_in_parent()).await,
    ) else {
        return Ok(NotDelivered);
    };
    if parent.is_null() || index < 0 {
        return Ok(NotDelivered);
    }
    let Ok(selection) = proxy::<SelectionProxy<'_>>(c.conn, &parent).await else {
        return Ok(NotDelivered);
    };
    if act(c, M, selection.select_child(index)).await? != Some(true) {
        return Ok(NotDelivered);
    }
    if stateful {
        return Ok(settle(c, Expect::Selected).await);
    }
    if c.verify && wait_for(c, SETTLE, |s| s.selected == Some(true)).await {
        return Ok(DeliveredVerified);
    }
    Ok(DeliveredUnverified)
}

async fn scroll_to(c: &Ctx<'_>) -> Step {
    const M: &str = "atspi.Component.ScrollTo";
    let p = proxy::<ComponentProxy<'_>>(c.conn, c.obj)
        .await
        .map_err(|_| unaddressable())?;
    Ok(match act(c, M, p.scroll_to(ScrollType::Anywhere)).await? {
        Some(true) => DeliveredUnverified,
        _ => NotDelivered,
    })
}

async fn run_rung(c: &Ctx<'_>, rung: &Rung, action: &ElementAction) -> (&'static str, Step) {
    let value = match action {
        ElementAction::SetValue(v) => v.as_str(),
        _ => "",
    };
    match rung {
        Rung::Already => ("atspi.state", Ok(StepOutcome::Satisfied)),
        Rung::Verb { verbs, expect } => verb(c, verbs, *expect).await,
        Rung::GrabFocus => ("atspi.Component.GrabFocus", grab_focus(c).await),
        Rung::SetText => (
            "atspi.EditableText.SetTextContents",
            set_text(c, value).await,
        ),
        Rung::SetNumber => ("atspi.Value.SetCurrentValue", set_number(c, value).await),
        Rung::SelectChild { stateful } => (
            "atspi.Selection.SelectChild",
            select_child(c, *stateful).await,
        ),
        Rung::ScrollTo => ("atspi.Component.ScrollTo", scroll_to(c).await),
    }
}

/// An ignored write is ACTION_FAILED with `details.cause: "write_ignored"`.
fn mark_write_ignored(mut err: GhostError) -> GhostError {
    if err.code == ErrorCode::ActionFailed {
        match err.details.as_mut() {
            Some(Value::Object(map)) => {
                map.insert("cause".into(), json!("write_ignored"));
            }
            _ => err.details = Some(json!({ "cause": "write_ignored" })),
        }
    }
    err
}

async fn run_chain(
    c: &Ctx<'_>,
    action: &ElementAction,
    rungs: Vec<Rung>,
) -> Result<ChainResult, GhostError> {
    let mut chain = ChainState::new(c.deadline);
    for rung in &rungs {
        chain.before_step()?;
        let (method, step) = run_rung(c, rung, action).await;
        if let ControlFlow::Break(done) = chain.record(method, step) {
            return done;
        }
    }
    let exhausted = chain.finish();
    if matches!(action, ElementAction::SetValue(_)) {
        return exhausted.map_err(mark_write_ignored);
    }
    exhausted
}

fn verification_for(
    action: &ElementAction,
    outcome: StepOutcome,
    verify: bool,
    secure: bool,
) -> Verification {
    let (scope, reason) = if outcome == StepOutcome::Satisfied {
        (VerificationScope::AlreadyInState, None)
    } else if !verify {
        (VerificationScope::Skipped, Some("not_requested"))
    } else if matches!(action, ElementAction::SetValue(_)) && secure {
        (VerificationScope::Unavailable, Some("secure_field"))
    } else if outcome == DeliveredVerified {
        match action {
            ElementAction::SetValue(_) => (VerificationScope::ElementValue, None),
            _ => (VerificationScope::ElementState, None),
        }
    } else if !action.is_stateful() {
        (VerificationScope::Unavailable, Some("not_stateful"))
    } else {
        (
            VerificationScope::Unavailable,
            Some("insufficient_evidence"),
        )
    };
    Verification { scope, reason }
}

/// Resolves `locator` and performs `action` over one AT-SPI connection.
pub(crate) async fn perform(
    conn: &zbus::Connection,
    locator: &ElementLocator,
    action: &ElementAction,
    opts: &ActionOptions,
    deadline: Instant,
) -> Result<ActionOutcome, GhostError> {
    if *action == ElementAction::Focus && !opts.allow_focus_steal {
        return Err(GhostError::policy_denied(
            "focusing the element would steal focus, which this call does not allow",
        ));
    }
    let live = resolve_live(conn, locator, deadline).await?;
    let role = live.resolved.node.stable_role();
    let before = live.resolved.state.clone();
    let secure = live.resolved.node.secure;
    let rungs = plan(action, &role, &before, live.states, secure)?;
    let c = Ctx {
        conn,
        obj: &live.obj,
        role: &role,
        secure,
        verify: opts.verify,
        deadline,
        before: &before,
    };
    let result = run_chain(&c, action, rungs).await?;
    let verification = verification_for(action, result.outcome, opts.verify, secure);
    let after = if opts.verify {
        read_state(conn, &live.obj, &role, secure, deadline).await
    } else {
        None
    };
    Ok(ActionOutcome {
        action: action.name(),
        method: result.method,
        delivery: result.outcome.delivery(),
        verification,
        attempts: result.attempts,
        element: live.resolved,
        before: Some(before),
        after,
        renderer: RendererA11y::NotApplicable,
    })
}
