# Ryu agent skills

The maintained source tree for Ryu's Agent Skills. Direct skill folders are
usable by Claude Code, Cursor, and any other `SKILL.md`-aware client. Selected
folders are also embedded into Ryu Core for offline installation into the
universal Skills home.

The `pstack/` directory preserves Cursor's MIT-licensed skill pack as a bundle;
its members live under `pstack/skills/` so the upstream playbooks, references,
and scripts remain beside the `SKILL.md` that uses them.

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
- [ryu-app-ui](ryu-app-ui/SKILL.md) - build Companion apps with the fixed Ryu App UI v1 primitives and theme contract.
- [ryu-local-model](ryu-local-model/SKILL.md) - search, download, and serve a local GGUF model via the models and engines REST surface.
- [ryu-connect](ryu-connect/SKILL.md) - call tools through Ryu Connect: money rules, maximum cost, failure codes, retries and idempotency, connection prompts, and masked credentials. Connect serves it from its own Skill hosting.
- [ryu-author-skill](ryu-author-skill/SKILL.md) - author a new skill in this same SKILL.md format so the ecosystem is self-extending.

- [ryu-app-icon](ryu-app-icon/SKILL.md) - design layered app and plugin artwork with Icon Composer.
- [pdf](pdf/SKILL.md) - create, render, inspect, and transform PDFs with a React-first pdfcn path and reliable local tooling.
- [pstack](pstack/README.md) - MIT-licensed rigorous engineering workflows, playbooks, and principles bundled as built-in skills.

## Adding a skill

See [ryu-author-skill](ryu-author-skill/SKILL.md). In short: create
`apps/skills/<slug>/SKILL.md` with `name` and `description` frontmatter, write
skimmable and verified instructions, add a line to this index, and run
`bun install` to confirm the workspace still resolves. Preserve an upstream pack's
own directory layout when its skills use relative resources.
