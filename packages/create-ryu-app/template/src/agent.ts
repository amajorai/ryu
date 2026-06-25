#!/usr/bin/env bun
/**
 * Starter Runnable — a minimal gateway-mandatory agent.
 *
 * Run with:
 *   bun run src/agent.ts
 *
 * Every model call goes through the Ryu gateway. Set RYU_GATEWAY_URL (default
 * http://127.0.0.1:7981) and RYU_GATEWAY_TOKEN before running if your gateway
 * requires auth.
 *
 * The model is a swappable string — change it here or via RYU_MODEL env var.
 * No provider key belongs in this file; credentials live in the gateway config.
 */

import { defineModel } from "@ryuhq/sdk/model";

const MODEL_ID = process.env.RYU_MODEL ?? "gpt-4o-mini";
const model = defineModel(MODEL_ID);

const messages: Array<{
	role: "user" | "assistant" | "system";
	content: string;
}> = [
	{
		role: "system",
		content: "You are a helpful assistant running inside the Ryu platform.",
	},
	{
		role: "user",
		content: "Hello! Say hi and tell me which model you are.",
	},
];

process.stdout.write(
	`streaming one turn via gateway (model: ${model.model}) ...\n\n`
);

for await (const delta of model.stream(messages)) {
	if (delta.content) {
		process.stdout.write(delta.content);
	}
}

process.stdout.write("\n");
