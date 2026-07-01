# Ryu agent skills

A collection of external agent skills that teach an AI coding agent (Claude Code, Cursor, and any other SKILL.md-aware client) how to set up and drive Ryu for a user.

These are external skills. They are not installed into Ryu's own skills registry - they live as instructions an agent loads. Driving a Ryu node from inside the agent is done through the `apps/mcp` MCP server, which these skills configure.

## The SKILL.md format

Each skill is a directory under `apps/skills/` with one `SKILL.md`:

```
apps/skills/<skill-slug>/SKILL.md
```

Every file starts with YAML frontmatter holding `name` and `description`, then Markdown instructions:

```md
---
name: setup-ryu
description: What the skill does and when to use it.
---

# ...instructions...
```

The `description` is what a loading agent reads to decide whether to open the skill, so it states both the capability and the trigger.

## How an agent loads one

- Point the agent's skills directory at `apps/skills`, or copy a skill folder into the agent's skills location (for many clients that is `~/.claude/skills/<slug>/SKILL.md`).
- The agent reads each `SKILL.md` frontmatter and surfaces the skill by its `description`.
- Skills cross-reference each other with `[[skill-name]]`.

## Index

- [setup-ryu](setup-ryu/SKILL.md) - set Ryu up end-to-end and point a user's other agents at the node via `apps/mcp`.
- [ryu-mcp](ryu-mcp/SKILL.md) - drive a Ryu node through the `apps/mcp` MCP server and its tools.
- [ryu-build-agent](ryu-build-agent/SKILL.md) - create and configure an agent on a node via the `/api/agents` REST surface.
- [ryu-local-model](ryu-local-model/SKILL.md) - search, download, and serve a local GGUF model via the models and engines REST surface.
- [ryu-author-skill](ryu-author-skill/SKILL.md) - author a new skill in this same SKILL.md format so the ecosystem is self-extending.

## Adding a skill

See [ryu-author-skill](ryu-author-skill/SKILL.md). In short: create `apps/skills/<slug>/SKILL.md` with `name` and `description` frontmatter, write skimmable and verified instructions, add a line to this index, and run `bun install` to confirm the workspace still resolves.
