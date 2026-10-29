import { describe, expect, test } from "bun:test";
import type { ScopeDefault } from "@/src/lib/api/hierarchy.ts";
import {
	type AgentSelection,
	EMPTY_AGENT_SELECTION,
} from "@/src/lib/api/preferences.ts";
import {
	laneDefaultCacheWarning,
	NODE_DEFAULT_SCOPE_LABEL,
	scopeDefaultCacheWarning,
} from "./node-default-cache-warning.ts";

const TITLE = "Apply now? This resets the prompt cache";

const scope: ScopeDefault = {
	coordinatorEffort: "high",
	coordinatorModel: "coordinator-a",
	coordinatorProvider: "openai",
	effort: "low",
	model: "thread-a",
	provider: "anthropic",
};

function lane(model: string, extra: Partial<AgentSelection> = {}) {
	return {
		...EMPTY_AGENT_SELECTION,
		agent_id: "ryu",
		provider: "openrouter",
		model,
		...extra,
	};
}

describe("node-wide scope default confirmation", () => {
	test("effort-only and unchanged saves ask nothing", () => {
		expect(
			scopeDefaultCacheWarning(NODE_DEFAULT_SCOPE_LABEL, scope, { ...scope })
		).toBeNull();
		expect(
			scopeDefaultCacheWarning(NODE_DEFAULT_SCOPE_LABEL, scope, {
				...scope,
				coordinatorEffort: "low",
				effort: "high",
			})
		).toBeNull();
	});

	test("a thread or coordinator model or provider change names the node-wide default", () => {
		for (const after of [
			{ ...scope, model: "thread-b" },
			{ ...scope, provider: "openai" },
			{ ...scope, coordinatorModel: "coordinator-b" },
			{ ...scope, coordinatorProvider: "anthropic" },
		]) {
			const warning = scopeDefaultCacheWarning(
				NODE_DEFAULT_SCOPE_LABEL,
				scope,
				after
			);
			expect(warning?.title).toBe(TITLE);
			expect(warning?.description).toContain(
				"Every thread that inherits the node-wide default switches model"
			);
		}
	});

	test("resetting a stored model asks; resetting an effort-only record does not", () => {
		const empty = { effort: "", model: "", provider: "" };
		expect(
			scopeDefaultCacheWarning(NODE_DEFAULT_SCOPE_LABEL, scope, empty)
		).not.toBeNull();
		expect(
			scopeDefaultCacheWarning(
				NODE_DEFAULT_SCOPE_LABEL,
				{ ...empty, effort: "high" },
				empty
			)
		).toBeNull();
	});
});

describe("lane default confirmation", () => {
	const local = lane("local-a", { provider: "local" });

	test("cloud lane model, provider or agent changes ask; effort and access changes do not", () => {
		const cloud = lane("model-a");
		for (const after of [
			lane("model-b"),
			lane("model-a", { provider: "anthropic" }),
			lane("model-a", { agent_id: "codex" }),
			EMPTY_AGENT_SELECTION,
		]) {
			expect(
				laneDefaultCacheWarning({
					after,
					cloudSelection: cloud,
					lane: "cloud",
					localSelection: local,
					managed: false,
				})?.description
			).toContain("the node-wide cloud default");
		}
		expect(
			laneDefaultCacheWarning({
				after: lane("model-a", {
					access_mode: "acceptEdits",
					effort: "high",
					thinking_level: "high",
				}),
				cloudSelection: cloud,
				lane: "cloud",
				localSelection: local,
				managed: false,
			})
		).toBeNull();
	});

	test("setting the cloud lane to the local model chats already use asks nothing", () => {
		expect(
			laneDefaultCacheWarning({
				after: { ...local },
				cloudSelection: EMPTY_AGENT_SELECTION,
				lane: "cloud",
				localSelection: local,
				managed: false,
			})
		).toBeNull();
		expect(
			laneDefaultCacheWarning({
				after: EMPTY_AGENT_SELECTION,
				cloudSelection: lane("model-a"),
				lane: "cloud",
				localSelection: local,
				managed: false,
			})
		).not.toBeNull();
	});

	test("a managed node's empty cloud lane counts as Auto cloud", () => {
		const auto = lane("openrouter/auto", { provider: "managed-openrouter" });
		expect(
			laneDefaultCacheWarning({
				after: auto,
				cloudSelection: EMPTY_AGENT_SELECTION,
				lane: "cloud",
				localSelection: local,
				managed: true,
			})
		).toBeNull();
		expect(
			laneDefaultCacheWarning({
				after: lane("model-b"),
				cloudSelection: EMPTY_AGENT_SELECTION,
				lane: "cloud",
				localSelection: local,
				managed: true,
			})
		).not.toBeNull();
	});

	test("the local lane asks only while chats fall back to it", () => {
		const input = {
			after: lane("local-b", { provider: "local" }),
			lane: "local" as const,
			localSelection: local,
		};
		expect(
			laneDefaultCacheWarning({
				...input,
				cloudSelection: lane("cloud-a"),
				managed: false,
			})
		).toBeNull();
		expect(
			laneDefaultCacheWarning({
				...input,
				cloudSelection: EMPTY_AGENT_SELECTION,
				managed: true,
			})
		).toBeNull();
		expect(
			laneDefaultCacheWarning({
				...input,
				cloudSelection: EMPTY_AGENT_SELECTION,
				managed: false,
			})?.description
		).toContain("the node-wide local default");
	});
});
