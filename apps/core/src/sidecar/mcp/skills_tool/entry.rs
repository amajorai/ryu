//! The `skills.*` dispatcher and the catalog-id forms a skill is offered under.

use super::*;

/// Dispatch a `skills` tool call against the live skill registry.
///
/// `skills_allowlist` is the **calling agent's** per-agent skill allowlist
/// (`AgentRecord.skills`), resolved by the registry dispatcher. It scopes `search`
/// and `load` to exactly the set the injected L1 index shows, via
/// [`SkillRegistry::enabled_for`], and scopes which slugs `author` may write.
///
/// **Empty = all enabled** — `enabled_for`'s documented back-compat semantics, and
/// a deliberate fail-open here. The callers with no agent card at all (workflows,
/// monitors, recipes, the approval engine re-running an approved call) pass an
/// empty slice, as does an agent whose record cannot be read. Failing *closed*
/// there would strip skills from callers that legitimately had them before this
/// gate existed, and would buy no security: a skill is instruction text with no
/// secrets, so the allowlist is a scoping tool (keep an agent focused on its own
/// skills), not a confidentiality boundary.
///
/// `Err` only for a malformed call (unknown tool / missing required arg); an
/// unknown, inactive, or out-of-allowlist skill id is a structured
/// `Ok({ok:false,...})` so the agent's turn continues.
pub async fn dispatch(
    tool: &str,
    arguments: Value,
    registry: &SkillRegistry,
    skills_allowlist: &[String],
) -> Result<Value> {
    match tool {
        "search" => do_search(arguments, registry, skills_allowlist).await,
        "load" => do_load(arguments, registry, skills_allowlist),
        "author" => do_author(arguments, registry, skills_allowlist),
        // Everything else under the `skills` server — including a `skills.<slug>`
        // id the model found in `tool_search` and mistook for a callable tool.
        //
        // This is where "a skill must not become callable" is actually enforced.
        // Merging skills into the one catalog put `skills.<slug>` ids in front of
        // models, and a request whose tool policy resolved to the `"*"` wildcard
        // sails through the gateway's `is_allowed` gate, so this arm is the backstop
        // rather than a second opinion. It refuses with an `Err` (a malformed call,
        // like `do_load`'s missing `id`) and names the one move that works.
        //
        // The message is deliberately **independent of whether `{other}` names a
        // real skill**: a reply that confirmed existence would hand an agent the
        // enumeration oracle the rest of this module spends its scoping avoiding.
        // Pointing every caller at `skills.load` costs nothing — `load` re-checks
        // the allowlist and answers identically for "absent" and "not yours".
        other => Err(anyhow::anyhow!(
            "'{SERVER_NAME}.{other}' is not a callable tool. The {SERVER_NAME} server \
             exposes {SEARCH_TOOL_ID} / {LOAD_TOOL_ID} / {AUTHOR_TOOL_ID}. If '{other}' is \
             an Agent Skill id, skills are instruction text you load, not functions you \
             call: use {LOAD_TOOL_ID} with {{\"id\": \"{other}\"}} and follow the \
             instructions it returns."
        )),
    }
}

/// Resolve the active [`ToolRanker`] from the `tools.active_ranker` pref.
///
/// Duplicates the four lines of `McpRegistry::resolve_ranker` because that is a
/// private method on the registry object, and this dispatcher is handed a
/// [`SkillRegistry`] only — there is no `McpRegistry` handle to borrow it from.
/// The pref key itself ([`RANKER_PREF_KEY`]) is the shared constant, so the two
/// resolutions cannot drift on *which* pref they read. An unopenable store
/// degrades to the Needle 3 default, exactly as it does for `tool_search`.
pub(super) async fn resolve_ranker() -> ToolRanker {
    let pref = match crate::server::preferences::PreferencesStore::open_default() {
        Ok(p) => p.get(RANKER_PREF_KEY).await.ok().flatten(),
        Err(_) => None,
    };
    ToolRanker::from_pref(pref.as_deref())
}

/// The catalog id a skill appears under: `skills.<slug>`.
///
/// Skills share the `skills` server segment with the `skills.*` tools that serve
/// them, and that is load-bearing in three places, not cosmetic:
///
/// - `ToolDescriptor::matches_allowlist` resolves a skill row's reachability from
///   the server segment, so an agent granted `skills` sees skill rows with no
///   Core-specific special case in the (Core-independent) registry crate;
/// - `McpRegistry::call_tool` routes `skills.<slug>` to this provider, which is
///   what gives [`dispatch`] the chance to refuse explicitly. A bare-slug id would
///   die in `split_tool_id` as "malformed tool id" — an accidental refusal with an
///   unhelpful message, in a module this one cannot reach;
/// - the id is self-describing to a model that has just read `skills.search`.
pub fn catalog_id(slug: &str) -> String {
    format!("{SERVER_NAME}{}{slug}", super::super::TOOL_ID_SEP)
}

/// Inverse of [`catalog_id`]: the bare skill slug inside a `skills.<slug>` catalog
/// id, or `None` for an id outside that namespace.
pub fn slug_from_catalog_id(id: &str) -> Option<&str> {
    id.strip_prefix(SERVER_NAME)
        .and_then(|rest| rest.strip_prefix(super::super::TOOL_ID_SEP))
        .filter(|slug| !slug.is_empty())
}

/// Whether a skill record has something to load — Core's spelling of the one rule.
///
/// **Thin delegate to [`SkillRecord::is_loadable`], which owns the rule.** It moved
/// into the `ryu-skills` crate because that crate owns the type *and*
/// `register_app_skill`, the producer of the body-less records this exists to catch
/// (`instructions: String::new()` and `enabled: true` — identity metadata only,
/// because the plugin's `SkillConfig` is `skill_id`-only and the real body lands when
/// the skill is materialised on disk). A `SKILL.md` that is front-matter only parses
/// to an empty body too, so the disk half produces the shape as well: the predicate
/// is about the body, not about the `app__` prefix or the record's origin.
///
/// This free function stays because it is what `apps/core` calls, and its signature
/// is unchanged so `catalog.rs` needs no edit.
///
/// The reason the rule had to move: this module only governs the doors it owns.
/// A body-less record answered `ok:true` with an empty `instructions` string from
/// `skills.load` — a status that reports healthy for a thing that is not there — and
/// filtering the two search doors fixed those two. It did **not** fix the injected
/// surfaces, which live in the Core-independent crate and could not call this
/// function: `SkillRegistry::progressive_block` kept listing the same records in the
/// L1 index under an instruction to `skills.load` them, and `skill_block` kept
/// injecting an empty `## Skill:` section for an `always_on` one. Those now apply
/// [`SkillRecord::is_loadable`] via `loadable_for`, so all five surfaces agree:
///
/// - progressive-disclosure L1 index (`progressive_block`);
/// - always-on / full-body injection (`progressive_block`, `skill_block`);
/// - `skills.search` — [`do_search`];
/// - `skills.load` — [`do_load`], the one door that still *sees* the record so it can
///   refuse it by name instead of by the enumeration-proof generic message;
/// - the merged tool catalog — `catalog.rs`, list and resolve.
pub fn is_loadable(s: &SkillRecord) -> bool {
    s.is_loadable()
}

/// Map a skill to its catalog descriptor — the one mapping both search doors use.
///
/// Identity only — id / name / description. The instruction *body* is deliberately
/// left out even though the old substring scorer gave it a weight-1 hit: BM25
/// length-normalises, so folding a multi-KB body into the document would let one
/// verbose skill dominate the term statistics of a set whose other documents are
/// one line long. L1 metadata is what the skill author writes to be *found* by;
/// the body is what you get after `skills.load`.
///
/// `meta` stays `None`. Its documented contract is "the tool's `_meta`, verbatim
/// (widget keys)", and it sits beside `widget_accessible` / `output_template`;
/// putting the bare slug there would invent a widget-shaped signal. The slug is
/// mechanically recoverable with [`slug_from_catalog_id`], and `describe` states the
/// exact `skills.load` call.
pub fn descriptor_for(s: &SkillRecord) -> ToolDescriptor {
    ToolDescriptor {
        id: catalog_id(&s.id),
        name: s.name.clone(),
        description: s.description.clone().unwrap_or_default(),
        kind: ToolKind::Skill,
        arg_names: Vec::new(),
        arg_descriptions: Vec::new(),
        score: None,
        meta: None,
        widget_accessible: false,
        output_template: None,
    }
}
