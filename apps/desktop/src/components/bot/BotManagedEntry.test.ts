import { describe, expect, test } from "bun:test";
import { EMPTY_AGENT_SELECTION } from "@/src/lib/api/preferences.ts";
import {
	resolveBotCloudSelection,
	resolveBotManagedEntryState,
} from "./bot-managed-entry-state.ts";

describe("Bot managed entry", () => {
	test("waits for the subscription verdict before deciding", () => {
		expect(
			resolveBotManagedEntryState({
				hasManagedNode: false,
				managedInference: false,
				resolvingSubscription: true,
			})
		).toBe("checking-subscription");
	});

	test("requires a subscription", () => {
		expect(
			resolveBotManagedEntryState({
				hasManagedNode: true,
				managedInference: false,
				resolvingSubscription: false,
			})
		).toBe("subscribe");
	});

	test("waits for the managed workspace after payment", () => {
		expect(
			resolveBotManagedEntryState({
				hasManagedNode: false,
				managedInference: true,
				resolvingSubscription: false,
			})
		).toBe("provisioning");
	});

	test("enters the shared desktop shell once a managed node is available", () => {
		expect(
			resolveBotManagedEntryState({
				hasManagedNode: true,
				managedInference: true,
				resolvingSubscription: false,
			})
		).toBe("ready");
	});

	test("seeds Auto cloud when the managed node has no cloud default", () => {
		const resolved = resolveBotCloudSelection(EMPTY_AGENT_SELECTION);

		expect(resolved.shouldPersist).toBe(true);
		expect(resolved.selection).toMatchObject({
			agent_id: "ryu",
			model: "openrouter/auto",
			provider: "managed-openrouter",
		});
	});

	test("preserves the Console-admin cloud default", () => {
		const configured = {
			...EMPTY_AGENT_SELECTION,
			agent_id: "ryu",
			model: "anthropic/claude-sonnet-4",
			provider: "managed-openrouter",
		};
		const resolved = resolveBotCloudSelection(configured);

		expect(resolved).toEqual({
			selection: configured,
			shouldPersist: false,
		});
	});
});
