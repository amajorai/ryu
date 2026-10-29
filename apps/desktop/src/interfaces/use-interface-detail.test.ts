import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import type { Conversation } from "@/types/chat.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// The loop's two context reads, so the hook can render without providers.
const loads: string[] = [];
mock.module("@/src/contexts/ChatHistoryContext.tsx", () => ({
	useChatHistoryContext: () => ({
		loadMessagesPageResult: (id: string) => {
			loads.push(id);
			return Promise.resolve({
				hasOlderMessages: false,
				messages: [],
				status: "ok",
			});
		},
	}),
}));
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => ({
		token: null,
		url: "https://node.test",
		userJwt: null,
	}),
}));
const { createRoot } = await import("react-dom/client");
const {
	detailCandidates,
	OTHER_READ_CAP,
	planHydration,
	RUNNING_READ_CAP,
	SWEEP_AGE_MS,
	SWEEP_READ_CAP,
	noteInterfaceNode,
	SWEEP_WINDOW_MS,
	useInterfaceDetail,
} = await import("./use-interface-detail.ts");
const { getLivePermission, isPermissionAnswered, useInterfaceDetailStore } =
	await import("@/src/store/useInterfaceDetailStore.ts");
type DetailCandidate = import("./use-interface-detail.ts").DetailCandidate;

const NOW = 1_760_000_000_000;
const DAY = 24 * 60 * 60_000;

function conversation(
	id: string,
	overrides: Partial<Conversation> = {}
): Conversation {
	return {
		agentId: "coder",
		createdAt: NOW - 30 * DAY,
		id,
		messageCount: 2,
		messages: [],
		title: id,
		updatedAt: NOW - DAY,
		...overrides,
	};
}

const statusOf = (c: Conversation) => c.runStatus;
const ids = (list: DetailCandidate[]) => list.map((c) => c.conversation.id);

describe("planHydration (test 11)", () => {
	test("running mains then sessions, newest first, capped at 8 together", () => {
		const conversations = [
			...Array.from({ length: 6 }, (_, i) =>
				conversation(`m${i}`, { runStatus: "running", updatedAt: NOW - i })
			),
			...Array.from({ length: 4 }, (_, i) =>
				conversation(`s${i}`, {
					hierarchy: { role: "session", spawnedByConversationId: "m0" },
					runStatus: "running",
					updatedAt: NOW - i,
				})
			),
		];
		const plan = planHydration({
			candidates: detailCandidates(conversations, statusOf, new Set()),
			current: () => false,
			nowMs: NOW,
			sweepReads: [],
		});
		expect(ids(plan.running)).toEqual([
			"m0",
			"m1",
			"m2",
			"m3",
			"m4",
			"m5",
			"s0",
			"s1",
		]);
		expect(plan.running).toHaveLength(RUNNING_READ_CAP);
		expect(plan.runningWithinCap).toBe(false);
	});

	test("a main with a running helper counts as running", () => {
		const candidates = detailCandidates(
			[
				conversation("main", { runStatus: "completed" }),
				conversation("helper", {
					hierarchy: { role: "session", spawnedByConversationId: "main" },
					runStatus: "running",
				}),
			],
			statusOf,
			new Set()
		);
		expect(candidates.find((c) => c.conversation.id === "main")?.running).toBe(
			true
		);
	});

	test("priority threads: at most 16, once per revision", () => {
		const conversations = Array.from({ length: 20 }, (_, i) =>
			conversation(`p${i}`, { updatedAt: NOW - i * 1000 })
		);
		const priority = new Set(conversations.map((c) => c.id));
		const candidates = detailCandidates(conversations, statusOf, priority);
		const first = planHydration({
			candidates,
			current: () => false,
			nowMs: NOW,
			sweepReads: [],
		});
		expect(first.other).toHaveLength(OTHER_READ_CAP);
		const done = new Set(ids(first.other));
		const second = planHydration({
			candidates,
			current: (c) => done.has(c.conversation.id),
			nowMs: NOW,
			sweepReads: [],
		});
		expect(ids(second.other)).toEqual(["p16", "p17", "p18", "p19"]);
	});

	test("the sweep reads 7-day threads within its budget and reports completion", () => {
		const recent = Array.from({ length: 20 }, (_, i) =>
			conversation(`r${i}`, { updatedAt: NOW - i * 1000 })
		);
		const old = conversation("old", { updatedAt: NOW - SWEEP_AGE_MS - 1 });
		const candidates = detailCandidates([...recent, old], statusOf, new Set());
		const plan = planHydration({
			candidates,
			current: () => false,
			nowMs: NOW,
			sweepReads: [],
		});
		expect(plan.sweep).toHaveLength(SWEEP_READ_CAP);
		expect(ids(plan.sweep)).not.toContain("old");
		expect(plan.sweepComplete).toBe(false);
		const spent = planHydration({
			candidates,
			current: () => false,
			nowMs: NOW,
			sweepReads: Array.from({ length: 16 }, () => NOW - 1000),
		});
		expect(spent.sweep).toEqual([]);
		const later = planHydration({
			candidates,
			current: () => false,
			nowMs: NOW + SWEEP_WINDOW_MS,
			sweepReads: Array.from({ length: 16 }, () => NOW - 1000),
		});
		expect(later.sweep).toHaveLength(SWEEP_READ_CAP);
		const complete = planHydration({
			candidates,
			current: (c) => c.conversation.id !== "old",
			nowMs: NOW,
			sweepReads: [],
		});
		expect(complete.sweepComplete).toBe(true);
	});

	test("the revision follows updatedAt, message count and the overlaid status", () => {
		const [candidate] = detailCandidates(
			[conversation("c", { messageCount: 4, updatedAt: 1_760_000_000_123 })],
			() => "running",
			new Set()
		);
		expect(candidate?.revision).toBe("1760000000123:4:running");
	});
});

describe("the hydration loop (test 11)", () => {
	const root = createRoot(document.createElement("div"));
	afterAll(() => {
		act(() => root.unmount());
	});
	const setVisibility = (state: "hidden" | "visible") => {
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			value: state,
		});
		document.dispatchEvent(new Event("visibilitychange"));
	};
	const conversations = [
		conversation("live", { runStatus: "running", updatedAt: NOW }),
	];
	const priorityIds = new Set<string>();
	function Loop() {
		useInterfaceDetail({
			agentOf: () => "coder",
			conversations,
			enabled: true,
			priorityIds,
			statusOf,
		});
		return null;
	}

	test("pauses while the window is hidden and resumes when it shows", async () => {
		setVisibility("hidden");
		await act(async () => root.render(createElement(Loop)));
		await act(async () => {
			await Bun.sleep(20);
		});
		expect(loads).toEqual([]);
		await act(async () => setVisibility("visible"));
		await act(async () => {
			await Bun.sleep(20);
		});
		expect(loads).toEqual(["live"]);
	});
});

describe("a node switch (bug 1)", () => {
	test("forgets the previous node's reads, live asks and answers", () => {
		noteInterfaceNode("https://node-a.test");
		const store = useInterfaceDetailStore.getState();
		store.setEntry(JSON.stringify(["https://node-a.test", "t"]), {
			detail: null,
			hasOlder: false,
			readAt: 0,
			revision: "r1",
			status: "ready",
		});
		const ask = {
			agentId: null,
			blocking: true,
			id: "permission:perm-3",
			kind: "permission" as const,
			since: null,
			source: "live-tab" as const,
			text: "Allow?",
			threadId: "t",
		};
		store.publishLive(
			{ nodeUrl: "https://node-a.test", threadId: "t" },
			{ permission: { ask, respond: () => undefined } }
		);
		store.markPermissionAnswered({
			nodeUrl: "https://node-a.test",
			requestId: "perm-1",
			threadId: "t",
		});
		expect(noteInterfaceNode("https://node-a.test")).toBe(false);
		expect(getLivePermission(ask, "https://node-a.test")).not.toBeNull();
		expect(noteInterfaceNode("https://node-b.test")).toBe(true);
		const after = useInterfaceDetailStore.getState();
		expect(after.entries).toEqual({});
		expect(getLivePermission(ask, "https://node-a.test")).toBeNull();
		expect(
			isPermissionAnswered(after.answeredPermissions, {
				nodeUrl: "https://node-a.test",
				requestId: "perm-1",
				threadId: "t",
			})
		).toBe(false);
	});
});

describe("live-tab entries in the snapshot input (bug 1)", () => {
	test("only tabs on the interface's node speak for its threads", async () => {
		useInterfaceDetailStore.setState({ live: {}, publishers: {} });
		const store = useInterfaceDetailStore.getState();
		store.publishLive(
			{ nodeUrl: "https://elsewhere.test", threadId: "t" },
			{ running: true, startedAtMs: 1 }
		);
		store.publishLive(
			{ nodeUrl: "https://node.test", threadId: "t" },
			{ running: false }
		);
		let seen: ReturnType<typeof useInterfaceDetail> | null = null;
		function Reader() {
			seen = useInterfaceDetail({
				agentOf: () => null,
				conversations: [],
				enabled: false,
				priorityIds: new Set(),
				statusOf: () => undefined,
			});
			return null;
		}
		const root = createRoot(document.createElement("div"));
		await act(async () => root.render(createElement(Reader)));
		const live = (seen as ReturnType<typeof useInterfaceDetail> | null)?.live;
		expect(live?.size).toBe(1);
		expect(live?.get("t")).toEqual({ running: false, threadId: "t" });
		act(() => root.unmount());
	});
});
