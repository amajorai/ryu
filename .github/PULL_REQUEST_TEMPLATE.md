<!--
Heads up: this repo is a one-way mirror of a private monorepo (the source of truth). We review
your PR here and replay it into the monorepo with authorship preserved; it returns on the next
sync. See CONTRIBUTING.md. Your branch SHA on main may be rewritten by that sync — that's normal.
-->

## What & why

<!-- One or two sentences: what changes, and the problem it solves. Link any issue. -->

Closes #

## Layer check

<!-- The rule: Core decides *what runs*; Gateway decides *what's allowed/measured/paid for*. -->

- [ ] This change is in the correct layer (Core vs Gateway) — see CONTRIBUTING.md.

## Checklist

- [ ] Focused on one concern.
- [ ] Rust: `cargo fmt` + `cargo clippy` clean / TS: `bun x ultracite fix` run.
- [ ] Tested locally (say how below).
- [ ] Docs updated if behavior or a public interface changed.

## How I tested

<!-- Commands run, endpoints hit, what you observed. "Tests pass" alone isn't verification. -->
