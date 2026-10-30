import {
	buildAgentNamePrompt,
	extractGeneratedAgentName,
} from "@/src/lib/agent-name.ts";
import { chatHeaders, chatStreamUrl } from "@/src/lib/api/chat.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { getLaneAgentSelection } from "@/src/lib/api/preferences.ts";
import { readUiMessageText } from "@/src/lib/ui-message-text-stream.ts";

/** Ask the local lane agent for one human name that fits the new agent's brief.
 *  Throws when the agent is unreachable or answers with anything else. */
export async function fetchGeneratedAgentName(
	target: ApiTarget,
	{ instructions, title }: { instructions: string; title: string }
): Promise<string> {
	const localSelection = await getLaneAgentSelection(target, "local");
	const response = await fetch(chatStreamUrl(target), {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...chatHeaders(target),
		},
		body: JSON.stringify({
			agent_id: localSelection.agent_id || "ryu",
			conversation_id: `agent-name-${crypto.randomUUID()}`,
			enable_long_term: false,
			messages: [
				{
					content: buildAgentNamePrompt({
						instructions,
						title,
					}),
					role: "user",
				},
			],
			persist: false,
		}),
	});
	if (!response.ok) {
		throw new Error(`Local agent returned ${response.status}`);
	}
	if (!response.body) {
		throw new Error("The local agent returned no response body");
	}
	const { text: answer } = await readUiMessageText(response.body);
	const generated = extractGeneratedAgentName(answer);
	if (!generated) {
		throw new Error("The local agent did not return a single human name");
	}
	return generated;
}
