import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { BYOK_MODEL_PROVIDERS as SHARED_BYOK_MODEL_PROVIDERS } from "@ryuhq/core-client/agent-account-access";
import { noSandboxNote } from "./AgentLaunchWarning.tsx";
import {
	BYOK_MODEL_PROVIDERS,
	engineRefusedWhenLimited,
} from "./agent-provider-access.ts";

const tl: LiteralMessage = (source) => `[${source}]`;

describe("agent provider access", () => {
	test("desktop's BYOK rows match the shared core-client list", () => {
		const desktop = BYOK_MODEL_PROVIDERS.map(
			({ slug, label }): { label: string; slug: string } => ({ label, slug })
		);
		const shared = SHARED_BYOK_MODEL_PROVIDERS.map(({ slug, label }) => ({
			label,
			slug,
		}));
		expect(desktop).toEqual(shared);
	});

	test("the managed-Pi refusal is one translated sentence", () => {
		const refusal = engineRefusedWhenLimited("acp:pi", "direct", tl);
		expect(
			refusal?.startsWith("[This agent's engine (Ryu in the engine list)")
		).toBe(true);
		expect(refusal?.endsWith("Limit to selected accounts off.]")).toBe(true);
		expect(engineRefusedWhenLimited("acp:pi", "gateway", tl)).toBeNull();
	});

	test("the no-sandbox note goes through the translator", () => {
		expect(noSandboxNote(tl)).toBe(
			"[On this computer, an agent with its own identity or limited accounts can run only on Ryu (without shell or file tools).]"
		);
	});
});
