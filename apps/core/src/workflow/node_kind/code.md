Run or check a program written in Lean 4, Bend 2, or BAML. The language
runners live in [`ryu_code_runner`]; this node decides *what runs* → Core.

- `run` (default): Lean and Bend run `main` with the step input as their
  single command-line argument and emit stdout. BAML calls `function` with
  `args` through the Ryu gateway and emits the result (raw text for a
  string, JSON otherwise).
- `check`: the node fails unless the language's checker accepts the
  source (Lean without `sorry`, Bend's `ALL PROOFS CHECK`, `baml-cli
  check`), and emits a JSON receipt otherwise.

`source` is never template-resolved, so step data cannot rewrite the
program; `input` and `args` are templates (`{{input}}`, `{{nodes.<id>}}`,
`{{state.<key>}}`, `{{trigger.*}}`).
