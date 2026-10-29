//! Single-screen generative UI guidance.
//!
//! A client that shows the agent's `ui.render` output as ONE live screen (the
//! Island, in a floating window beside it) sets [`GENERATIVE_UI_FLAG`] in the
//! request's `plugin_flags`. The model is then told to answer structured
//! requests as a compact screen and to re-render the whole screen when the user
//! refines it, because the client replaces the previous screen rather than
//! stacking cards.
//!
//! The component vocabulary itself stays in the `ui.render` tool description
//! (`sidecar/mcp/agent_ui_contract.md`); this layer only covers how the surface
//! behaves, so it never drifts from the renderer's catalog.

use std::collections::HashMap;

/// The `plugin_flags` key a single-screen generative-UI client sets per turn.
pub(crate) const GENERATIVE_UI_FLAG: &str = "io.ryu.generative-ui";

const GENERATIVE_UI_HINT: &str = "## Generative UI screen\n\
This conversation is in the Ryu Island, a compact floating assistant. Your most \
recent `ui.render` output is shown as one live screen in a floating window on \
the user's desktop, up to about 560px wide. If the `ui.render` tool is \
available:\n\
- When an answer has structure (options to choose between, a comparison, \
numbers or a status, a plan, or details to collect from the user), render it as \
a screen with `ui.render` and keep your text reply to one short sentence.\n\
- When the user refines or follows up on a screen, call `ui.render` again with \
the complete updated screen. It replaces the previous one, so never send only \
the changed part.\n\
- Design for that width: a single column, short labels, at most about \
eight rows, and no wide tables.\n\
- For small talk or a one-line answer, reply in text only; the screen then \
closes.\n\
- Island screens are not saved: what the user types or ticks on a screen is \
lost when it closes or is replaced, and `ui.get_state` returns nothing for \
them. To learn what the user chose, give the screen a submit action (the \
values arrive as the user's next message) instead of reading saved state.";

/// The guidance block for this turn, or `None` when the client did not opt in or
/// Safe Mode is active.
pub(crate) fn generative_ui_hint(flags: &HashMap<String, bool>) -> Option<String> {
    generative_ui_hint_when(crate::safe_mode::is_active(), flags)
}

/// [`generative_ui_hint`] with Safe Mode passed in, so tests need no global state.
fn generative_ui_hint_when(safe_mode: bool, flags: &HashMap<String, bool>) -> Option<String> {
    if safe_mode || !flags.get(GENERATIVE_UI_FLAG).copied().unwrap_or(false) {
        return None;
    }
    Some(GENERATIVE_UI_HINT.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flags(value: Option<bool>) -> HashMap<String, bool> {
        value
            .map(|v| HashMap::from([(GENERATIVE_UI_FLAG.to_owned(), v)]))
            .unwrap_or_default()
    }

    #[test]
    fn hint_requires_the_client_flag() {
        assert!(generative_ui_hint_when(false, &flags(None)).is_none());
        assert!(generative_ui_hint_when(false, &flags(Some(false))).is_none());
        let hint = generative_ui_hint_when(false, &flags(Some(true))).unwrap();
        assert!(hint.contains("`ui.render`"));
        assert!(hint.contains("complete updated screen"));
        // The Island keeps no widget state, so the shared ui.render contract's
        // "state is saved" promise must be withdrawn here.
        assert!(hint.contains("not saved"));
        assert!(hint.contains("`ui.get_state` returns nothing"));
    }

    #[test]
    fn safe_mode_strips_the_hint() {
        assert!(generative_ui_hint_when(true, &flags(Some(true))).is_none());
    }
}
