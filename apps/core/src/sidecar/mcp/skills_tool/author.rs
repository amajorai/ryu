//! `skills.author`: writing a structured `SKILL.md` into the shared skills
//! directory, scoped by the calling agent's allowlist.

use super::*;

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
pub(super) fn do_author(
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
pub(super) fn author_refusal(slug: &str, reserved_namespace: bool) -> Value {
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
