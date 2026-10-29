import { describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { InterfaceAsk } from "@ryuhq/protocol/interfaces";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
const { answerAskWith, EVENT_RENDERERS, snapshotAsk } = await import(
	"./InterfaceSurface.tsx"
);
const { getLivePermission, useInterfaceDetailStore } = await import(
	"@/src/store/useInterfaceDetailStore.ts"
);

function deps(
	threads: Record<string, string | null> = {},
	options: {
		holders?: Record<string, { conversationId: string; toolCallId: string }>;
		gone?: string[];
		permissions?: Record<string, (optionId: string) => unknown>;
		redacted?: boolean;
		resolved?: boolean;
	} = {}
) {
	return {
		approve: mock((_id: string) => Promise.resolve()),
		livePermission: (ask: InterfaceAsk) =>
			options.permissions?.[ask.id] ?? null,
		openInbox: mock(() => undefined),
		openThread: mock((_id: string) => undefined),
		questionHolder: (ask: InterfaceAsk) => options.holders?.[ask.id] ?? null,
		redacted: () => options.redacted === true,
		reject: mock((_id: string) => Promise.resolve()),
		respondQuestion: mock(
			(_conversationId: string, _toolCallId: string, _answers: unknown[]) =>
				Promise.resolve({ resolved: options.resolved ?? true })
		),
		currentAsk: (askId: string) =>
			options.gone?.includes(askId)
				? null
				: ({ id: askId, threadId: threads[askId] ?? null } as InterfaceAsk),
	};
}

describe("port.answerAsk", () => {
	test("approvals approve or reject through the pending-approvals hook", async () => {
		const d = deps();
		await answerAskWith(d, "approval:abc", "approve");
		await answerAskWith(d, "approval:def", "reject");
		expect(d.approve.mock.calls).toEqual([["abc"]]);
		expect(d.reject.mock.calls).toEqual([["def"]]);
		expect(d.openThread).not.toHaveBeenCalled();
	});

	test("a single-select question posts to the conversation that holds it", async () => {
		const holders = {
			"question:call-1": { conversationId: "session-1", toolCallId: "call-1" },
		};
		const d = deps({ "question:call-1": "main-1" }, { holders });
		await answerAskWith(d, "question:call-1", "postgres");
		expect(d.respondQuestion.mock.calls).toEqual([
			["session-1", "call-1", [{ kind: "single", selectedIds: ["postgres"] }]],
		]);
		expect(d.openThread).not.toHaveBeenCalled();
	});

	test("resolved:false or an error opens the thread instead", async () => {
		const holders = {
			"question:call-1": { conversationId: "session-1", toolCallId: "call-1" },
		};
		const d = deps(
			{ "question:call-1": "main-1" },
			{ holders, resolved: false }
		);
		await answerAskWith(d, "question:call-1", "postgres");
		expect(d.openThread.mock.calls).toEqual([["main-1"]]);
		const failing = deps({ "question:call-1": "main-1" }, { holders });
		failing.respondQuestion.mockImplementation(() =>
			Promise.reject(new Error("offline"))
		);
		await answerAskWith(failing, "question:call-1", "postgres");
		expect(failing.openThread.mock.calls).toEqual([["main-1"]]);
	});

	test("a permission goes through the tab's own respond callback", async () => {
		const respond = mock((_optionId: string) => undefined);
		const d = deps({}, { permissions: { "permission:req-1": respond } });
		await answerAskWith(d, "permission:req-1", "allow_once");
		expect(respond.mock.calls).toEqual([["allow_once"]]);
		expect(d.openThread).not.toHaveBeenCalled();
	});

	test("asks it cannot answer in place open their thread, or the inbox", async () => {
		const d = deps({ "permission:req-1": "t-ada" });
		await answerAskWith(d, "permission:req-1", "allow_once");
		expect(d.openThread.mock.calls).toEqual([["t-ada"]]);
		await answerAskWith(d, "approval:wf", "later");
		expect(d.openInbox).toHaveBeenCalledTimes(1);
		expect(d.approve).not.toHaveBeenCalled();
	});

	test("an ask that left the snapshot is not answered", async () => {
		const d = deps({}, { gone: ["approval:old"] });
		await answerAskWith(d, "approval:old", "approve");
		expect(d.approve).not.toHaveBeenCalled();
		expect(d.openThread).not.toHaveBeenCalled();
	});

	test("while redacted every ask only opens its thread or the inbox", async () => {
		const d = deps({ "approval:a": "t-ada" }, { redacted: true });
		await answerAskWith(d, "approval:a", "approve");
		await answerAskWith(d, "approval:wf", "approve");
		expect(d.approve).not.toHaveBeenCalled();
		expect(d.openThread.mock.calls).toEqual([["t-ada"]]);
		expect(d.openInbox).toHaveBeenCalledTimes(1);
	});

	test("a failed approval rejects so the ask card can show it", async () => {
		const d = deps();
		d.approve.mockImplementation(() => Promise.reject(new Error("no")));
		await expect(answerAskWith(d, "approval:x", "approve")).rejects.toThrow(
			"no"
		);
	});
});

describe("port.answerAsk targets the ask on screen (bug 1)", () => {
	test("one request id held on two threads: deciding thread A's ask reaches A only", async () => {
		useInterfaceDetailStore.setState({ live: {}, publishers: {} });
		const reached: [string, string][] = [];
		const askFor = (threadId: string) =>
			({
				id: "permission:perm-3",
				kind: "permission",
				threadId,
			}) as InterfaceAsk;
		// Thread B published first, so a global search by ask id finds B.
		for (const threadId of ["thread-b", "thread-a"]) {
			useInterfaceDetailStore.getState().publishLive(
				{ nodeUrl: "http://node-a", threadId },
				{
					permission: {
						ask: askFor(threadId),
						respond: (optionId) => {
							reached.push([threadId, optionId]);
						},
					},
				}
			);
		}
		const d = {
			...deps(),
			currentAsk: () => askFor("thread-a"),
			livePermission: (ask: InterfaceAsk) =>
				getLivePermission(ask, "http://node-a")?.respond ?? null,
		};
		await answerAskWith(d, "permission:perm-3", "allow_once");
		expect(reached).toEqual([["thread-a", "allow_once"]]);
		expect(d.openThread).not.toHaveBeenCalled();
	});

	test("the holder is asked for with the ask on screen, not its bare id", async () => {
		const seen: InterfaceAsk[] = [];
		const d = {
			...deps({ "question:call-1": "main-1" }),
			questionHolder: (ask: InterfaceAsk) => {
				seen.push(ask);
				return null;
			},
		};
		await answerAskWith(d, "question:call-1", "postgres");
		expect(seen.map((ask) => ask.threadId)).toEqual(["main-1"]);
		// No holder for that thread: nothing is posted; the thread opens.
		expect(d.respondQuestion).not.toHaveBeenCalled();
		expect(d.openThread.mock.calls).toEqual([["main-1"]]);
	});

	test("an id two snapshot asks share is refused, so the card shows the failure", async () => {
		const asks = [
			{ id: "question:call_1", threadId: "thread-a" },
			{ id: "question:call_1", threadId: "thread-b" },
		] as InterfaceAsk[];
		expect(() => snapshotAsk(asks, "question:call_1")).toThrow();
		expect(snapshotAsk(asks.slice(0, 1), "question:call_1")?.threadId).toBe(
			"thread-a"
		);
		expect(snapshotAsk(asks, "question:other")).toBeNull();
		const d = {
			...deps(),
			currentAsk: (id: string) => snapshotAsk(asks, id),
		};
		await expect(
			answerAskWith(d, "question:call_1", "postgres")
		).rejects.toThrow();
		expect(d.respondQuestion).not.toHaveBeenCalled();
	});
});

describe("EVENT_RENDERERS", () => {
	test("every useful-state game reads scheduled runs", () => {
		for (const id of [
			"aquarium",
			"arcade",
			"card-table",
			"farm",
			"kitchen",
			"lobby",
			"market",
			"passport",
			"path",
			"planets",
			"quiz",
			"rides",
			"seasonal",
			"town",
			"warehouse",
			"workers",
			"world-2d",
			"world-3d",
		]) {
			expect(EVENT_RENDERERS.has(id)).toBe(true);
		}
	});
});
