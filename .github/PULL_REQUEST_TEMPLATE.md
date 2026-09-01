<!--
Heads up: this public repository is generated from the Ryu monorepo. We review your PR here and
replay accepted changes into the monorepo with authorship preserved; they return on the next sync.
See CONTRIBUTING.md. The public `main` branch may be rewritten by that sync - this is normal.
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
