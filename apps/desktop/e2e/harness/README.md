# Welcome proof bundle

`welcome-step-story.html` and its React entrypoint are the source of truth for
the welcome proof. Run `bun run test:e2e:welcome` from `apps/desktop` to build
the bundle into the ignored `tmp/ryu-welcome-proof` directory and serve that
fresh output with Vite preview before Playwright starts. Build output stays
local; the harness source is the only checked-in test input.
