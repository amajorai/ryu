#!/usr/bin/env bun
/**
 * A minimal Ryu agent (Runnable, kind: "agent").
 *
 * `defineAgent` wraps your `run` function as a Runnable the platform can invoke.
 * Every model call goes through the Ryu gateway via `defineModel` — no provider
 * key lives in this file; credentials are configured in the gateway.
 *
 * Run:  bun run examples/agent/minimal-agent.ts "What is the capital of Japan?"
 * Env:  RYU_GATEWAY_URL (default http://127.0.0.1:7981), RYU_GATEWAY_TOKEN, RYU_MODEL
 */

import { defineModel } from "@ryu/sdk/model";
import { defineAgent } from "@ryu/sdk";

const model = defineModel(process.env.RYU_MODEL ?? "gpt-4o-mini");

export const haiku = defineAgent<{ topic: string }, string>({
  id: "agent-haiku",
  name: "Haiku Writer",
  async run(input) {
    const reply = await model.chat([
      { role: "system", content: "You write a single three-line haiku. No preamble." },
      { role: "user", content: `Topic: ${input.topic}` },
    ]);
    return reply.content;
  },
});

// Demo when run directly.
if (import.meta.main) {
  const topic = process.argv[2] ?? "the sea at dawn";
  const out = await haiku.run({ topic }, { gateway: undefined as never });
  process.stdout.write(`${out}\n`);
}
