#!/usr/bin/env bun
/**
 * Starter Agent — a declarative, loop-owning Ryu agent.
 *
 * Run with:
 *   bun run src/agent.ts
 *
 * This is an expense-tracker skeleton: it reads the user's Gmail through an
 * existing Ryu tool (Composio) and summarizes the expenses it finds. The agent
 * OWNS its tool-calling loop — you don't write the loop, you declare the agent.
 *
 * Every model call goes through the Ryu gateway of the node you target. Set
 * RYU_GATEWAY_URL (default http://127.0.0.1:7981) and RYU_GATEWAY_TOKEN for
 * inference; set RYU_CORE_URL (default http://127.0.0.1:7980) and RYU_TOKEN for
 * tool execution. No provider key belongs in this file — credentials live in the
 * gateway/Core config.
 *
 * Before this works end to end you need, once:
 *   1. A Composio API key set on the node (Settings → Integrations).
 *   2. A Core agent (here "agent-expense") whose allowlist includes the Gmail
 *      actions below. `agentId` binds this SDK agent to it for governance.
 *   3. On first run the agent emits an `auth_required` event with a Gmail OAuth
 *      link — open it, connect Gmail, then run again.
 */

import { Agent, ryuTool } from "@ryuhq/sdk/agent";

const MODEL_ID = process.env.RYU_MODEL ?? "gpt-4o-mini";

const agent = new Agent({
	name: "expense-tracker",
	model: MODEL_ID,
	agentId: "agent-expense",
	instructions:
		"You are an expense tracker. Search the user's Gmail for receipts and " +
		"expense emails, read the relevant ones, and return a concise list of " +
		"expenses with amount, merchant, date, and a category.",
	tools: {
		gmailSearch: ryuTool("composio__GMAIL_SEARCH_EMAILS", {
			description: "Search the user's Gmail messages",
			parameters: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description:
							'Gmail search query, e.g. "receipt OR invoice newer_than:30d"',
					},
				},
				required: ["query"],
			},
		}),
		gmailGet: ryuTool("composio__GMAIL_GET_EMAIL", {
			description: "Fetch a single Gmail message by id",
		}),
	},
});

const result = await agent.generate(
	"Find my expenses from the last 30 days and summarize them."
);

if (result.authRequired) {
	process.stdout.write(
		`\nConnect your account to continue: ${result.authRequired.url ?? "(see message)"}\n`
	);
} else {
	process.stdout.write(`\n${result.text}\n`);
	process.stdout.write(`\n(${result.steps} step(s))\n`);
}

// ── Prefer the raw model client instead? ──────────────────────────────────────
// For a single text turn with no tools, skip the agent loop entirely:
//
//   import { defineModel } from "@ryuhq/sdk";
//   const model = defineModel(MODEL_ID);
//   for await (const delta of model.stream([{ role: "user", content: "hi" }])) {
//     if (delta.content) process.stdout.write(delta.content);
//   }
