import { describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RyuJsonValue } from "@ryu/app-host/json-values";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
mock.module("@/src/contexts/entitlement-context.tsx", () => ({
	useEntitlementContext: () => ({
		requestUpgrade: () => undefined,
		verdict: null,
	}),
}));
mock.module("@/src/lib/window-routing.ts", () => ({
	listenForEntityActivation: async () => () => undefined,
	registerWindowTabs: async () => undefined,
	tabEntityKey: () => null,
}));

const { reuseUnchangedTabs } = await import("./TabsContext.tsx");
type Tab = import("./TabsContext.tsx").Tab;

// `Required<Tab>` makes this fixture list every field the Tab type carries, so
// a new field fails type checking here until it gets a changed value below and
// therefore a reuse-versus-change case.
const FULL_TAB: Required<Tab> = {
	busy: false,
	busySpeed: "normal",
	conversationId: "conversation-1",
	groupId: "group-1",
	icon: { kind: "icon", id: "chat", color: "blue" },
	id: "tab-1",
	initialAgent: "agent-1",
	initialGhost: false,
	initialImages: [
		{ filename: "a.png", id: "image-1", url: "data:image/png;base64,AAAA" },
	],
	initialModel: "model-1",
	initialPluginFlags: { search: true },
	initialProactiveOpening: false,
	initialProject: "project-1",
	initialPrompt: "Draft",
	initialQuote: "Quote",
	initialStoreItem: { id: "item-1", kind: "plugin" },
	initialStoreQuery: "search",
	initialSubmit: false,
	initialTeamId: "team-1",
	mountContext: { nested: { depth: 1 } },
	navToken: 1,
	path: "/chat",
	pinned: false,
	restoredNode: "node-1",
	scrollToMessageId: "message-1",
	splitId: "workbench:center",
	title: "Chat",
	unloaded: false,
	workspaceSession: {
		bottom: { activeIndex: 0, tabs: [{ kind: "terminal", label: "Shell" }] },
		bottomOpen: true,
		right: { activeIndex: 0, tabs: [] },
		rightOpen: false,
	},
	worktreeMode: false,
};

const CHANGED: Required<Tab> = {
	busy: true,
	busySpeed: "fast",
	conversationId: "conversation-2",
	groupId: "group-2",
	icon: { kind: "icon", id: "chat", color: "red" },
	id: "tab-2",
	initialAgent: "agent-2",
	initialGhost: true,
	initialImages: [
		{ filename: "a.png", id: "image-1", url: "data:image/png;base64,BBBB" },
	],
	initialModel: "model-2",
	initialPluginFlags: { search: false },
	initialProactiveOpening: true,
	initialProject: "project-2",
	initialPrompt: "Draft 2",
	initialQuote: "Quote 2",
	initialStoreItem: { id: "item-2", kind: "plugin" },
	initialStoreQuery: "search 2",
	initialSubmit: true,
	initialTeamId: "team-2",
	mountContext: { nested: { depth: 2 } },
	navToken: 2,
	path: "/chat/2",
	pinned: true,
	restoredNode: "node-2",
	scrollToMessageId: "message-2",
	splitId: "other-split",
	title: "Chat 2",
	unloaded: true,
	workspaceSession: {
		bottom: { activeIndex: 0, tabs: [{ kind: "terminal", label: "Logs" }] },
		bottomOpen: true,
		right: { activeIndex: 0, tabs: [] },
		rightOpen: false,
	},
	worktreeMode: true,
};

/** A JSON-shaped value that is not a plain record (it has its own prototype),
    which a tab's `mountContext` may carry and the projection compares by identity. */
class OpaqueHandle {
	[key: string]: RyuJsonValue;
	id: string;

	constructor(id: string) {
		this.id = id;
	}
}

const SIBLING: Tab = { id: "tab-sibling", path: "/library", title: "Library" };

function freshCopy<T>(value: T): T {
	return structuredClone(value);
}

describe("reuseUnchangedTabs", () => {
	test("keeps the previous array and tab objects when every field is equal by value", () => {
		const previous: Tab[] = [freshCopy(FULL_TAB), freshCopy(SIBLING)];
		const next = previous.map(freshCopy);
		expect(next[0]).not.toBe(previous[0]);

		const shared = reuseUnchangedTabs(previous, next);

		expect(shared).toBe(previous);
		expect(shared[0]).toBe(previous[0]);
		expect(shared[1]).toBe(previous[1]);
	});

	test("treats an absent field and an undefined field as the same projection", () => {
		const previous: Tab[] = [{ id: "a", path: "/a", title: "A" }];
		const next: Tab[] = [
			{ id: "a", path: "/a", title: "A", splitId: undefined, busy: undefined },
		];

		expect(reuseUnchangedTabs(previous, next)).toBe(previous);
	});

	for (const field of Object.keys(FULL_TAB) as (keyof Tab)[]) {
		test(`a changed ${field} produces a new tab object and leaves its sibling shared`, () => {
			const previous: Tab[] = [freshCopy(FULL_TAB), freshCopy(SIBLING)];
			const changed: Tab = { ...freshCopy(FULL_TAB), [field]: CHANGED[field] };
			const next: Tab[] = [changed, freshCopy(SIBLING)];

			const shared = reuseUnchangedTabs(previous, next);

			expect(shared).not.toBe(previous);
			expect(shared[0]).toBe(changed);
			expect(shared[0]?.[field]).toEqual(CHANGED[field]);
			expect(shared[1]).toBe(previous[1]);
		});
	}

	test("a field that appears or disappears produces a new tab object", () => {
		const previous: Tab[] = [{ id: "a", path: "/a", title: "A" }];
		const added = reuseUnchangedTabs(previous, [
			{ id: "a", path: "/a", title: "A", pinned: true },
		]);
		expect(added[0]).not.toBe(previous[0]);
		expect(added[0]?.pinned).toBe(true);

		const removed = reuseUnchangedTabs(
			[{ id: "b", path: "/b", title: "B", busy: true }],
			[{ id: "b", path: "/b", title: "B" }]
		);
		expect(removed[0]?.busy).toBeUndefined();
	});

	test("nested arrays and records compare by length and keys, not only values", () => {
		const previous: Tab[] = [freshCopy(FULL_TAB)];
		const longer = reuseUnchangedTabs(previous, [
			{
				...freshCopy(FULL_TAB),
				initialImages: [
					...(FULL_TAB.initialImages ?? []),
					{ filename: "b.png", id: "image-2", url: "data:," },
				],
			},
		]);
		expect(longer[0]).not.toBe(previous[0]);
		expect(longer[0]?.initialImages).toHaveLength(2);

		const extraKey = reuseUnchangedTabs(previous, [
			{
				...freshCopy(FULL_TAB),
				initialPluginFlags: { search: true, voice: false },
			},
		]);
		expect(extraKey[0]).not.toBe(previous[0]);
		expect(extraKey[0]?.initialPluginFlags).toEqual({
			search: true,
			voice: false,
		});
	});

	test("reordering reuses the tab objects but returns the new order", () => {
		const first: Tab = { id: "a", path: "/a", title: "A" };
		const second: Tab = { id: "b", path: "/b", title: "B" };
		const shared = reuseUnchangedTabs(
			[first, second],
			[freshCopy(second), freshCopy(first)]
		);

		expect(shared.map((tab) => tab.id)).toEqual(["b", "a"]);
		expect(shared[0]).toBe(second);
		expect(shared[1]).toBe(first);
	});

	test("opening and closing tabs returns a new array and keeps survivors shared", () => {
		const first: Tab = { id: "a", path: "/a", title: "A" };
		const second: Tab = { id: "b", path: "/b", title: "B" };
		const opened: Tab = { id: "c", path: "/c", title: "C" };

		const afterOpen = reuseUnchangedTabs(
			[first, second],
			[freshCopy(first), freshCopy(second), opened]
		);
		expect(afterOpen).toHaveLength(3);
		expect(afterOpen[0]).toBe(first);
		expect(afterOpen[1]).toBe(second);
		expect(afterOpen[2]).toBe(opened);

		const afterClose = reuseUnchangedTabs(afterOpen, [freshCopy(second)]);
		expect(afterClose).toEqual([second]);
		expect(afterClose[0]).toBe(second);
	});

	test("a non-plain value is compared by identity", () => {
		const handle = new OpaqueHandle("image");
		const previous: Tab[] = [
			{ id: "a", path: "/a", title: "A", mountContext: { handle } },
		];
		expect(
			reuseUnchangedTabs(previous, [
				{ id: "a", path: "/a", title: "A", mountContext: { handle } },
			])
		).toBe(previous);
		const replaced = reuseUnchangedTabs(previous, [
			{
				id: "a",
				path: "/a",
				title: "A",
				mountContext: { handle: new OpaqueHandle("image") },
			},
		]);
		expect(replaced[0]).not.toBe(previous[0]);
	});
});
