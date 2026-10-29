import { describe, expect, test } from "bun:test";
import type { Agent } from "@/src/lib/api/agents.ts";
import { buildRyuPersonalizationInput } from "./ryu-personalization.ts";

const agent: Agent = {
	accountAccess: null,
	builtIn: true,
	canCreateAgents: true,
	chatModel: { engine: "acp:pi", modelId: null },
	composioActions: ["gmail.search"],
	createdAt: null,
	description: "Ryu agent",
	engine: "acp:pi",
	id: "ryu",
	identityMode: "managed",
	identityProfileIds: ["personal"],
	inference: null,
	lifecycleStatus: "active",
	locked: false,
	memory: { read_levels: ["user"], space_ids: ["home"], write_enabled: true },
	model: null,
	name: "Ryu",
	orchestrator: true,
	persona: {
		display_name: "Ryu",
		output_style_id: "plain-technical",
		tone: "friendly",
	},
	safetyProfile: "autonomous",
	skills: ["built-in"],
	source: "{}",
	systemPrompt: "Keep the user's tools safe.",
	title: "Assistant",
	tools: ["*"],
	updatedAt: null,
	version: "1.0.0",
};

describe("Ryu onboarding personalization", () => {
	test("changes the name and avatar while preserving the agent configuration", () => {
		const input = buildRyuPersonalizationInput(agent, "  Nova  ", {
			kind: "emoji",
			emoji: "🪐",
		});

		expect(input.name).toBe("Nova");
		expect(input.persona).toMatchObject({
			display_name: "Ryu",
			emoji: "🪐",
			output_style_id: "plain-technical",
			tone: "friendly",
		});
		expect(input.chatModel).toEqual(agent.chatModel);
		expect(input.engine).toBe(agent.engine);
		expect(input.systemPrompt).toBe(agent.systemPrompt);
		expect(input.tools).toEqual(agent.tools);
		expect(input.memory).toEqual(agent.memory);
	});

	test("clears all custom avatar sources when the default avatar is chosen", () => {
		const input = buildRyuPersonalizationInput(
			{
				...agent,
				persona: {
					...agent.persona,
					display_name: agent.persona?.display_name ?? null,
					tone: agent.persona?.tone ?? null,
					avatar_url: "data:image/png;base64,abc",
					emoji: "🪐",
				},
			},
			"Ryu",
			null
		);

		expect(input.persona).toMatchObject({
			avatar_url: null,
			emoji: null,
			icon: null,
			dicebear: null,
			expressive: null,
			dither: null,
		});
	});
});
