---
name: ryu-author-skill
description: Author a new agent skill in the SKILL.md format used by this collection, so the Ryu skill ecosystem is self-extending. Covers the directory layout, the YAML frontmatter schema (name and description), writing skimmable instructional content, cross-referencing other skills, and validating the result. Use when adding a new skill under apps/skills.
---

# Author a Ryu skill

This skill explains how to write another skill in the same format as this collection. The skills here are external agent skills - instructions an AI agent loads to learn how to set up and drive Ryu. They are not installed into Ryu's own skills registry, so do not touch `registry/registry.json` or `skills-lock.json`.

## Where it goes

One skill per directory, each with a single `SKILL.md`:

```
apps/skills/<skill-slug>/SKILL.md
```

The slug is lowercase, hyphenated, and matches the `name` in the frontmatter (for example `ryu-build-agent`).

## Frontmatter schema

The file starts with YAML frontmatter between `---` fences. The required keys are `name` and `description`:

```md
---
name: my-skill
description: One or two sentences on what the skill does and when an agent should use it. Lead with the capability, then the trigger.
---
```

- `name` - the skill slug, matching the directory name.
- `description` - the single most important field. The loading agent reads it to decide whether to open the skill, so make it specific: what the skill does plus the situations that should trigger it.

Keep it to those two keys unless you have a concrete reason to add more. These are instructional skills, not slash commands, so do not add an `argument-hint`.

## Body

After the frontmatter, write the instructions in Markdown. Aim for skimmable and true:

- Open with a one-line statement of what the agent is doing and any prerequisite (link it).
- Use `-` bullet lists and short sections with `##` headings.
- Put real, copyable commands in fenced code blocks. Only cite endpoints and commands you have verified against the codebase - never invent a route.
- Cross-reference sibling skills with double brackets, for example see [[setup-ryu]] or [[ryu-mcp]]. Use the skill `name` inside the brackets.

## Style rules for this repo

- No em dashes. Rewrite so they are not needed; use `-` or `:` in lists where helpful.
- Do not put a `:` directly after inline `code`; use `-` instead.
- Use `bun` for any JavaScript commands.
- Implement before importing in code samples, since the Biome linter strips unused imports.

## Validate

- Confirm the frontmatter is valid YAML and has both `name` and `description`.
- Confirm the directory name matches `name`.
- From the repo root, run `bun install` and confirm the workspace still resolves with your new skill present. The `apps/skills/package.json` workspace member is what keeps the `apps/*` glob from breaking - do not remove it.
- Add a one-line entry for the new skill to `apps/skills/README.md` so it is indexed.

## Template

```md
---
name: ryu-thing
description: Do the thing on a Ryu node. Use when a user asks to do the thing.
---

# Do the thing

Prerequisite: [[setup-ryu]].

## Step 1

- ...

## Step 2

```sh
curl -s http://127.0.0.1:7980/api/health
```
```
