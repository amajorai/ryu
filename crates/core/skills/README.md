# ryu-skills

The Core side of the **Agent Skills** standard (M3, issue #145): SKILL.md parsing, the
executable Skill `Runnable`, the dual-root registry, progressive-disclosure injection,
authoring + version history, and the `/api/skills/*` CRUD surface.

## Role in the decomposition

An extracted **Core capability crate**, compiled into `apps/core` as the in-process
default and **kernel-required** — the registry is injected into every chat turn.
Consumed as a path dependency whose axum router merges into Core's.

Core-vs-Gateway: Core decides *what skills run* (selection, loading, injecting skill
instructions into the outgoing request body *before* it reaches the Gateway); the
Gateway decides *what is allowed / measured / paid* (it calls `SkillsRegistry::inject`
to govern egress and counts the skill-tagged call toward budget/audit).

Zero dependency on `apps/core`. The one coupling — the relocatable Ryu data dir (for
the activation set, version snapshots, and legacy-migration source) — is inverted:
Core publishes it once at startup via `set_data_dir(paths::ryu_dir())` into a
`OnceLock`, falling back to `$RYU_DIR`/`~/.ryu` when unset (crate-isolated tests).
Core also implements `Runnable` for `SkillRecord` host-side. **That data-dir publish
is the seam.**

## Key surface

- `SkillRecord` — the real, executable Skill Runnable (front-matter + Markdown body).
- `SkillRegistry` — dual-root scan so a skill installed by *any* agent is detected:
  `~/.claude/skills/<id>/SKILL.md` (Claude Code / skills-CLI, also Ryu's write target)
  and the vendor-neutral `~/.agents/skills/<id>/SKILL.md` (agentskills.io /
  vercel-labs, and the path the managed Pi binary auto-loads). `~/.claude` wins on id
  collision; overridable via `RYU_SKILLS_DIR`; legacy flat `<id>.md` still loads.
- `api::{routes, SkillsCtx}` — the `/api/skills/*` CRUD router (utoipa-documented).
- `store` — activation set, version snapshots, authoring/migration.
- `SKILLS_ENV_LOCK` — cross-crate test lock (Core test modules that stayed behind hold
  it too).

## Consumed as

Compiled-into-Core crate; router merged into Core's axum app.

Deps: axum, serde/serde_json, serde_yml, dirs, chrono, uuid, utoipa. Dev: tempfile.
