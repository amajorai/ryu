use super::*;

// ── Plan-mode pill → in-band sentinel (Unit 7) ─────────────────────────────
//
// The composer's synthesized `ryu.plan` option cannot be applied over ACP, so
// the turn path materializes it into the prompt. These pin the PLACEMENT,
// which is the whole contract: the receiving hook matches the token only as
// the first line of the text, or the first line of its final `\n\n` block,
// precisely so a pasted diff cannot flip the mode.

fn plan_config(value: &str) -> std::collections::HashMap<String, String> {
    std::collections::HashMap::from([(acp::PLAN_MODE_CONFIG_ID.to_owned(), value.to_owned())])
}

#[test]
fn plan_mode_sentinel_leads_the_user_message_on_both_roads() {
    let cfg = plan_config(acp::PLAN_MODE_ON);
    let message = apply_plan_mode_sentinel("add a health endpoint".to_owned(), Some(&cfg));
    let sentinel = crate::pi_config::plan_mode_sentinel(true);

    // Road 1 — turn 2+, where Core sends this string raw as the turn delta.
    // The token must be the first line of the whole text, on its own.
    assert_eq!(message, format!("{sentinel}\nadd a health endpoint"));

    // Road 2 — turn 1, where the same string is the tail of a composed prompt
    // carrying a preamble and short-term context. The token must then be the
    // first line of the FINAL `\n\n` block. Building the real prompt is what
    // proves one edit covers both roads.
    let prompt = build_acp_prompt(
        Some("You are helpful.".to_owned()),
        Some("Earlier: the user prefers Rust.".to_owned()),
        &message,
    );
    let final_block = prompt
        .rsplit("\n\n")
        .next()
        .expect("prompt has a final block");
    assert_eq!(
        final_block.lines().next(),
        Some(sentinel),
        "sentinel leads the final block: {prompt}"
    );
    // ...and the user's own words survive intact, after it.
    assert!(prompt.ends_with("add a health endpoint"));
}

#[test]
fn plan_mode_sentinel_absent_unless_the_pill_says_on() {
    let untouched = "just do it".to_owned();
    // No config at all — the overwhelmingly common turn.
    assert_eq!(apply_plan_mode_sentinel(untouched.clone(), None), untouched);
    // Config present but carrying other agent-reported options only.
    let others = std::collections::HashMap::from([
        ("model".to_owned(), "gpt-5".to_owned()),
        ("thought_level".to_owned(), "high".to_owned()),
    ]);
    assert_eq!(
        apply_plan_mode_sentinel(untouched.clone(), Some(&others)),
        untouched
    );
    // Explicitly OFF. Deliberately a no-op rather than an `/plan off` token:
    // the composer persists an option's value per agent, so this value rides
    // every later turn forever once the pill has been touched.
    assert_eq!(
        apply_plan_mode_sentinel(untouched.clone(), Some(&plan_config("off"))),
        untouched
    );
    // An unrecognised value is not "on" — fail towards the normal path.
    assert_eq!(
        apply_plan_mode_sentinel(untouched.clone(), Some(&plan_config("ON"))),
        untouched,
        "the value match is exact; a near-miss must not enter plan mode"
    );
}

#[test]
fn plan_mode_sentinel_is_not_always_in_the_final_block() {
    // The case that says why the receiving hook has to search the `\n\n`
    // blocks FROM THE END rather than test only the last one: a first message
    // with a blank line of its own pushes the sentinel's block into the middle
    // of the composed prompt. Nothing on this side can prevent that — the
    // user's own text is what carries the blank line — so this test exists to
    // pin the shape the extension must cope with, and to fail loudly if the
    // producer is ever changed to append the token instead of prepending it.
    let cfg = plan_config(acp::PLAN_MODE_ON);
    let message = apply_plan_mode_sentinel(
        "add a health endpoint\n\nit should return the build sha".to_owned(),
        Some(&cfg),
    );
    let sentinel = crate::pi_config::plan_mode_sentinel(true);
    let prompt = build_acp_prompt(
        Some("You are helpful.".to_owned()),
        Some("Earlier: the user prefers Rust.".to_owned()),
        &message,
    );
    let blocks: Vec<&str> = prompt.split("\n\n").collect();
    assert_ne!(
        blocks.last().and_then(|b| b.lines().next()),
        Some(sentinel),
        "the final block is the user's SECOND paragraph here, not the sentinel"
    );
    assert!(
        blocks.iter().any(|b| b.lines().next() == Some(sentinel)),
        "the sentinel still heads one of the blocks: {prompt}"
    );
}
