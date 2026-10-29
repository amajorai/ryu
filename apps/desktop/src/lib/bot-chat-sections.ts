import type { AppRequestValue } from "@ryuhq/core-client/app-request-json.ts";
import { z } from "zod";
import { isProjectMainThread } from "@/src/lib/thread-hierarchy.ts";
import type { Conversation } from "@/types/chat.ts";
import {
	sectionLabelSchema,
	sectionStorageMapSchema,
} from "./bot-section-storage.ts";

/**
 * The built-in **Chats** section: bot threads, group chats, and every chat from
 * before the hierarchy. The id keeps its historical value so assignments and
 * section order stored by older builds stay valid.
 */
export const UNORGANIZED_SECTION_ID = "unorganized";

/** The built-in **Projects** section: every project's coordinator main thread. */
export const PROJECTS_SECTION_ID = "projects";

/** Built-in sections: always present, reorderable, never deleted or renamed. */
export const BUILTIN_SECTION_IDS: readonly string[] = [
	PROJECTS_SECTION_ID,
	UNORGANIZED_SECTION_ID,
];

/** Display label of a built-in section. */
export function builtinSectionLabel(sectionId: string): string | null {
	if (sectionId === PROJECTS_SECTION_ID) {
		return "Projects";
	}
	if (sectionId === UNORGANIZED_SECTION_ID) {
		return "Chats";
	}
	return null;
}

function isBuiltinSection(id: string): boolean {
	return BUILTIN_SECTION_IDS.includes(id);
}

/** The section a row lands in when the user has not placed it anywhere. */
export function defaultSectionFor(conversation: Conversation): string {
	return isProjectMainThread(conversation)
		? PROJECTS_SECTION_ID
		: UNORGANIZED_SECTION_ID;
}

export interface BotChatSection {
	id: string;
	name: string;
	/**
	 * The custom section this one is nested inside (Zen-style folders in
	 * folders). Absent for a top-level section. Built-in sections never nest
	 * and never hold children.
	 */
	parentId?: string;
}

export interface BotChatSectionState {
	assignments: Record<string, string>;
	sections: BotChatSection[];
}

function trimmedString(value: AppRequestValue): string | null {
	const parsed = sectionLabelSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

export function normalizeBotChatSections(
	value: Parameters<typeof sectionStorageMapSchema.parse>[0]
): BotChatSectionState {
	const parsed = sectionStorageMapSchema.safeParse(value);
	if (!parsed.success) {
		return { assignments: {}, sections: [] };
	}

	const raw = parsed.data;
	const sections: BotChatSection[] = [];
	const sectionIds = new Set<string>();
	const storedParents = new Map<string, string>();
	if (Array.isArray(raw.sections)) {
		for (const candidate of raw.sections) {
			const section = sectionStorageMapSchema.safeParse(candidate);
			if (!section.success) {
				continue;
			}
			const id = trimmedString(section.data.id);
			const name = trimmedString(section.data.name);
			if (!(id && name) || isBuiltinSection(id) || sectionIds.has(id)) {
				continue;
			}
			sectionIds.add(id);
			sections.push({ id, name });
			const parentId = trimmedString(section.data.parentId ?? null);
			if (parentId) {
				storedParents.set(id, parentId);
			}
		}
	}
	// A parent must name another custom section, and the chain must not loop
	// back (a hand-edited or racing sync could store a cycle); otherwise the
	// section falls back to top level.
	for (const section of sections) {
		const parentId = storedParents.get(section.id);
		if (
			parentId &&
			sectionIds.has(parentId) &&
			!parentChainReaches(storedParents, parentId, section.id)
		) {
			section.parentId = parentId;
		}
	}

	const assignments: Record<string, string> = {};
	const storedAssignments = sectionStorageMapSchema.safeParse(raw.assignments);
	if (storedAssignments.success) {
		for (const [conversationId, sectionIdValue] of Object.entries(
			storedAssignments.data
		)) {
			const sectionId = trimmedString(sectionIdValue);
			if (
				conversationId.trim() &&
				sectionId &&
				(sectionIds.has(sectionId) || isBuiltinSection(sectionId))
			) {
				assignments[conversationId] = sectionId;
			}
		}
	}

	return { assignments, sections };
}

function parentChainReaches(
	parents: ReadonlyMap<string, string>,
	startId: string,
	targetId: string
): boolean {
	const seen = new Set<string>();
	let current: string | undefined = startId;
	while (current && !seen.has(current)) {
		if (current === targetId) {
			return true;
		}
		seen.add(current);
		current = parents.get(current);
	}
	return false;
}

function parentMap(sections: readonly BotChatSection[]): Map<string, string> {
	const parents = new Map<string, string>();
	for (const section of sections) {
		if (section.parentId) {
			parents.set(section.id, section.parentId);
		}
	}
	return parents;
}

/** The parent of a section, or `null` for a top-level (or built-in) one. */
export function parentSectionOf(
	state: BotChatSectionState,
	sectionId: string
): string | null {
	return (
		state.sections.find((section) => section.id === sectionId)?.parentId ?? null
	);
}

/** Direct children of `parentId` (`null` = top level), in stored order. */
export function childSectionsOf(
	state: BotChatSectionState,
	parentId: string | null
): BotChatSection[] {
	return state.sections.filter(
		(section) => (section.parentId ?? null) === parentId
	);
}

/** Whether `sectionId` may move under `parentId` (`null` = top level). */
export function canNestBotChatSection(
	state: BotChatSectionState,
	sectionId: string,
	parentId: string | null
): boolean {
	if (
		isBuiltinSection(sectionId) ||
		!state.sections.some((section) => section.id === sectionId)
	) {
		return false;
	}
	if (parentId === null) {
		return true;
	}
	if (
		isBuiltinSection(parentId) ||
		!state.sections.some((section) => section.id === parentId)
	) {
		return false;
	}
	// Nesting a section inside itself or one of its descendants would loop.
	return !parentChainReaches(parentMap(state.sections), parentId, sectionId);
}

/**
 * Move a custom section under another custom section, or back to top level
 * with `parentId: null`. Its rows and child sections move with it.
 */
export function nestBotChatSection(
	state: BotChatSectionState,
	sectionId: string,
	parentId: string | null
): BotChatSectionState {
	if (
		!canNestBotChatSection(state, sectionId, parentId) ||
		parentSectionOf(state, sectionId) === parentId
	) {
		return state;
	}
	return {
		...state,
		sections: state.sections.map((section) => {
			if (section.id !== sectionId) {
				return section;
			}
			if (parentId === null) {
				return { id: section.id, name: section.name };
			}
			return { ...section, parentId };
		}),
	};
}

export function createBotChatSection(
	state: BotChatSectionState,
	section: BotChatSection
): BotChatSectionState {
	const id = trimmedString(section.id);
	const name = trimmedString(section.name);
	if (
		!(id && name) ||
		isBuiltinSection(id) ||
		state.sections.some((item) => item.id === id)
	) {
		return state;
	}
	return { ...state, sections: [...state.sections, { id, name }] };
}

export function renameBotChatSection(
	state: BotChatSectionState,
	id: string,
	name: string
): BotChatSectionState {
	const trimmedName = name.trim();
	if (!trimmedName || isBuiltinSection(id)) {
		return state;
	}
	if (!state.sections.some((section) => section.id === id)) {
		return state;
	}
	return {
		...state,
		sections: state.sections.map((section) =>
			section.id === id ? { ...section, name: trimmedName } : section
		),
	};
}

export function removeBotChatSection(
	state: BotChatSectionState,
	id: string
): BotChatSectionState {
	if (isBuiltinSection(id)) {
		return state;
	}
	const removed = state.sections.find((section) => section.id === id);
	if (!removed) {
		return state;
	}
	// Child sections are kept and lifted to the removed section's parent, the
	// same way its rows fall back to their default section.
	const sections = state.sections.flatMap((section) => {
		if (section.id === id) {
			return [];
		}
		if (section.parentId !== id) {
			return [section];
		}
		return [
			removed.parentId
				? { ...section, parentId: removed.parentId }
				: { id: section.id, name: section.name },
		];
	});
	const assignments = Object.fromEntries(
		Object.entries(state.assignments).filter(
			([, sectionId]) => sectionId !== id
		)
	);
	return { assignments, sections };
}

export function assignConversationToBotChatSection(
	state: BotChatSectionState,
	conversationId: string,
	sectionId: string
): BotChatSectionState {
	if (!conversationId.trim()) {
		return state;
	}
	const known =
		isBuiltinSection(sectionId) ||
		state.sections.some((section) => section.id === sectionId);
	if (state.assignments[conversationId] === sectionId) {
		return state;
	}
	const assignments = { ...state.assignments };
	if (known) {
		assignments[conversationId] = sectionId;
	} else if (conversationId in assignments) {
		delete assignments[conversationId];
	} else {
		return state;
	}
	return { ...state, assignments };
}

/**
 * The section a row is drawn in: the user's placement when it still names a
 * section, else the row's default (Projects for a project main thread, Chats
 * for everything else). Accepts a bare id for callers without the row.
 */
const conversationIdSchema = z.string();
function isConversationId(value: Conversation | string): value is string {
	return conversationIdSchema.safeParse(value).success;
}

export function sectionForConversation(
	state: BotChatSectionState,
	conversation: Conversation | string
): string {
	const id = isConversationId(conversation) ? conversation : conversation.id;
	const sectionId = state.assignments[id];
	if (
		sectionId &&
		(isBuiltinSection(sectionId) ||
			state.sections.some((section) => section.id === sectionId))
	) {
		return sectionId;
	}
	return isConversationId(conversation)
		? UNORGANIZED_SECTION_ID
		: defaultSectionFor(conversation);
}

export function sortConversationsByActivity(
	conversations: readonly Conversation[]
): Conversation[] {
	return [...conversations].sort((a, b) => {
		const activityDelta =
			(b.lastMessageAt ?? b.updatedAt) - (a.lastMessageAt ?? a.updatedAt);
		if (activityDelta !== 0) {
			return activityDelta;
		}
		const updatedDelta = b.updatedAt - a.updatedAt;
		if (updatedDelta !== 0) {
			return updatedDelta;
		}
		return a.title.localeCompare(b.title);
	});
}

export function conversationsForSection(
	conversations: readonly Conversation[],
	state: BotChatSectionState,
	sectionId: string
): Conversation[] {
	return sortConversationsByActivity(
		conversations.filter(
			(conversation) =>
				sectionForConversation(state, conversation) === sectionId
		)
	);
}
