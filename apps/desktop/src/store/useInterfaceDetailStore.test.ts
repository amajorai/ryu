import { beforeEach, describe, expect, test } from "bun:test";
import type { InterfaceAsk } from "@ryuhq/protocol/interfaces";
import type { ThreadDetail } from "@/src/lib/interface-detail.ts";
import {
	DETAIL_ERROR_RETRY_MS,
	ensureInterfaceDetail,
	getLivePermission,
	getQuestionHolder,
	isInterfaceDetailCurrent,
	isPermissionAnswered,
	liveTabKey,
	resetInterfaceDetail,
	resetInterfaceNode,
	useInterfaceDetailStore,
} from "./useInterfaceDetailStore.ts";

const empty: ThreadDetail = {
	activity: null,
	blocker: null,
	hasLaterAssistant: false,
	outcome: null,
	progress: null,
	progressMarks: {
		messageAt: null,
		partAt: null,
		turnMessageAt: null,
		turnPartAt: null,
	},
	questionAsks: [],
	userStart: null,
};

function deferred() {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

beforeEach(() => {
	resetInterfaceDetail();
	useInterfaceDetailStore.setState({
		answeredPermissions: {},
		live: {},
		publishers: {},
	});
});

describe("ensureInterfaceDetail (test 11)", () => {
	test("dedupes a revision and skips a current one unless forced", async () => {
		let reads = 0;
		const load = () => {
			reads += 1;
			return Promise.resolve({
				hasOlder: false,
				messages: [],
				status: "ok" as const,
			});
		};
		const input = { derive: () => empty, key: "k", load, revision: "r1" };
		await Promise.all([
			ensureInterfaceDetail(input).done,
			ensureInterfaceDetail(input).done,
		]);
		expect(reads).toBe(1);
		await ensureInterfaceDetail(input).done;
		expect(reads).toBe(1);
		await ensureInterfaceDetail({ ...input, force: true }).done;
		expect(reads).toBe(2);
		await ensureInterfaceDetail({ ...input, revision: "r2" }).done;
		expect(reads).toBe(3);
		expect(useInterfaceDetailStore.getState().entries.k).toMatchObject({
			revision: "r2",
			status: "ready",
		});
	});

	test("a read that finishes after a newer one started is dropped", async () => {
		const slow = deferred();
		const first = ensureInterfaceDetail({
			derive: () => ({ ...empty, userStart: 1 }),
			key: "k",
			load: async () => {
				await slow.promise;
				return { hasOlder: false, messages: [], status: "ok" as const };
			},
			revision: "r1",
		});
		await ensureInterfaceDetail({
			derive: () => ({ ...empty, userStart: 2 }),
			key: "k",
			load: () =>
				Promise.resolve({
					hasOlder: true,
					messages: [],
					status: "ok" as const,
				}),
			revision: "r2",
		}).done;
		slow.resolve();
		await first.done;
		expect(useInterfaceDetailStore.getState().entries.k).toMatchObject({
			hasOlder: true,
			revision: "r2",
		});
		expect(
			useInterfaceDetailStore.getState().entries.k?.detail?.userStart
		).toBe(2);
	});

	test("a failed read is an error entry, keeping the last good detail", async () => {
		await ensureInterfaceDetail({
			derive: () => ({ ...empty, userStart: 7 }),
			key: "k",
			load: () =>
				Promise.resolve({
					hasOlder: false,
					messages: [],
					status: "ok" as const,
				}),
			revision: "r1",
		}).done;
		await ensureInterfaceDetail({
			derive: () => empty,
			key: "k",
			load: () =>
				Promise.resolve({
					hasOlder: false,
					messages: [],
					status: "error" as const,
				}),
			revision: "r2",
		}).done;
		expect(useInterfaceDetailStore.getState().entries.k).toMatchObject({
			revision: "r2",
			status: "error",
		});
		expect(
			useInterfaceDetailStore.getState().entries.k?.detail?.userStart
		).toBe(7);
	});
});

describe("failed reads", () => {
	test("retry after the backoff, not before; a started flag reports real reads", async () => {
		let now = 1000;
		let reads = 0;
		const failing = {
			derive: () => empty,
			key: "k",
			load: () => {
				reads += 1;
				return Promise.resolve({
					hasOlder: false,
					messages: [],
					status: "error" as const,
				});
			},
			now: () => now,
			revision: "r1",
		};
		const first = ensureInterfaceDetail(failing);
		expect(first.started).toBe(true);
		await first.done;
		const again = ensureInterfaceDetail(failing);
		expect(again.started).toBe(false);
		expect(
			isInterfaceDetailCurrent(
				useInterfaceDetailStore.getState().entries.k,
				"r1",
				now
			)
		).toBe(true);
		now += DETAIL_ERROR_RETRY_MS;
		expect(
			isInterfaceDetailCurrent(
				useInterfaceDetailStore.getState().entries.k,
				"r1",
				now
			)
		).toBe(false);
		const retry = ensureInterfaceDetail(failing);
		expect(retry.started).toBe(true);
		await retry.done;
		expect(reads).toBe(2);
	});
});

describe("live-tab entries", () => {
	const ask = { id: "permission:req-1", threadId: "t" } as InterfaceAsk;
	const scope = { nodeUrl: "http://node-a", threadId: "t" };

	test("publish merges, getLivePermission finds by ask, removal drops", () => {
		const respond = () => undefined;
		const { clearLivePermission, publishLive, removeLive } =
			useInterfaceDetailStore.getState();
		publishLive(scope, { permission: { ask, respond }, startedAtMs: 5 });
		publishLive(scope, { lastProgressAt: "2026-10-16T10:00:00.000Z" });
		const key = liveTabKey(scope);
		expect(useInterfaceDetailStore.getState().live[key]).toMatchObject({
			lastProgressAt: "2026-10-16T10:00:00.000Z",
			nodeUrl: "http://node-a",
			startedAtMs: 5,
			threadId: "t",
		});
		expect(getLivePermission(ask, "http://node-a")?.respond).toBe(respond);
		clearLivePermission(scope, "permission:req-1");
		expect(getLivePermission(ask, "http://node-a")).toBeNull();
		expect(useInterfaceDetailStore.getState().live[key]?.startedAtMs).toBe(5);
		removeLive(scope);
		expect(useInterfaceDetailStore.getState().live[key]).toBeUndefined();
	});
});

describe("asks resolve to their own thread and node (bug 1)", () => {
	const permission = (threadId: string) =>
		({ id: "permission:perm-3", threadId }) as InterfaceAsk;

	test("one request id held by two threads reaches only the thread on screen", () => {
		const reached: string[] = [];
		const { publishLive } = useInterfaceDetailStore.getState();
		for (const threadId of ["thread-a", "thread-b"]) {
			publishLive(
				{ nodeUrl: "http://node-a", threadId },
				{
					permission: {
						ask: permission(threadId),
						respond: () => {
							reached.push(threadId);
						},
					},
				}
			);
		}
		getLivePermission(permission("thread-b"), "http://node-a")?.respond(
			"allow_once"
		);
		getLivePermission(permission("thread-a"), "http://node-a")?.respond(
			"allow_once"
		);
		expect(reached).toEqual(["thread-b", "thread-a"]);
	});

	test("the same request id on another node never answers this one", () => {
		const reached: string[] = [];
		const { publishLive } = useInterfaceDetailStore.getState();
		for (const nodeUrl of ["http://node-a", "http://node-b"]) {
			publishLive(
				{ nodeUrl, threadId: "thread-a" },
				{
					permission: {
						ask: permission("thread-a"),
						respond: () => {
							reached.push(nodeUrl);
						},
					},
				}
			);
		}
		getLivePermission(permission("thread-a"), "http://node-b")?.respond(
			"allow_once"
		);
		expect(reached).toEqual(["http://node-b"]);
		// Nothing published for this thread on the active node: refused.
		expect(getLivePermission(permission("thread-a"), "http://node-c")).toBe(
			null
		);
		expect(getLivePermission(permission("thread-z"), "http://node-a")).toBe(
			null
		);
	});

	test("a question resolves to its own thread's holder on the active node", () => {
		const question = (threadId: string, holderId: string) => ({
			ask: { id: "question:call_1", threadId } as InterfaceAsk,
			holderId,
			toolCallId: "call_1",
		});
		const { setEntry } = useInterfaceDetailStore.getState();
		const ready = (questionAsks: ThreadDetail["questionAsks"]) => ({
			detail: { ...empty, questionAsks },
			hasOlder: false,
			readAt: 0,
			revision: "r1",
			status: "ready" as const,
		});
		setEntry(
			JSON.stringify(["http://node-a", "thread-a"]),
			ready([question("thread-a", "thread-a")])
		);
		setEntry(
			JSON.stringify(["http://node-a", "thread-b"]),
			ready([question("thread-b", "thread-b")])
		);
		setEntry(
			JSON.stringify(["http://node-b", "thread-b"]),
			ready([question("thread-b", "thread-b-elsewhere")])
		);
		const asked = (threadId: string) =>
			({ id: "question:call_1", threadId }) as InterfaceAsk;
		expect(getQuestionHolder(asked("thread-b"), "http://node-a")).toEqual({
			conversationId: "thread-b",
			toolCallId: "call_1",
		});
		expect(getQuestionHolder(asked("thread-a"), "http://node-a")).toEqual({
			conversationId: "thread-a",
			toolCallId: "call_1",
		});
		expect(getQuestionHolder(asked("thread-b"), "http://node-b")).toEqual({
			conversationId: "thread-b-elsewhere",
			toolCallId: "call_1",
		});
		expect(getQuestionHolder(asked("thread-c"), "http://node-a")).toBeNull();
	});

	test("two helper sessions holding one tool-call id for a thread are refused", () => {
		const { setEntry } = useInterfaceDetailStore.getState();
		for (const session of ["session-1", "session-2"]) {
			setEntry(JSON.stringify(["http://node-a", session]), {
				detail: {
					...empty,
					questionAsks: [
						{
							ask: { id: "question:call_1", threadId: "main" } as InterfaceAsk,
							holderId: session,
							toolCallId: "call_1",
						},
					],
				},
				hasOlder: false,
				readAt: 0,
				revision: "r1",
				status: "ready",
			});
		}
		expect(
			getQuestionHolder(
				{ id: "question:call_1", threadId: "main" },
				"http://node-a"
			)
		).toBeNull();
	});

	test("a node reset drops that node's reads, live entries and answers", () => {
		const store = useInterfaceDetailStore.getState();
		store.setEntry(JSON.stringify(["http://node-a", "t"]), {
			detail: empty,
			hasOlder: false,
			readAt: 0,
			revision: "r1",
			status: "ready",
		});
		store.publishLive({ nodeUrl: "http://node-a", threadId: "t" }, {});
		store.publishLive({ nodeUrl: "http://node-b", threadId: "t" }, {});
		const answered = { requestId: "perm-1", threadId: "t" };
		store.markPermissionAnswered({ ...answered, nodeUrl: "http://node-a" });
		store.markPermissionAnswered({ ...answered, nodeUrl: "http://node-b" });
		resetInterfaceNode("http://node-a");
		const after = useInterfaceDetailStore.getState();
		expect(after.entries).toEqual({});
		expect(Object.keys(after.live)).toEqual([
			liveTabKey({ nodeUrl: "http://node-b", threadId: "t" }),
		]);
		expect(
			isPermissionAnswered(after.answeredPermissions, {
				...answered,
				nodeUrl: "http://node-a",
			})
		).toBe(false);
		expect(
			isPermissionAnswered(after.answeredPermissions, {
				...answered,
				nodeUrl: "http://node-b",
			})
		).toBe(true);
	});
});

describe("answered permissions are scoped and pruned (bug 2)", () => {
	const answered = (nodeUrl: string, threadId: string) =>
		isPermissionAnswered(
			useInterfaceDetailStore.getState().answeredPermissions,
			{ nodeUrl, requestId: "perm-1", threadId }
		);

	test("an answer on one conversation or node hides no other", () => {
		useInterfaceDetailStore.getState().markPermissionAnswered({
			nodeUrl: "http://node-a",
			requestId: "perm-1",
			threadId: "thread-a",
		});
		expect(answered("http://node-a", "thread-a")).toBe(true);
		expect(answered("http://node-a", "thread-b")).toBe(false);
		expect(answered("http://node-b", "thread-a")).toBe(false);
	});

	test("after the turn ends the same id is shown again", () => {
		const store = useInterfaceDetailStore.getState();
		store.markPermissionAnswered({
			nodeUrl: "http://node-a",
			requestId: "perm-1",
			threadId: "thread-a",
		});
		store.markPermissionAnswered({
			nodeUrl: "http://node-a",
			requestId: "perm-1",
			threadId: "thread-b",
		});
		store.pruneAnsweredPermissions({
			nodeUrl: "http://node-a",
			threadId: "thread-a",
		});
		expect(answered("http://node-a", "thread-a")).toBe(false);
		expect(answered("http://node-a", "thread-b")).toBe(true);
	});

	test("answering clears the ask on that thread only", () => {
		const { markPermissionAnswered, publishLive } =
			useInterfaceDetailStore.getState();
		for (const threadId of ["thread-a", "thread-b"]) {
			publishLive(
				{ nodeUrl: "http://node-a", threadId },
				{
					permission: {
						ask: { id: "permission:perm-1", threadId } as InterfaceAsk,
						respond: () => undefined,
					},
				}
			);
		}
		markPermissionAnswered({
			nodeUrl: "http://node-a",
			requestId: "perm-1",
			threadId: "thread-a",
		});
		const live = useInterfaceDetailStore.getState().live;
		expect(
			live[liveTabKey({ nodeUrl: "http://node-a", threadId: "thread-a" })]
				?.permission ?? null
		).toBeNull();
		expect(
			live[liveTabKey({ nodeUrl: "http://node-a", threadId: "thread-b" })]
				?.permission?.ask.id
		).toBe("permission:perm-1");
	});
});
