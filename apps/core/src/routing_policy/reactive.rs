//! Reactive failover — "my agent just hit its cap; run this turn on whichever
//! plan still has room, and if none does, tell me which window opens first."
//!
//! The sibling of this module's parent. [`super`] is **proactive**: the user
//! writes a rule ("Claude weekly under 50% → Sonnet") and it fires *before* the
//! turn on a threshold they chose. This is **reactive**: nobody writes a rule,
//! the turn has already failed, and the question is not "which rule matches" but
//! "of every plan I am paying for, which one can answer right now".
//!
//! That is a different decision, so it is a different function. It deliberately
//! does NOT route through [`super::evaluate`]:
//!
//! - `evaluate` degrades any agent-typed rule to a `Warn` unless
//!   [`super::Target::at_conversation_start`], because moving agents mid-thread
//!   abandons the vendor-side session an ACP agent owns. A retry is mid-thread
//!   *by definition*, so reusing that path would make this feature a permanent
//!   no-op.
//! - The trade is genuinely different on this path: the turn **failed**, so
//!   there is no answer to abandon. What is lost is the vendor's own session
//!   continuity — the retry continues from the flattened replay Ryu assembles
//!   (`build_acp_prompt`), not from the agent's server-side thread. That is a
//!   real downgrade, which is why it is opt-in and always announced.
//!
//! ## The error is the trigger; `ryu_usage` is the authority
//!
//! A vendor CLI reports "you have hit your 5-hour limit" in prose that differs
//! per vendor and changes without notice, so classifying on the message text
//! would rot silently and — worse — would reroute turns that failed for some
//! unrelated reason. Instead any turn error makes us go *look*: re-read the
//! agent's own windows and only call it a limit hit when a window that gates
//! this turn is genuinely at its cap. The gateway plane has a typed signal
//! (HTTP 429 + `provider_rate_limited` / `rate_limit_exceeded`) and uses it,
//! but still confirms the same way when the agent has readable windows.
//!
//! The read here is **uncached** on purpose. [`super::signals`] serves windows
//! from a 5-minute stale-while-revalidate cache, which is right for a per-turn
//! proactive check and exactly wrong here: a stale snapshot saying "you have
//! room" is what let the turn fail in the first place. This path runs only on a
//! failure, so one fresh vendor call is affordable.
//!
//! ## What is not here
//!
//! Waiting out a window and resuming the turn later. The scheduler has no
//! one-shot-at-an-absolute-time [`Schedule`] and `JobTarget::Agent` starts a
//! *fresh* turn rather than resuming a conversation, so "retry at 14:05 when the
//! weekly rolls over" is a second feature, not a flag on this one. When no plan
//! has room, [`Verdict::Wait`] reports the soonest reset and stops there.
//!
//! [`Schedule`]: crate::scheduler::store::Schedule

use serde::{Deserialize, Serialize};
use serde_json::Value;

mod note;
mod read;
mod turn;
mod windows;

// Part of the module's API; not every item is used outside it yet.
#[allow(unused_imports)]
pub use read::{read_agent_windows, read_all_windows};
#[allow(unused_imports)]
pub use turn::{
    error_type_of, gateway_failure_kind, FailureKind, FrameAction, FrameGate, TurnFailure,
    TurnWatch,
};
pub use windows::{AgentWindows, WindowReading};

/// Preference key holding the node's reactive failover config, as JSON
/// ([`RetryPolicy`]).
///
/// Node-scoped and edited in the **Gateway (node) settings** dialog, right next
/// to [`super::ROUTING_POLICY_PREF`] — and for the same reason spelled out
/// there: a settings tab registered by an App inherits that App's enablement, so
/// disabling the App would leave turns still being rerouted with no UI left to
/// explain why, or would silently stop a failover the user still believes is
/// armed. Retry routing is the sharper version of that trap, because its whole
/// job is to act at the moment the user is least able to see what happened.
pub const RETRY_POLICY_PREF: &str = "routing-retry-policy";

/// How much of a window must be left for it to count as usable. A window under
/// this is "spent" — both for judging that the failed agent really did hit its
/// cap, and for refusing to hand the turn to a candidate that is about to.
///
/// Not zero: vendors round, and a plan reporting 0.4% left will not survive one
/// more turn. Not large either — this is the "is it over" line, not a comfort
/// margin, and the proactive rules in [`super`] are where a user expresses
/// "start moving me at 20%".
const DEFAULT_SPENT_BELOW_PERCENT: f64 = 2.0;

/// The node's reactive failover config.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RetryPolicy {
    /// Off by default. A node that never opts in behaves exactly as it does
    /// today: the failure surfaces and nothing is rerouted.
    #[serde(default)]
    pub enabled: bool,
    /// Explain, never reroute. The turn still fails, but the user is told which
    /// of their plans had room (or when the first window reopens) instead of
    /// being handed a bare vendor error.
    ///
    /// This is the setting to reach for first, mirroring the empty-`fallback`
    /// notify-only rule in [`super::FallbackRule`] — it lets someone watch the
    /// decision the feature *would* have made before letting it rewrite turns.
    #[serde(default)]
    pub notify_only: bool,
    /// Restrict failover to these agent ids, in preference order. Empty means
    /// "any subscription agent whose windows I can read", which is the useful
    /// default: the whole point is to shop across the plans the user already
    /// pays for without first enumerating them in a settings screen.
    ///
    /// A non-empty list is honoured as **priority order**, not merely as a
    /// filter — someone who lists Codex before Copilot is stating a preference
    /// that must beat a raw headroom comparison.
    #[serde(default)]
    pub candidates: Vec<String>,
    /// Percent-left below which a window counts as spent. See
    /// [`DEFAULT_SPENT_BELOW_PERCENT`].
    #[serde(default = "default_spent_below")]
    pub spent_below_percent: f64,
}

fn default_spent_below() -> f64 {
    DEFAULT_SPENT_BELOW_PERCENT
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            notify_only: false,
            candidates: Vec::new(),
            spent_below_percent: DEFAULT_SPENT_BELOW_PERCENT,
        }
    }
}

impl RetryPolicy {
    /// Parse a stored preference value. An unreadable value yields the DEFAULT
    /// (disabled) policy, never an error — a corrupt setting must degrade to
    /// today's behaviour rather than start rerouting turns on a guess.
    pub fn parse(raw: &str) -> Self {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Self::default();
        }
        serde_json::from_str(trimmed).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "retry policy is unreadable; treating as disabled");
            Self::default()
        })
    }

    /// Serialize for storage.
    pub fn to_pref_value(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// The threshold, clamped to something a window can actually be measured
    /// against. A hand-edited pref carrying `-5` or `140` must not make every
    /// plan look spent (or none of them).
    fn spent_threshold(&self) -> f64 {
        if self.spent_below_percent.is_nan() {
            return DEFAULT_SPENT_BELOW_PERCENT;
        }
        self.spent_below_percent.clamp(0.0, 100.0)
    }
}

/// Read the node's reactive failover config.
pub async fn load(prefs: &crate::server::preferences::PreferencesStore) -> RetryPolicy {
    match prefs.get(RETRY_POLICY_PREF).await {
        Ok(Some(raw)) => RetryPolicy::parse(&raw),
        _ => RetryPolicy::default(),
    }
}

/// What the reactive path decided about a failed turn.
///
/// Every verdict but [`Verdict::Stand`] carries `note`, its sentences rendered
/// in the node's language, and `messages`, the same sentences as Core messages
/// (`{ message, args }`) so a client renders them in the reader's language.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Verdict {
    /// Not a limit failure, or nothing to say. The caller surfaces the original
    /// error unchanged — this path adds nothing.
    Stand,
    /// A plan with room was found. `note` is a finished sentence for the user.
    Reroute {
        agent_id: String,
        /// Percent left on that agent's tightest gating window.
        headroom_percent: f64,
        note: String,
        messages: Vec<Value>,
    },
    /// The cap is real and no plan has room. `resets_at` is the soonest window
    /// that will reopen, across every readable agent.
    Wait {
        /// The agent whose window reopens first.
        agent_id: String,
        /// RFC3339.
        resets_at: String,
        note: String,
        messages: Vec<Value>,
    },
    /// A plan with room was found and deliberately NOT used, because the node is
    /// configured [`RetryPolicy::notify_only`].
    ///
    /// Distinct from [`Verdict::NoCandidate`] on purpose: the two look alike in
    /// that neither reroutes, but they mean opposite things to a reader — one
    /// found somewhere to go and held back, the other found nowhere. Collapsing
    /// them makes a working notify-only setup render as a warning that nothing
    /// could be done.
    Held {
        /// The agent that would have taken the turn.
        agent_id: String,
        headroom_percent: f64,
        note: String,
        messages: Vec<Value>,
    },
    /// The cap is real, but there is nothing readable to move to and no reset we
    /// can name (no other plan configured, or every reset time unknown).
    NoCandidate { note: String, messages: Vec<Value> },
}

impl Verdict {
    /// The agent to run the retry on, when the verdict calls for one.
    pub fn reroute_agent(&self) -> Option<&str> {
        match self {
            Self::Reroute { agent_id, .. } => Some(agent_id.as_str()),
            _ => None,
        }
    }

    /// The sentence to show the user, if any.
    pub fn note(&self) -> Option<&str> {
        match self {
            Self::Stand => None,
            Self::Reroute { note, .. }
            | Self::Held { note, .. }
            | Self::Wait { note, .. }
            | Self::NoCandidate { note, .. } => Some(note.as_str()),
        }
    }
}

/// Decide what to do about a turn that failed on `failed_agent`.
///
/// Pure: every vendor read has already happened and arrives in `readings`. That
/// is what lets the interesting behaviour — min-over-windows, the notify-only
/// downgrade, the ordering of a wait — be tested without a credential on disk.
///
/// `readings` must include the failed agent itself when its windows are
/// readable; its absence is treated as "we could not confirm a cap", which
/// yields [`Verdict::Stand`] rather than a guess — UNLESS `kind` is already
/// [`FailureKind::RateLimited`], which is the Gateway stating it outright.
///
/// Those two confirmation paths exist because the planes carry different
/// evidence. On the ACP plane the vendor CLI reports a cap as prose, so the
/// windows are the only trustworthy witness and a turn that failed with room to
/// spare must be left alone. On the gateway plane a 429 / `provider_rate_limited`
/// IS the witness — and the turn may have been routed to a BYO-key provider that
/// has no subscription window to read at all, so demanding one would make the
/// feature silently inert for exactly the failures it was told about.
///
/// The note is in the node's language as of the last [`read_all_windows`];
/// [`decide_in`] names the locale instead.
pub fn decide(
    policy: &RetryPolicy,
    failed_agent: &str,
    model: Option<&str>,
    kind: FailureKind,
    readings: &[AgentWindows],
) -> Verdict {
    decide_in(
        policy,
        failed_agent,
        model,
        kind,
        readings,
        note::node_locale(),
    )
}

/// [`decide`], with the note rendered for `locale`.
pub fn decide_in(
    policy: &RetryPolicy,
    failed_agent: &str,
    model: Option<&str>,
    kind: FailureKind,
    readings: &[AgentWindows],
    locale: &str,
) -> Verdict {
    if !policy.enabled {
        return Verdict::Stand;
    }
    let spent_below = policy.spent_threshold();

    // 1. Confirm the cap, by whichever witness this plane has.
    let failed = readings
        .iter()
        .find(|r| r.agent_id.eq_ignore_ascii_case(failed_agent));
    let told_outright = kind == FailureKind::RateLimited;
    let confirmed_by_windows = failed
        .and_then(|f| f.headroom_percent(model))
        .is_some_and(|headroom| headroom < spent_below);
    if !told_outright && !confirmed_by_windows {
        return Verdict::Stand;
    }
    // The spent window, when the windows confirmed the cap; otherwise the
    // sentence says "usage limit".
    let spent_label = failed
        .and_then(|f| f.tightest(model))
        .filter(|_| confirmed_by_windows)
        .map(|w| w.label.as_str());
    let out_of = note::out_of(failed_agent, spent_label, failed);

    // 2. Rank the alternatives.
    let ranked = rank_candidates(policy, failed_agent, model, readings, spent_below);

    if let Some((best, headroom)) = ranked.first().copied() {
        if policy.notify_only {
            let (note, messages) = note::finish(&[out_of, note::held(best, headroom)], locale);
            return Verdict::Held {
                agent_id: best.to_string(),
                headroom_percent: headroom,
                note,
                messages,
            };
        }
        let (note, messages) = note::finish(&[out_of, note::retrying(best, headroom)], locale);
        return Verdict::Reroute {
            agent_id: best.to_string(),
            headroom_percent: headroom,
            note,
            messages,
        };
    }

    // 3. Nobody has room. Report the window that reopens first, across every
    //    readable agent INCLUDING the one that just failed — the ordinary
    //    outcome for a single-plan user is "your own 5-hour window is back at
    //    18:40", which is the most useful thing we can say.
    let soonest = readings
        .iter()
        .filter(|r| r.readable)
        .filter(|r| {
            is_candidate(policy, failed_agent, r) || r.agent_id.eq_ignore_ascii_case(failed_agent)
        })
        .filter_map(|r| {
            let (label, at) = r.soonest_reset(model, spent_below)?;
            let parsed = chrono::DateTime::parse_from_rfc3339(&at).ok()?;
            Some((parsed, r.agent_id.clone(), label, at))
        })
        .min_by_key(|(parsed, _, _, _)| *parsed);

    match soonest {
        Some((parsed, agent_id, label, at)) => {
            let (note, messages) = note::finish(&[note::wait(&agent_id, &label, parsed)], locale);
            Verdict::Wait {
                agent_id,
                resets_at: at,
                note,
                messages,
            }
        }
        None => {
            let (note, messages) = note::finish(&[out_of, note::no_candidate()], locale);
            Verdict::NoCandidate { note, messages }
        }
    }
}

/// Whether `reading` is eligible to receive a rerouted turn at all — before any
/// headroom comparison.
fn is_candidate(policy: &RetryPolicy, failed_agent: &str, reading: &AgentWindows) -> bool {
    if reading.agent_id.eq_ignore_ascii_case(failed_agent) {
        return false;
    }
    if !reading.readable {
        return false;
    }
    policy.candidates.is_empty()
        || policy
            .candidates
            .iter()
            .any(|c| c.eq_ignore_ascii_case(&reading.agent_id))
}

/// Candidates that can take the turn right now, best first.
///
/// Ordering is *preference then headroom*: an explicit `candidates` list is the
/// user stating priority, so it outranks a raw percentage. With no list, the
/// most headroom wins, and ties break on agent id so the choice is reproducible
/// rather than dependent on whichever vendor call returned first.
fn rank_candidates<'a>(
    policy: &RetryPolicy,
    failed_agent: &str,
    model: Option<&str>,
    readings: &'a [AgentWindows],
    spent_below: f64,
) -> Vec<(&'a str, f64)> {
    let mut ranked: Vec<(&str, f64, usize)> = readings
        .iter()
        .filter(|r| is_candidate(policy, failed_agent, r))
        .filter_map(|r| {
            let headroom = r.headroom_percent(model)?;
            if headroom < spent_below {
                return None;
            }
            let rank = policy
                .candidates
                .iter()
                .position(|c| c.eq_ignore_ascii_case(&r.agent_id))
                .unwrap_or(usize::MAX);
            Some((r.agent_id.as_str(), headroom, rank))
        })
        .collect();
    ranked.sort_by(|a, b| {
        a.2.cmp(&b.2)
            .then_with(|| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal))
            .then_with(|| a.0.cmp(b.0))
    });
    ranked.into_iter().map(|(id, h, _)| (id, h)).collect()
}

#[cfg(test)]
use note::display_agent;
#[cfg(test)]
use windows::models_match;
#[cfg(test)]
mod note_tests;
#[cfg(test)]
mod tests;
