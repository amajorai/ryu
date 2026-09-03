---
name: Visual planning
description: Investigate first, publish the plan as steps with real dependencies, and let a human decide it before you edit
keep-coding-instructions: true
---

Work that is expensive to undo gets planned in the open. Before a migration, a
refactor that crosses many files, a dependency swap, a change to auth or billing, or
anything that rewrites data — write the plan down, publish it, and let a person read
it. The plan is a **Blueprint** artifact, not a message in the transcript: it has
addressable steps, a dependency graph, and a verdict.

## Investigate before you propose

A plan written from the request alone is a guess with headings on it. Read first, and
make the reading cheap enough that you actually do it: find the files the change
lands in, read the ones that decide the shape, run the test that currently passes, and
check whether the thing you are about to add already exists under another name.

You are looking for the two facts that make a plan reviewable:

- **The real ordering.** Which step cannot start until another finishes, and *why* —
  a schema column has to exist before a backfill reads it; a flag has to ship before
  the code behind it does.
- **The blast radius.** Which files each step touches. A reviewer who sees
  `packages/auth/src/session.ts` in step 3 will stop you there; the same reviewer
  reading "update session handling" will not.

If investigation changes what you think the task is, say so before you publish.
Publishing a confident plan for the wrong task wastes a human's attention, which is
the scarcest thing in this loop.

## Publish the plan

Call `blueprint.plan_publish` with a `title`, the plan as `markdown`, and — this is
the part that makes it worth reviewing — an explicit `steps` array.

The markdown is rendered as addressable blocks: headings, paragraphs, list items,
code, quotes, mermaid. Write it for a person who has not read the code. Lead with what
changes and what it costs, not with a restatement of the request.

Each step carries:

- `title` — an imperative, one line. "Add the shadow column behind a flag", not
  "Schema work".
- `summary` — what actually happens, including the thing a reviewer would object to
  if they knew it. If a step is irreversible, say so here.
- `depends_on` — the ids of the steps that must finish first. **Only real
  dependencies.** Chaining every step to the previous one turns the graph into a line
  and throws away the information the reviewer came for: what can go in parallel, and
  which step everything is queued behind.
- `files` — the paths this step touches. Guesses are fine if marked as guesses; an
  empty list on a step that edits code is not.
- `risk` — for the steps where the honest answer is "this one".

Number the steps in the markdown too, so the prose and the graph agree. `steps` is
what the graph is built from; the markdown is what gets read.

`blueprint.plan_publish` returns `{ plan_id, revision, status, review_url }`. Give
the human the `review_url` in your reply — a plan nobody opens is not a review.

## While the plan is out

Poll with `blueprint.plan_status({ plan_id, wait_secs })`. `wait_secs` is clamped to
at most 60 and the call returns as soon as a verdict lands, so a wait is cheap; use
something like 30 rather than hammering it.

Three outcomes, and only one of them is permission:

- **`approved`** — start. Read `feedback` first anyway: an approved plan can still
  carry unresolved comments, and they are advisory notes the reviewer expects you to
  have seen.
- **`changes_requested`** — do not edit. Revise (below).
- **`in_review`** — the wait expired. **This is not approval, and it is not
  rejection.** It means nobody has answered yet. Poll again a bounded number of times
  — a handful, not forever — and if the plan is still undecided, stop and tell the
  person you are waiting on them, with the `review_url`. Never spin, and never read a
  timeout as consent.

While a verdict is outstanding, do not touch a file the plan proposes to change. Keep
reading, keep gathering facts, sharpen the plan — but the point of publishing is that
the human's answer arrives *before* the diff exists, not after.

A `blocker` annotation stops you on its own. If one is open against a step, that step
does not start, whatever the rest of the plan says.

## When changes are requested

`blueprint.plan_status` returns `feedback` already serialized: each finding names the
step or block it is anchored to, and a `redline` carries the exact replacement text
the reviewer wants. Read it as instructions about *specific lines*, not as a general
sentiment. Use `blueprint.plan_get` when you need the surrounding plan text to
understand which sentence a finding is about.

Then revise and publish again **with the same `plan_id`**. That appends a revision to
the existing plan and resets it to `in_review`. It matters more than it looks:

- The reviewer gets a **diff** against the revision they already read, because block
  ids are stable across revisions by content. They re-read the paragraphs you changed,
  not all of them.
- Their annotations stay attached to the revision they were written against, so the
  record of what was objected to and what you did about it survives.

Publishing without `plan_id` creates a *new* plan. Now there are two plans, the
reviewer's annotations point at the abandoned one, and they have to diff by eye. Do
not do it — a new `plan_id` is for a genuinely different piece of work.

Answer every finding. If you disagree with one, the revision is where you say why —
change the plan text to argue the case, and let them decide again. Silently ignoring a
redline and re-publishing is how a reviewer learns that reviewing does nothing.

## As you execute

Mark progress with `blueprint.step_update({ plan_id, step_id, status })` — `in_progress`
when you start a step, `done` when it lands, `blocked` when it cannot proceed. The
reviewer is watching the graph; this is what turns it from a proposal into a live
picture of the work, and it costs one call.

Mark `done` when the step is actually finished — the test passes, the file is written
— not when you have decided how to do it. `blocked` is not a failure to report
reluctantly; it is the signal that gets a human back to the graph while there is still
time to re-plan.

If executing a step teaches you the plan was wrong — a dependency you missed, a file
that turned out to be load-bearing — stop and publish a revision under the same
`plan_id`. A plan that has quietly diverged from what you are doing is worse than no
plan, because it tells the reviewer the work is under control when it is not.
