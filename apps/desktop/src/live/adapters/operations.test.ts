// apps/desktop/src/live/adapters/operations.test.ts
//
// The card an operation becomes in the Live section: its headline, its
// progress line, the mark for a run that continued after a node restart, and
// the rule that a finished operation leaves the dock, and that only the
// signed-in user's own operations get a card: the rule of the import dialog
// (`isOwnOperation`), plus the operations this app started in this window.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n";
import { formatMessage } from "@ryu/i18n/lite";
import { registerVaultOwnerSource } from "@/lib/session-owner.ts";
import type { Operation, OperationViewer } from "@/src/lib/api/operations.ts";

/** The session bearer the auth client holds, `null` when signed out. */
let bearer: string | null = null;

mock.module("@/lib/auth-client.ts", () => ({
	TOKEN_KEY: "ryu_session_token",
	getToken: () => null,
	getActiveToken: () => bearer,
}));
mock.module("@/src/lib/realtime/jwt.ts", () => ({
	getRealtimeJwt: () => null,
}));
// Only the mounting hook reads the node store. The functions under test take
// the node as an argument, so the node registry is not loaded here.
mock.module("@/src/store/useNodeStore.ts", () => ({
	useNodeStore: () => ({ token: null, url: "http://127.0.0.1:7980" }),
}));

const {
	operationFraction,
	operationProgressText,
	operationToActivity,
	reconcileOperationActivities,
	selectLiveOperations,
} = await import("./operations.ts");
const { useLiveActivityStore } = await import(
	"@/src/store/useLiveActivityStore.ts"
);

/** The app's real ICU formatter in English, which is what `tl` gives there. */
const tl: LiteralMessage = (source, values) =>
	formatMessage(source, values ?? {}, "en");

function operation(over: Partial<Operation> = {}): Operation {
	return {
		attempt: 1,
		cancelRequested: false,
		createdAt: "2026-11-18T10:00:00.000Z",
		id: "op_1",
		kind: "import.setup",
		progress: { done: 3, total: 12 },
		resumed: false,
		status: "running",
		title: ".claude",
		updatedAt: "2026-11-18T10:00:05.000Z",
		...over,
	};
}

let current: Operation;
beforeEach(() => {
	current = operation();
});

describe("the card of an operation", () => {
	test("a running import shows its folder and how far it is", () => {
		const card = operationToActivity(current, tl);
		expect(card.id).toBe("operation:op_1");
		expect(card.appId).toBe("shell");
		expect(card.kind).toBe("operation");
		expect(card.title).toBe("Importing .claude");
		expect(card.detail).toBe("3 of 12 items");
		expect(card.status).toBe("running");
		expect(card.progress).toBe(0.25);
		expect(card.startedAt).toBe(Date.parse("2026-11-18T10:00:00.000Z"));
		expect(card.updatedAt).toBe(Date.parse("2026-11-18T10:00:05.000Z"));
	});

	test("a queued operation waits and says so", () => {
		const card = operationToActivity(operation({ status: "queued" }), tl);
		expect(card.status).toBe("waiting");
		expect(card.detail).toBe("Queued");
	});

	test("a run that continued after a restart is marked", () => {
		const card = operationToActivity(operation({ resumed: true }), tl);
		expect(card.detail).toBe("Resumed after restart · 3 of 12 items");
	});

	test("an operation of another kind keeps the title the node gave it", () => {
		const card = operationToActivity(
			operation({ kind: "data.move", title: "Move data folder" }),
			tl
		);
		expect(card.title).toBe("Move data folder");
	});

	test("a time that does not parse does not break the card", () => {
		const card = operationToActivity(operation({ createdAt: "soon" }), tl);
		expect(card.startedAt).toBe(0);
	});
});

describe("the progress line", () => {
	test("a requested stop wins over the count", () => {
		expect(
			operationProgressText(operation({ cancelRequested: true }), tl)
		).toBe("Stopping…");
	});

	test("without a total there is no count and no fraction", () => {
		const starting = operation({ progress: { done: 0, total: 0 } });
		expect(operationProgressText(starting, tl)).toBe("Starting…");
		expect(operationFraction(starting)).toBeUndefined();
	});

	test("the fraction never passes one", () => {
		expect(
			operationFraction(operation({ progress: { done: 9, total: 4 } }))
		).toBe(1);
	});
});

/** The mirror of the active node, as the Live section reads it. */
function mirror(list: Operation[], surfaces: Record<string, string[]> = {}) {
	return {
		operations: Object.fromEntries(list.map((o) => [o.id, o])),
		surfaces,
	};
}

describe("which operations get a card", () => {
	const ids = (list: Operation[]) => list.map((o) => o.id);
	/** The signed-in user "me", who presents that identity to the node. */
	const ME: OperationViewer = { presentsIdentity: true, userId: "me" };
	/** Signed out, with no delegation: the one operator of an unbound node. */
	const NOBODY: OperationViewer = { presentsIdentity: false, userId: null };
	/** The client sends an identity it cannot name (a placeholder account). */
	const UNNAMED: OperationViewer = { presentsIdentity: true, userId: null };

	test("the user's own running operations get a card, finished ones do not", () => {
		const s = mirror([
			operation({ id: "mine", ownerUserId: "me" }),
			operation({ id: "done", ownerUserId: "me", status: "succeeded" }),
		]);
		expect(ids(selectLiveOperations(s, ME))).toEqual(["mine"]);
	});

	test("another user's running operation gets no card", () => {
		const s = mirror([
			operation({ id: "mine", ownerUserId: "me" }),
			operation({ id: "theirs", ownerUserId: "someone-else" }),
		]);
		expect(ids(selectLiveOperations(s, ME))).toEqual(["mine"]);
		expect(ids(selectLiveOperations(s, NOBODY))).toEqual([]);
		expect(ids(selectLiveOperations(s, UNNAMED))).toEqual([]);
	});

	test("an ownerless operation gets a card only where the dialog would take it", () => {
		const s = mirror([operation({ id: "anonymous" })]);
		// A client that presents no identity starts ownerless operations itself.
		expect(ids(selectLiveOperations(s, NOBODY))).toEqual(["anonymous"]);
		// A client that presents an identity did not start it, named or not.
		expect(ids(selectLiveOperations(s, ME))).toEqual([]);
		expect(ids(selectLiveOperations(s, UNNAMED))).toEqual([]);
	});

	test("an operation this app started keeps its card whatever its owner says", () => {
		const s = mirror(
			[
				operation({ createdAt: "2026-11-18T09:00:00.000Z", id: "anonymous" }),
				operation({
					createdAt: "2026-11-18T08:00:00.000Z",
					id: "started-here",
					ownerUserId: "other-account",
				}),
			],
			{ "import-setup": ["started-here"] }
		);
		expect(ids(selectLiveOperations(s, ME))).toEqual(["started-here"]);
		expect(ids(selectLiveOperations(s, UNNAMED))).toEqual(["started-here"]);
		expect(ids(selectLiveOperations(s, NOBODY))).toEqual([
			"anonymous",
			"started-here",
		]);
	});
});

describe("the cards of the live session", () => {
	const LOCAL = { token: "node-token", url: "http://127.0.0.1:7980" };
	const MANAGED = {
		token: null,
		url: "https://node.example.com",
		userJwt: "delegation",
	};
	/** What the node lists to a caller it takes for its admin. */
	const LISTED = [
		operation({ id: "mine", ownerUserId: "user-a" }),
		operation({ id: "theirs", ownerUserId: "user-b" }),
		operation({ id: "anonymous" }),
	];

	let unregister: () => void = () => undefined;
	function session(userId: string | null, token: string | null) {
		unregister();
		unregister = registerVaultOwnerSource({
			accountCount: () => (token ? 1 : 0),
			verifiedActiveUserId: () => userId,
		});
		bearer = token;
	}
	/** Reconcile and give the ids of the operation cards, in a fixed order. */
	function cards(
		node: typeof LOCAL | typeof MANAGED,
		surfaces: Record<string, string[]> = {}
	) {
		reconcileOperationActivities(mirror(LISTED, surfaces), node, tl);
		return Object.keys(useLiveActivityStore.getState().activities).sort();
	}
	beforeEach(() => {
		useLiveActivityStore.getState().reset();
	});
	afterEach(() => {
		unregister();
		unregister = () => undefined;
		bearer = null;
		useLiveActivityStore.getState().reset();
	});

	test("a verified user gets a card for their own operation only", () => {
		session("user-a", "session-bearer");
		expect(cards(LOCAL)).toEqual(["operation:mine"]);
		expect(cards(MANAGED)).toEqual(["operation:mine"]);
	});

	test("a placeholder account gets no card, owned or ownerless", () => {
		// A bearer is live and the client mints the account JWT from it, but no
		// user id is verified.
		session(null, "session-bearer");
		expect(cards(LOCAL)).toEqual([]);
	});

	test("a delegation with no verified user gets no card either", () => {
		session(null, null);
		expect(cards(MANAGED)).toEqual([]);
	});

	test("signed out on a local node, the one operator sees the ownerless operation", () => {
		session(null, null);
		expect(cards(LOCAL)).toEqual(["operation:anonymous"]);
	});

	test("an operation started in this window keeps its card while the user cannot be named", () => {
		session(null, "session-bearer");
		expect(cards(LOCAL, { "import-setup": ["mine"] })).toEqual([
			"operation:mine",
		]);
	});
});
