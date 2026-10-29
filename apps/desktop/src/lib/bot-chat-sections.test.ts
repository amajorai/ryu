import { describe, expect, test } from "bun:test";
import type { Conversation } from "@/types/chat.ts";
import {
	assignConversationToBotChatSection,
	builtinSectionLabel,
	canNestBotChatSection,
	childSectionsOf,
	conversationsForSection,
	createBotChatSection,
	nestBotChatSection,
	normalizeBotChatSections,
	PROJECTS_SECTION_ID,
	parentSectionOf,
	removeBotChatSection,
	renameBotChatSection,
	sectionForConversation,
	sortConversationsByActivity,
	UNORGANIZED_SECTION_ID,
} from "./bot-chat-sections.ts";

const conversation = (
	id: string,
	updatedAt: number,
	lastMessageAt?: number
): Conversation => ({
	createdAt: updatedAt,
	id,
	lastMessageAt,
	messages: [],
	title: id,
	updatedAt,
});

test("normalization fails soft to Unorganized", () => {
	const state = normalizeBotChatSections({
		assignments: { stale: "missing", loose: "section-a" },
		sections: [
			{ id: "section-a", name: "  Follow up  " },
			{ id: UNORGANIZED_SECTION_ID, name: "Renamed" },
			{ id: "section-a", name: "Duplicate" },
		],
	});

	expect(state.sections).toEqual([{ id: "section-a", name: "Follow up" }]);
	expect(sectionForConversation(state, "stale")).toBe(UNORGANIZED_SECTION_ID);
	expect(sectionForConversation(state, "loose")).toBe("section-a");
});

test("sorts every section by latest message activity", () => {
	const sorted = sortConversationsByActivity([
		conversation("fallback", 40),
		conversation("latest-message", 20, 90),
		conversation("older-message", 80, 60),
	]);

	expect(sorted.map((item) => item.id)).toEqual([
		"latest-message",
		"older-message",
		"fallback",
	]);
});

test("filters conversations into a custom section and keeps unknown ids loose", () => {
	const state = normalizeBotChatSections({
		assignments: { one: "section-a", stale: "gone" },
		sections: [{ id: "section-a", name: "Follow up" }],
	});
	const conversations = [conversation("one", 1), conversation("two", 2)];

	expect(
		conversationsForSection(conversations, state, "section-a").map(
			(item) => item.id
		)
	).toEqual(["one"]);
	expect(
		conversationsForSection(conversations, state, UNORGANIZED_SECTION_ID).map(
			(item) => item.id
		)
	).toEqual(["two"]);
});

test("section transitions keep local assignments coherent", () => {
	const created = createBotChatSection(normalizeBotChatSections(null), {
		id: "section-a",
		name: "Follow up",
	});
	const renamed = renameBotChatSection(
		created,
		"section-a",
		" Client follow-up "
	);
	const assigned = assignConversationToBotChatSection(
		renamed,
		"one",
		"section-a"
	);

	expect(renamed.sections).toEqual([
		{ id: "section-a", name: "Client follow-up" },
	]);
	expect(assigned.assignments).toEqual({ one: "section-a" });

	const removed = removeBotChatSection(assigned, "section-a");
	expect(removed.sections).toEqual([]);
	expect(removed.assignments).toEqual({});
	expect(sectionForConversation(removed, "one")).toBe(UNORGANIZED_SECTION_ID);
});

describe("hierarchy sections", () => {
	const base = {
		createdAt: 1,
		messages: [],
		title: "t",
		updatedAt: 1,
	};
	const project = {
		...base,
		hierarchy: { ownerKind: "project" as const, role: "main" as const },
		id: "project-main",
	};
	const chat = { ...base, id: "chat" };

	test("project main threads default to Projects and chats to Chats", () => {
		const state = normalizeBotChatSections(null);
		expect(sectionForConversation(state, project)).toBe(PROJECTS_SECTION_ID);
		expect(sectionForConversation(state, chat)).toBe(UNORGANIZED_SECTION_ID);
		expect(builtinSectionLabel(UNORGANIZED_SECTION_ID)).toBe("Chats");
		expect(builtinSectionLabel(PROJECTS_SECTION_ID)).toBe("Projects");
	});

	test("any row can be placed in a custom or built-in section", () => {
		let state = createBotChatSection(normalizeBotChatSections(null), {
			id: "launch",
			name: "Launch",
		});
		state = assignConversationToBotChatSection(state, "project-main", "launch");
		state = assignConversationToBotChatSection(
			state,
			"chat",
			PROJECTS_SECTION_ID
		);
		expect(sectionForConversation(state, project)).toBe("launch");
		expect(sectionForConversation(state, chat)).toBe(PROJECTS_SECTION_ID);
		// Deleting the custom section returns its rows to their defaults.
		state = removeBotChatSection(state, "launch");
		expect(sectionForConversation(state, project)).toBe(PROJECTS_SECTION_ID);
	});

	test("built-in sections cannot be created, renamed, or deleted", () => {
		const state = normalizeBotChatSections(null);
		expect(
			createBotChatSection(state, { id: PROJECTS_SECTION_ID, name: "x" })
		).toBe(state);
		expect(renameBotChatSection(state, PROJECTS_SECTION_ID, "x")).toBe(state);
		expect(removeBotChatSection(state, PROJECTS_SECTION_ID)).toBe(state);
	});
});

test("storage normalization keeps valid sections beside malformed future rows", () => {
	const raw = JSON.parse(
		'{"sections":[{"id":" follow-up ","name":"  Follow up  ","metadata":{"__proto__":{"future":true}}},{"id":false,"name":"ignored"},null,5],"assignments":{" chat ":" follow-up ","bad":false,"gone":"missing"},"future":[1,null]}'
	);
	expect(normalizeBotChatSections(raw)).toEqual({
		sections: [{ id: "follow-up", name: "Follow up" }],
		assignments: { " chat ": "follow-up" },
	});
});

test("legacy assignment arrays retain numeric conversation ids", () => {
	expect(
		normalizeBotChatSections({
			sections: [{ id: "follow-up", name: "Follow up" }],
			assignments: ["follow-up", false],
		})
	).toEqual({
		sections: [{ id: "follow-up", name: "Follow up" }],
		assignments: { 0: "follow-up" },
	});
	expect(normalizeBotChatSections([])).toEqual({
		sections: [],
		assignments: {},
	});
});

describe("nested sections", () => {
	const three = () =>
		normalizeBotChatSections({
			sections: [
				{ id: "work", name: "Work" },
				{ id: "clients", name: "Clients" },
				{ id: "acme", name: "Acme" },
			],
		});

	test("a custom section nests inside another and back to top level", () => {
		let state = nestBotChatSection(three(), "clients", "work");
		state = nestBotChatSection(state, "acme", "clients");
		expect(parentSectionOf(state, "clients")).toBe("work");
		expect(parentSectionOf(state, "acme")).toBe("clients");
		expect(childSectionsOf(state, null).map((s) => s.id)).toEqual(["work"]);
		expect(childSectionsOf(state, "work").map((s) => s.id)).toEqual([
			"clients",
		]);

		state = nestBotChatSection(state, "acme", null);
		expect(parentSectionOf(state, "acme")).toBeNull();
		expect(state.sections.find((s) => s.id === "acme")).toEqual({
			id: "acme",
			name: "Acme",
		});
	});

	test("refuses cycles and built-in sections", () => {
		const state = nestBotChatSection(
			nestBotChatSection(three(), "clients", "work"),
			"acme",
			"clients"
		);
		expect(canNestBotChatSection(state, "work", "acme")).toBe(false);
		expect(canNestBotChatSection(state, "work", "work")).toBe(false);
		expect(nestBotChatSection(state, "work", "acme")).toBe(state);
		expect(canNestBotChatSection(state, PROJECTS_SECTION_ID, "work")).toBe(
			false
		);
		expect(canNestBotChatSection(state, "acme", UNORGANIZED_SECTION_ID)).toBe(
			false
		);
		expect(canNestBotChatSection(state, "acme", "missing")).toBe(false);
		expect(canNestBotChatSection(state, "acme", "work")).toBe(true);
	});

	test("deleting a parent lifts its children one level and keeps their rows", () => {
		let state = nestBotChatSection(three(), "clients", "work");
		state = nestBotChatSection(state, "acme", "clients");
		state = assignConversationToBotChatSection(state, "chat", "acme");
		state = removeBotChatSection(state, "clients");
		expect(parentSectionOf(state, "acme")).toBe("work");
		expect(sectionForConversation(state, "chat")).toBe("acme");
		state = removeBotChatSection(state, "work");
		expect(parentSectionOf(state, "acme")).toBeNull();
	});

	test("normalization drops unknown, built-in, and cyclic parents", () => {
		const state = normalizeBotChatSections({
			sections: [
				{ id: "a", name: "A", parentId: "b" },
				{ id: "b", name: "B", parentId: "a" },
				{ id: "c", name: "C", parentId: "missing" },
				{ id: "d", name: "D", parentId: PROJECTS_SECTION_ID },
				{ id: "e", name: "E", parentId: " c " },
			],
		});
		expect(state.sections).toEqual([
			{ id: "a", name: "A" },
			{ id: "b", name: "B" },
			{ id: "c", name: "C" },
			{ id: "d", name: "D" },
			{ id: "e", name: "E", parentId: "c" },
		]);
	});
});
