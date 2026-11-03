//! `skills.search` and `skills.load`: ranking, allowlist scoping, and the L2
//! body loader.

use super::*;

/// Rank `skills` against `query` and return the tool's result rows, best first.
///
/// Split out from [`do_search`] so the ranking contract is testable without going
/// near the preferences store: the caller injects the ranker instead of it being
/// read from disk.
///
/// Zero-scored rows are dropped under a **lexical** ranker only; see the inline
/// comment on the filter for why that cut is wrong under a live embedder.
pub(super) async fn rank_skills(
    query: &str,
    limit: usize,
    skills: &[SkillRecord],
    ranker: ToolRanker,
    embedder: Option<&dyn ToolEmbedder>,
    selector: Option<&dyn ryu_tool_registry::ToolSelector>,
) -> Vec<Value> {
    let candidates: Vec<ToolDescriptor> = skills.iter().map(descriptor_for).collect();
    // `kind = Some(Skill)`: this call is literally the kind-filtered view of the one
    // catalog. The candidate set is already skills-only, so the filter is a no-op on
    // *this* input — it is passed anyway so the door cannot silently start returning
    // non-skills if the candidate set ever widens, and so the two doors run the same
    // `run_search` shape. No Composio descriptors participate.
    let ranked = ryu_tool_registry::run_search_with_selector(
        query,
        candidates,
        Vec::new(),
        Some(ToolKind::Skill),
        limit,
        ranker,
        embedder,
        selector,
    )
    .await;

    // Whether a `0.0` score means "irrelevant" is ranker-dependent, so the cut has
    // to be too. This is the one place `skills.search` diverges from
    // `McpRegistry::search_scoped`, which never drops a ranked row.
    //
    // - **Lexical (BM25, and the Semantic→BM25 fallback): drop zeros.** A `0.0`
    //   there means *no query term occurred in the document at all*: `bm25_score`'s
    //   IDF is `ln(((n - df + 0.5) / (df + 0.5)) + 1.0)`, and the `+ 1.0` smoothing
    //   keeps it strictly positive even for a term present in every candidate, so a
    //   genuine match can never be false-dropped. Dropping preserves this tool's
    //   pre-existing "no match → empty results" contract (the old substring scorer
    //   dropped `score <= 0`), which is what stops a query like "quantum physics"
    //   from returning `limit` arbitrary skills for the model to load.
    // - **Semantic with a live embedder: keep every row.** Cosine similarity has no
    //   zero floor for irrelevance — a real sentence embedder returns ~0.3-0.9 for
    //   almost any pair — so the filter would drop *nothing* on the off-topic query
    //   it exists for, while `0.0` there means something else entirely:
    //   `semantic_score` assigns `0.0` to an item whose own `embed` call failed
    //   (documented at `tool-registry/src/lib.rs`). Filtering would make that skill
    //   **invisible** to `skills.search` while the same failure only costs a tool
    //   its rank in `tool_search`. A flaky embedder must cost a skill position,
    //   never visibility; relevance under Semantic is expressed by the ordering.
    //
    // `ranker == Semantic` with no embedder is `run_search`'s documented BM25
    // fallback, so the scores really are lexical there and the cut applies.
    let scores_are_lexical = !matches!(ranker, ToolRanker::Semantic) || embedder.is_none();

    ranked
        .into_iter()
        // Filtering *after* truncation loses nothing: the kept set is the descending
        // top-`limit`, so anything dropped here sorted at or below every survivor.
        .filter(|d| !scores_are_lexical || d.score.unwrap_or(0.0) > 0.0)
        // Map back to skill rows by id, un-qualifying `skills.<slug>` first. The
        // registry is the source of truth for the returned `name`/`description`, and
        // this door keeps returning the **bare** slug: that is what the injected L1
        // index shows, what `skills.load` has always taken, and what any existing
        // caller parses. (`skills.load` accepts the qualified form too, so a model
        // that found the skill through `tool_search` is not stranded.)
        .filter_map(|d| {
            let slug = slug_from_catalog_id(&d.id)?;
            skills.iter().find(|s| s.id == slug)
        })
        .map(|s| {
            json!({
                "id": s.id,
                "name": s.name,
                "description": s.description,
            })
        })
        .collect()
}

pub(super) async fn do_search(
    arguments: Value,
    registry: &SkillRegistry,
    skills_allowlist: &[String],
) -> Result<Value> {
    let query = arguments
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("missing required string argument 'query'"))?;
    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, SEARCH_MAX_LIMIT))
        .unwrap_or(SEARCH_DEFAULT_LIMIT);

    // Same scope as the injected index: search must not reveal a skill this agent
    // is not allowed to load. Body-less records are dropped for the reason in
    // [`is_loadable`] — offering a skill whose `load` returns nothing is the
    // healthy-status-for-a-dead-thing defect, not a discovery win.
    let skills: Vec<SkillRecord> = registry
        .enabled_for(skills_allowlist)
        .into_iter()
        .filter(is_loadable)
        .collect();

    let ranker = resolve_ranker().await;
    // Built lazily for the selected model/embedding ranker. `from_registry` loads
    // the model registry off disk, while the Needle 3 selector resolves its own
    // pinned runtime on first use.
    let embedder = matches!(ranker, ToolRanker::Semantic)
        .then(crate::tool_registry_host::CoreToolEmbedder::from_registry);
    let selector: Option<std::sync::Arc<dyn ryu_tool_registry::ToolSelector>> = match ranker {
        ToolRanker::Needle3 => Some(crate::needle3::selector()),
        ToolRanker::Needle2 => Some(crate::needle2::selector()),
        _ => None,
    };
    let results = rank_skills(
        query,
        limit,
        &skills,
        ranker,
        embedder.as_ref().map(|e| e as &dyn ToolEmbedder),
        selector
            .as_deref()
            .map(|s| s as &dyn ryu_tool_registry::ToolSelector),
    )
    .await;

    Ok(json!({ "ok": true, "results": results }))
}

pub(super) fn do_load(
    arguments: Value,
    registry: &SkillRegistry,
    skills_allowlist: &[String],
) -> Result<Value> {
    let id = arguments
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("missing required string argument 'id'"))?;

    // `enabled_for`, not `enabled`: an agent must not be able to load a skill by id
    // that its allowlist keeps out of the index it was shown.
    let permitted = registry.enabled_for(skills_allowlist);

    // Accept both id forms. The bare slug is what the injected L1 index and
    // `skills.search` show; `skills.<slug>` is what the merged tool catalog shows,
    // and a model that discovered the skill through `tool_search` will hand back the
    // id it was given. Exact match is tried FIRST so a skill genuinely named
    // `skills.foo` (nothing forbids the slug — `sanitize_slug` keeps `_`) still
    // wins over the un-qualified reading of its own id.
    let found = permitted.iter().find(|s| s.id == id).or_else(|| {
        slug_from_catalog_id(id).and_then(|slug| permitted.iter().find(|s| s.id == slug))
    });

    match found {
        // A record with no instruction body is a registered-but-not-materialised
        // plugin skill (see [`is_loadable`]). Returning `ok:true` with an empty
        // string told the model it had loaded instructions it did not get. This
        // branch is reached only for a skill already inside `enabled_for`'s scope —
        // i.e. one the caller can already see in its L1 index — so naming it
        // distinctly reveals nothing the caller did not have.
        Some(s) if !is_loadable(s) => Ok(json!({
            "ok": false,
            "id": s.id,
            "error": format!(
                "skill '{}' is registered by a plugin but its instructions are not \
                 installed on this node yet, so there is nothing to load.",
                s.id
            ),
        })),
        Some(s) => {
            crate::stats_beacon::record_skill_load(&s);
            Ok(json!({
                "ok": true,
                "id": s.id,
                "name": s.name,
                "instructions": s.instructions,
            }))
        }
        // Wording is intentionally identical for "does not exist", "disabled" and
        // "outside your allowlist": a distinguishable message would let an agent
        // enumerate skills it is not allowed to see.
        None => Ok(json!({
            "ok": false,
            "id": id,
            "error": format!("no enabled skill with id '{id}'. Use skills.search to find one."),
        })),
    }
}
