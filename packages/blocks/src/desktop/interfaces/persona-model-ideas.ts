import { translate as tr } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	type InterfaceAgent,
	type InterfaceThread,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { byRecency } from "./persona-model-order.ts";

export interface PersonaIdea {
	id: string;
	prompt: string;
	/** When the conversation an idea follows up on last moved. */
	updatedAt?: string;
}

export interface PersonaIdeaGroup {
	ideas: PersonaIdea[];
	key: string;
	label: string;
}

const MAX_RECENT_IDEAS = 4;
const SKILL_TEMPLATES = [
	{
		prompt: (topic: string) =>
			tr("What changed in {topic} this week?", { topic }),
	},
	{
		prompt: (topic: string) => tr("Draft a plan for {topic}", { topic }),
	},
	{
		prompt: (topic: string) =>
			tr("Review {topic} and flag anything risky", { topic }),
	},
] as const;

/** A part that reads as an action ("digs through papers"), not a topic. */
const VERB_PHRASE = /^\w+s\s+(through|into|on|for|with|about|over)\b/i;
/** A part that names a role ("full-stack engineer"), not a topic. */
const ROLE_NOUN =
	/\b(agent|analyst|assistant|designer|developer|engineer|manager|researcher|writer)$/i;

/**
 * Split "Deploys, alerts and on-call runbooks" into lower-cased topics,
 * dropping parts that describe an action or a role, so templates read as
 * plain sentences.
 */
export function descriptionTopics(description: string): string[] {
	return description
		.split(/,|\band\b|&|;|\//i)
		.map((part) =>
			part
				.trim()
				.replace(/\.$/, "")
				.replace(/^(the|a|an)\s+/i, "")
		)
		.filter(
			(part) =>
				part.length > 1 && !VERB_PHRASE.test(part) && !ROLE_NOUN.test(part)
		)
		.map((part) =>
			/^[A-Z][a-z]/.test(part) ? part[0]?.toLowerCase() + part.slice(1) : part
		)
		.slice(0, SKILL_TEMPLATES.length);
}

/**
 * A description with no list of topics ("Full-stack engineer") names a
 * role, so the ideas ask the persona about its own next move instead of
 * echoing the role back as a template.
 */
function roleIdeas(description: string): PersonaIdea[] {
	if (description.trim().length < 2) {
		return [];
	}
	return [
		{ id: "role:next", prompt: "What would you tackle next?" },
		{ id: "role:ship", prompt: "What should we check before shipping?" },
	];
}

function threadIdea(thread: InterfaceThread): PersonaIdea | null {
	const title = thread.title || tr("Untitled");
	switch (threadStatus(thread)) {
		case "attention":
			return {
				id: `retry:${thread.id}`,
				prompt: tr("Retry {title} and tell me what went wrong", { title }),
				updatedAt: thread.updatedAt,
			};
		case "your-turn":
			return {
				id: `follow:${thread.id}`,
				prompt: tr("Follow up on {title}", { title }),
				updatedAt: thread.updatedAt,
			};
		case "waiting":
			return {
				id: `nudge:${thread.id}`,
				prompt: tr("Add more detail to {title}", { title }),
				updatedAt: thread.updatedAt,
			};
		case "working":
			return {
				id: `status:${thread.id}`,
				prompt: tr("Give me a short status on {title}", { title }),
				updatedAt: thread.updatedAt,
			};
		default:
			return null;
	}
}

/**
 * Prompt suggestions, derived deterministically from the persona's recent
 * thread titles and description. Nothing here is sent: the user edits and
 * submits a suggestion in the composer.
 */
export function personaIdeas(
	agent: InterfaceAgent | undefined,
	threads: InterfaceThread[],
	tl: LiteralMessage
): PersonaIdeaGroup[] {
	if (!agent) {
		return [];
	}
	const groups: PersonaIdeaGroup[] = [];
	const recent: PersonaIdea[] = [];
	for (const thread of [...threads].sort(byRecency)) {
		const idea = threadIdea(thread);
		if (idea) {
			recent.push(idea);
		}
		if (recent.length >= MAX_RECENT_IDEAS) {
			break;
		}
	}
	if (recent.length > 0) {
		groups.push({
			ideas: recent,
			key: "recent",
			label: "Pick up where you left off",
		});
	}
	const skills = descriptionTopics(agent.description).map(
		(topic, index): PersonaIdea => ({
			id: `skill:${index}`,
			prompt: SKILL_TEMPLATES[index]?.prompt(topic) ?? topic,
		})
	);
	if (skills.length === 0) {
		skills.push(...roleIdeas(agent.description));
	}
	if (skills.length > 0) {
		groups.push({
			ideas: skills,
			key: "skills",
			label: tl("Ask about {name}'s work", { name: agent.name }),
		});
	}
	groups.push({
		ideas: [
			{
				id: "routine:week",
				prompt: "Summarise this week",
			},
			{
				id: "routine:today",
				prompt: "What needs my attention today?",
			},
		],
		key: "routine",
		label: "Check-ins",
	});
	return groups;
}
