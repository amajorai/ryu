import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { glyphToPersonaFields } from "@/src/lib/agent-persona.ts";
import type { Agent, AgentInput } from "@/src/lib/api/agents.ts";

/** Keep Ryu's runtime and capabilities intact while onboarding changes identity. */
export function buildRyuPersonalizationInput(
	agent: Agent,
	name: string,
	avatar: GlyphValue
): AgentInput {
	return {
		canCreateAgents: agent.canCreateAgents,
		chatModel: agent.chatModel ?? undefined,
		composioActions: agent.composioActions,
		description: agent.description,
		engine: agent.engine,
		identityProfileIds: agent.identityProfileIds,
		inference: agent.inference ?? undefined,
		memory: agent.memory,
		model: agent.model,
		name: name.trim(),
		orchestrator: agent.orchestrator,
		persona: {
			...agent.persona,
			display_name: agent.persona?.display_name ?? null,
			tone: agent.persona?.tone ?? null,
			...glyphToPersonaFields(avatar),
		},
		safetyProfile: agent.safetyProfile,
		skills: agent.skills,
		systemPrompt: agent.systemPrompt,
		title: agent.title,
		tools: agent.tools,
		version: agent.version,
	};
}
