use super::authoring::*;
use super::*;

// ── One search door: skill rows, the loader, and the refusal ──────────────

/// `skills.search` keeps returning **bare** ids — that is what the injected L1
/// index shows and what every existing caller parses — even though it now ranks
/// through the `kind = Skill` filtered view of the one catalog.
#[tokio::test]
async fn search_still_returns_bare_ids_not_catalog_ids() {
    let reg = registry_with(vec![skill(
        "merge-conflicts",
        "Resolve merge conflicts",
        "resolve a git merge conflict",
        "body",
        true,
    )]);
    let out = dispatch("search", json!({ "query": "merge conflict" }), &reg, &[])
        .await
        .expect("search ok");
    let results = out["results"].as_array().expect("results array");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["id"], json!("merge-conflicts"));
}

/// A body-less plugin skill (`register_app_skill` before the skill is
/// materialised on disk) is offered by **none** of the four model-facing doors:
/// the progressive-disclosure L1 index, the always-on/full-body injection,
/// `skills.search`, and `skills.load` — which alone still sees it, so it can
/// say why instead of answering `ok:true` with an empty instruction string.
///
/// The four are asserted together on purpose. The search doors and the injected
/// blocks live on opposite sides of the `apps/core` ↔ `ryu-skills` boundary, and
/// the first cut of this rule only reached the two doors this module owns — so
/// the loudest surface, the index that tells the model to call `skills.load`
/// with the id, kept advertising exactly what `load` had started refusing. This
/// test fails if the two sides drift apart again.
#[tokio::test]
async fn a_body_less_plugin_skill_is_offered_by_no_door() {
    let reg = SkillRegistry::empty();
    reg.register_app_skill(
        "app__summarize".into(),
        "Summarize".into(),
        Some("App-registered skill (skill_id: summarize)".into()),
    );

    // Doors 1 and 2 — the injected blocks (`ryu-skills`). Nothing loadable is
    // enabled, so both must say "no skills" rather than emit an empty section.
    assert!(
        reg.progressive_block(&[]).is_none(),
        "the L1 index must not list a skill whose load is refused"
    );
    assert!(
        reg.skill_block(&[]).is_none(),
        "full-body injection must not emit a bodyless `## Skill:` section"
    );

    // Door 3 — `skills.search`.
    let searched = dispatch("search", json!({ "query": "summarize" }), &reg, &[])
        .await
        .expect("search ok");
    assert!(
        searched["results"].as_array().expect("array").is_empty(),
        "a skill with nothing to load must not be offered: {searched}"
    );

    // Door 4 — `skills.load`, the one that still resolves the record so the
    // refusal can name the actual reason.
    let loaded = dispatch("load", json!({ "id": "app__summarize" }), &reg, &[])
        .await
        .expect("load ok");
    assert_eq!(loaded["ok"], json!(false), "{loaded}");
    assert!(
        loaded["error"]
            .as_str()
            .expect("error string")
            .contains("not installed on this node yet"),
        "{loaded}"
    );

    // Once the same id has a real body on disk it is a normal skill at all four
    // doors — the guard is about the empty body, not about the `app__` prefix.
    let materialised = registry_with(vec![skill(
        "app__summarize",
        "Summarize",
        "d",
        "## Purpose\nsummarize",
        true,
    )]);
    let ok = dispatch(
        "load",
        json!({ "id": "app__summarize" }),
        &materialised,
        &[],
    )
    .await
    .expect("load ok");
    assert_eq!(ok["ok"], json!(true), "{ok}");

    let found = dispatch(
        "search",
        json!({ "query": "summarize" }),
        &materialised,
        &[],
    )
    .await
    .expect("search ok");
    assert_eq!(
        found["results"].as_array().expect("array").len(),
        1,
        "{found}"
    );

    let (index, _) = materialised.progressive_block(&[]).expect("a block");
    assert!(index.contains("app__summarize"), "{index}");
    let (full, ids) = materialised.skill_block(&[]).expect("a block");
    assert!(full.contains("## Purpose"), "{full}");
    assert_eq!(ids, vec!["app__summarize".to_owned()]);
}

/// A model that found the skill through `tool_search` hands back the catalog id
/// it was given. `load` accepts both forms; the exact match wins so a skill
/// genuinely named `skills.x` is still reachable by its own id.
#[tokio::test]
async fn load_accepts_both_the_bare_and_the_catalog_id_form() {
    let reg = registry_with(vec![
        skill("pdf", "PDF", "d", "bare-body", true),
        skill("skills.pdf", "Shadow", "d", "literal-body", true),
    ]);

    let bare = dispatch("load", json!({ "id": "pdf" }), &reg, &[])
        .await
        .expect("load ok");
    assert_eq!(bare["instructions"], json!("bare-body"));

    // Exact match first: `skills.pdf` is a real skill id here, so it wins over
    // reading the same string as a catalog id for `pdf`.
    let literal = dispatch("load", json!({ "id": "skills.pdf" }), &reg, &[])
        .await
        .expect("load ok");
    assert_eq!(literal["instructions"], json!("literal-body"));

    // With no literal collision, the catalog form resolves to the bare skill.
    let plain = registry_with(vec![skill("pdf", "PDF", "d", "bare-body", true)]);
    let via_catalog = dispatch("load", json!({ "id": "skills.pdf" }), &plain, &[])
        .await
        .expect("load ok");
    assert_eq!(via_catalog["ok"], json!(true), "{via_catalog}");
    assert_eq!(via_catalog["instructions"], json!("bare-body"));
}

/// The catalog id form does not widen `load`'s scope: an out-of-allowlist skill
/// is refused through either spelling, with the same undifferentiated wording.
#[tokio::test]
async fn the_catalog_id_form_does_not_bypass_the_skill_allowlist() {
    let reg = registry_with(vec![skill("theirs", "Theirs", "d", "secret", true)]);
    let allow = ["mine".to_string()];
    for id in ["theirs", "skills.theirs"] {
        let out = dispatch("load", json!({ "id": id }), &reg, &allow)
            .await
            .expect("load ok");
        assert_eq!(out["ok"], json!(false), "{id}: {out}");
        assert!(
            out["error"]
                .as_str()
                .expect("error string")
                .contains("no enabled skill with id"),
            "{id}: {out}"
        );
    }
}

/// **The execution boundary.** A model that mistakes a `skills.<slug>` catalog
/// row for a callable tool routes here — this is the backstop, since a request
/// carrying the `"*"` tool-policy wildcard passes the gateway's `is_allowed`
/// gate. It must refuse, and name `skills.load`.
#[tokio::test]
async fn calling_a_skill_id_as_a_tool_is_refused_and_names_the_loader() {
    let reg = registry_with(vec![skill("pdf", "PDF", "d", "body", true)]);
    let err = dispatch("pdf", json!({}), &reg, &[])
        .await
        .expect_err("a skill id must not be callable as a tool");
    let msg = err.to_string();
    assert!(msg.contains("not a callable tool"), "{msg}");
    assert!(msg.contains(LOAD_TOOL_ID), "{msg}");
    assert!(msg.contains("\"id\": \"pdf\""), "{msg}");

    // The refusal is identical for an id that names no skill at all: confirming
    // existence here would be the enumeration oracle the rest of this module
    // scopes to avoid.
    let ghost = dispatch("no-such-skill", json!({}), &reg, &[])
        .await
        .expect_err("still an error");
    assert!(ghost.to_string().contains("not a callable tool"));
    assert_eq!(
        msg.replace("pdf", "X"),
        ghost.to_string().replace("no-such-skill", "X"),
        "the two refusals must differ only in the echoed id"
    );
}

/// The catalog-id helpers are exact inverses, and reject ids outside the
/// namespace (which is what keeps `describe`/`load` from mis-reading a tool id).
#[test]
fn catalog_id_round_trips_and_rejects_foreign_ids() {
    assert_eq!(catalog_id("pdf"), "skills.pdf");
    assert_eq!(slug_from_catalog_id("skills.pdf"), Some("pdf"));
    assert_eq!(slug_from_catalog_id(&catalog_id("app__x")), Some("app__x"));
    assert_eq!(slug_from_catalog_id("exa.search"), None);
    assert_eq!(slug_from_catalog_id("skills"), None);
    // An empty slug is not a skill id.
    assert_eq!(slug_from_catalog_id("skills."), None);
}

/// Carried-over finding: before a plugin is enabled its `app__<id>` skills are
/// in NO snapshot (`register_app_skill` fills the bag on enable; `reload()`
/// never does), so the namespace check saw the id as free and an out-of-scope
/// agent could pre-claim it. The reserved prefix closes that without depending
/// on load order.
#[tokio::test]
async fn an_out_of_scope_agent_cannot_pre_claim_an_unregistered_app_skill_id() {
    let env = author_env();
    let reg = SkillRegistry::empty();
    // Nothing registered, nothing on disk: the id resolves nowhere.
    assert!(reg.list_all().is_empty());
    assert!(ryu_skills::resolve_skill_md("app__summarize").is_none());

    let out = dispatch(
        "author",
        author_args("Summarize", "app__summarize", "do the thing"),
        &reg,
        &["something-else".to_string()],
    )
    .await
    .expect("author returns a soft refusal");
    assert_eq!(out["ok"], json!(false), "{out}");
    let err = out["error"].as_str().expect("error string");
    assert!(
        err.contains("reserved for skills contributed by plugins"),
        "{err}"
    );
    // The refusal must not claim the id exists — it does not.
    assert!(!err.contains("already exists"), "{err}");
    assert!(
        !env.skills_dir
            .join("app__summarize")
            .join("SKILL.md")
            .exists(),
        "a refused call must write nothing"
    );

    // A slug outside the reserved namespace is still creatable by the same
    // out-of-scope agent (the create-vs-refine split is unchanged).
    let ok = dispatch(
        "author",
        author_args("Mine", "mine-own", "do the thing"),
        &reg,
        &["something-else".to_string()],
    )
    .await
    .expect("author ok");
    assert_eq!(ok["ok"], json!(true), "{ok}");
}

/// The reservation gates *claiming*, not refining: an agent allowed to load
/// `app__summarize` may still author it, and the reply does not invent a refine
/// of something that was never there.
#[tokio::test]
async fn an_in_scope_agent_may_still_author_an_app_prefixed_slug() {
    let env = author_env();
    let reg = SkillRegistry::empty();
    let out = dispatch(
        "author",
        author_args("Summarize", "app__summarize", "do the thing"),
        &reg,
        &["app__summarize".to_string()],
    )
    .await
    .expect("author ok");
    assert_eq!(out["ok"], json!(true), "{out}");
    assert_eq!(
        out["refined"],
        json!(false),
        "nothing existed, so nothing was refined: {out}"
    );
    assert!(env
        .skills_dir
        .join("app__summarize")
        .join("SKILL.md")
        .exists());
}
