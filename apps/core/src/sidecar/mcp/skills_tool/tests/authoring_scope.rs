use super::authoring::*;
use super::*;

/// Existence is a property of the **namespace**, not of the path `author` writes.
///
/// The guard this pins used to read `dest.exists()`, i.e. only
/// `skills_dir()/<slug>/SKILL.md`. A slug already taken by the legacy flat
/// `<root>/<slug>.md` form therefore looked free, so an out-of-allowlist create
/// succeeded — and since the directory form beats the flat one inside a root
/// (`scan_skill_dir_opts`), the agent's text became what every consumer loads for
/// that id. Same shape as the production two-root case (an id owned by
/// `~/.agents/skills`), which is not reachable here: `RYU_SKILLS_DIR` collapses
/// `skills_scan_roots()` to one root, and the second root is only redirectable via
/// `$HOME`, which too much of this test binary resolves to mutate safely. The
/// two-root half is covered root-explicitly by
/// `ryu_skills`'s `resolve_skill_md_spans_every_root_and_both_layouts`.
#[tokio::test]
async fn out_of_allowlist_create_refuses_a_slug_taken_by_the_legacy_flat_layout() {
    let env = author_env();
    let reg = SkillRegistry::empty();

    // An existing skill in the flat layout — a real id, no `<slug>/SKILL.md`.
    let flat = env.skills_dir.join("theirs.md");
    std::fs::write(&flat, "---\nname: Theirs\n---\ntheir procedure text").expect("seed flat");

    let denied = dispatch(
        "author",
        author_args("Theirs", "theirs", "shadowing text"),
        &reg,
        &["mine".to_owned()],
    )
    .await
    .expect("dispatch ok (soft)");

    assert_eq!(denied["ok"], json!(false), "a taken id may not be shadowed");
    assert!(
        denied["error"]
            .as_str()
            .expect("error message")
            .contains("different slug"),
        "the refusal must still name the recoverable move: {denied}"
    );
    assert!(
        !env.skills_dir.join("theirs").join("SKILL.md").exists(),
        "no shadowing file may be written on a refused call"
    );
    assert_eq!(
        std::fs::read_to_string(&flat).expect("flat skill still there"),
        "---\nname: Theirs\n---\ntheir procedure text",
        "the existing definition is byte-for-byte untouched"
    );
}

/// The unscoped path (every agent-less caller: workflows, monitors, the approval
/// engine) may take an id over — but it must not call that a fresh create.
/// `refined` used to be `dest.exists()`, so shadowing a flat/second-root skill
/// reported `refined: false` *and* activated the shadowing text while telling the
/// model it had authored something new.
#[tokio::test]
async fn unscoped_author_of_a_taken_id_reports_a_refine_and_names_the_shadowed_file() {
    let env = author_env();
    let reg = SkillRegistry::empty();

    let flat = env.skills_dir.join("theirs.md");
    std::fs::write(&flat, "---\nname: Theirs\n---\ntheir procedure text").expect("seed flat");

    let out = dispatch(
        "author",
        author_args("Theirs", "theirs", "replacement text"),
        &reg,
        &[],
    )
    .await
    .expect("author ok");

    assert_eq!(out["ok"], json!(true));
    assert_eq!(
        out["refined"],
        json!(true),
        "taking over an existing id is a refine, however it landed on disk: {out}"
    );
    let note = out["note"].as_str().expect("shadow note");
    assert!(
        note.contains(&flat.to_string_lossy().to_string()),
        "the note must name the file that is now unreachable, got: {note}"
    );
    // Unscoped callers keep activate-on-author: authority they already have.
    assert_eq!(out["active"], json!(true));

    // And the shadow is real — the new text is what loads for that id.
    let loaded = dispatch("load", json!({ "id": "theirs" }), &reg, &[])
        .await
        .expect("load ok");
    assert!(loaded["instructions"]
        .as_str()
        .expect("body")
        .contains("replacement text"));
}

/// `"active": false` has to be enforced, not inferred from "we did not call
/// `set_active`". Activation is keyed by **id** in a node-global set and
/// `SkillRegistry::reload` ANDs `active.contains(id)` into `enabled`, so an orphan
/// entry for the slug (a skill the user activated and later deleted) made the
/// freshly created file active on the very reload `do_author` triggers — while the
/// reply, the tool description and the module doc all claimed otherwise.
#[tokio::test]
async fn a_scoped_create_lands_inactive_even_when_its_id_is_already_active() {
    let _env = author_env();
    let reg = SkillRegistry::empty();

    // Orphan activation: the id is active, nothing on disk resolves to it.
    ryu_skills::set_active("fresh-method", true);
    assert!(ryu_skills::load_active_set().contains("fresh-method"));

    let created = dispatch(
        "author",
        author_args("Fresh Method", "fresh-method", "capture the method"),
        &reg,
        &["mine".to_owned()],
    )
    .await
    .expect("dispatch ok");

    assert_eq!(created["ok"], json!(true));
    assert_eq!(created["active"], json!(false));
    assert!(
        !ryu_skills::load_active_set().contains("fresh-method"),
        "the stale activation must be cleared, or the claim is false"
    );
    // The claim, checked where it is actually decided: not enabled, so not
    // searchable, not loadable, not injected.
    assert!(
        reg.list_all().iter().any(|s| s.id == "fresh-method"),
        "it is installed and visible in the library"
    );
    assert!(
        reg.enabled().iter().all(|s| s.id != "fresh-method"),
        "an out-of-scope create must not be enabled after the reload it triggers"
    );
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
}

#[tokio::test]
async fn author_refines_a_slug_inside_the_agent_allowlist() {
    // The allowlist narrows authoring, it does not disable it: an agent may still
    // refine the skills it is allowed to load.
    let _env = author_env();
    let reg = SkillRegistry::empty();
    let allowlist = vec!["mine".to_owned()];

    let first = dispatch(
        "author",
        author_args("Mine", "mine", "first procedure text"),
        &reg,
        &allowlist,
    )
    .await
    .expect("author ok");
    assert_eq!(first["ok"], json!(true));

    let second = dispatch(
        "author",
        author_args("Mine", "mine", "second procedure text"),
        &reg,
        &allowlist,
    )
    .await
    .expect("refine ok");
    assert_eq!(second["ok"], json!(true));
    assert_eq!(second["refined"], json!(true));
    // In-scope authoring keeps the historical activate-on-author behaviour: only
    // the out-of-scope create path (which may touch slugs the agent was never
    // granted) declines to write the node-global activation set.
    assert_eq!(second["active"], json!(true));
    assert!(ryu_skills::load_active_set().contains("mine"));

    let loaded = dispatch("load", json!({ "id": "mine" }), &reg, &allowlist)
        .await
        .expect("load ok");
    assert!(loaded["instructions"]
        .as_str()
        .expect("body")
        .contains("second procedure text"));
}

#[tokio::test]
async fn author_missing_required_arg_is_an_error() {
    let _env = author_env();
    let reg = SkillRegistry::empty();
    // No `verification`.
    let args = json!({
        "name": "x",
        "slug": "x",
        "purpose": "p",
        "procedure": "pr",
        "failure_modes": "f",
    });
    assert!(dispatch("author", args, &reg, &[]).await.is_err());
}

#[tokio::test]
async fn author_slug_cannot_escape_skills_dir() {
    let env = author_env();
    let reg = SkillRegistry::empty();

    // A traversal slug is sanitized to a single safe segment; nothing is ever
    // written outside skills_dir.
    let out = dispatch("author", author_args("Evil", "../evil", "x"), &reg, &[]).await;
    if let Ok(v) = out {
        let path = v["path"].as_str().expect("path");
        assert!(
            std::path::Path::new(path).starts_with(&env.skills_dir),
            "authored skill must stay inside skills_dir, got {path}"
        );
    }
    let escaped = env
        .skills_dir
        .parent()
        .expect("parent")
        .join("evil")
        .join("SKILL.md");
    assert!(!escaped.exists(), "traversal must not write a sibling dir");

    // A slug that sanitizes to nothing safe is a hard error (writes nothing).
    assert!(
        dispatch("author", author_args("Dots", "..", "x"), &reg, &[])
            .await
            .is_err()
    );
}

#[tokio::test]
async fn author_front_matter_escaping_roundtrips() {
    let env = author_env();
    let reg = SkillRegistry::empty();

    // Quotes, a colon, and a `---` sequence in the name must stay inside the
    // YAML value instead of breaking the front-matter block.
    let tricky = r#"Weird: "quoted" --- name"#;
    let args = json!({
        "name": tricky,
        "slug": "tricky",
        "purpose": "p",
        "procedure": "pr",
        "failure_modes": "f",
        "verification": "v",
    });
    let out = dispatch("author", args, &reg, &[])
        .await
        .expect("author ok");
    assert_eq!(out["ok"], json!(true));

    let md =
        std::fs::read_to_string(env.skills_dir.join("tricky").join("SKILL.md")).expect("read back");
    let rec = ryu_skills::parse_skill_md("tricky", &md).expect("escaped front-matter round-trips");
    assert_eq!(rec.name, tricky);
}
