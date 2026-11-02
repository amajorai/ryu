use super::parse_reward;

#[test]
fn parse_reward_handles_formats() {
    assert_eq!(parse_reward("0.82"), Some(0.82));
    assert_eq!(parse_reward("Score: 0.8/1.0"), Some(0.8)); // numerator, not 1.0
    assert_eq!(parse_reward("80"), Some(0.8)); // bare integer read as percentage
    assert_eq!(parse_reward("95"), Some(0.95));
    assert_eq!(parse_reward("1"), Some(1.0));
    assert_eq!(parse_reward("1.0"), Some(1.0));
    assert_eq!(parse_reward("nonsense"), None);
    // Prose with a leading integer must not poison the score (review finding).
    assert_eq!(
        parse_reward("handles 2 edge cases, so I rate it 0.9"),
        Some(0.9)
    );
    assert_eq!(parse_reward("GPT-4 rates this 0.85 overall"), Some(0.85));
}

#[test]
fn bare_percentage_only_when_it_is_the_whole_reply() {
    assert_eq!(parse_reward("80%"), Some(0.8));
    assert_eq!(parse_reward("  Score: 85% \n"), Some(0.85));
    assert_eq!(parse_reward("score:90"), Some(0.9));
    assert_eq!(parse_reward("SCORE: 0"), Some(0.0));
    assert_eq!(parse_reward("100"), Some(1.0));
    // Off-scale or longer than three digits is not a percentage.
    assert_eq!(parse_reward("999"), None);
    assert_eq!(parse_reward("1000"), None);
    // An integer inside prose is never read as a percentage.
    assert_eq!(parse_reward("I rate it 80%"), None);
    assert_eq!(parse_reward("It covers 3 of the 4 points"), None);
    assert_eq!(parse_reward("Score: 80/100"), None);
}

#[test]
fn empty_and_refusal_replies_are_never_a_reward() {
    for reply in [
        "",
        "   \n",
        "I'm sorry, but I can't rate this. It is 100% against policy.",
        "I can\u{2019}t help with that request. 1",
        "I cannot evaluate this content; it scores 1.0 on harm.",
        "As an AI, I must decline to grade this. 0.9",
        "Sorry, but I won't score content like this (0.95).",
        "I am unable to comply with request #42",
        "I refuse. 100",
    ] {
        assert_eq!(parse_reward(reply), None, "{reply:?} must not score");
    }
}

#[test]
fn sentence_dots_are_not_decimals() {
    // "Step 1." used to read as the decimal 1.0 (a perfect reward).
    assert_eq!(parse_reward("Step 1. The reply is wrong. 0.2"), Some(0.2));
    assert_eq!(parse_reward("Point 1. Point 2."), None);
    assert_eq!(parse_reward(".5"), Some(0.5));
}

#[test]
fn a_percent_sign_always_means_a_percentage() {
    // "1%" is one percent, not a perfect 1.0.
    assert_eq!(parse_reward("1%"), Some(0.01));
    assert_eq!(parse_reward("Score: 1%"), Some(0.01));
    assert_eq!(parse_reward("0%"), Some(0.0));
    assert_eq!(parse_reward("1"), Some(1.0));
}

#[test]
fn conflicting_or_negative_decimals_are_no_verdict() {
    for reply in [
        // An echoed score from the graded content next to the judge's own.
        "The reply claims 1.0, but I would give it 0.3",
        "0.9\n\nActually, 0.1",
        // A negative score must not lose its sign and read as a reward.
        "-0.4",
        "Score: \u{2212}0.6",
        "Score: - 0.5",
    ] {
        assert_eq!(parse_reward(reply), None, "{reply:?} must not score");
    }
    // A denominator, a repeated score and out-of-range numbers are not conflicts.
    assert_eq!(parse_reward("0.7 / 1.0"), Some(0.7));
    assert_eq!(parse_reward("0.6, so the final score is 0.6"), Some(0.6));
    assert_eq!(parse_reward("GPT-4.5 rates this 0.85"), Some(0.85));
}

#[test]
fn look_alike_apostrophes_still_read_as_a_refusal() {
    for reply in ["I can\u{02BC}t rate this. 0.9", "I\u{FF07}m sorry: 0.8"] {
        assert_eq!(parse_reward(reply), None, "{reply:?} must not score");
    }
}
