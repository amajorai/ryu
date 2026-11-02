import type { LiteralMessage } from "@ryu/i18n/react";
import { sentenceLabel } from "@ryu/i18n/sentence-label";
import type { HookInventoryItem, HookSource } from "@/src/lib/api/hooks.ts";

export interface HookPhaseCopy {
	description: string;
	title: string;
}

export interface HookPhaseGroup extends HookPhaseCopy {
	hooks: HookInventoryItem[];
	phase: string;
}

export interface HookOwnerGroup {
	hookCount: number;
	ownerId: string;
	ownerName: string;
	phases: HookPhaseGroup[];
	reviewCount: number;
}

export interface HookSourceGroup {
	label: string;
	owners: HookOwnerGroup[];
	source: HookSource;
}

const KNOWN_PHASE_COPY = new Map<string, HookPhaseCopy>([
	[
		"session_start",
		{ description: "When a new session starts", title: "Session start" },
	],
	[
		"user_prompt_submit",
		{
			description: "When the user submits a prompt",
			title: "User prompt submit",
		},
	],
	[
		"pre_user_turn",
		{ description: "Before the user's turn runs", title: "Pre user turn" },
	],
	[
		"pre_tool_use",
		{ description: "Before a tool executes", title: "Pre tool use" },
	],
	[
		"post_tool_use",
		{ description: "After a tool finishes", title: "Post tool use" },
	],
	[
		"post_assistant_turn",
		{
			description: "After the assistant completes a turn",
			title: "Post assistant turn",
		},
	],
	["stop", { description: "Right before the turn ends", title: "Stop" }],
	["context", { description: "When context is assembled", title: "Context" }],
	[
		"tool_result",
		{ description: "When a tool result is received", title: "Tool result" },
	],
]);

const humanizePhase = (phase: string): string => {
	const words = phase.replaceAll("-", "_").split("_").filter(Boolean);
	const phrase = words.join(" ");
	return phrase ? phrase[0]?.toUpperCase() + phrase.slice(1) : "Hook";
};

export const hookPhaseCopy = (
	tl: LiteralMessage,
	phase: string
): HookPhaseCopy => {
	const known = KNOWN_PHASE_COPY.get(phase);
	if (known) {
		return known;
	}
	const title = humanizePhase(phase);
	return {
		description: tl("When {phaseName} runs", {
			phaseName: sentenceLabel(tl, title),
		}),
		title,
	};
};

const sourceLabel = (source: HookSource): string =>
	source === "config" ? "From config" : "From plugins";

const groupOwnerHooks = (
	tl: LiteralMessage,
	ownerId: string,
	ownerHooks: HookInventoryItem[]
): HookOwnerGroup => {
	const phases = new Map<string, HookInventoryItem[]>();
	for (const hook of ownerHooks) {
		const hooks = phases.get(hook.phase) ?? [];
		hooks.push(hook);
		phases.set(hook.phase, hooks);
	}
	return {
		hookCount: ownerHooks.length,
		ownerId,
		ownerName: ownerHooks[0]?.ownerName ?? ownerId,
		phases: [...phases.entries()].map(([phase, hooks]) => ({
			...hookPhaseCopy(tl, phase),
			hooks,
			phase,
		})),
		reviewCount: ownerHooks.filter((hook) => hook.reviewRequired).length,
	};
};

export const groupHookInventory = (
	tl: LiteralMessage,
	hooks: readonly HookInventoryItem[]
): HookSourceGroup[] => {
	const sourceOwners = new Map<HookSource, Map<string, HookInventoryItem[]>>();
	for (const hook of hooks) {
		const owners = sourceOwners.get(hook.source) ?? new Map();
		const ownerHooks = owners.get(hook.ownerId) ?? [];
		ownerHooks.push(hook);
		owners.set(hook.ownerId, ownerHooks);
		sourceOwners.set(hook.source, owners);
	}
	const sourceOrder: HookSource[] = ["config", "plugin"];
	return sourceOrder.flatMap((source) => {
		const owners = sourceOwners.get(source);
		if (!owners) {
			return [];
		}
		return [
			{
				label: sourceLabel(source),
				owners: [...owners.entries()]
					.map(([ownerId, ownerHooks]) =>
						groupOwnerHooks(tl, ownerId, ownerHooks)
					)
					.sort((left, right) => left.ownerName.localeCompare(right.ownerName)),
				source,
			},
		];
	});
};
