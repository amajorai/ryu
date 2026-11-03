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
//!   [`ryu_tool_registry::run_search`] — the same Needle 3 default, the same Semantic
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

mod author;
mod authoring_md;
mod catalog;
mod entry;
mod lookup;

#[cfg(test)]
mod tests;

use self::{author::*, authoring_md::*, catalog::*, entry::*, lookup::*};

pub(crate) use catalog::server_description;
pub use catalog::tools;
pub use entry::{descriptor_for, dispatch, is_loadable, slug_from_catalog_id};
