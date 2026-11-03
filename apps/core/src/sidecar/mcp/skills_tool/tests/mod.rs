use super::author::author_refusal;
use super::authoring_md::sanitize_slug;
use super::catalog::{server_description, tools};
use super::entry::{catalog_id, dispatch, slug_from_catalog_id};
use super::lookup::rank_skills;
use super::*;
use ryu_skills::SkillRecord;

fn registry_with(skills: Vec<SkillRecord>) -> SkillRegistry {
    let reg = SkillRegistry::empty();
    reg.replace_for_test(skills);
    reg
}

fn skill(id: &str, name: &str, desc: &str, body: &str, enabled: bool) -> SkillRecord {
    SkillRecord {
        id: id.to_owned(),
        name: name.to_owned(),
        description: Some(desc.to_owned()),
        instructions: body.to_owned(),
        allowed_tools: vec![],
        enabled,
        always_on: false,
    }
}

mod authoring;
mod authoring_scope;
mod one_door;
mod search;

#[test]
fn lists_two_read_tools_by_default() {
    // Serialize on the shared env lock: another test may be toggling the flag.
    let _env = ryu_skills::SKILLS_ENV_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    std::env::remove_var(AUTHOR_FLAG_ENV);
    let tools = tools();
    assert_eq!(tools.len(), 2, "author is hidden by default");
    assert!(tools.iter().any(|t| t.id == SEARCH_TOOL_ID));
    assert!(tools.iter().any(|t| t.id == LOAD_TOOL_ID));
    assert!(!tools.iter().any(|t| t.id == AUTHOR_TOOL_ID));
    assert!(tools.iter().all(|t| t.server == SERVER_NAME));
}

#[test]
fn lists_author_tool_when_enabled() {
    let _env = ryu_skills::SKILLS_ENV_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    std::env::set_var(AUTHOR_FLAG_ENV, "1");
    let tools = tools();
    std::env::remove_var(AUTHOR_FLAG_ENV);
    assert_eq!(tools.len(), 3);
    assert!(tools.iter().any(|t| t.id == SEARCH_TOOL_ID));
    assert!(tools.iter().any(|t| t.id == LOAD_TOOL_ID));
    assert!(tools.iter().any(|t| t.id == AUTHOR_TOOL_ID));
    assert!(tools.iter().all(|t| t.server == SERVER_NAME));
}

/// The `GET /api/mcp/servers` row must not promise a tool `tools()` withholds.
/// The inline literal this replaced advertised `skills.author` unconditionally, so
/// on a stock (opt-in off) node the listing named a tool that was not there.
#[test]
fn server_description_advertises_author_only_when_it_is_offered() {
    let _env = ryu_skills::SKILLS_ENV_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    std::env::set_var(AUTHOR_FLAG_ENV, "1");
    let with_author = server_description();
    std::env::remove_var(AUTHOR_FLAG_ENV);
    let without_author = server_description();

    assert!(with_author.contains("skills.author"));
    assert!(with_author.contains("skills.search"));
    assert!(
        !without_author.contains("skills.author"),
        "default-off node must not advertise a tool it does not offer: {without_author}"
    );
    assert!(without_author.contains("skills.search"));
}

#[tokio::test]
async fn unknown_tool_is_an_error() {
    let reg = registry_with(vec![]);
    assert!(dispatch("nope", json!({}), &reg, &[]).await.is_err());
}

#[tokio::test]
async fn load_missing_id_is_an_error() {
    let reg = registry_with(vec![]);
    assert!(dispatch("load", json!({}), &reg, &[]).await.is_err());
}

#[tokio::test]
async fn load_returns_body_for_enabled_skill() {
    let reg = registry_with(vec![skill(
        "greeter",
        "Greeter",
        "says hi",
        "Always say hello first.",
        true,
    )]);
    let out = dispatch("load", json!({ "id": "greeter" }), &reg, &[])
        .await
        .expect("ok");
    assert_eq!(out["ok"], json!(true));
    assert_eq!(out["instructions"], json!("Always say hello first."));
}

#[tokio::test]
async fn load_unknown_id_is_soft_error() {
    let reg = registry_with(vec![]);
    let out = dispatch("load", json!({ "id": "ghost" }), &reg, &[])
        .await
        .expect("dispatch ok");
    assert_eq!(out["ok"], json!(false));
    assert!(out["error"].is_string());
}

#[tokio::test]
async fn load_skips_disabled_skill() {
    let reg = registry_with(vec![skill("off", "Off", "d", "body", false)]);
    let out = dispatch("load", json!({ "id": "off" }), &reg, &[])
        .await
        .expect("dispatch ok");
    assert_eq!(out["ok"], json!(false));
}

#[tokio::test]
async fn search_ranks_name_hits_first() {
    let reg = registry_with(vec![
        skill("a", "Web Researcher", "search the web", "uses spider", true),
        skill("b", "Greeter", "polite hello", "say hi", true),
    ]);
    let out = dispatch("search", json!({ "query": "web" }), &reg, &[])
        .await
        .expect("ok");
    let results = out["results"].as_array().expect("array");
    assert_eq!(results[0]["id"], json!("a"));
}

#[tokio::test]
async fn search_missing_query_is_an_error() {
    let reg = registry_with(vec![]);
    assert!(dispatch("search", json!({}), &reg, &[]).await.is_err());
}

#[test]
fn slugs_sanitize_to_one_safe_path_segment() {
    assert_eq!(sanitize_slug("  My Skill!  "), Some("My-Skill".to_owned()));
    assert_eq!(sanitize_slug("../evil"), Some("evil".to_owned()));
    assert_eq!(sanitize_slug("a/b\\c:d"), Some("a-b-c-d".to_owned()));
    for unusable in ["", "..", ".", "///", " - "] {
        assert_eq!(sanitize_slug(unusable), None, "{unusable:?}");
    }
}

#[test]
fn author_refusals_name_the_slug_and_the_move_that_works() {
    let taken = author_refusal("theirs", false);
    assert_eq!(taken["ok"], false);
    assert_eq!(taken["id"], "theirs");
    let message = taken["error"].as_str().expect("error text");
    assert!(message.contains("already exists"), "{message}");
    assert!(
        message.contains("Author under a different slug"),
        "{message}"
    );

    let reserved = author_refusal("app__summarize", true);
    let message = reserved["error"].as_str().expect("error text");
    assert!(message.contains("'app__' namespace"), "{message}");
    assert!(
        message.contains("Author under a different slug"),
        "{message}"
    );
}
