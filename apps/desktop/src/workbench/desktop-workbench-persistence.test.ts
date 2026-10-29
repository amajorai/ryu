import { describe, expect, test } from "bun:test";
import { createDefaultWorkbench } from "@ryu/workbench/model";
import {
	serializeWorkbenchSnapshot,
	type WorkbenchIds,
} from "@ryu/workbench/persistence";
import {
	createDesktopWorkbenchWriter,
	readDesktopWorkbenchStartup,
	WORKBENCH_STORAGE_KEY,
	writeDesktopWorkbenchSnapshot,
} from "./desktop-workbench-persistence.ts";

const FIXED_IDS: WorkbenchIds = {
	bottomGroupId: "bottom-main",
	centerGroupId: "center-main",
	leftGroupId: "left-main",
	navigationId: "navigation",
	rightGroupId: "right-main",
	makeItemId: (sourceKey) => `item:${sourceKey}`,
};

class MemoryStorage implements Storage {
	readonly reads: string[] = [];
	readonly writes: [string, string][] = [];
	private readonly values = new Map<string, string>();

	get length(): number {
		return this.values.size;
	}

	clear(): void {
		this.values.clear();
	}

	getItem(key: string): string | null {
		this.reads.push(key);
		return this.values.get(key) ?? null;
	}

	key(index: number): string | null {
		return [...this.values.keys()][index] ?? null;
	}

	removeItem(key: string): void {
		this.values.delete(key);
	}

	setItem(key: string, value: string): void {
		this.writes.push([key, value]);
		this.values.set(key, value);
	}
}

describe("readDesktopWorkbenchStartup", () => {
	test("retains legacy own keys and non-finite JSON metadata while normalizing the selected index", () => {
		const storage = new MemoryStorage();
		const raw =
			'{"activeIndex":1e400,"tabs":[{"path":"/chat/one","title":"One","conversationId":"conversation","workspaceSession":{"bottom":{"activeIndex":0,"tabs":[{"kind":"terminal","label":"Terminal"}]},"bottomOpen":true,"right":{"activeIndex":0,"tabs":[]},"rightOpen":false}}],"__proto__":{"future":true},"futureMetadata":1e400}';
		storage.setItem("ryu_session_tabs", raw);
		const startup = readDesktopWorkbenchStartup({
			storage,
			ids: FIXED_IDS,
			folder: "/project",
		});
		expect(startup.source).toBe("legacy");
		expect(startup.state.openRegions.bottom).toBe(true);
		expect(
			startup.state.items.find(
				(item) =>
					item.source.kind === "shell" && item.source.panel === "terminal"
			)?.scope
		).toEqual({ kind: "conversation", conversationId: "conversation" });
		expect(storage.getItem("ryu_session_tabs")).toBe(raw);
	});
	test("uses a validated v2 snapshot without reading legacy stores", () => {
		const storage = new MemoryStorage();
		const persisted = {
			...createDefaultWorkbench(FIXED_IDS),
			sizes: { bottom: 300, left: 310, right: 420 },
		};
		storage.setItem(
			WORKBENCH_STORAGE_KEY,
			JSON.stringify(serializeWorkbenchSnapshot(persisted))
		);
		storage.writes.length = 0;

		const startup = readDesktopWorkbenchStartup({
			storage,
			folder: "/tmp/project",
			ids: FIXED_IDS,
		});

		expect(startup.source).toBe("v2");
		expect(startup.state.sizes).toEqual({
			bottom: 300,
			left: 310,
			right: 420,
		});
		expect(storage.reads).toEqual([WORKBENCH_STORAGE_KEY]);
		expect(storage.writes).toEqual([]);
	});

	test("migrates the three legacy stores once and persists validated v2", () => {
		const storage = new MemoryStorage();
		storage.setItem(
			"ryu_session_tabs",
			JSON.stringify({
				activeIndex: 0,
				tabs: [
					{
						conversationId: "conversation-1",
						path: "/chat",
						title: "Chat",
						workspaceSession: {
							bottom: {
								activeIndex: 0,
								tabs: [{ kind: "terminal", label: "Terminal" }],
							},
							bottomOpen: true,
							right: { activeIndex: 0, tabs: [] },
							rightOpen: false,
						},
					},
				],
			})
		);
		storage.setItem(
			"ryu_pinned_dock_tabs",
			JSON.stringify({
				"/tmp/project": [{ kind: "files", label: "Files", side: "right" }],
			})
		);
		storage.setItem("ryu:sidebar-width", "312");
		storage.writes.length = 0;

		const startup = readDesktopWorkbenchStartup({
			storage,
			folder: "/tmp/project",
			ids: FIXED_IDS,
		});

		expect(startup.state.version).toBe(2);
		expect(startup.source).toBe("legacy");
		expect(startup.state.sizes.left).toBe(312);
		expect(startup.state.openRegions.bottom).toBe(true);
		expect(
			startup.state.items.find(
				(item) =>
					item.source.kind === "shell" && item.source.panel === "terminal"
			)?.scope
		).toEqual({ kind: "conversation", conversationId: "conversation-1" });
		expect(
			startup.state.items.find(
				(item) => item.source.kind === "shell" && item.source.panel === "files"
			)?.scope
		).toEqual({ kind: "project", folder: "/tmp/project" });
		expect(storage.getItem(WORKBENCH_STORAGE_KEY)).not.toBeNull();
		expect(
			storage.writes.filter(([key]) => key === WORKBENCH_STORAGE_KEY)
		).toHaveLength(1);

		const secondStartup = readDesktopWorkbenchStartup({
			storage,
			folder: "/tmp/project",
			ids: FIXED_IDS,
		});
		expect(secondStartup.source).toBe("v2");
		expect(
			storage.writes.filter(([key]) => key === WORKBENCH_STORAGE_KEY)
		).toHaveLength(1);
	});

	test("migrates the current legacy sidebar visibility preference", () => {
		for (const sidebarOpen of [false, true]) {
			const storage = new MemoryStorage();
			const startup = readDesktopWorkbenchStartup({
				storage,
				folder: "/tmp/project",
				ids: FIXED_IDS,
				sidebarOpen,
			});

			expect(startup.state.openRegions.left).toBe(sidebarOpen);
		}
	});

	test("clamps a high active tab index before migrating its workspace", () => {
		const storage = new MemoryStorage();
		storage.setItem(
			"ryu_session_tabs",
			JSON.stringify({
				activeIndex: 99,
				tabs: [
					{
						conversationId: "conversation-1",
						path: "/chat/one",
						title: "First",
						workspaceSession: {
							bottom: { activeIndex: 0, tabs: [] },
							bottomOpen: false,
							right: { activeIndex: 0, tabs: [] },
							rightOpen: false,
						},
					},
					{
						conversationId: "conversation-2",
						path: "/chat/two",
						title: "Second",
						workspaceSession: {
							bottom: {
								activeIndex: 0,
								tabs: [{ kind: "terminal", label: "Second terminal" }],
							},
							bottomOpen: true,
							right: { activeIndex: 0, tabs: [] },
							rightOpen: false,
						},
					},
				],
			})
		);
		storage.writes.length = 0;

		const startup = readDesktopWorkbenchStartup({
			storage,
			folder: "/tmp/project",
			ids: FIXED_IDS,
		});

		expect(startup.state.openRegions.bottom).toBe(true);
		expect(
			startup.state.items.find(
				(item) =>
					item.source.kind === "shell" && item.source.panel === "terminal"
			)?.scope
		).toEqual({ kind: "conversation", conversationId: "conversation-2" });
		const centerGroup = startup.state.groups.find(
			(group) => group.region === "center"
		);
		const activeCenterItem = startup.state.items.find(
			(item) => item.id === centerGroup?.activeItemId
		);
		expect(activeCenterItem?.source).toEqual({
			kind: "route",
			path: "/chat/two",
		});
	});

	test("does not borrow a valid owner when the effective row is malformed", () => {
		const storage = new MemoryStorage();
		storage.setItem(
			"ryu_session_tabs",
			JSON.stringify({
				activeIndex: 99,
				tabs: [
					{
						conversationId: "conversation-1",
						path: "/chat/one",
						title: "First",
					},
					{
						conversationId: "conversation-2",
						path: "/chat/two",
						workspaceSession: {
							bottom: {
								activeIndex: 0,
								tabs: [{ kind: "terminal", label: "Terminal" }],
							},
							bottomOpen: true,
							right: { activeIndex: 0, tabs: [] },
							rightOpen: false,
						},
					},
				],
			})
		);
		storage.writes.length = 0;

		const startup = readDesktopWorkbenchStartup({
			storage,
			folder: "/tmp/project",
			ids: FIXED_IDS,
		});

		expect(
			startup.state.items.find(
				(item) =>
					item.source.kind === "shell" && item.source.panel === "terminal"
			)?.scope
		).toEqual({ kind: "window" });
	});

	test("falls back safely for malformed v2 without deleting legacy data", () => {
		const storage = new MemoryStorage();
		const legacySession = JSON.stringify({
			activeIndex: 0,
			tabs: [{ path: "/chat", title: "Legacy chat" }],
		});
		storage.setItem(WORKBENCH_STORAGE_KEY, "{malformed");
		storage.setItem("ryu_session_tabs", legacySession);
		storage.writes.length = 0;

		const startup = readDesktopWorkbenchStartup({
			storage,
			folder: "/tmp/project",
			ids: FIXED_IDS,
		});

		expect(startup.source).toBe("default");
		expect(startup.state).toEqual(createDefaultWorkbench(FIXED_IDS));
		expect(storage.getItem("ryu_session_tabs")).toBe(legacySession);
		expect(storage.getItem(WORKBENCH_STORAGE_KEY)).toBe("{malformed");
		expect(storage.writes).toEqual([]);
	});

	test("contains legacy read failures without committing an empty migration", () => {
		const storage = new MemoryStorage();
		const read = storage.getItem.bind(storage);
		storage.getItem = (key) => {
			if (key === "ryu_session_tabs") {
				throw new Error("storage unavailable");
			}
			return read(key);
		};

		const startup = readDesktopWorkbenchStartup({
			storage,
			folder: "/tmp/project",
			ids: FIXED_IDS,
		});

		expect(startup.source).toBe("default");
		expect(startup.state).toEqual(createDefaultWorkbench(FIXED_IDS));
		expect(storage.writes).toEqual([]);
	});
});

test("desktop writer debounces, skips equal snapshots, and flushes", () => {
	const storage = new MemoryStorage();
	const writer = createDesktopWorkbenchWriter(storage, 60_000);
	const initial = createDefaultWorkbench(FIXED_IDS);
	const resized = {
		...initial,
		sizes: { ...initial.sizes, right: 500 },
	};

	writer.schedule(initial);
	writer.schedule(initial);
	writer.schedule(resized);
	expect(storage.writes).toEqual([]);

	writer.flush();
	expect(storage.writes).toHaveLength(1);
	writer.schedule(resized);
	writer.flush();
	expect(storage.writes).toHaveLength(1);

	const baselineStorage = new MemoryStorage();
	const baselineWriter = createDesktopWorkbenchWriter(
		baselineStorage,
		60_000,
		initial
	);
	baselineWriter.schedule(resized);
	baselineWriter.schedule(initial);
	baselineWriter.flush();
	expect(baselineStorage.writes).toEqual([]);
});

test("storage write failures stay contained", () => {
	const storage = new MemoryStorage();
	storage.setItem = () => {
		throw new Error("quota exceeded");
	};
	const state = createDefaultWorkbench(FIXED_IDS);
	const writer = createDesktopWorkbenchWriter(storage, 60_000);

	expect(writeDesktopWorkbenchSnapshot(storage, state)).toBe(false);
	expect(() => {
		writer.schedule(state);
		writer.flush();
	}).not.toThrow();
});
