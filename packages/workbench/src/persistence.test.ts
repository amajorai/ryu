import { expect, test } from "bun:test";
import { createDefaultWorkbench, type WorkbenchState } from "./model.ts";
import {
	migrateWorkbenchSnapshot,
	parseWorkbenchSnapshot,
	sameWorkbenchSnapshot,
	serializeWorkbenchSnapshot,
	type WorkbenchIds,
} from "./persistence.ts";

const FIXED_IDS: WorkbenchIds = {
	bottomGroupId: "bottom-main",
	centerGroupId: "center-main",
	leftGroupId: "left-main",
	navigationId: "navigation",
	rightGroupId: "right-main",
	makeItemId: (sourceKey) => `item:${sourceKey}`,
};

function defaultWorkbench(): WorkbenchState {
	return createDefaultWorkbench(FIXED_IDS);
}

test("does not inspect split descendants beyond the persistence depth limit", () => {
	let reads = 0;
	const beyondLimit = {
		get type() {
			reads += 1;
			throw new Error("A descendant beyond the limit was inspected");
		},
	};
	interface DepthLimitBranch {
		children: (DepthLimitBranch | typeof beyondLimit)[];
		orientation: "columns";
		type: "branch";
	}
	let tree: DepthLimitBranch = {
		children: [beyondLimit],
		orientation: "columns",
		type: "branch",
	};
	for (let depth = 1; depth < 33; depth += 1) {
		tree = { children: [tree], orientation: "columns", type: "branch" };
	}
	const parsed = parseWorkbenchSnapshot(
		{ ...defaultWorkbench(), centerTree: tree },
		FIXED_IDS
	);
	expect(parsed?.centerTree).toEqual({ type: "leaf", groupId: "center-main" });
	expect(reads).toBe(0);
});

test("rejects malformed persisted rows and unknown discriminants", () => {
	const parsed = parseWorkbenchSnapshot(
		{
			version: 2,
			items: [
				{ id: "bad", source: { kind: "unknown" }, title: "Bad" },
				{
					closable: true,
					duplicable: false,
					id: "route",
					pinned: false,
					preferredRegion: "center",
					scope: { kind: "project", folder: "/tmp/project" },
					source: { kind: "route", path: "/project" },
					title: "Project",
				},
			],
			groups: [
				{
					activeItemId: "route",
					id: "center-main",
					itemIds: ["route"],
					locked: false,
					region: "center",
				},
				{ id: "bad-group", region: "unknown" },
			],
			centerTree: { type: "leaf", groupId: "center-main" },
			bottomAlignment: "center",
			focusedGroupId: "center-main",
			openRegions: { bottom: false, center: true, left: true, right: false },
			sizes: { bottom: 240, left: 280, right: 320 },
		},
		FIXED_IDS
	);

	expect(parsed?.items.map((item) => item.id)).toEqual(["route", "navigation"]);
	expect(parsed?.groups.some((group) => group.id === "bad-group")).toBe(false);
});

test("drops future fields and clamps persisted string and size values", () => {
	const long = "x".repeat(700);
	const parsed = parseWorkbenchSnapshot(
		{
			...defaultWorkbench(),
			futureTopLevel: { enabled: true },
			items: [
				{
					closable: true,
					duplicable: true,
					futureItemField: true,
					id: long,
					pinned: false,
					preferredRegion: "right",
					scope: { folder: long, kind: "project" },
					source: { kind: "shell", panel: long },
					title: long,
				},
			],
			groups: [
				{
					activeItemId: long,
					id: long,
					itemIds: [long],
					locked: false,
					region: "right",
				},
			],
			centerTree: { type: "leaf", groupId: "missing" },
			sizes: { bottom: -100, left: 9999, right: Number.NaN },
		},
		FIXED_IDS
	);

	const item = parsed?.items.find(
		(candidate) => candidate.source.kind === "shell"
	);
	expect(item?.id).toHaveLength(512);
	expect(item?.title).toHaveLength(256);
	expect(item?.source).toEqual({ kind: "shell", panel: "x".repeat(512) });
	expect(item?.scope).toEqual({ kind: "project", folder: "x".repeat(512) });
	expect(parsed?.sizes).toEqual({ bottom: 160, left: 520, right: 360 });
	expect(parsed).not.toHaveProperty("futureTopLevel");
});

test("repairs missing active ids after parsing", () => {
	const parsed = parseWorkbenchSnapshot(
		{
			...defaultWorkbench(),
			groups: [
				{
					activeItemId: "missing",
					id: "left-main",
					itemIds: ["navigation"],
					locked: false,
					region: "left",
				},
			],
		},
		FIXED_IDS
	);

	expect(
		parsed?.groups.find((group) => group.id === "left-main")?.activeItemId
	).toBe("navigation");
});

test("serializes a normalized snapshot without close history and round-trips it", () => {
	const state: WorkbenchState = {
		...defaultWorkbench(),
		closedItems: [
			{
				groupId: "center-main",
				index: 0,
				item: {
					closable: true,
					duplicable: false,
					id: "closed",
					pinned: false,
					preferredRegion: "center",
					scope: { kind: "window" },
					source: { kind: "route", path: "/closed" },
					title: "Closed",
				},
			},
		],
	};
	const serialized = serializeWorkbenchSnapshot(state);
	const parsed = parseWorkbenchSnapshot(serialized, FIXED_IDS);

	expect(serialized).not.toHaveProperty("closedItems");
	expect(parsed?.closedItems).toEqual([]);
	expect(sameWorkbenchSnapshot(state, parsed ?? defaultWorkbench())).toBe(true);
});

test("migrates route tabs, chat docks, project pins, and Navigation once", () => {
	const migrated = migrateWorkbenchSnapshot(
		{
			session: {
				activeIndex: 0,
				tabs: [{ path: "/library/space", title: "Library" }],
			},
			activeWorkspace: {
				bottom: {
					activeIndex: 0,
					tabs: [{ kind: "terminal", label: "Terminal", project: true }],
				},
				bottomOpen: true,
				right: {
					activeIndex: 0,
					tabs: [{ kind: "files", label: "Files", project: true }],
				},
				rightOpen: true,
			},
			pinnedByFolder: {
				"/tmp/project": [{ kind: "files", label: "Files", side: "right" }],
			},
			folder: "/tmp/project",
			sidebarOpen: true,
			sidebarWidth: 300,
		},
		FIXED_IDS
	);
	expect(
		migrated.items.filter((item) => item.source.kind === "navigation")
	).toHaveLength(1);
	expect(
		migrated.items.filter(
			(item) => item.source.kind === "shell" && item.source.panel === "files"
		)
	).toHaveLength(1);
	expect(migrated.openRegions).toMatchObject({
		bottom: true,
		left: true,
		right: true,
	});
	expect(migrateWorkbenchSnapshot({ snapshot: migrated }, FIXED_IDS)).toEqual(
		migrated
	);
});

test("deduplicates equivalent project tabs without merging different owners", () => {
	const migrated = migrateWorkbenchSnapshot(
		{
			activeWorkspace: {
				right: {
					activeIndex: 0,
					tabs: [{ kind: "files", label: "Files", project: true }],
				},
				rightOpen: true,
			},
			folder: "/tmp/a",
			pinnedByFolder: {
				"/tmp/a": [{ kind: "files", label: "Files", side: "right" }],
				"/tmp/b": [{ kind: "files", label: "Files", side: "right" }],
			},
		},
		FIXED_IDS
	);
	const files = migrated.items.filter(
		(item) => item.source.kind === "shell" && item.source.panel === "files"
	);

	expect(files).toHaveLength(2);
	expect(files.map((item) => item.scope)).toEqual([
		{ kind: "project", folder: "/tmp/a" },
		{ kind: "project", folder: "/tmp/b" },
	]);
	expect(migrateWorkbenchSnapshot({ snapshot: migrated }, FIXED_IDS)).toEqual(
		migrated
	);
});

test("migrates non-project dock tabs into the active conversation scope", () => {
	const conversationOwned = migrateWorkbenchSnapshot(
		{
			session: {
				activeIndex: 1,
				tabs: [
					{ path: "/library", title: "Library" },
					{ conversationId: "c-1", path: "/chat", title: "Chat" },
				],
			},
			activeWorkspace: {
				right: {
					activeIndex: 0,
					tabs: [{ kind: "files", label: "Files" }],
				},
			},
		},
		FIXED_IDS
	);
	const fallback = migrateWorkbenchSnapshot(
		{
			session: {
				activeIndex: 0,
				tabs: [{ path: "/library", title: "Library" }],
			},
			activeWorkspace: {
				right: {
					activeIndex: 0,
					tabs: [{ kind: "files", label: "Files" }],
				},
			},
		},
		FIXED_IDS
	);

	expect(
		conversationOwned.items.find(
			(item) => item.source.kind === "shell" && item.source.panel === "files"
		)?.scope
	).toEqual({ kind: "conversation", conversationId: "c-1" });
	expect(
		conversationOwned.items.find(
			(item) => item.source.kind === "route" && item.source.path === "/chat"
		)?.scope
	).toEqual({ kind: "conversation", conversationId: "c-1" });
	expect(
		fallback.items.find(
			(item) => item.source.kind === "shell" && item.source.panel === "files"
		)?.scope
	).toEqual({ kind: "window" });
});

test("keeps delimiter-containing project source and owner pairs distinct", () => {
	const migrated = migrateWorkbenchSnapshot(
		{
			pinnedByFolder: {
				"/tmp/a|project:b": [{ kind: "files", label: "First", side: "right" }],
				b: [
					{
						kind: "files|project:/tmp/a",
						label: "Second",
						side: "right",
					},
				],
			},
		},
		FIXED_IDS
	);
	const shells = migrated.items.filter((item) => item.source.kind === "shell");

	expect(shells).toHaveLength(2);
	expect(shells.map((item) => [item.source, item.scope])).toEqual([
		[
			{ kind: "shell", panel: "files" },
			{ kind: "project", folder: "/tmp/a|project:b" },
		],
		[
			{ kind: "shell", panel: "files|project:/tmp/a" },
			{ kind: "project", folder: "b" },
		],
	]);
});

test("resolves conversation ownership from original legacy session indexes", () => {
	const malformedBeforeActive = migrateWorkbenchSnapshot(
		{
			session: {
				activeIndex: 1,
				tabs: [
					{ path: "/malformed" },
					{ conversationId: "c-2", path: "/chat", title: "Chat" },
				],
			},
			activeWorkspace: {
				right: {
					activeIndex: 0,
					tabs: [{ kind: "files", label: "Files" }],
				},
			},
		},
		FIXED_IDS
	);
	const malformedActive = migrateWorkbenchSnapshot(
		{
			session: {
				activeIndex: 0,
				tabs: [
					{ path: "/malformed" },
					{ conversationId: "c-3", path: "/chat", title: "Chat" },
				],
			},
			activeWorkspace: {
				right: {
					activeIndex: 0,
					tabs: [{ kind: "files", label: "Files" }],
				},
			},
		},
		FIXED_IDS
	);
	const outOfRangeActive = migrateWorkbenchSnapshot(
		{
			session: {
				activeIndex: 2,
				tabs: [{ conversationId: "c-4", path: "/chat", title: "Chat" }],
			},
			activeWorkspace: {
				right: {
					activeIndex: 0,
					tabs: [{ kind: "files", label: "Files" }],
				},
			},
		},
		FIXED_IDS
	);

	expect(
		malformedBeforeActive.items.find(
			(item) => item.source.kind === "shell" && item.source.panel === "files"
		)?.scope
	).toEqual({ kind: "conversation", conversationId: "c-2" });
	expect(
		malformedActive.items.find(
			(item) => item.source.kind === "shell" && item.source.panel === "files"
		)?.scope
	).toEqual({ kind: "window" });
	expect(
		outOfRangeActive.items.find(
			(item) => item.source.kind === "shell" && item.source.panel === "files"
		)?.scope
	).toEqual({ kind: "window" });
});
