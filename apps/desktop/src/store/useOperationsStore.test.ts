// apps/desktop/src/store/useOperationsStore.test.ts
//
// Tests for the client mirror of Core's operations service and the selectors
// the import surfaces read through. What must hold: a dialog that is closed
// and opened again finds the operation it started, a snapshot taken before a
// start does not drop that operation, and a newer summary from the stream
// keeps the per-item results of the last full read.
//
// The store reaches `lib/api/client.ts` through the operations client. Stub
// the same two leaf modules as `useDownloadsStore.test.ts` and load the store
// afterwards.

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Operation, OperationViewer } from "@/src/lib/api/operations.ts";

mock.module("@/lib/auth-client.ts", () => ({
	TOKEN_KEY: "ryu_session_token",
	getToken: () => null,
	getActiveToken: () =>
		globalThis.localStorage?.getItem("ryu_session_token") ?? null,
}));
mock.module("@/src/lib/realtime/jwt.ts", () => ({
	getRealtimeJwt: () => null,
}));

const {
	mergeOperation,
	useOperationsStore,
	selectHasActiveOperation,
	selectOrderedOperations,
	selectSurfaceOperationIds,
} = await import("./useOperationsStore.ts");

function operation(over: Partial<Operation> & { id: string }): Operation {
	return {
		attempt: 1,
		cancelRequested: false,
		createdAt: "2026-11-18T10:00:00.000Z",
		kind: "import.setup",
		progress: { done: 0, total: 4 },
		resumed: false,
		status: "running",
		title: ".claude",
		updatedAt: "2026-11-18T10:00:00.000Z",
		...over,
	};
}

/** The signed-in user "me", who presents that identity to the active node. */
const ME: OperationViewer = { presentsIdentity: true, userId: "me" };

const store = () => useOperationsStore.getState();
const shown = (
	surface = "import-setup",
	adopter: OperationViewer | null = ME
) => selectSurfaceOperationIds(store(), surface, "import.setup", adopter);
const merged = (id: string) =>
	mergeOperation(store().operations[id], store().details[id]);

beforeEach(() => {
	store().reset();
});

describe("the mirror", () => {
	test("a snapshot replaces what was there and lists newest first", () => {
		store().applyUpdate(operation({ id: "old" }));
		store().applySnapshot([
			operation({ id: "a", createdAt: "2026-11-18T09:00:00.000Z" }),
			operation({ id: "b", createdAt: "2026-11-18T11:00:00.000Z" }),
		]);
		expect(selectOrderedOperations(store()).map((o) => o.id)).toEqual([
			"b",
			"a",
		]);
	});

	test("an older copy never replaces a newer one", () => {
		store().applyUpdate(
			operation({
				id: "a",
				progress: { done: 3, total: 4 },
				updatedAt: "2026-11-18T10:00:03.000Z",
			})
		);
		store().applyUpdate(
			operation({
				id: "a",
				progress: { done: 1, total: 4 },
				updatedAt: "2026-11-18T10:00:01.000Z",
			})
		);
		expect(store().operations.a?.progress.done).toBe(3);
	});

	test("a removal drops the operation, its full record and its surface", () => {
		const op = operation({ id: "a" });
		store().watch("import-setup", [op]);
		store().setDetail(op);
		store().removeOperation("a");
		expect(store().operations).toEqual({});
		expect(store().details).toEqual({});
		expect(store().surfaces).toEqual({});
	});

	test("active means queued or running", () => {
		expect(selectHasActiveOperation(store())).toBe(false);
		store().applyUpdate(operation({ id: "a", status: "succeeded" }));
		store().applyUpdate(operation({ id: "b", status: "interrupted" }));
		expect(selectHasActiveOperation(store())).toBe(false);
		store().applyUpdate(operation({ id: "c", status: "queued" }));
		expect(selectHasActiveOperation(store())).toBe(true);
	});
});

describe("a surface and its operation", () => {
	test("a surface finds the operation it started after it was closed", () => {
		store().watch("import-setup", [operation({ id: "a" })]);
		// The dialog unmounts here. Nothing in the store changes.
		store().applyUpdate(
			operation({
				id: "a",
				status: "succeeded",
				updatedAt: "2026-11-18T10:05:00.000Z",
			})
		);
		expect(shown()).toEqual(["a"]);
		expect(merged("a")?.status).toBe("succeeded");
	});

	test("a snapshot taken before the start keeps the watched operation", () => {
		store().watch("import-setup", [operation({ id: "fresh" })]);
		store().applySnapshot([operation({ id: "other", status: "succeeded" })]);
		expect(Object.keys(store().operations).sort()).toEqual(["fresh", "other"]);
	});

	test("without a watched operation a surface adopts the user's running one of its kind", () => {
		store().applySnapshot([
			operation({ id: "done", ownerUserId: "me", status: "succeeded" }),
			operation({ id: "backup", kind: "backup.archive", ownerUserId: "me" }),
			operation({ id: "import", ownerUserId: "me", status: "queued" }),
		]);
		expect(shown()).toEqual(["import"]);
	});

	test("a surface never adopts another user's running operation", () => {
		store().applySnapshot([
			operation({
				createdAt: "2026-11-18T09:00:00.000Z",
				id: "mine",
				ownerUserId: "me",
			}),
			operation({
				createdAt: "2026-11-18T11:00:00.000Z",
				id: "theirs",
				ownerUserId: "someone-else",
			}),
		]);
		// The newer one is someone else's: the surface takes its own.
		expect(shown()).toEqual(["mine"]);
		store().removeOperation("mine");
		expect(shown()).toEqual([]);
	});

	test("an ownerless operation is adopted only by a client that presents no identity", () => {
		store().applySnapshot([operation({ id: "anonymous" })]);
		expect(shown()).toEqual([]);
		expect(
			shown("import-setup", { presentsIdentity: false, userId: null })
		).toEqual(["anonymous"]);
	});

	test("a client that sends an identity it cannot name adopts nothing", () => {
		// A placeholder account or an unverified bearer: an identity goes to the
		// node, but no user id is verified.
		const unnamed: OperationViewer = { presentsIdentity: true, userId: null };
		store().applySnapshot([
			operation({ id: "anonymous" }),
			operation({ id: "owned", ownerUserId: "me" }),
		]);
		expect(shown("import-setup", unnamed)).toEqual([]);
	});

	test("a surface that does not talk to the active node adopts nothing", () => {
		store().applySnapshot([operation({ id: "mine", ownerUserId: "me" })]);
		expect(shown("onboarding-migration", null)).toEqual([]);
		// What it started itself it still shows.
		store().watch("onboarding-migration", [
			operation({ id: "started-here", ownerUserId: "me" }),
		]);
		expect(shown("onboarding-migration", null)).toEqual(["started-here"]);
	});

	test("a surface with nothing to show gets no operation", () => {
		store().applySnapshot([operation({ id: "done", status: "succeeded" })]);
		expect(shown()).toEqual([]);
		expect(mergeOperation(undefined, undefined)).toBeNull();
	});

	test("after unwatch the finished operation is no longer shown", () => {
		store().watch("import-setup", [
			operation({ id: "a", status: "succeeded" }),
		]);
		store().unwatch("import-setup");
		expect(shown()).toEqual([]);
		expect(store().operations.a?.id).toBe("a");
	});

	test("a surface that started several imports shows them in start order", () => {
		store().watch("onboarding-migration", [
			operation({ id: "first" }),
			operation({ id: "second", status: "queued" }),
		]);
		expect(shown("onboarding-migration")).toEqual(["first", "second"]);
		store().removeOperation("first");
		expect(shown("onboarding-migration")).toEqual(["second"]);
		store().removeOperation("second");
		expect(store().surfaces).toEqual({});
	});

	test("a newer summary keeps the results of the last full read", () => {
		const results = { results: [{ id: "x" }] };
		store().setDetail(
			operation({
				id: "a",
				cursor: results,
				updatedAt: "2026-11-18T10:00:01.000Z",
			})
		);
		store().applyUpdate(
			operation({
				id: "a",
				progress: { done: 2, total: 4 },
				updatedAt: "2026-11-18T10:00:02.000Z",
			})
		);
		expect(merged("a")?.progress.done).toBe(2);
		expect(merged("a")?.cursor).toEqual(results);
	});

	test("a full read that is as new as the summary is shown as it is", () => {
		const full = operation({
			id: "a",
			result: { results: [] },
			status: "succeeded",
			updatedAt: "2026-11-18T10:00:09.000Z",
		});
		store().setDetail(full);
		expect(merged("a")).toEqual(full);
	});

	test("a node switch clears operations, full records and surfaces", () => {
		const op = operation({ id: "a" });
		store().watch("import-setup", [op]);
		store().setDetail(op);
		store().reset();
		expect(store().operations).toEqual({});
		expect(store().details).toEqual({});
		expect(store().surfaces).toEqual({});
	});
});
