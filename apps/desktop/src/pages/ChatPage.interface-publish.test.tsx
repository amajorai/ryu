// ChatPage publishes its live tab state through `useLiveTabPublish`. ChatPage
// itself is too large to mount here, so the harness reproduces exactly the
// state it passes in: the `activePermission` memo over `resolvedPermissions`
// (keyed by node, conversation and request id), `respondToPermission`, which
// marks the request resolved and then POSTs, the composer card shown only
// while the turn runs, and `useAnsweredPermissionPrune` at the turn's end.
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	jest,
	mock,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useCallback, useMemo, useState } from "react";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const {
	answeredPermissionParts,
	permissionPartKey,
	useAnsweredPermissionPrune,
	useLiveTabPublish,
	PERMISSION_WAIT_MS,
} = await import("@/src/lib/interface-live-tab.ts");
const {
	answeredPermissionKey,
	getLivePermission,
	isPermissionAnswered,
	liveTabKey,
	useInterfaceDetailStore,
} = await import("@/src/store/useInterfaceDetailStore.ts");
const { answerAskWith } = await import("@/src/interfaces/InterfaceSurface.tsx");

const NODE = "http://node-a";
const posts: Array<{
	nodeUrl: string;
	optionId: string | null;
	requestId: string;
	threadId: string;
}> = [];
const prompt = {
	options: [
		{ kind: "allow_once", name: "Allow once", optionId: "allow_once" },
		{ kind: "reject_once", name: "Reject", optionId: "reject_once" },
	],
	requestId: "req-1",
	toolCall: {
		kind: "edit",
		locations: [{ path: "/r/deploy.sh" }],
		title: "Edit deploy.sh",
	},
};
/** The composer card each tab shows, by node and thread. */
const shown = new Map<string, string | null>();
let shownPermission: string | null = null;

interface HarnessMessage {
	id?: string;
	parts?: unknown[];
	role: string;
}

/** The assistant message that carries the prompt (ChatPage's stream part). */
const promptMessage = (id = "m-1"): HarnessMessage => ({
	id,
	parts: [{ data: prompt, type: "data-ryu-permission" }],
	role: "assistant",
});

function Tab({
	error = null,
	messages: given = [],
	nodeUrl = NODE,
	promptIn = ["m-1"],
	running,
	threadId = "t-ada",
	withPrompt = true,
}: {
	error?: { message?: string } | null;
	messages?: HarnessMessage[];
	nodeUrl?: string;
	/** The messages, oldest first, that each carry a `req-1` prompt. */
	promptIn?: string[];
	running: boolean;
	threadId?: string;
	withPrompt?: boolean;
}) {
	const messages = useMemo(
		() => [...given, ...(withPrompt ? promptIn.map(promptMessage) : [])],
		[given, withPrompt, promptIn]
	);
	const [resolved, setResolved] = useState<Set<string>>(() => new Set());
	const [spent, setSpent] = useState<Set<string>>(() => new Set());
	const answered = useInterfaceDetailStore(
		(state) => state.answeredPermissions
	);
	// ChatPage's `activePermission` memo: the newest prompt not answered.
	const activePermission = useMemo(() => {
		for (const message of [...messages].reverse()) {
			for (const part of (message.parts ?? []) as { type?: string }[]) {
				if (part.type !== "data-ryu-permission" || !message.id) {
					continue;
				}
				const scope = { nodeUrl, requestId: prompt.requestId, threadId };
				if (
					!(
						spent.has(permissionPartKey(message.id, prompt.requestId)) ||
						resolved.has(answeredPermissionKey(scope)) ||
						isPermissionAnswered(answered, scope)
					)
				) {
					return prompt;
				}
			}
		}
		return null;
	}, [messages, resolved, spent, answered, nodeUrl, threadId]);
	const respondToPermission = useCallback(
		(requestId: string, optionId: string | null) => {
			const scope = { nodeUrl, requestId, threadId };
			setResolved((prev) => new Set(prev).add(answeredPermissionKey(scope)));
			useInterfaceDetailStore.getState().markPermissionAnswered(scope);
			posts.push({ ...scope, optionId });
		},
		[nodeUrl, threadId]
	);
	useLiveTabPublish({
		activePermission,
		agentId: "ada",
		error,
		messages,
		nodeUrl,
		respondToPermission,
		running,
		startedAtMs: running ? 1_760_000_000_000 : null,
		threadId,
	});
	useAnsweredPermissionPrune({
		nodeUrl,
		onTurnEnd: () => {
			const store = useInterfaceDetailStore.getState().answeredPermissions;
			const done = answeredPermissionParts(messages, (requestId) => {
				const scope = { nodeUrl, requestId, threadId };
				return (
					resolved.has(answeredPermissionKey(scope)) ||
					isPermissionAnswered(store, scope)
				);
			});
			setSpent((prev) => new Set([...prev, ...done]));
			setResolved(new Set());
		},
		running,
		threadId,
	});
	const card = running ? (activePermission?.requestId ?? null) : null;
	shown.set(liveTabKey({ nodeUrl, threadId }), card);
	shownPermission = card;
	return null;
}

let root: ReturnType<typeof createRoot>;
const liveOf = (threadId = "t-ada", nodeUrl = NODE) =>
	useInterfaceDetailStore.getState().live[liveTabKey({ nodeUrl, threadId })];
const askInStore = () => liveOf()?.permission?.ask ?? null;

beforeEach(() => {
	posts.length = 0;
	shown.clear();
	useInterfaceDetailStore.setState({
		answeredPermissions: {},
		live: {},
		publishers: {},
	});
	root = createRoot(document.createElement("div"));
});

afterEach(() => {
	act(() => root.unmount());
	jest.useRealTimers();
});

describe("live-tab permission entry (test 11)", () => {
	test("published while running, with the exact turn start", async () => {
		await act(async () => root.render(<Tab running />));
		expect(askInStore()).toMatchObject({
			holdsRun: true,
			id: "permission:req-1",
			source: "live-tab",
			text: "Allow Edit deploy.sh?",
		});
		expect(liveOf()?.startedAtMs).toBe(1_760_000_000_000);
	});

	test("removed when the run stops", async () => {
		await act(async () => root.render(<Tab running />));
		await act(async () => root.render(<Tab running={false} />));
		expect(askInStore()).toBeNull();
	});

	test("removed when the tab unmounts", async () => {
		await act(async () => root.render(<Tab running />));
		await act(async () => root.unmount());
		expect(liveOf()).toBeUndefined();
		root = createRoot(document.createElement("div"));
	});

	test("removed at its upper-bound deadline", async () => {
		jest.useFakeTimers();
		await act(async () => root.render(<Tab running />));
		expect(askInStore()).not.toBeNull();
		await act(async () => {
			jest.advanceTimersByTime(PERMISSION_WAIT_MS + 1);
		});
		expect(askInStore()).toBeNull();
	});
});

describe("answering a permission through the interface (test 13e)", () => {
	test("clears the composer prompt and the ask, and POSTs exactly once", async () => {
		await act(async () => root.render(<Tab running />));
		const openThread = mock((_id: string) => undefined);
		const ask = askInStore();
		await act(async () => {
			await answerAskWith(
				{
					approve: () => Promise.resolve(),
					currentAsk: () => ask,
					livePermission: (current) =>
						getLivePermission(current, NODE)?.respond ?? null,
					openInbox: () => undefined,
					openThread,
					questionHolder: () => null,
					redacted: () => false,
					reject: () => Promise.resolve(),
					respondQuestion: () => Promise.resolve({ resolved: true }),
				},
				"permission:req-1",
				"allow_once"
			);
		});
		expect(posts).toEqual([
			{
				nodeUrl: NODE,
				optionId: "allow_once",
				requestId: "req-1",
				threadId: "t-ada",
			},
		]);
		expect(shownPermission).toBeNull();
		expect(askInStore()).toBeNull();
		expect(openThread).not.toHaveBeenCalled();
	});

	test("with no live entry it opens the thread", async () => {
		const openThread = mock((_id: string) => undefined);
		await answerAskWith(
			{
				approve: () => Promise.resolve(),
				currentAsk: (id) =>
					({ id, threadId: "t-ada" }) as ReturnType<
						Parameters<typeof answerAskWith>[0]["currentAsk"]
					>,
				livePermission: (current) =>
					getLivePermission(current, NODE)?.respond ?? null,
				openInbox: () => undefined,
				openThread,
				questionHolder: () => null,
				redacted: () => false,
				reject: () => Promise.resolve(),
				respondQuestion: () => Promise.resolve({ resolved: true }),
			},
			"permission:req-1",
			"allow_once"
		);
		expect(openThread.mock.calls).toEqual([["t-ada"]]);
		expect(posts).toEqual([]);
	});
});

describe("review follow-ups (B2)", () => {
	const lapse = {
		data: { agentId: "ada", message: "Sign in again" },
		type: "data-ryu-acp-auth-required",
	};

	test("a login lapse fixed by a later clean turn is not published again", async () => {
		const lapsed = [
			{ parts: [{ text: "go", type: "text" }], role: "user" },
			{ parts: [lapse], role: "assistant" },
		];
		await act(async () =>
			root.render(<Tab messages={lapsed} running={false} withPrompt={false} />)
		);
		expect(liveOf()?.blocker).toMatchObject({
			atApprox: true,
			kind: "auth",
		});
		const fixed = [
			...lapsed,
			{ parts: [{ text: "again", type: "text" }], role: "user" },
			{ parts: [{ text: "Done.", type: "text" }], role: "assistant" },
		];
		await act(async () =>
			root.render(<Tab messages={fixed} running={false} withPrompt={false} />)
		);
		expect(liveOf()?.blocker).toBeNull();
	});

	test("a blocker keeps the time it was first seen across re-renders", async () => {
		const lapsed = [{ parts: [lapse], role: "assistant" }];
		await act(async () =>
			root.render(<Tab messages={lapsed} running={false} withPrompt={false} />)
		);
		const first = liveOf()?.blocker?.at;
		await Bun.sleep(5);
		await act(async () =>
			root.render(
				<Tab messages={[...lapsed]} running={false} withPrompt={false} />
			)
		);
		expect(liveOf()?.blocker?.at).toBe(first);
	});

	test("two tabs on one thread keep their own entries", async () => {
		const second = createRoot(document.createElement("div"));
		await act(async () => root.render(<Tab running />));
		await act(async () =>
			second.render(<Tab running={false} withPrompt={false} />)
		);
		// The tab holding the prompt still speaks for the thread.
		expect(askInStore()?.id).toBe("permission:req-1");
		await act(async () => second.unmount());
		expect(askInStore()?.id).toBe("permission:req-1");
		expect(
			Object.keys(
				useInterfaceDetailStore.getState().publishers[
					liveTabKey({ nodeUrl: NODE, threadId: "t-ada" })
				] ?? {}
			)
		).toHaveLength(1);
	});

	test("two tabs streaming one thread: one answer, one POST, the ask leaves", async () => {
		const second = createRoot(document.createElement("div"));
		await act(async () => root.render(<Tab running />));
		await act(async () => second.render(<Tab running />));
		const onScreen = { id: "permission:req-1", threadId: "t-ada" };
		const respond = getLivePermission(onScreen, NODE)?.respond;
		expect(respond).toBeDefined();
		await act(async () => {
			await respond?.("allow_once");
		});
		expect(posts).toEqual([
			{
				nodeUrl: NODE,
				optionId: "allow_once",
				requestId: "req-1",
				threadId: "t-ada",
			},
		]);
		expect(getLivePermission(onScreen, NODE)).toBeNull();
		expect(liveOf()?.permission ?? null).toBeNull();
		await act(async () => second.unmount());
	});

	test("a later failure with the same words gets its own time", async () => {
		const failed = { message: "Network down" };
		const blockerAt = () => liveOf()?.blocker?.at;
		await act(async () =>
			root.render(<Tab error={failed} running={false} withPrompt={false} />)
		);
		const first = blockerAt();
		expect(first).toBeDefined();
		await act(async () => root.render(<Tab running withPrompt={false} />));
		await Bun.sleep(5);
		await act(async () =>
			root.render(<Tab error={failed} running={false} withPrompt={false} />)
		);
		expect(blockerAt()).not.toBe(first);
	});
});

describe("answered permissions never hide another prompt (bug 2)", () => {
	const answerOnScreen = async (threadId: string, nodeUrl = NODE) => {
		const respond = getLivePermission(
			{ id: "permission:req-1", threadId },
			nodeUrl
		)?.respond;
		if (!respond) {
			throw new Error(`no live permission on ${threadId}`);
		}
		await act(async () => {
			await respond("allow_once");
		});
	};

	test("an answer on one conversation does not hide the same id on another", async () => {
		const second = createRoot(document.createElement("div"));
		await act(async () => root.render(<Tab running threadId="t-ada" />));
		await act(async () => second.render(<Tab running threadId="t-bo" />));
		await answerOnScreen("t-ada");
		expect(shown.get(liveTabKey({ nodeUrl: NODE, threadId: "t-ada" }))).toBe(
			null
		);
		expect(shown.get(liveTabKey({ nodeUrl: NODE, threadId: "t-bo" }))).toBe(
			"req-1"
		);
		expect(liveOf("t-bo")?.permission?.ask.id).toBe("permission:req-1");
		await act(async () => second.unmount());
	});

	test("an answer on one node does not hide the same id on another", async () => {
		const second = createRoot(document.createElement("div"));
		await act(async () => root.render(<Tab running />));
		await act(async () =>
			second.render(<Tab nodeUrl="http://node-b" running />)
		);
		await answerOnScreen("t-ada");
		expect(
			shown.get(liveTabKey({ nodeUrl: "http://node-b", threadId: "t-ada" }))
		).toBe("req-1");
		expect(liveOf("t-ada", "http://node-b")?.permission?.ask.id).toBe(
			"permission:req-1"
		);
		await act(async () => second.unmount());
	});

	test("after the turn ends, a new turn's reused id is shown and published", async () => {
		await act(async () => root.render(<Tab running />));
		await answerOnScreen("t-ada");
		expect(shownPermission).toBeNull();
		// The turn ends; Core restarts and the next turn mints req-1 again.
		await act(async () => root.render(<Tab running={false} />));
		await act(async () =>
			root.render(<Tab promptIn={["m-1", "m-2"]} running />)
		);
		expect(shownPermission).toBe("req-1");
		expect(askInStore()?.id).toBe("permission:req-1");
	});

	test("the prompt answered in an ended turn never comes back", async () => {
		await act(async () => root.render(<Tab running />));
		await answerOnScreen("t-ada");
		await act(async () => root.render(<Tab running={false} />));
		// The next turn asks nothing: the old, answered prompt stays hidden.
		await act(async () => root.render(<Tab running />));
		expect(shownPermission).toBeNull();
		expect(askInStore()).toBeNull();
	});

	test("a tab still streaming the thread keeps the shared answer", async () => {
		const second = createRoot(document.createElement("div"));
		await act(async () => root.render(<Tab running />));
		await act(async () => second.render(<Tab running />));
		await answerOnScreen("t-ada");
		// The first tab's turn ends before the second tab's stream does.
		await act(async () => root.render(<Tab running={false} />));
		expect(shownPermission).toBeNull();
		expect(
			isPermissionAnswered(
				useInterfaceDetailStore.getState().answeredPermissions,
				{ nodeUrl: NODE, requestId: "req-1", threadId: "t-ada" }
			)
		).toBe(true);
		await act(async () => second.render(<Tab running={false} />));
		expect(
			isPermissionAnswered(
				useInterfaceDetailStore.getState().answeredPermissions,
				{ nodeUrl: NODE, requestId: "req-1", threadId: "t-ada" }
			)
		).toBe(false);
		await act(async () => second.unmount());
	});
});
