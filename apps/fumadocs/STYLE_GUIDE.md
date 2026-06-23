# Ryu docs style guide

How every page under `content/docs/` is written. The goal: a newcomer finds the right page in
one click, every page is exactly one kind of document, no fact appears twice, and sibling pages
sit at the same depth. This guide is the contract for anyone (human or agent) editing the docs.

> Scope: the five reference realms - `start-here`, `using-ryu`, `gateway`, `core`, `develop`.
> The `academy/` realm is a separate learning/certification track and is NOT governed by this
> guide. Do not edit it.

## Hard rules (non-negotiable)

- **No em dashes.** Never use `—`. Rewrite the sentence, or use a spaced hyphen ` - ` for an
  aside, or a colon to introduce a list. This applies to prose, tables, and callouts.
- **No colon directly after inline code.** Write ``the `enabled` flag - off by default`` not
  ``the `enabled` flag: off``. Use ` - ` instead.
- **Ground every claim in code.** Cite the real route, file, flag, or env var
  (e.g. `POST /api/tools/exec`, `apps/core/src/teams/mod.rs`, `RYU_MESH_ENABLED`). If you cannot
  cite it, do not write it. Never invent a capability, endpoint, or default.
- **Be honest about maturity.** If a feature is Windows-first, opt-in, off by default, or not yet
  live-verified, say so in a `<Callout type="warn">`. The ground truth in `CLAUDE.md` /
  `AGENTS.md` flags these; carry the caveat forward, never sand it off.
- **One source of truth.** A fact lives on exactly one page. Everywhere else, link to it. If you
  feel the urge to re-explain something, link instead.

## Page types (Diataxis) - pick exactly one per page

| Type | Job | Shape | Voice |
|---|---|---|---|
| **Tutorial** | Teach by doing one guaranteed-to-work path | Numbered steps, start to finish, no option dumps | "you", present tense |
| **How-to** | Accomplish one task; assumes competence | Short intro, then steps or "to do X, do Y" | "you", imperative |
| **Reference** | Exhaustive, consistent, dry | Tables of fields/routes/flags, one shape per page | neutral, third person |
| **Explanation** (concept) | Build understanding, the "why" and trade-offs | Prose, diagrams, no step lists | neutral, can use "we" |

Never mix two types on one page. If a how-to drifts into theory, extract the theory to a concept
page and link it. Reference never teaches; tutorials never enumerate every option.

## Frontmatter

Every `.mdx` starts with:

```yaml
---
title: Concise Title in Title Case
description: One sentence, what this page is and who it is for. No trailing period needed.
---
```

`title` becomes the sidebar label and the `<h1>` - do not repeat it as a heading in the body.
`description` is shown under the title and inside `<DocCard>` previews, so write it to read well
as a card subtitle.

## Landing pages (realm `index.mdx` and section index pages)

A landing page routes, it does not dump. Structure:

1. One or two sentences: what this realm/section is and who it serves.
2. Optional: a short orientation (a diagram, or "what runs on every request" style list).
3. A card grid to the highest-value next pages.

Use `<AutoCards url="/docs/<realm>" />` to auto-list every child with its description, or a hand
-curated `<Cards>` of `<DocCard href="..." />` when you want a specific order or subset. Do not
hand-write titles/descriptions that duplicate the target page's frontmatter - `<DocCard>` pulls
them automatically.

## Depth bands (keep siblings consistent)

- Landing: ~20-50 lines. Orientation + cards, never the full detail.
- How-to / tutorial: ~50-150 lines. The task, end to end, plus the one or two caveats that bite.
- Reference: as long as the surface demands, but every sibling reference page uses the same
  template (intro -> what it is -> the data/route/field tables -> behavior/guarantees -> caveats).
- A two-paragraph page sitting beside a 300-line page is a smell. Promote, demote, merge, or split.

## Components available

These are registered globally (`src/components/mdx.tsx`); use them, do not import.

- `<Callout type="info|warn|error">…</Callout>` - asides, caveats, honesty notes.
- `<Cards>` + `<DocCard href="/docs/…" />` - a curated card grid (auto-pulls title/description).
- `<DocCard href title description />` - override the auto-pulled text when needed.
- `<AutoCards url="/docs/…" />` - list every child page of a folder index.
- `<Mermaid chart={`…`} />` or a ```mermaid fenced block - diagrams for concept pages.
- `<TryInRyu page="chat" />` - an "Open in Ryu" deep-link CTA for user-facing how-tos. Valid
  `page` keys mirror the desktop deep-link surfaces (chat, agents, models, skills, tools, spaces,
  workflows, monitors, marketplace, settings, channels, engines, store, …). An unknown key just
  renders an inert link, so it never breaks the build.
- Standard markdown tables, fenced code blocks (with a language), `<Steps>` from Fumadocs for
  numbered tutorials when helpful.

## Linking

- Always absolute: `/docs/<realm>/<page>` (e.g. `/docs/core/workflows`). No relative `../`.
- Cross-realm links are expected and good - that is how single-source-of-truth works.
- When you reference another subsystem, link its canonical page rather than re-explaining it.

## Code and routes

- Show real endpoints with method - ```` ```\nPOST /api/tools/exec\n``` ```` or inline `POST /api/tools/exec`.
- Tables are the default for enumerating fields, routes, flags, defaults. Columns stay consistent
  within a page.
- Code samples must be runnable or clearly illustrative; prefer the languages the repo uses
  (TypeScript, Rust, bash, toml, json).

## The acceptance check (run it on every page you touch)

1. The page is exactly one Diataxis type.
2. Every claim cites a real route/file/flag, and every caveat from ground truth survives.
3. No fact on this page is also stated on another page (link instead).
4. It sits at the same depth as its siblings.
5. No em dash; no colon after inline code.
