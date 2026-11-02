use super::{finish_reactions, ReactionOp};

fn owned(emojis: &[&str]) -> Vec<String> {
    emojis.iter().map(|emoji| (*emoji).to_owned()).collect()
}

#[test]
fn the_agent_reaction_replaces_the_working_marker() {
    let agent = owned(&["👍"]);
    assert_eq!(
        finish_reactions(true, true, &agent),
        vec![(ReactionOp::Remove, "👀"), (ReactionOp::Add, "👍")]
    );
}

#[test]
fn a_turn_the_agent_did_not_react_to_ends_with_no_reaction() {
    assert_eq!(
        finish_reactions(true, true, &[]),
        vec![(ReactionOp::Remove, "👀")]
    );
}

#[test]
fn a_failed_turn_is_marked() {
    assert_eq!(
        finish_reactions(true, false, &[]),
        vec![(ReactionOp::Remove, "👀"), (ReactionOp::Add, "❌")]
    );
}

#[test]
fn agent_reactions_mirror_even_with_lifecycle_reactions_off() {
    let agent = owned(&["🙏", "🎉"]);
    assert_eq!(
        finish_reactions(false, true, &agent),
        vec![(ReactionOp::Add, "🙏"), (ReactionOp::Add, "🎉")]
    );
    assert!(finish_reactions(false, true, &[]).is_empty());
    assert!(finish_reactions(false, false, &[]).is_empty());
}

#[test]
fn an_agent_that_chose_the_working_emoji_keeps_it() {
    let agent = owned(&["👀"]);
    assert_eq!(
        finish_reactions(true, true, &agent),
        vec![(ReactionOp::Add, "👀")]
    );
}
