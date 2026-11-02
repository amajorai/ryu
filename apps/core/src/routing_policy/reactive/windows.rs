//! The vendor's usage windows as the reactive path reads them: one
//! [`WindowReading`] per rolling window and an [`AgentWindows`] per plan.

/// One rolling window, carrying the two fields the proactive
/// [`crate::routing_policy::WindowReading`] drops: when it resets, and how long it runs.
///
/// Both matter here and neither is interchangeable with the other. `resets_at`
/// is what orders a wait; `window_seconds` only ever labels one ("5h", "7d").
/// Sorting a wait by length would be wrong in the ordinary case — a 5-hour
/// window that just refilled loses to a weekly one rolling over in ten minutes.
#[derive(Debug, Clone, PartialEq)]
pub struct WindowReading {
    pub label: String,
    /// Set only for a model-scoped window (Claude's per-model weekly limits).
    pub model: Option<String>,
    /// Percent of the cap consumed, 0–100.
    pub used_percent: f64,
    /// RFC3339, when the vendor said so. `None` means unknown — never "now".
    pub resets_at: Option<String>,
    /// The window's own length in seconds, for labelling only.
    pub window_seconds: Option<i64>,
}

impl WindowReading {
    /// Percent of this window still unused.
    pub(super) fn remaining_percent(&self) -> f64 {
        (100.0 - self.used_percent).clamp(0.0, 100.0)
    }
}

/// One agent's readable plan state.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentWindows {
    pub agent_id: String,
    /// Plan label when the vendor gave one ("Max 20x"), for the note text.
    pub plan: Option<String>,
    /// False when the snapshot was unavailable for ANY reason — not logged in,
    /// no plan on the account, token expired, the usage endpoint itself rate
    /// limited, unsupported. All of them mean the same thing to this module:
    /// nothing here can be trusted to answer a turn, so the agent is neither a
    /// candidate nor evidence that the failed agent is spent.
    pub readable: bool,
    pub windows: Vec<WindowReading>,
}

impl AgentWindows {
    /// The windows that actually gate a turn on `model`.
    ///
    /// Account-wide windows (`model: None`) always gate. A model-scoped window
    /// gates only when it names the model the turn will use — Opus being spent
    /// says nothing about a Sonnet turn.
    ///
    /// When the model is unknown, model-scoped windows are **excluded** rather
    /// than folded in. Including them is the tempting conservative choice and it
    /// is wrong in the direction that matters: one spent per-model cap would
    /// condemn a whole plan for a model this turn may never touch, so the
    /// feature would refuse to fail over to an agent that had plenty of room.
    pub(super) fn gating<'a>(
        &'a self,
        model: Option<&'a str>,
    ) -> impl Iterator<Item = &'a WindowReading> {
        self.windows.iter().filter(move |w| match &w.model {
            None => true,
            Some(scoped) => model.is_some_and(|m| models_match(scoped, m)),
        })
    }

    /// Percent left on the tightest window gating a turn on `model`, or `None`
    /// when the agent reports nothing we can judge.
    ///
    /// **MIN, not max.** A plan carries several windows at once (Claude has a
    /// 5-hour, a weekly, and per-model weeklies) and a turn needs *every* one of
    /// them to have room. Taking the maximum — the natural reading of "how much
    /// headroom does this plan have" — picks an account whose weekly is at 99%
    /// on the strength of a freshly reset 5-hour window, and the retry fails
    /// exactly like the turn it was replacing.
    pub fn headroom_percent(&self, model: Option<&str>) -> Option<f64> {
        if !self.readable {
            return None;
        }
        self.gating(model)
            .map(WindowReading::remaining_percent)
            .fold(None, |acc: Option<f64>, remaining| {
                Some(acc.map_or(remaining, |a| a.min(remaining)))
            })
    }

    /// The gating window that is currently tightest, for the note text.
    pub(super) fn tightest<'a>(&'a self, model: Option<&'a str>) -> Option<&'a WindowReading> {
        self.gating(model).min_by(|a, b| {
            a.remaining_percent()
                .partial_cmp(&b.remaining_percent())
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    }

    /// The soonest RFC3339 reset among the gating windows that are actually
    /// spent, paired with that window's label.
    ///
    /// Only spent windows are considered: a 5-hour window sitting at 3% used
    /// will reset soon and tells us nothing — waiting for it changes nothing
    /// because it is not what is blocking. A window with no `resets_at` is
    /// skipped entirely rather than sorted as "now", following the same abstain
    /// rule the proactive module states: an absent signal never fires a verdict.
    pub(super) fn soonest_reset(
        &self,
        model: Option<&str>,
        spent_below: f64,
    ) -> Option<(String, String)> {
        self.gating(model)
            .filter(|w| w.remaining_percent() < spent_below)
            .filter_map(|w| {
                let at = w.resets_at.as_deref()?;
                let parsed = chrono::DateTime::parse_from_rfc3339(at).ok()?;
                Some((parsed, w.label.clone(), at.to_string()))
            })
            .min_by_key(|(parsed, _, _)| *parsed)
            .map(|(_, label, at)| (label, at))
    }
}

/// Whether a window's model scope names the model a turn will run on.
///
/// Lenient and symmetric on purpose: vendors label these windows for humans
/// ("Opus", "Sonnet") while a turn carries a full id (`claude-opus-4-20250514`),
/// and neither side is canonical. Comparison is on lowercased alphanumerics so
/// punctuation and casing differences (`GPT-5` vs `gpt5`) do not split a match.
pub(super) fn models_match(scoped: &str, model: &str) -> bool {
    let norm = |s: &str| {
        s.chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .map(|c| c.to_ascii_lowercase())
            .collect::<String>()
    };
    let (a, b) = (norm(scoped), norm(model));
    if a.is_empty() || b.is_empty() {
        return false;
    }
    a.contains(&b) || b.contains(&a)
}
