use crate::server::{skill_card_matches_query, skill_cards_from_value, SKILL_ALL_SOURCES_ID};
use serde_json::json;

#[test]
fn all_view_selector_is_not_a_registered_source_id() {
    assert_eq!(SKILL_ALL_SOURCES_ID, "all");
}

#[test]
fn card_matching_covers_id_name_source_and_description() {
    let card = json!({
        "id": "lobehub/lateral-thinking",
        "name": "Lateral Thinking",
        "source": "lobehub",
        "description": "Explore alternate solutions"
    });
    assert!(skill_card_matches_query(&card, "lateral"));
    assert!(skill_card_matches_query(&card, "alternate"));
    assert!(skill_card_matches_query(&card, "LOBEHUB"));
    assert!(!skill_card_matches_query(&card, "calendar"));
    assert!(skill_card_matches_query(&card, ""));
}

#[test]
fn source_response_without_skills_degrades_to_empty() {
    assert!(skill_cards_from_value(json!({ "items": [] })).is_empty());
}
