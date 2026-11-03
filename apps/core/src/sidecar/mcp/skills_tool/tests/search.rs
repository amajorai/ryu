use super::*;

// ── per-agent skill allowlist ─────────────────────────────────────────────

#[tokio::test]
async fn load_refuses_skill_outside_the_agent_allowlist() {
    // Both skills are globally enabled; the agent is only allowed `mine`.
    let reg = registry_with(vec![
        skill("mine", "Mine", "d", "my body", true),
        skill("theirs", "Theirs", "d", "secret body", true),
    ]);
    let allowlist = vec!["mine".to_owned()];

    let ok = dispatch("load", json!({ "id": "mine" }), &reg, &allowlist)
        .await
        .expect("dispatch ok");
    assert_eq!(ok["ok"], json!(true));
    assert_eq!(ok["instructions"], json!("my body"));

    let denied = dispatch("load", json!({ "id": "theirs" }), &reg, &allowlist)
        .await
        .expect("dispatch ok");
    assert_eq!(denied["ok"], json!(false));
    assert!(
        !denied.to_string().contains("secret body"),
        "an out-of-allowlist body must never be returned: {denied}"
    );
    // Indistinguishable from a nonexistent id, so the error cannot be used to
    // probe for skills outside the allowlist.
    let ghost = dispatch("load", json!({ "id": "nonexistent" }), &reg, &allowlist)
        .await
        .expect("dispatch ok");
    assert_eq!(
        denied["error"].as_str().map(|e| e.replace("theirs", "X")),
        ghost["error"]
            .as_str()
            .map(|e| e.replace("nonexistent", "X")),
        "denied and unknown ids must share one message shape"
    );
}

#[tokio::test]
async fn empty_allowlist_still_loads_every_enabled_skill() {
    // The documented back-compat default (`enabled_for`: empty = all enabled),
    // which every agent-less caller relies on.
    let reg = registry_with(vec![skill("mine", "Mine", "d", "body", true)]);
    let out = dispatch("load", json!({ "id": "mine" }), &reg, &[])
        .await
        .expect("dispatch ok");
    assert_eq!(out["ok"], json!(true));
}

#[tokio::test]
async fn search_hides_skills_outside_the_agent_allowlist() {
    // Search must be scoped too, or it leaks exactly what `load` refuses.
    let reg = registry_with(vec![
        skill("mine", "Web Researcher", "search the web", "body", true),
        skill("theirs", "Web Scraper", "search the web", "body", true),
    ]);
    let out = dispatch(
        "search",
        json!({ "query": "web" }),
        &reg,
        &["mine".to_owned()],
    )
    .await
    .expect("ok");
    let results = out["results"].as_array().expect("array");
    assert_eq!(results.len(), 1, "only the allowed skill is visible");
    assert_eq!(results[0]["id"], json!("mine"));
}

// ── ranking (shared with the tool catalog) ────────────────────────────────

/// `rank_skills` is driven directly with an explicit ranker so the assertion is
/// about the ranking contract, not about whatever `tools.active_ranker` happens
/// to be set to in the environment running the test.
#[tokio::test]
async fn search_ranks_through_the_shared_bm25_ranker() {
    let skills = vec![
        skill("unrelated", "Greeter", "polite hello", "body", true),
        skill(
            "merge-conflicts",
            "Resolve merge conflicts",
            "fix a conflicted rebase",
            "body",
            true,
        ),
        skill(
            "rebase-helper",
            "Rebase helper",
            "rewrite history safely",
            "body",
            true,
        ),
    ];

    let rows = rank_skills("merge conflicts", 10, &skills, ToolRanker::Bm25, None, None).await;
    assert_eq!(
        rows[0]["id"],
        json!("merge-conflicts"),
        "the best lexical match ranks first: {rows:?}"
    );
    assert!(
        !rows.iter().any(|r| r["id"] == json!("unrelated")),
        "a zero-scoring skill must be dropped, not padded in: {rows:?}"
    );

    // An exact id match takes the crate's exact-match boost — the same behaviour
    // `tool_search` gets, which the old substring scorer could not express.
    let rows = rank_skills("rebase-helper", 10, &skills, ToolRanker::Bm25, None, None).await;
    assert_eq!(rows[0]["id"], json!("rebase-helper"));

    // No match at all → an empty result set, never a list of arbitrary skills.
    let rows = rank_skills("photosynthesis", 10, &skills, ToolRanker::Bm25, None, None).await;
    assert!(rows.is_empty(), "unrelated query returns nothing: {rows:?}");
}

/// A deterministic stand-in for Core's `CoreToolEmbedder`, so the Semantic path
/// is exercised without a model. Texts are embedded as a tiny bag-of-keywords
/// vector with a **constant axis**, reproducing the property that broke the
/// zero-score filter: a real sentence embedder returns a comfortably positive
/// cosine for unrelated pairs. `fail_on` substrings return `None`, which is how
/// `semantic_score` documents a per-item embedding failure (that item → `0.0`).
struct FakeEmbedder {
    fail_on: Vec<String>,
}

#[async_trait::async_trait]
impl ToolEmbedder for FakeEmbedder {
    async fn embed(&self, text: &str) -> Option<Vec<f32>> {
        if self.fail_on.iter().any(|needle| text.contains(needle)) {
            return None;
        }
        let lower = text.to_ascii_lowercase();
        Some(vec![
            lower.matches("web").count() as f32,
            lower.matches("git").count() as f32,
            1.0,
        ])
    }
}

fn ranked_ids(rows: &[Value]) -> Vec<String> {
    rows.iter()
        .map(|r| r["id"].as_str().unwrap_or_default().to_owned())
        .collect()
}

/// The zero-score cut is lexical-only. Under a live embedder a skill whose own
/// `embed` call fails scores `0.0`, and dropping it would make that skill
/// invisible to `skills.search` while the identical failure only costs a tool
/// its rank in `tool_search`.
#[tokio::test]
async fn semantic_ranker_keeps_a_zero_scored_skill_visible() {
    let skills = vec![
        skill("web-helper", "Web Helper", "browse the web", "body", true),
        skill(
            "git-helper",
            "Git Helper",
            "rewrite git history",
            "body",
            true,
        ),
    ];
    let embedder = FakeEmbedder {
        // Only this skill's document fails; the query and its sibling embed fine.
        fail_on: vec!["git-helper".to_owned()],
    };

    let rows = rank_skills(
        "web",
        10,
        &skills,
        ToolRanker::Semantic,
        Some(&embedder),
        None,
    )
    .await;
    let ids = ranked_ids(&rows);
    assert!(
        ids.contains(&"git-helper".to_owned()),
        "a skill whose embedding failed must stay visible, only ranked lower: {ids:?}"
    );
    assert_eq!(
        ids.first().map(String::as_str),
        Some("web-helper"),
        "the semantically closest skill still ranks first: {ids:?}"
    );

    // The contrast that makes the divergence deliberate rather than accidental:
    // under BM25 the same non-matching skill *is* dropped, because there `0.0`
    // means "no query term occurred at all".
    let lexical = ranked_ids(&rank_skills("web", 10, &skills, ToolRanker::Bm25, None, None).await);
    assert_eq!(lexical, vec!["web-helper".to_owned()]);
}

/// `ranker == Semantic` with no embedder is `run_search`'s documented BM25
/// fallback, so the scores are lexical and the "no match → empty" cut must still
/// apply — otherwise an unreachable embedder would silently start padding
/// arbitrary skills into every search.
#[tokio::test]
async fn semantic_without_an_embedder_keeps_the_bm25_cut() {
    let skills = vec![skill(
        "web-helper",
        "Web Helper",
        "browse the web",
        "b",
        true,
    )];
    let rows = rank_skills(
        "photosynthesis",
        10,
        &skills,
        ToolRanker::Semantic,
        None,
        None,
    )
    .await;
    assert!(
        rows.is_empty(),
        "the BM25 fallback keeps the empty-on-no-match contract: {rows:?}"
    );
}

#[tokio::test]
async fn search_respects_the_limit_and_result_shape() {
    let skills: Vec<SkillRecord> = (0..5)
        .map(|i| skill(&format!("s{i}"), "Web thing", "about the web", "body", true))
        .collect();
    let rows = rank_skills("web", 2, &skills, ToolRanker::Bm25, None, None).await;
    assert_eq!(rows.len(), 2, "limit is honoured");
    // The JSON shape the model sees is unchanged by the ranker swap: exactly
    // these three keys, `description` still nullable. Key order is not part of
    // the shape: Core's `serde_json` keeps insertion order (`preserve_order`).
    let mut keys: Vec<&String> = rows[0].as_object().expect("object").keys().collect();
    keys.sort();
    assert_eq!(keys, vec!["description", "id", "name"]);
}
