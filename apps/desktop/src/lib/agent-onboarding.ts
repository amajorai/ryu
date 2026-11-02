// Shared onboarding seed for a manually-created agent's first chat.
//
// Keeping the prompt and tab options together matters: the compact create
// dialog and the full editor must both select the newly-created agent and send
// the same one-shot welcome request. ChatPage turns that request into the
// agent's actual introduction, so this remains a normal, inspectable chat turn.
// The prompt is model-facing and stays English; the tab title is the reader's.

import { translate as tl } from "@ryu/i18n/core";

export interface NewAgentChatSeed {
	forceNew: true;
	initialAgent: string;
	initialPrompt: string;
	initialSubmit: true;
	title: string;
}

export function buildNewAgentChatSeed(
	agentId: string,
	agentName: string
): NewAgentChatSeed {
	const name = agentName.trim() || "your new agent";

	return {
		forceNew: true,
		initialAgent: agentId,
		initialPrompt: `Introduce yourself to me as ${name}. Briefly explain what you can help with based on your setup, then ask what I would like to work on first. Keep the welcome concise and friendly.`,
		initialSubmit: true,
		title: tl("{name} chat", { name }),
	};
}
