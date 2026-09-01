//! Built-in **skills** tool server — the progressive-disclosure bridge between
//! Agent Skills and the unified tool gateway.
//!
//! Historically Core injected the *full body* of every enabled skill into the
//! system prompt on every turn (`skills::SkillRegistry::skill_block`), which
//! bloats context and hurts low-context local models the most. The Agent Skills
//! standard instead uses **progressive disclosure**: only a skill's name +
//! description (L1) is always in context, and its full instructions (L2) load on
//! demand when the model decides the skill is relevant.
//!
//! This server is the L2 loader. It exposes three tools:
//!
//! - `skills.search { query }` — find skills by task (id, name, description).
//! - `skills.load { id }` — return a skill's full instruction body. The returned
//!   text *is* the injection: the model reads it as the tool result and follows it
//!   for the rest of the turn (the same mechanism as Claude Code's Skill tool).
//! - `skills.author { name, purpose, procedure, failure_modes, verification, .. }`
//!   — write a structured, reusable `SKILL.md` into the same `~/.claude/skills`
//!   layout the installer targets, then reload + activate it so it is immediately
//!   discoverable by `skills.search` / `skills.load`. Calling it again with the
//!   same slug refines (overwrites) the skill in place — the self-authoring loop:
//!   an agent captures what it learned solving a complex task, and sharpens it on
//!   reuse.
//!
//! ## One search door: what is and is not shared with the tool catalog
//!
//! A model used to face **two** discovery doors and had to guess which — `tool_search`
//! for tools, `skills.search` for skills. It now faces one: `McpRegistry::search_scoped`
//! merges skill descriptors ([`ToolKind::Skill`]) alongside tools, so a single query
//! ranks both and each row says which it got. `skills.search` survives as the
//! **kind-filtered, skill-allowlist-scoped view** of that same catalog, so an agent
//! that already knows it wants a skill does not have to filter.
//!
//! What is shared and what is not, exactly, because the halves fail differently:
//!
//! - **Shared: ranking.** `skills.search` ranks through
//!   [`ryu_tool_registry::run_search`] — the same Needle 2 default, the same Semantic
//!   embedder seam, and the same `tools.active_ranker` pref that
//!   `McpRegistry::search_scoped` (`tool_search`) obeys. Flip the pref and skill search
//!   changes with tool search. Each [`ryu_skills::SkillRecord`] is mapped to a
//!   [`ToolDescriptor`] by [`descriptor_for`] — the same mapping the merged catalog
//!   uses, so the two doors cannot describe the same skill differently.
//! - **Shared: the catalog.** Enabled, loadable skills now appear in
//!   `tool_search` as `skills.<slug>` rows of kind `skill`. They are still NOT in
//!   `McpRegistry::list_all_tools()` — they are merged at *search* time only, the
//!   same way Core's self-API descriptors are — so nothing offers a skill as a
//!   callable function def.
//! - **Not shared: execution.** A skill is instruction text you load; a tool is a
//!   function you call. `skills.<slug>` is a discovery id, not a call target:
//!   calling it lands in this module's [`dispatch`] fallthrough and is refused with
//!   a message naming `skills.load`. See "Discovery is unified, execution is not"
//!   below.
//! - **Not shared: the zero-score cut.** `McpRegistry::search_scoped` returns every
//!   ranked row; `skills.search` drops zero-scored rows **only when the scores
//!   are lexical** (BM25, including the Semantic→BM25 fallback) to keep its
//!   "no match → empty results" contract. Under a live Semantic embedder it drops
//!   nothing, because there `0.0` means a failed per-item embedding rather than
//!   "no term matched" — see [`rank_skills`] for the full reasoning. So the one
//!   place the two searches disagree on *ranking* is BM25-only, and it is deliberate.
//! - **Shared, now: the scope.** `skills.search` narrows to
//!   `SkillRegistry::enabled_for(<the calling agent's skill allowlist>)`, and
//!   `tool_search` narrows to the same list wherever the caller's agent id reaches
//!   `McpRegistry::search_scoped` — which is every plane that has one: the ACP
//!   bridge, and `GET /api/tools/search?agent=` (which is also how the
//!   openai-compat chat plane arrives). A caller with no agent id — a workflow, a
//!   monitor, the approval engine — passes the empty list, and `enabled_for`
//!   defines that as every enabled skill, which is the same answer `skills.search`
//!   gives those callers. So the two doors agree on scope on every plane.
//! - **Not shared: the injected index.** The always-on L1 index in the system
//!   prompt is built by `SkillRegistry::progressive_block`, which is neither
//!   query-aware nor ranker-driven (deliberately — a query-dependent system prefix
//!   busts the prompt cache every ACP turn; see that function's doc-comment). So
//!   the ranker affects what search returns, never what is injected.
//!
//! ## Discovery is unified, execution is not
//!
//! Three things keep a discoverable skill from becoming a callable tool:
//!
//! 1. **Nothing offers it as a function.** Skills are merged at search time and are
//!    absent from `list_all_tools()`, so neither the ACP bridge's `list_tools` nor
//!    the gateway's always-on set ever contains one. The gateway additionally skips
//!    `kind == "skill"` rows when it describes-and-injects the top hits.
//! 2. **`describe` points at the loader.** `McpRegistry::describe("skills.<slug>")`
//!    returns a `DescribedTool` of kind `skill` with no arguments whose description
//!    is the literal `skills.load` call to make.
//! 3. **The call path refuses.** `skills.<slug>` routes to the `skills` provider
//!    like any `skills.*` id, reaches [`dispatch`]'s fallthrough arm, and returns an
//!    error naming `skills.load`. This is the real backstop, not a belt-and-braces
//!    one: a request whose tool policy resolved to the `"*"` wildcard passes the
//!    gateway's `is_allowed` gate, so Core is the only thing left to say no.
//!
//! ## Architecture note (Core-vs-Gateway)
//!
//! Deciding *what skills run* is Core, so this lives here as a reserved server name
//! (`skills`) like `web_fetch`/`threads`. A skill stays **instruction text**, not a
//! function call — this server only borrows the gateway's discovery mechanism; it
//! returns instructions, never executes them. The Gateway still governs egress /
//! budget / audit of the underlying model call.
//!
//! ## v1 scope (honest)
//!
//! - **All three tools are scoped by the calling agent's skill allowlist.** For
//!   `search`/`load` that makes no response an oracle for a skill the agent may not
//!   see; `author` is the one documented exception (it leaks a single existence bit,
//!   below).
//!   `search`/`load` operate over the enabled skills permitted by that allowlist
//!   (`SkillRegistry::enabled_for`) — the same predicate that scopes the injected
//!   L1 index, so what an agent can load equals what it can see. Previously only
//!   the index was scoped and `load` matched on the globally-enabled set, so an
//!   agent could name an out-of-allowlist skill by id and get its body. An
//!   out-of-allowlist id now returns the same "no enabled skill with id" result as
//!   a nonexistent one. `author` is scoped by the same list (see below), but its
//!   verdict is *not* computed from the allowlist alone — it also depends on
//!   whether the slug already exists, so unlike `search`/`load` it does leak one
//!   bit. That trade-off is stated in full under "`author` scoping" below. (An
//!   earlier version of this list claimed the opposite in the same breath as that
//!   section documented the leak; the claim was false from the moment `author`
//!   split into create-vs-refine.)
//! - The allowlist is resolved from the calling agent's record at dispatch. When
//!   there is no calling agent (workflows, monitors, the approval engine) it is
//!   empty, which `enabled_for` defines as "all enabled" — see the fail-open note
//!   on [`dispatch`].
//! - `author` writes to the same on-disk location the catalog installer targets
//!   (`SkillRegistry::skills_dir()/<slug>/SKILL.md`). Beyond the `skills` server
//!   allowlist (an agent that can `search`/`load` can also `author`) and the
//!   [`AUTHOR_FLAG_ENV`] opt-in, the skill allowlist scopes **taking over an
//!   existing id** (by overwrite *or* by shadow), not the write — see the next
//!   section, which is the part an implementer gets wrong.
//!
//! ## `author` scoping: refine is allowlisted, create is not
//!
//! Two operations hide behind one tool, and only one of them can be gated by the
//! agent's skill allowlist:
//!
//! - **Refine** = the slug is already **taken in the skill identity namespace**.
//!   This takes over instruction text the agent was not necessarily given, so it
//!   requires the slug to be in the agent's allowlist (empty list = unscoped caller
//!   = anything). This is the integrity rule the previous round added, and it
//!   stands.
//! - **Create** = the slug resolves to nothing anywhere in that namespace. Nothing
//!   can be clobbered *or shadowed*, so it is allowed for every caller, allowlist or
//!   not.
//!
//! **"Taken" means the namespace, not the write path.** This is the sentence a
//! previous round got wrong, and the whole split rests on it. The write target is
//! `SkillRegistry::skills_dir()/<slug>/SKILL.md`, but the namespace every consumer
//! reads is `ryu_skills::scan_all_skill_dirs()`: **two roots** (`~/.claude/skills`
//! then the read-only ecosystem root `~/.agents/skills`) deduped **first-root-wins**,
//! and within a root the directory form beats a legacy flat `<slug>.md`. So a
//! `SKILL.md` created at the write root for a slug that already resolves in root two
//! (or as `<root>/<slug>.md`) wins the dedupe and every consumer —
//! `search`/`load`/`skill_block`/`progressive_block` and the library UI — serves the
//! new text under the old id. The older bytes survive on disk and are unreachable,
//! i.e. the effect *equals* an overwrite. Existence is therefore decided by
//! [`ryu_skills::resolve_skill_md`] (all roots, both layouts) plus the registry's
//! in-memory `app_skills` bag, never by `dest.exists()`.
//!
//! **And the namespace has a reserved region the snapshot cannot see.** The
//! `app_skills` bag is filled on plugin *enable* and emptied on disable — `reload()`
//! never populates it — so before a plugin is enabled its `app__<id>` skills are in
//! no snapshot at all, and an out-of-scope agent could create `app__<id>` while the
//! id looked free. `do_author` therefore treats the whole [`APP_SKILL_PREFIX`]
//! namespace as unclaimable by an out-of-scope caller, independent of what is
//! registered. Refining an `app__` id you *are* allowed to load is unaffected.
//!
//! Gating *both* on the allowlist (the state this replaced) made creation
//! impossible for any scoped agent: a brand-new slug is by definition not in the
//! list, so every derived slug was refused, while the tool description still
//! advertised "write a new SKILL.md". The refusal is a soft `{ok:false}`, so the
//! model's rational move is to retry under another name — which could never
//! succeed. Unbounded wasted rounds, which is worse than what the gate bought.
//!
//! **The accepted leak.** Because create succeeds and refine-outside-the-allowlist
//! refuses, the two replies differ, so an out-of-allowlist call reveals one bit:
//! whether that slug is taken. Note the namespace rule *widens* that bit — it now
//! answers "taken in any root, in either layout, or by a plugin-contributed skill"
//! rather than "has a SKILL.md under the write root". Still one bit per call, on a
//! slug the caller had to name, and the trade is the same one this module makes
//! knowingly:
//!
//! - The allowlist is explicitly *not* a confidentiality boundary — see the
//!   fail-open note on [`dispatch`], which says so about this same list, and note
//!   that it defaults to empty (= everything) for every agent-less caller.
//! - The bit is expensive and self-announcing: probing costs a full `author` call
//!   (five required prose fields) and every probe of a free slug *materializes a
//!   real SKILL.md* the user can see in the skills library. Contrast the oracle the
//!   previous round closed, which was free (`refined: <dest existed>` on a slug the
//!   call had just clobbered).
//! - The alternative that closes the bit — replying with a fake successful create —
//!   was rejected: lying to the model about what is on disk is worse than the bit.
//!
//! **What a scoped create does NOT do: activate.** An in-scope author calls
//! `ryu_skills::set_active(slug, true)`, and that activation set is **node-global**
//! (`crates/core/skills/src/lib.rs`: `set_active` → `save_active_set` →
//! `~/.ryu/skills-active.json`, and `SkillRegistry::reload` computes
//! `record.enabled = record.enabled && active.contains(id)`). So activating means
//! injecting into *every other* agent's prompt — a cross-agent write. Since a
//! scoped agent may now create slugs it was never granted, its creates are written
//! **inactive**: on disk, listed by `list_all` (the skills library), excluded from
//! `enabled`/`enabled_for` and therefore from `search`/`load`/`skill_block`/
//! `progressive_block` until a human activates it. Same posture the bulk-discovered
//! ecosystem skills get. Unscoped callers (the default, and every agent-less
//! caller) keep the historical activate-on-author behaviour untouched.
//!
//! Landing inactive takes an explicit `set_active(slug, false)`, not merely *not*
//! calling `set_active(.., true)` — because activation is keyed by **id**, not by
//! path. `reload` ANDs `active.contains(id)` in, so a stale id sitting in the
//! node-global set (a skill the user once activated and later deleted) would make
//! the freshly created file active on the very reload `do_author` itself triggers.
//! The clear is safe precisely because the namespace guard above already proved that
//! nothing resolves to this id, so any surviving entry for it is an orphan pointing
//! at nothing. It runs *before* the reload, or the record would land enabled until
//! whatever reload came next.
//!
//! One honest consequence: a scoped agent cannot `load` back what it just created
//! (`enabled_for` filters both on the allowlist and on activation). It is no longer
//! a *dead end* — the reply is `ok:true` and the knowledge persists for the user and
//! for unscoped agents — but the write-then-read loop stays closed until the agent's
//! own `skills` list gains the slug, which is a write to the agent record
//! (`agents/mod.rs`), not something this module can do.
//!
//! The slug is sanitized to a single safe path segment so a call can never escape
//! the skills directory, and the rendered file is round-tripped through the loader
//! before it is committed to disk (fail closed on a malformed body).

use anyhow::Result;
use serde_json::{json, Value};

use super::RegistryTool;
use ryu_skills::{SkillRecord, SkillRegistry};
use ryu_tool_registry::{ToolDescriptor, ToolEmbedder, ToolKind, ToolRanker, RANKER_PREF_KEY};

/// Reserved registry server name for the built-in skills provider.
pub const SERVER_NAME: &str = "skills";

/// Fully-qualified ids of the tools this provider exposes.
pub const SEARCH_TOOL_ID: &str = "skills.search";
pub const LOAD_TOOL_ID: &str = "skills.load";
pub const AUTHOR_TOOL_ID: &str = "skills.author";

/// Default / max search results.
const SEARCH_DEFAULT_LIMIT: usize = 10;
const SEARCH_MAX_LIMIT: usize = 25;

/// Id prefix reserved for plugin-contributed skills (`RunnableKind::Skill`).
///
/// Mirrors the literal the runnable handler mints ids with
/// (`apps/core/src/server/mod.rs`: `format!("app__{}", cfg.skill_id)`) and the one
/// the disable path un-registers with. `do_author` treats the whole namespace as
/// **taken** so an agent cannot pre-claim an `app__<id>` a plugin has not registered
/// yet — see the `taken` computation there for why the registry snapshot alone
/// cannot see that case.
const APP_SKILL_PREFIX: &str = "app__";

/// Env flag that opts a node into autonomous skill self-authoring.
///
/// **Default OFF.** Unlike `search`/`load` (which only return instruction text),
/// `skills.author` has side effects — it writes a SKILL.md into the shared
/// `~/.claude/skills` directory and flips the global activation set. So it stays
/// gated behind an explicit opt-in and is neither listed nor callable until this is
/// set, mirroring this module's existing `RYU_SKILLS_*` env idiom
/// (`RYU_SKILLS_DIR` / `RYU_SKILLS_ACTIVE_FILE`) and the default-safe rule that new
/// runtime behavior does not change existing defaults.
const AUTHOR_FLAG_ENV: &str = "RYU_SKILLS_AUTHOR";

/// Whether skill self-authoring is enabled on this node. Default `false`; enabled
/// when `RYU_SKILLS_AUTHOR` is a truthy value (`1` / `true` / `yes` / `on`).
fn author_enabled() -> bool {
    std::env::var(AUTHOR_FLAG_ENV)
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

/// The `skills` row's description for `GET /api/mcp/servers`.
///
/// Lives here rather than as an inline literal in `McpRegistry::list_servers` (where
/// every other built-in server's text does) for one reason: it has to agree with
/// [`author_enabled`], and the previous inline literal did not — it advertised
/// `skills.author` unconditionally while [`tools`] only offers it when the opt-in is
/// set, so on a stock node the listing named a tool that was not there. Keeping the
/// string next to the gate is what makes the two impossible to drift apart.
pub(crate) fn server_description() -> String {
    let mut text = "Built-in skills: discover and load Agent Skills on demand \
                    (skills.search / skills.load) instead of injecting every skill body \
                    up front — progressive disclosure for low-context models."
        .to_owned();
    if author_enabled() {
        text.push_str(
            " skills.author writes a structured, reusable SKILL.md — creating a new slug, \
             or refining one the calling agent is allowed to load.",
        );
    }
    text
}

fn search_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "What you want to accomplish. Matched against skill names and descriptions."
            },
            "limit": {
                "type": "integer",
                "description": "Max results to return (default 10)."
            }
        },
        "required": ["query"]
    })
}

fn load_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": {
                "type": "string",
                "description": "The skill id to load (as shown in the available-skills list or returned by skills.search)."
            }
        },
        "required": ["id"]
    })
}

fn author_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Human-readable skill name, e.g. \"Resolve merge conflicts\"."
            },
            "slug": {
                "type": "string",
                "description": "Optional stable id / directory name. Sanitized to a single safe path segment (alphanumerics, '-', '_', '.'). Derived from the name when omitted. Reuse the same slug to refine that skill — allowed only for skills in your available-skills list; use a slug no installed skill already uses otherwise."
            },
            "description": {
                "type": "string",
                "description": "One-line summary shown in the always-on skill index (L1). Keep it short and task-focused."
            },
            "purpose": {
                "type": "string",
                "description": "When and why to use this skill — the situation it applies to."
            },
            "procedure": {
                "type": "string",
                "description": "The step-by-step method to follow. This is the core of the skill."
            },
            "failure_modes": {
                "type": "string",
                "description": "Known pitfalls, edge cases, and what to avoid."
            },
            "verification": {
                "type": "string",
                "description": "How to confirm the task actually succeeded."
            },
            "allowed_tools": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Optional list of tool names this skill declares it needs."
            }
        },
        "required": ["name", "purpose", "procedure", "failure_modes", "verification"]
    })
}

/// The skills tools exposed through the registry.
///
/// `search` and `load` are always present; `author` is added only when the
/// self-authoring opt-in ([`author_enabled`]) is set, so the default surface is
/// unchanged.
pub fn tools() -> Vec<RegistryTool> {
    let mut tools = vec![
        RegistryTool {
            id: SEARCH_TOOL_ID.to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "search".to_owned(),
            description: Some(
                "Search available Agent Skills by task. Returns a ranked list of \
                 { id, name, description }. Call skills.load with an id to read a \
                 skill's full instructions before acting on it."
                    .to_owned(),
            ),
            input_schema: Some(search_schema()),
            ..Default::default()
        },
        RegistryTool {
            id: LOAD_TOOL_ID.to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "load".to_owned(),
            description: Some(
                "Load an Agent Skill's full instructions by id. Returns \
                 { ok, id, name, instructions }. Read the instructions and follow \
                 them for the rest of this turn. Call this when a skill listed as \
                 available is relevant to the user's request."
                    .to_owned(),
            ),
            input_schema: Some(load_schema()),
            ..Default::default()
        },
    ];
    if author_enabled() {
        tools.push(RegistryTool {
            id: AUTHOR_TOOL_ID.to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "author".to_owned(),
            description: Some(
                "Write a new, reusable Agent Skill as a structured SKILL.md \
                 (Purpose / Procedure / Failure modes / Verification) into the \
                 shared skills directory. Call this after solving a complex task to \
                 capture the method for reuse. An UNUSED slug is always created; \
                 re-authoring a slug that any installed skill already uses refines \
                 (replaces) it, which is allowed only for skills in your \
                 available-skills list — if it is refused, author under a different \
                 slug instead of retrying. A created skill is activated (so \
                 skills.search / skills.load see it immediately) unless it fell \
                 outside your available skills, in which case it is saved for the \
                 user to activate. Returns { ok, id, path, refined, active }."
                    .to_owned(),
            ),
            input_schema: Some(author_schema()),
            ..Default::default()
        });
    }
    tools
}

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
/// degrades to the Needle 2 default, exactly as it does for `tool_search`.
async fn resolve_ranker() -> ToolRanker {
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
    format!("{SERVER_NAME}{}{slug}", super::TOOL_ID_SEP)
}

/// Inverse of [`catalog_id`]: the bare skill slug inside a `skills.<slug>` catalog
/// id, or `None` for an id outside that namespace.
pub fn slug_from_catalog_id(id: &str) -> Option<&str> {
    id.strip_prefix(SERVER_NAME)
        .and_then(|rest| rest.strip_prefix(super::TOOL_ID_SEP))
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

/// Rank `skills` against `query` and return the tool's result rows, best first.
///
/// Split out from [`do_search`] so the ranking contract is testable without going
/// near the preferences store: the caller injects the ranker instead of it being
/// read from disk.
///
/// Zero-scored rows are dropped under a **lexical** ranker only; see the inline
/// comment on the filter for why that cut is wrong under a live embedder.
async fn rank_skills(
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

async fn do_search(
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
    // the model registry off disk, while the Needle 2 selector resolves its own
    // pinned runtime on first use.
    let embedder = matches!(ranker, ToolRanker::Semantic)
        .then(crate::tool_registry_host::CoreToolEmbedder::from_registry);
    let selector = matches!(ranker, ToolRanker::Needle2).then(crate::needle2::selector);
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

fn do_load(
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
        Some(s) => Ok(json!({
            "ok": true,
            "id": s.id,
            "name": s.name,
            "instructions": s.instructions,
        })),
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

/// Sanitize a raw slug (or a name to derive one from) into a single safe path
/// segment. Keeps alphanumerics, `-`, `_`, `.`; collapses everything else to a
/// dash; trims leading/trailing dashes and dots. Returns `None` when nothing safe
/// remains (empty, `.`, `..`), so a call can never escape the skills directory via
/// `..`, an absolute path, or a drive/UNC prefix (`:` and separators are neutered).
///
/// Mirrors `skills_catalog::from_source::sanitize_name` but fails closed instead of
/// falling back to a default id, so an unusable slug is a caller error.
fn sanitize_slug(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(['-', '.']).to_string();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return None;
    }
    Some(trimmed)
}

/// Render a structured `SKILL.md`: quoted-safe YAML front-matter (name, optional
/// description, optional allowed-tools) followed by the four `##` body sections.
///
/// The front-matter is serialized with `serde_yml` (the same crate `parse_skill_md`
/// reads back), so a `name`/`description` containing quotes, colons, newlines, or a
/// `---` sequence is escaped correctly instead of breaking the block.
fn render_skill_md(
    name: &str,
    description: Option<&str>,
    allowed_tools: &[String],
    purpose: &str,
    procedure: &str,
    failure_modes: &str,
    verification: &str,
) -> Result<String> {
    let mut front = serde_json::Map::new();
    front.insert("name".to_owned(), json!(name));
    if let Some(d) = description {
        front.insert("description".to_owned(), json!(d));
    }
    if !allowed_tools.is_empty() {
        front.insert("allowed-tools".to_owned(), json!(allowed_tools));
    }
    let yaml = serde_yml::to_string(&Value::Object(front))
        .map_err(|e| anyhow::anyhow!("failed to render skill front-matter: {e}"))?;

    Ok(format!(
        "---\n{yaml}---\n\n## Purpose\n\n{purpose}\n\n## Procedure\n\n{procedure}\n\n## Failure modes\n\n{failure_modes}\n\n## Verification\n\n{verification}\n",
        yaml = yaml,
        purpose = purpose.trim(),
        procedure = procedure.trim(),
        failure_modes = failure_modes.trim(),
        verification = verification.trim(),
    ))
}

/// Read a required non-empty string argument, or `Err` (a malformed call — same
/// contract as `do_load`'s missing-`id` behavior).
fn required_str<'a>(arguments: &'a Value, key: &str) -> Result<&'a str> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("missing required string argument '{key}'"))
}

/// Write a structured, reusable SKILL.md into the shared skills directory. Additive
/// and idempotent per slug: re-authoring the same slug overwrites the body in place
/// (the refine-on-reuse loop).
///
/// `skills_allowlist` scopes the **overwrite**, not the write — an agent carrying a
/// non-empty list may refine only slugs inside it, but may always *create* a slug
/// that is free, because creating clobbers nothing. See the module doc ("`author`
/// scoping") for why gating creation too was worse than the one bit of existence
/// information this split reveals, and for why an out-of-scope create is written
/// **inactive** (activation is node-global).
///
/// "Free" is decided over the whole skill identity namespace — every root
/// [`ryu_skills::resolve_skill_md`] scans, plus the registry's in-memory
/// `app_skills` bag — not over the single path this function writes to. Writing into
/// root one for an id root two already owns is a shadow, which every consumer
/// experiences as an overwrite; see the module doc for the full mechanism.
///
/// `Err` only for a malformed call (missing required arg, unsafe slug, or a body
/// that does not round-trip through the loader). A refused overwrite is a soft
/// `{ ok: false }` like `load`'s, so the agent's turn continues, and its message
/// names the one move that can succeed (author under a different slug) so the model
/// does not burn turns retrying a call that never can. A successful write returns
/// `{ ok: true, id, path, refined, active }`, where `refined` is namespace-derived:
/// true whenever the id was already taken, whether the bytes were overwritten in
/// place or a shadowing file was created (the reply names the shadowed path).
fn do_author(
    arguments: Value,
    registry: &SkillRegistry,
    skills_allowlist: &[String],
) -> Result<Value> {
    // Defense in depth: the tool is normally hidden when the opt-in is off (see
    // `tools()`), but never let a direct call by id write files when disabled.
    if !author_enabled() {
        return Ok(json!({
            "ok": false,
            "available": false,
            "error": "skill authoring is disabled on this node (set RYU_SKILLS_AUTHOR to enable)",
        }));
    }

    let name = required_str(&arguments, "name")?;
    let purpose = required_str(&arguments, "purpose")?;
    let procedure = required_str(&arguments, "procedure")?;
    let failure_modes = required_str(&arguments, "failure_modes")?;
    let verification = required_str(&arguments, "verification")?;

    let description = arguments
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let allowed_tools: Vec<String> = arguments
        .get("allowed_tools")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();

    // Prefer an explicit slug; otherwise derive one from the name. Fail closed if
    // nothing safe remains so a call can never escape the skills directory.
    let slug_source = arguments
        .get("slug")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(name);
    let slug = sanitize_slug(slug_source).ok_or_else(|| {
        anyhow::anyhow!("could not derive a safe skill slug from '{slug_source}'")
    })?;

    // Overwrite scope = read scope. Empty list = "all enabled" (`enabled_for`'s
    // back-compat default), which is what every agent-less caller passes, so this
    // only ever narrows an agent that was given an explicit list. Note this decides
    // *refine rights*, not whether the call may write at all: an out-of-scope slug
    // still gets to CREATE (below), it just may not take over an existing skill.
    let may_refine = skills_allowlist.is_empty() || skills_allowlist.iter().any(|id| id == &slug);

    // Does this id already exist? Decided over the **identity namespace**, never over
    // the path we are about to write:
    //
    // - `resolve_skill_md` walks every root `scan_all_skill_dirs` walks, in the same
    //   first-root-wins order, honouring the legacy flat layout where that root does.
    //   It returns the exact `SKILL.md` `SkillRegistry::reload` would read for `slug`,
    //   so `Some(_)` means "writing our own copy would shadow that file", which for
    //   every consumer is indistinguishable from overwriting it.
    // - `registry.list_all()` adds the one part of the namespace that is not on disk:
    //   the in-memory `app_skills` bag of plugin-contributed skills (`app__<id>`,
    //   reachable as a slug since `sanitize_slug` keeps `_`). Those records are merged
    //   into `enabled()`, so a same-id disk skill would give `load` two candidates and
    //   the disk one wins.
    //
    // The two halves are stale in OPPOSITE directions, and an earlier version of this
    // comment claimed both fail toward refusing. Only the first does:
    //
    // - `resolve_skill_md` reads the filesystem, so it is never stale; the
    //   `list_all()` half can still list a disk skill deleted since the last reload,
    //   which over-reports "taken" and so fails toward *refusing* — safe, self-heals.
    // - The `app_skills` bag half fails the other way. Read
    //   `crates/core/skills/src/lib.rs`: the bag is filled by `register_app_skill` on
    //   plugin **enable** and emptied by `unregister_app_skill` on disable; `reload()`
    //   never touches it. So before a plugin is enabled its `app__<id>` skills are
    //   absent from `list_all()`, this check reports the id free, and an out-of-scope
    //   agent may create `<write root>/app__<id>/SKILL.md`. When the plugin later
    //   registers, `do_load`'s lookup returns the disk record first (disk records
    //   precede the bag in `enabled()`) — the agent has taken an id it was not
    //   granted. Narrow (needs the `RYU_SKILLS_AUTHOR` opt-in plus that timing), but
    //   real, and not something the namespace check can see.
    //
    // [`APP_SKILL_PREFIX`] closes it without depending on load order: the whole
    // `app__` namespace belongs to plugin contributions, so it counts as taken
    // whether or not a plugin has registered yet. In-scope refine of an already
    // materialised `app__foo` still works (the allowlist decides that, as always);
    // only an out-of-scope *create* into the namespace is refused, which is exactly
    // the hole.
    let shadowed = ryu_skills::resolve_skill_md(&slug);
    // Does the id resolve to something RIGHT NOW …
    let exists = shadowed.is_some() || registry.list_all().iter().any(|s| s.id == slug);
    // … versus: is it an id this caller may claim at all? The reserved namespace is
    // not "taken" in the reporting sense (there may be no such plugin skill yet), so
    // the two are kept apart — `refined` below is derived from `exists` only, or a
    // create into `app__` would tell the model it had refined something imaginary.
    let reserved = slug.starts_with(APP_SKILL_PREFIX);

    // The integrity rule, applied to the namespace: an agent may not take over an id
    // it was not granted, by overwrite, by shadow, or by pre-claiming a plugin id.
    // Checked before anything is written so no file lands on a refused call.
    if (exists || reserved) && !may_refine {
        return Ok(author_refusal(&slug, reserved && !exists));
    }

    let md = render_skill_md(
        name,
        description,
        &allowed_tools,
        purpose,
        procedure,
        failure_modes,
        verification,
    )?;

    // Fail closed: the file we are about to persist must parse back through the
    // exact loader `reload()` uses, so we never leave an unreadable skill on disk.
    ryu_skills::parse_skill_md(&slug, &md).map_err(|e| {
        anyhow::anyhow!("authored skill did not round-trip through the loader: {e}")
    })?;

    let skill_dir = SkillRegistry::skills_dir().join(&slug);
    std::fs::create_dir_all(&skill_dir)
        .map_err(|e| anyhow::anyhow!("creating skill dir {}: {e}", skill_dir.display()))?;

    let dest = skill_dir.join("SKILL.md");

    if !may_refine {
        // Create-only mode: reached only when the namespace check above found the id
        // free. `create_new` closes the window between that check and this write —
        // the "never take over a skill this agent was not given" guarantee has to be
        // atomic, and check + rename is not (a `SKILL.md` landing in between would be
        // silently overwritten). O_EXCL / CREATE_NEW makes the OS arbitrate, so the
        // only outcomes are "we created it" and "someone won the race, nothing
        // written".
        //
        // Honest bound: it arbitrates the *write root* only. A concurrent process
        // creating the same id in the ecosystem root during this call still ends up
        // shadowed, because no filesystem primitive spans two directories. The
        // namespace check narrows that to a genuine race rather than the steady state
        // it used to be.
        //
        // The cost of skipping tmp+rename here: a registry reload racing this write
        // can read a short file. Bounded — `parse_skill_md` rejects it, that one
        // skill is skipped with a warning, and the `reload()` below re-reads the
        // complete file a moment later.
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&dest)
        {
            Ok(mut file) => {
                use std::io::Write as _;
                if let Err(e) = file.write_all(md.as_bytes()) {
                    // Undo the `create_new`: leaving a truncated (or empty) SKILL.md
                    // would both break the loader and make every later author of this
                    // slug hit the "already exists" refusal for a file this call
                    // failed to write.
                    drop(file);
                    let _ = std::fs::remove_file(&dest);
                    return Err(anyhow::anyhow!("writing {}: {e}", dest.display()));
                }
            }
            // Same refusal shape and wording as the pre-write branch, deliberately:
            // the race loser and the steady-state refusal are the same verdict, and a
            // differently-worded reply would break the "name the recoverable move"
            // contract that `author_refusal` carries.
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                return Ok(author_refusal(&slug, false));
            }
            Err(e) => return Err(anyhow::anyhow!("writing {}: {e}", dest.display())),
        }
        // Inactive is *enforced*, not merely un-requested. Activation is keyed by id
        // in a node-global set, so an orphan entry for this id (a skill the user once
        // activated and later deleted) would otherwise make this file active on the
        // reload below — `SkillRegistry::reload` computes
        // `enabled = enabled && active.contains(id)`. Clearing is safe because the
        // namespace check proved nothing resolves to this id, so any entry for it
        // pointed at nothing. Order matters: clear, THEN reload.
        ryu_skills::set_active(&slug, false);
        registry.reload();
        return Ok(json!({
            "ok": true,
            "id": slug,
            "path": dest.to_string_lossy(),
            "refined": false,
            "active": false,
            "note": "Created, but left inactive because this skill is outside your allowed \
                     skills: it is saved for the user to activate and is not loadable by you \
                     yet. Do not re-author it.",
        }));
    }

    // Namespace-derived, not `dest.exists()`: an id owned by the ecosystem root or by
    // a legacy flat `<slug>.md` is still an id this call takes over, and reporting
    // `refined: false` for it would tell the model it had created something new.
    // `exists`, NOT the write gate: an unscoped caller creating a fresh `app__<id>`
    // passed the gate on `may_refine`, and there is nothing there to have refined.
    let refined = exists;

    // Atomic tmp+rename (mirrors the catalog installer) so a concurrent registry
    // reload never observes a half-written SKILL.md. Only the in-scope path can use
    // it: rename overwrites, which is exactly what the create-only path above must
    // not do.
    let tmp = skill_dir.join("SKILL.md.tmp");
    std::fs::write(&tmp, md.as_bytes())
        .map_err(|e| anyhow::anyhow!("writing {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &dest)
        .map_err(|e| anyhow::anyhow!("rename {} -> {}: {e}", tmp.display(), dest.display()))?;

    // A self-authored skill is active by default (it injects on the default route),
    // matching the catalog install paths. Then reload so search/load see it now.
    // Only in-scope authors reach this: the caller either holds the slug in its
    // allowlist or is unscoped (every agent-less caller), so writing the node-global
    // activation set is authority it already has.
    ryu_skills::set_active(&slug, true);
    registry.reload();

    let mut out = json!({
        "ok": true,
        "id": slug,
        "path": dest.to_string_lossy(),
        "refined": refined,
        "active": true,
    });
    // Say so when the previous definition was not overwritten but shadowed — the
    // bytes at that path still exist and are now unreachable, which is a materially
    // different thing to have done and the user may want to reconcile it.
    if let Some(prev) = shadowed.filter(|p| p != &dest) {
        out["note"] = json!(format!(
            "Refined by shadowing: skill id '{slug}' already resolved to {} (another skills \
             root, or the legacy flat layout). That file is untouched but is no longer what \
             loads for this id.",
            prev.display()
        ));
    }
    Ok(out)
}

/// The refusal reply for "this slug is not yours to claim".
///
/// Shared by the pre-write namespace check and the `create_new` race loser so the two
/// cannot drift: both are the same verdict, and the message has to name the one move
/// that can succeed (author under a different slug) or the model's rational retry is
/// another attempt at the same slug, which can never work.
///
/// `reserved_namespace` distinguishes the one case where nothing exists yet: an
/// out-of-scope create into the plugin-owned [`APP_SKILL_PREFIX`] namespace. Saying
/// "already exists" there would be false, and the model's recoverable move is the
/// same either way. This branch leaks nothing new — the `app__` rule is static and
/// caller-independent, so the reply is derivable without making the call.
fn author_refusal(slug: &str, reserved_namespace: bool) -> Value {
    let error = if reserved_namespace {
        format!(
            "skill id '{slug}' is in the '{APP_SKILL_PREFIX}' namespace, which is reserved for \
             skills contributed by plugins, and it is outside this agent's skill allowlist. \
             Author under a different slug to capture this as a new skill."
        )
    } else {
        format!(
            "skill id '{slug}' already exists and is outside this agent's skill allowlist, \
             so it cannot be overwritten. Author under a different slug to capture this as a \
             new skill."
        )
    };
    json!({ "ok": false, "id": slug, "error": error })
}

#[cfg(test)]
mod tests {
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
        let lexical =
            ranked_ids(&rank_skills("web", 10, &skills, ToolRanker::Bm25, None, None).await);
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
        // these three keys, `description` still nullable.
        let keys: Vec<&String> = rows[0].as_object().expect("object").keys().collect();
        assert_eq!(keys, vec!["description", "id", "name"]);
    }

    // ── skills.author ────────────────────────────────────────────────────────

    /// Point the skills dir + activation file at fresh tempdirs and hold the env
    /// lock for the life of the returned guard, so author tests can round-trip real
    /// disk I/O without clobbering each other.
    struct AuthorEnv {
        _guard: std::sync::MutexGuard<'static, ()>,
        _skills: tempfile::TempDir,
        _active: tempfile::TempDir,
        skills_dir: std::path::PathBuf,
    }

    impl Drop for AuthorEnv {
        fn drop(&mut self) {
            std::env::remove_var("RYU_SKILLS_DIR");
            std::env::remove_var("RYU_SKILLS_ACTIVE_FILE");
            std::env::remove_var(AUTHOR_FLAG_ENV);
        }
    }

    fn author_env() -> AuthorEnv {
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

    fn author_args(name: &str, slug: &str, procedure: &str) -> Value {
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

        let md = std::fs::read_to_string(env.skills_dir.join("tricky").join("SKILL.md"))
            .expect("read back");
        let rec =
            ryu_skills::parse_skill_md("tricky", &md).expect("escaped front-matter round-trips");
        assert_eq!(rec.name, tricky);
    }

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
}
