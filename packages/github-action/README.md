# Ryu for GitHub

Use a self-hosted or managed Ryu Core node from GitHub Actions. The action validates
the node, exports reusable node variables, runs saved Ryu agents/teams/workflows, and
can invoke an allowlisted MCP/Ryu tool directly.

## Setup-only workflow

```yaml
name: Ryu setup

on: [push]

jobs:
  ryu:
    runs-on: ubuntu-latest
    steps:
      - uses: amajorai/ryu@v1
        with:
          target: managed
          managed-node-url: ${{ secrets.RYU_MANAGED_NODE_URL }}
          managed-node-token: ${{ secrets.RYU_MANAGED_NODE_TOKEN }}
          operation: setup

      - run: echo "Ryu is available at $RYU_CORE_URL"
```

`target: self-hosted` uses `node-url`/`node-token` or `RYU_CORE_URL`/
`RYU_CORE_TOKEN`. `target: managed` verifies that `/api/system/info` reports
`managed: true`. `target: auto` accepts either kind of node.

## Run an agent, team, or workflow

```yaml
- uses: amajorai/ryu@v1
  id: ryu
  with:
    target: managed
    managed-node-url: ${{ secrets.RYU_MANAGED_NODE_URL }}
    managed-node-token: ${{ secrets.RYU_MANAGED_NODE_TOKEN }}
    operation: run
    agent: review-agent
    prompt: Review the changed files and return a concise release decision.
    response-file: .ryu/review.txt

- run: cat .ryu/review.txt
- run: echo "${{ steps.ryu.outputs.response }}"
```

Use `team` or `workflow` instead of `agent`; the three selectors are mutually
exclusive. Existing Ryu tools configured for the selected agent/team/workflow remain
available through Core's normal allowlist and approval rules.

Runs do not persist conversations or enable long-term memory unless `persist: true`
or `enable-long-term: true` is set. A remote node cannot see the GitHub runner's
filesystem, so set `cwd` only when the targeted Core process can access that path.

## Call a direct tool

```yaml
- uses: amajorai/ryu@v1
  id: ryu-tool
  with:
    node-url: ${{ secrets.RYU_NODE_URL }}
    node-token: ${{ secrets.RYU_NODE_TOKEN }}
    operation: tool
    agent: release-agent
    tool: exa.search
    tool-arguments: '{"query":"Ryu release notes"}'

- run: echo '${{ steps.ryu-tool.outputs.result-json }}'
```

Direct calls require an agent because Core uses that agent's configured tool
allowlist. A denied or failed call fails the action.

## Gate a pull request on evals

`operation: eval` replays a dataset through the node's Gateway eval runner, compares the
scores with `eval-threshold`, and fails the job on a regression. The dataset is a JSON,
JSONL, or CSV file in the checked-out repository; each row needs a `prompt` (or `input`,
`question`, `query`) and may carry an `expected` answer, `context`, `id`, and Gateway
case fields such as `assertions` and `evaluators`. Extra CSV columns become `{{vars}}`.

```yaml
- uses: actions/checkout@v4
- uses: amajorai/ryu@v1
  id: evals
  with:
    node-url: ${{ secrets.RYU_NODE_URL }}
    node-token: ${{ secrets.RYU_NODE_TOKEN }}
    operation: eval
    agent: support-agent
    eval-dataset: evals/support.jsonl
    eval-scorers: answer_relevance, toxicity
    eval-threshold: |
      0.8
      overall=0.7
    eval-junit-file: reports/ryu-eval.xml

- if: always()
  run: echo '${{ steps.evals.outputs.eval-passed }}'
```

A bare threshold applies to every listed scorer (or to `overall` when none is listed);
`scorer=n` sets one. Scorers are offline Gateway catalog evaluators or the built-in
metrics `overall`, `assertions`, `policy`, `substring`, and `latency`. Negative-signal
evaluators such as `toxicity` are inverted, so every threshold reads "at least this
good". A scorer that never executed fails its threshold. The step summary lists each
threshold check and the failing case ids (or truncated prompts), never response text.

## Export Ryu Vault secrets

List vault values in `secrets` (one per line: `NAME`, `/folder/NAME`, `ENV:NAME`, or
`ENV:/folder/NAME`). The action logs in with a Ryu Vault machine identity, reads the
values from `/api/vault/agent/export`, masks each one, and exports it as an
environment variable named after the secret for later steps. The short-lived vault
token is revoked when the values have been read.

With GitHub OIDC (no stored credential), create a JWT machine identity whose bound
claims name your repository, then:

```yaml
permissions:
  id-token: write
  contents: read

steps:
  - uses: amajorai/ryu@v1
    with:
      node-url: ${{ secrets.RYU_NODE_URL }}
      vault-jwt-identity: github-deploy
      vault-jwt-audience: ryu
      secrets: |
        DATABASE_URL
        prod:/stripe/STRIPE_SECRET_KEY

  - run: ./deploy.sh   # DATABASE_URL and STRIPE_SECRET_KEY are set and masked
```

With AppRole, pass `vault-role-id` and `vault-secret-id` (store the secret id as a
GitHub secret) instead of `vault-jwt-identity`. Machine tokens read node-scoped
values that the identity's policies allow; a listed value the token cannot read
fails the step before anything is exported. A vault-only `setup` step does not need
`node-token`. The `vault-secrets` output lists the exported names, never values.

## Inputs and outputs

The complete input/output contract is declared in the repository-root `action.yml`.
Tokens are masked before requests run and are never logged by the action. The optional
`write-summary` report contains operation/node metadata and, for `eval`, the threshold
table and failing case names; response text is exposed only through `response`,
`result-json`, `eval-json`, and `response-file`.
