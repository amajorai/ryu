// Portions adapted from vercel-labs/agent-desktop (Apache-2.0); modified.
//! Semantic action chains over AXUIElement. Never synthesizes HID input.

use std::time::{Duration, Instant};

use super::super::chain::{run_chain, ChainResult, Rung};
use super::super::{ActionOptions, ActionOutcome, ElementAction, ElementLocator, RendererA11y};
use super::super::{StepOutcome, Verification, VerificationScope, WalkLimits};
use super::actions_state::*;
use super::attr::*;
use super::ax_error::ReadBack;
use super::ax_error::{classify_perform, classify_set, uninformative_outcome, PerformClass};
use super::cf::{cf_array_of, cf_boolean, cf_number, CfRef};
use super::electron;
use super::nav::resolve_live;
use super::snapshot::{acquire, walk_root};
use super::walk::has_selected_state;
use crate::contract::{Delivery, GhostError};

const PRESS_SELECT_WINDOW: Duration = Duration::from_millis(300);
const TOGGLE_INTERVAL: Duration = Duration::from_millis(25);
const TOGGLE_WINDOW: Duration = Duration::from_millis(600);
const EXPAND_INTERVAL: Duration = Duration::from_millis(20);
const EXPAND_WINDOW: Duration = Duration::from_millis(300);
const MENU_WINDOW: Duration = Duration::from_millis(600);
const SETTLE_INTERVAL: Duration = Duration::from_millis(25);
const SETTLE_WINDOW: Duration = Duration::from_millis(300);
const RENDERER_WALK_BUDGET: Duration = Duration::from_secs(1);

/// The resolved element and the session handles every rung shares.
struct Ctx<'a> {
    el: &'a CfRef,
    app: &'a CfRef,
    role_key: String,
    deadline: Instant,
}

impl Ctx<'_> {
    fn poll(
        &self,
        interval: Duration,
        window: Duration,
        target: bool,
        read: impl FnMut() -> Option<bool>,
    ) -> Option<bool> {
        poll_state(self.deadline, interval, window, target, read)
    }
}

/// An `AXUIElementPerformAction` rung. `effect` reports the observable result:
/// reached `Some(true)`, a known other state `Some(false)`, unknown `None`.
fn perform_rung<'a>(
    ctx: &'a Ctx<'a>,
    action: &'static str,
    strict_guard: bool,
    effect: impl Fn() -> Option<bool> + 'a,
) -> Rung<'a> {
    Rung {
        method: action,
        run: Box::new(move || {
            let allowed = if strict_guard {
                advertises(ctx.el, action)
            } else {
                may_perform(ctx.el, action)
            };
            if !allowed {
                return Ok(StepOutcome::NotDelivered);
            }
            set_timeout(ctx.el, ctx.deadline);
            let code = perform(ctx.el, action);
            match classify_perform(code, action) {
                PerformClass::Success => Ok(match effect() {
                    Some(true) => StepOutcome::DeliveredVerified,
                    Some(false) => StepOutcome::DeliveredWithoutEffect,
                    None => StepOutcome::DeliveredUnverified,
                }),
                PerformClass::Unsupported => Ok(StepOutcome::NotDelivered),
                PerformClass::Uninformative => {
                    uninformative_outcome(code, action, effect() == Some(true))
                }
                PerformClass::Error(e) => Err(e),
            }
        }),
    }
}

/// A settable-attribute rung: `write` returns the AXError, `readback` decides.
fn set_rung<'a>(
    ctx: &'a Ctx<'a>,
    attr: &'static str,
    write: impl Fn() -> i32 + 'a,
    readback: impl Fn() -> ReadBack + 'a,
) -> Rung<'a> {
    Rung {
        method: attr,
        run: Box::new(move || {
            if !is_settable(ctx.el, attr) {
                return Ok(StepOutcome::NotDelivered);
            }
            set_timeout(ctx.el, ctx.deadline);
            let code = write();
            classify_set(code, readback(), attr)
        }),
    }
}

fn satisfied() -> ChainResult {
    ChainResult {
        method: "none",
        outcome: StepOutcome::Satisfied,
        attempts: Vec::new(),
    }
}

fn press(ctx: &Ctx<'_>) -> Result<ChainResult, GhostError> {
    let selectable = has_selected_state(&ctx.role_key);
    let selected_effect = move || {
        if !selectable {
            return None;
        }
        let seen = ctx.poll(SETTLE_INTERVAL, PRESS_SELECT_WINDOW, true, || {
            attr_bool(ctx.el, "AXSelected")
        });
        effect_of(seen, true)
    };
    run_chain(
        vec![
            perform_rung(ctx, "AXPress", false, selected_effect),
            perform_rung(ctx, "AXConfirm", false, || None),
            perform_rung(ctx, "AXOpen", false, || None),
            perform_rung(ctx, "AXPick", false, || None),
        ],
        ctx.deadline,
    )
}

fn focus(ctx: &Ctx<'_>) -> Result<ChainResult, GhostError> {
    if attr_bool(ctx.el, "AXFocused") == Some(true) {
        return Ok(satisfied());
    }
    let readback = || {
        let seen = ctx.poll(SETTLE_INTERVAL, SETTLE_WINDOW, true, || {
            focus_reached(ctx.app, ctx.el, ctx.deadline)
        });
        bool_readback(seen, true)
    };
    let write = || set_attr(ctx.el, "AXFocused", cf_boolean(true));
    run_chain(
        vec![set_rung(ctx, "AXFocused", write, readback)],
        ctx.deadline,
    )
}

fn set_value(
    ctx: &Ctx<'_>,
    input: &str,
    secure: bool,
    before: Option<&str>,
) -> Result<ChainResult, GhostError> {
    if !is_settable(ctx.el, "AXValue") {
        return run_chain(
            vec![set_rung(ctx, "AXValue", || 0, || ReadBack::Unreadable)],
            ctx.deadline,
        );
    }
    let want = coerce(value_kind(ctx.el), input)?;
    if !secure && before.is_some_and(|b| coerced_matches(&ctx.role_key, &want, b)) {
        return Ok(satisfied());
    }
    let value: Option<CfRef> = match &want {
        Coerced::Number(n) => cf_number(*n),
        Coerced::Boolean(_) => None,
        Coerced::Text(s) => Some(
            CfRef::string(s)
                .ok_or_else(|| GhostError::invalid_args("the value contains a NUL character"))?,
        ),
    };
    let write = || match (&want, &value) {
        (Coerced::Boolean(b), _) => set_attr(ctx.el, "AXValue", cf_boolean(*b)),
        (_, Some(v)) => set_attr(ctx.el, "AXValue", v.as_ptr()),
        (_, None) => super::ffi::AX_ILLEGAL_ARGUMENT,
    };
    // A secure field's value is never read back: the write is unverified by design.
    let readback = || {
        if secure {
            return ReadBack::Unreadable;
        }
        let until = Instant::now() + SETTLE_WINDOW;
        loop {
            let observed = attr_value_text(ctx.el, "AXValue");
            let rb = value_readback(&ctx.role_key, &want, before, observed.as_deref());
            if rb == ReadBack::Requested
                || Instant::now() + SETTLE_INTERVAL > until.min(ctx.deadline)
            {
                return rb;
            }
            std::thread::sleep(SETTLE_INTERVAL);
        }
    };
    run_chain(
        vec![set_rung(ctx, "AXValue", write, readback)],
        ctx.deadline,
    )
}

fn toggle(ctx: &Ctx<'_>, action: &ElementAction) -> Result<ChainResult, GhostError> {
    let before = read_checked(ctx.el);
    let target = match action {
        ElementAction::Check => Some(true),
        ElementAction::Uncheck => Some(false),
        _ => before.map(|b| !b),
    };
    if before.is_some() && before == target {
        return Ok(satisfied());
    }
    if *action == ElementAction::Uncheck && ctx.role_key == "radiobutton" {
        return Err(GhostError::not_supported(
            "a radio button cannot be unchecked; check another option instead",
        ));
    }
    let numeric = value_kind(ctx.el) == ValueKind::Number;
    let value_rung = match target {
        Some(t) => set_rung(
            ctx,
            "AXValue",
            move || match (numeric, cf_number(if t { 1.0 } else { 0.0 })) {
                (true, Some(n)) => set_attr(ctx.el, "AXValue", n.as_ptr()),
                _ => set_attr(ctx.el, "AXValue", cf_boolean(t)),
            },
            move || {
                bool_readback(
                    ctx.poll(TOGGLE_INTERVAL, TOGGLE_WINDOW, t, || read_checked(ctx.el)),
                    t,
                )
            },
        ),
        None => Rung {
            method: "AXValue",
            run: Box::new(|| Ok(StepOutcome::NotDelivered)),
        },
    };
    let press_effect = move || {
        let t = target?;
        effect_of(
            ctx.poll(TOGGLE_INTERVAL, TOGGLE_WINDOW, t, || read_checked(ctx.el)),
            t,
        )
    };
    run_chain(
        vec![
            value_rung,
            perform_rung(ctx, "AXPress", false, press_effect),
        ],
        ctx.deadline,
    )
}

fn expand(ctx: &Ctx<'_>, target: bool) -> Result<ChainResult, GhostError> {
    let before = read_expanded(ctx.el, &ctx.role_key);
    if before == Some(target) {
        return Ok(satisfied());
    }
    let observe = move || {
        ctx.poll(EXPAND_INTERVAL, EXPAND_WINDOW, target, || {
            read_expanded(ctx.el, &ctx.role_key)
        })
    };
    let native = if target { "AXExpand" } else { "AXCollapse" };
    let known_opposite = before == Some(!target);
    let press_rung = if known_opposite {
        perform_rung(ctx, "AXPress", false, move || effect_of(observe(), target))
    } else {
        Rung {
            method: "AXPress",
            run: Box::new(|| Ok(StepOutcome::NotDelivered)),
        }
    };
    run_chain(
        vec![
            perform_rung(ctx, native, true, move || effect_of(observe(), target)),
            set_rung(
                ctx,
                "AXExpanded",
                move || set_attr(ctx.el, "AXExpanded", cf_boolean(target)),
                move || bool_readback(observe(), target),
            ),
            press_rung,
        ],
        ctx.deadline,
    )
}

/// Selects `el` through an ancestor (up to 3 levels) whose `attr` is settable.
fn ancestor_select(ctx: &Ctx<'_>, attr: &'static str) -> Result<StepOutcome, GhostError> {
    let mut cur = attr_element(ctx.el, "AXParent");
    for _ in 0..3 {
        let Some(parent) = cur else { break };
        set_timeout(&parent, ctx.deadline);
        if is_settable(&parent, attr) {
            let Some(arr) = cf_array_of(ctx.el.as_ptr()) else {
                return Err(GhostError::internal("could not build the selection array"));
            };
            let code = set_attr(&parent, attr, arr.as_ptr());
            let seen = ctx.poll(SETTLE_INTERVAL, SETTLE_WINDOW, true, || {
                attr_bool(ctx.el, "AXSelected")
            });
            return classify_set(code, bool_readback(seen, true), attr);
        }
        cur = attr_element(&parent, "AXParent");
    }
    Ok(StepOutcome::NotDelivered)
}

fn select(ctx: &Ctx<'_>) -> Result<ChainResult, GhostError> {
    if attr_bool(ctx.el, "AXSelected") == Some(true) {
        return Ok(satisfied());
    }
    let readback = || {
        bool_readback(
            ctx.poll(SETTLE_INTERVAL, SETTLE_WINDOW, true, || {
                attr_bool(ctx.el, "AXSelected")
            }),
            true,
        )
    };
    run_chain(
        vec![
            set_rung(
                ctx,
                "AXSelected",
                || set_attr(ctx.el, "AXSelected", cf_boolean(true)),
                readback,
            ),
            Rung {
                method: "AXSelectedRows",
                run: Box::new(|| ancestor_select(ctx, "AXSelectedRows")),
            },
            Rung {
                method: "AXSelectedChildren",
                run: Box::new(|| ancestor_select(ctx, "AXSelectedChildren")),
            },
        ],
        ctx.deadline,
    )
}

fn show_menu(ctx: &Ctx<'_>) -> Result<ChainResult, GhostError> {
    let effect = || {
        let seen = ctx.poll(SETTLE_INTERVAL, MENU_WINDOW, true, || {
            has_menu_child(ctx.el, ctx.deadline).then_some(true)
        });
        (seen == Some(true)).then_some(true)
    };
    run_chain(
        vec![perform_rung(ctx, "AXShowMenu", false, effect)],
        ctx.deadline,
    )
}

fn verification(
    action: &ElementAction,
    outcome: StepOutcome,
    secure: bool,
    verify: bool,
) -> Verification {
    let (scope, reason) = match outcome {
        StepOutcome::Satisfied => (VerificationScope::AlreadyInState, None),
        _ if !verify => (VerificationScope::Skipped, Some("not_requested")),
        _ if secure && matches!(action, ElementAction::SetValue(_)) => {
            (VerificationScope::Unavailable, Some("secure_field"))
        }
        StepOutcome::DeliveredVerified if matches!(action, ElementAction::SetValue(_)) => {
            (VerificationScope::ElementValue, None)
        }
        StepOutcome::DeliveredVerified => (VerificationScope::ElementState, None),
        _ if !action.is_stateful() => (VerificationScope::Unavailable, Some("not_stateful")),
        _ => (
            VerificationScope::Unavailable,
            Some("insufficient_evidence"),
        ),
    };
    Verification { scope, reason }
}

/// Activates the renderer of the locator's process before resolving, if asked.
fn activate_renderer(locator: &ElementLocator, deadline: Instant) -> RendererA11y {
    let Ok(win) = acquire(&locator.window, deadline) else {
        return RendererA11y::Failed;
    };
    let limits = WalkLimits::platform_default().with_budget(RENDERER_WALK_BUDGET);
    let (tree, _) = walk_root(&win.root, limits);
    electron::ensure_renderer_accessibility(&win.app, win.pid, &tree, deadline)
}

/// Resolves `locator` and runs `action`'s chain within `opts.deadline`.
pub(crate) fn perform_sync(
    locator: &ElementLocator,
    action: &ElementAction,
    opts: &ActionOptions,
) -> Result<ActionOutcome, GhostError> {
    let deadline = Instant::now() + opts.deadline;
    let renderer = if opts.activate_renderer {
        activate_renderer(locator, deadline)
    } else {
        RendererA11y::NotApplicable
    };
    let live = resolve_live(locator, deadline)?;
    let secure = live.resolved.node.secure;
    let before = live.resolved.state.clone();
    let ctx = Ctx {
        el: &live.el,
        app: &live.win.app,
        role_key: live.resolved.node.stable_role(),
        deadline,
    };
    let result = match action {
        ElementAction::Press => press(&ctx),
        ElementAction::Focus => focus(&ctx),
        ElementAction::SetValue(v) => set_value(&ctx, v, secure, before.value.as_deref()),
        ElementAction::Toggle | ElementAction::Check | ElementAction::Uncheck => {
            toggle(&ctx, action)
        }
        ElementAction::Expand => expand(&ctx, true),
        ElementAction::Collapse => expand(&ctx, false),
        ElementAction::Select => select(&ctx),
        ElementAction::ScrollIntoView => run_chain(
            vec![perform_rung(&ctx, "AXScrollToVisible", false, || None)],
            deadline,
        ),
        ElementAction::ShowMenu => show_menu(&ctx),
    }?;
    let mut outcome = result.outcome;
    if secure
        && matches!(action, ElementAction::SetValue(_))
        && outcome == StepOutcome::DeliveredVerified
    {
        outcome = StepOutcome::DeliveredUnverified;
    }
    let after = opts
        .verify
        .then(|| read_state(&live.el, &live.resolved.node));
    let delivery = match outcome {
        StepOutcome::Satisfied => Delivery::NotDelivered,
        other => other.delivery(),
    };
    Ok(ActionOutcome {
        action: action.name(),
        method: result.method,
        delivery,
        verification: verification(action, outcome, secure, opts.verify),
        attempts: result.attempts,
        element: live.resolved.clone(),
        before: Some(before),
        after,
        renderer,
    })
}
