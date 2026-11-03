use super::*;

// ── skills.author ────────────────────────────────────────────────────────

/// Point the skills dir + activation file at fresh tempdirs and hold the env
/// lock for the life of the returned guard, so author tests can round-trip real
/// disk I/O without clobbering each other.
pub(super) struct AuthorEnv {
    pub(super) _guard: std::sync::MutexGuard<'static, ()>,
    pub(super) _skills: tempfile::TempDir,
    pub(super) _active: tempfile::TempDir,
    pub(super) skills_dir: std::path::PathBuf,
}

impl Drop for AuthorEnv {
    fn drop(&mut self) {
        std::env::remove_var("RYU_SKILLS_DIR");
        std::env::remove_var("RYU_SKILLS_ACTIVE_FILE");
        std::env::remove_var(AUTHOR_FLAG_ENV);
    }
}

pub(super) fn author_env() -> AuthorEnv {
    // Shared with the `skills` and `skills_catalog::from_source` test modules:
    // all three point the global RYU_SKILLS_* vars at their own tempdirs, so
    // they must serialize or a clobbered set_var falls through to the real dir.
    let guard = ryu_skills::SKILLS_ENV_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let skills = tempfile::tempdir().expect("skills tempdir");
    let active = tempfile::tempdir().expect("active tempdir");
    std::env::set_var("RYU_SKILLS_DIR", skills.path());
    std::env::set_var("RYU_SKILLS_ACTIVE_FILE", active.path().join("active.json"));
    // The author tool is default-off; opt this test node in.
    std::env::set_var(AUTHOR_FLAG_ENV, "1");
    let skills_dir = skills.path().to_path_buf();
    AuthorEnv {
        _guard: guard,
        _skills: skills,
        _active: active,
        skills_dir,
    }
}

pub(super) fn author_args(name: &str, slug: &str, procedure: &str) -> Value {
    json!({
        "name": name,
        "slug": slug,
        "description": "does a thing",
        "purpose": "when you need to do the thing",
        "procedure": procedure,
        "failure_modes": "watch out for the edge",
        "verification": "confirm it worked",
    })
}

#[tokio::test]
async fn authored_skill_roundtrips_through_loader() {
    let env = author_env();
    let reg = SkillRegistry::empty();

    let out = dispatch(
        "author",
        author_args("My Skill", "my-skill", "do step one"),
        &reg,
        &[],
    )
    .await
    .expect("author ok");
    assert_eq!(out["ok"], json!(true));
    assert_eq!(out["id"], json!("my-skill"));
    assert_eq!(out["refined"], json!(false));

    let md_path = env.skills_dir.join("my-skill").join("SKILL.md");
    assert!(md_path.exists(), "SKILL.md written to skills_dir/<slug>");

    let contents = std::fs::read_to_string(&md_path).expect("read back");
    let rec = ryu_skills::parse_skill_md("my-skill", &contents)
        .expect("authored file parses through the loader");
    assert_eq!(rec.name, "My Skill");
    assert!(rec.instructions.contains("## Purpose"));
    assert!(rec.instructions.contains("## Procedure"));
    assert!(rec.instructions.contains("## Failure modes"));
    assert!(rec.instructions.contains("## Verification"));
    assert!(rec.instructions.contains("do step one"));
}

#[tokio::test]
async fn author_then_search_and_load() {
    let _env = author_env();
    let reg = SkillRegistry::empty();

    dispatch(
        "author",
        author_args("Conflict Resolver", "conflict-resolver", "rebase carefully"),
        &reg,
        &[],
    )
    .await
    .expect("author ok");

    // reload (inside do_author) + set_active make it enabled and discoverable.
    let found = dispatch("search", json!({ "query": "conflict" }), &reg, &[])
        .await
        .expect("search ok");
    let results = found["results"].as_array().expect("array");
    assert!(
        results
            .iter()
            .any(|r| r["id"] == json!("conflict-resolver")),
        "authored skill is searchable after authoring"
    );

    let loaded = dispatch("load", json!({ "id": "conflict-resolver" }), &reg, &[])
        .await
        .expect("load ok");
    assert_eq!(loaded["ok"], json!(true));
    assert!(loaded["instructions"]
        .as_str()
        .expect("body")
        .contains("rebase carefully"));
}

#[tokio::test]
async fn refine_overwrites_existing() {
    let _env = author_env();
    let reg = SkillRegistry::empty();

    let first = dispatch(
        "author",
        author_args("Refiner", "refiner", "first procedure text"),
        &reg,
        &[],
    )
    .await
    .expect("first author ok");
    assert_eq!(first["refined"], json!(false));

    let second = dispatch(
        "author",
        author_args("Refiner", "refiner", "second procedure text"),
        &reg,
        &[],
    )
    .await
    .expect("second author ok");
    assert_eq!(second["refined"], json!(true));

    let loaded = dispatch("load", json!({ "id": "refiner" }), &reg, &[])
        .await
        .expect("load ok");
    let body = loaded["instructions"].as_str().expect("body");
    assert!(
        body.contains("second procedure text"),
        "refined body persists"
    );
    assert!(!body.contains("first procedure text"), "old body replaced");
}

#[tokio::test]
async fn author_is_a_noop_when_disabled() {
    let _guard = ryu_skills::SKILLS_ENV_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let skills = tempfile::tempdir().expect("skills tempdir");
    let active = tempfile::tempdir().expect("active tempdir");
    std::env::set_var("RYU_SKILLS_DIR", skills.path());
    std::env::set_var("RYU_SKILLS_ACTIVE_FILE", active.path().join("active.json"));
    std::env::remove_var(AUTHOR_FLAG_ENV); // default-off

    let reg = SkillRegistry::empty();
    let out = dispatch("author", author_args("Nope", "nope", "x"), &reg, &[])
        .await
        .expect("dispatch ok (soft)");

    std::env::remove_var("RYU_SKILLS_DIR");
    std::env::remove_var("RYU_SKILLS_ACTIVE_FILE");

    assert_eq!(out["ok"], json!(false));
    assert_eq!(out["available"], json!(false));
    assert!(
        !skills.path().join("nope").join("SKILL.md").exists(),
        "disabled author must write nothing"
    );
}

/// The overwrite half of the scope rule: a scoped agent may not refine — or even
/// truncate — a skill it was not given. Refusal is soft (the turn continues) and
/// the existing body is byte-for-byte untouched.
#[tokio::test]
async fn author_refuses_to_overwrite_a_skill_outside_the_agent_allowlist() {
    let env = author_env();
    let reg = SkillRegistry::empty();

    // An existing skill this agent was not given.
    dispatch(
        "author",
        author_args("Theirs", "theirs", "their procedure text"),
        &reg,
        &[],
    )
    .await
    .expect("seed author ok");

    let allowlist = vec!["mine".to_owned()];
    let denied = dispatch(
        "author",
        author_args("Theirs", "theirs", "clobbered text"),
        &reg,
        &allowlist,
    )
    .await
    .expect("dispatch ok (soft)");
    assert_eq!(denied["ok"], json!(false));

    // The write is refused, not partially applied: the other skill's body stands.
    let body = std::fs::read_to_string(env.skills_dir.join("theirs").join("SKILL.md"))
        .expect("existing SKILL.md still there");
    assert!(body.contains("their procedure text"), "body untouched");
    assert!(!body.contains("clobbered text"));

    // The refusal must name the one move that CAN succeed. Without it the model's
    // rational next step is another name, and under the previous gate (which
    // scoped creation too) no name could ever work — unbounded wasted rounds.
    let error = denied["error"].as_str().expect("error message");
    assert!(
        error.contains("different slug"),
        "refusal must point at the recoverable move, got: {error}"
    );
}

/// The creation half: a **new** slug is by definition not in any allowlist, so
/// gating creation on the allowlist made authoring impossible for every scoped
/// agent. Creation clobbers nothing, so it is allowed — but it is NOT activated,
/// because `ryu_skills::set_active` writes a node-global set and would inject a
/// skill this agent was never granted into every other agent's prompt.
#[tokio::test]
async fn a_scoped_agent_can_create_a_new_skill_but_it_lands_inactive() {
    let env = author_env();
    let reg = SkillRegistry::empty();
    let allowlist = vec!["mine".to_owned()];

    let created = dispatch(
        "author",
        author_args("Fresh Method", "fresh-method", "capture the method"),
        &reg,
        &allowlist,
    )
    .await
    .expect("dispatch ok");

    assert_eq!(created["ok"], json!(true), "creation must be possible");
    assert_eq!(created["id"], json!("fresh-method"));
    assert_eq!(created["refined"], json!(false));
    assert_eq!(
        created["active"],
        json!(false),
        "out-of-scope create is inert"
    );

    let md = env.skills_dir.join("fresh-method").join("SKILL.md");
    let body = std::fs::read_to_string(&md).expect("SKILL.md written");
    assert!(body.contains("capture the method"));

    // Inactive is enforced at the source of truth (the global activation set),
    // which `SkillRegistry::reload` ANDs into `record.enabled`.
    assert!(
        !ryu_skills::load_active_set().contains("fresh-method"),
        "a scoped create must not enter the node-global activation set"
    );

    // Consequence, asserted rather than assumed: nobody sees it until a human
    // activates it — not the author (also out of its allowlist), not an unscoped
    // agent (inactive ⇒ not `enabled`).
    let searched = dispatch("search", json!({ "query": "method" }), &reg, &[])
        .await
        .expect("search ok");
    assert!(
        searched["results"]
            .as_array()
            .expect("array")
            .iter()
            .all(|r| r["id"] != json!("fresh-method")),
        "an inactive skill must not be searchable"
    );
    let loaded = dispatch("load", json!({ "id": "fresh-method" }), &reg, &allowlist)
        .await
        .expect("load ok (soft)");
    assert_eq!(loaded["ok"], json!(false));
}

/// The accepted, documented leak: create and refuse are distinguishable, so an
/// out-of-allowlist call reveals whether that slug exists. Pinned as a test so the
/// trade-off is a decision, not an accident — the alternative that hides it (reply
/// with a fake successful create) would lie to the model about what is on disk.
/// The allowlist is a scoping tool, not a confidentiality boundary (see
/// [`dispatch`]), and every probe of a free slug leaves a real SKILL.md behind.
#[tokio::test]
async fn out_of_allowlist_create_and_refuse_are_deliberately_distinguishable() {
    let _env = author_env();
    let reg = SkillRegistry::empty();
    let allowlist = vec!["mine".to_owned()];

    dispatch(
        "author",
        author_args("Theirs", "theirs", "their procedure text"),
        &reg,
        &[],
    )
    .await
    .expect("seed author ok");

    let existing = dispatch(
        "author",
        author_args("Theirs", "theirs", "x"),
        &reg,
        &allowlist,
    )
    .await
    .expect("dispatch ok (soft)");
    let free = dispatch(
        "author",
        author_args("Nobody", "nobody", "x"),
        &reg,
        &allowlist,
    )
    .await
    .expect("dispatch ok");

    assert_eq!(existing["ok"], json!(false));
    assert_eq!(free["ok"], json!(true));
}
