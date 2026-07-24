// apps/desktop/src/store/useDownloadsStore.test.ts
//
// Tests for the client mirror of Core's download center and the pure selectors
// every install surface reads through. The selectors are the load-bearing part:
// `selectAggregate` drives the desktop download pill (running count + overall
// percent), and `selectInstallProgress` matches a catalog button to its live
// download by artifact kind + a name hint. Both have real edge cases (mixed
// terminal/active states, clamping, name-match precedence, sole-candidate
// fallback) that a wrong refactor would silently break.
//
// The store transitively reaches `lib/api/client.ts` -> `lib/auth-client.ts` ->
// `@ryu/settings` -> `@ryu/ui`, whose extensionless component export bare
// `bun test` can't resolve. Stub exactly those two leaf boundaries (nothing
// under test calls either) and load the store dynamically afterwards, mirroring
// the pattern in `useNodeStore.test.ts`.

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type {
	DownloadKind,
	DownloadState,
	DownloadTask,
} from "@/src/lib/api/downloads.ts";

mock.module("@/lib/auth-client.ts", () => ({
	TOKEN_KEY: "ryu_session_token",
	getToken: () => null,
}));
mock.module("@/src/lib/realtime/jwt.ts", () => ({
	getRealtimeJwt: () => null,
}));

const {
	useDownloadsStore,
	selectAggregate,
	selectInstallProgress,
	selectOrderedTasks,
} = await import("./useDownloadsStore.ts");

// A DownloadTask with sane defaults; override only what a case cares about.
function task(over: Partial<DownloadTask> & { id: string }): DownloadTask {
	return {
		created_at: 0,
		dest_path: null,
		error: null,
		kind: "model" as DownloadKind,
		label: "",
		received_bytes: 0,
		retryable: false,
		speed_bps: null,
		state: "active" as DownloadState,
		total_bytes: null,
		updated_at: 0,
		url: null,
		...over,
	};
}

function stateFrom(tasks: DownloadTask[]) {
	return { tasks: Object.fromEntries(tasks.map((t) => [t.id, t])) };
}

beforeEach(() => {
	useDownloadsStore.setState({ tasks: {} });
});

describe("store mutations", () => {
	test("applySnapshot replaces the whole set, keyed by id", () => {
		useDownloadsStore
			.getState()
			.applySnapshot([task({ id: "a" }), task({ id: "b" })]);
		expect(Object.keys(useDownloadsStore.getState().tasks).sort()).toEqual([
			"a",
			"b",
		]);
		// A second snapshot fully replaces, it does not merge.
		useDownloadsStore.getState().applySnapshot([task({ id: "c" })]);
		expect(Object.keys(useDownloadsStore.getState().tasks)).toEqual(["c"]);
	});

	test("applyUpdate upserts one task without disturbing the others", () => {
		useDownloadsStore.getState().applySnapshot([task({ id: "a", label: "x" })]);
		useDownloadsStore.getState().applyUpdate(task({ id: "b", label: "y" }));
		useDownloadsStore.getState().applyUpdate(task({ id: "a", label: "x2" }));
		const { tasks } = useDownloadsStore.getState();
		expect(tasks.a.label).toBe("x2");
		expect(tasks.b.label).toBe("y");
	});

	test("removeTask drops only its id; reset clears everything", () => {
		useDownloadsStore
			.getState()
			.applySnapshot([task({ id: "a" }), task({ id: "b" })]);
		useDownloadsStore.getState().removeTask("a");
		expect(Object.keys(useDownloadsStore.getState().tasks)).toEqual(["b"]);
		useDownloadsStore.getState().reset();
		expect(useDownloadsStore.getState().tasks).toEqual({});
	});

	test("removeTask on an unknown id is a no-op", () => {
		useDownloadsStore.getState().applySnapshot([task({ id: "a" })]);
		useDownloadsStore.getState().removeTask("missing");
		expect(Object.keys(useDownloadsStore.getState().tasks)).toEqual(["a"]);
	});
});

describe("selectOrderedTasks", () => {
	test("orders newest-first by created_at", () => {
		const s = stateFrom([
			task({ id: "old", created_at: 100 }),
			task({ id: "new", created_at: 300 }),
			task({ id: "mid", created_at: 200 }),
		]);
		expect(selectOrderedTasks(s as never).map((t) => t.id)).toEqual([
			"new",
			"mid",
			"old",
		]);
	});

	test("empty store yields an empty list", () => {
		expect(selectOrderedTasks(stateFrom([]) as never)).toEqual([]);
	});
});

describe("selectAggregate", () => {
	test("empty: hasAny false, no in-flight, null percent", () => {
		expect(selectAggregate(stateFrom([]) as never)).toEqual({
			inFlight: 0,
			failed: 0,
			percent: null,
			hasAny: false,
		});
	});

	test("counts in-flight (queued/active/verifying) and failed separately", () => {
		const s = stateFrom([
			task({ id: "q", state: "queued" }),
			task({ id: "a", state: "active" }),
			task({ id: "v", state: "verifying" }),
			task({ id: "p", state: "paused" }), // not in-flight
			task({ id: "f", state: "failed" }),
			task({ id: "c", state: "completed" }),
		]);
		const agg = selectAggregate(s as never);
		expect(agg.inFlight).toBe(3);
		expect(agg.failed).toBe(1);
		expect(agg.hasAny).toBe(true);
	});

	test("percent aggregates only sized tasks in active states, paused included", () => {
		const s = stateFrom([
			task({
				id: "a",
				state: "active",
				received_bytes: 25,
				total_bytes: 100,
			}),
			// paused is an ACTIVE_STATE for the percent bucket even though it is
			// not counted as in-flight.
			task({
				id: "p",
				state: "paused",
				received_bytes: 25,
				total_bytes: 100,
			}),
			// completed is excluded from the percent bucket entirely.
			task({
				id: "done",
				state: "completed",
				received_bytes: 999,
				total_bytes: 999,
			}),
		]);
		// (25 + 25) / (100 + 100) = 25%
		expect(selectAggregate(s as never).percent).toBe(25);
	});

	test("percent is null when no in-flight task has a known size", () => {
		const s = stateFrom([
			task({ id: "a", state: "active", total_bytes: null }),
		]);
		expect(selectAggregate(s as never).percent).toBeNull();
	});

	test("received is clamped to total so overshoot can't exceed 100%", () => {
		const s = stateFrom([
			task({
				id: "a",
				state: "active",
				received_bytes: 250,
				total_bytes: 100,
			}),
		]);
		expect(selectAggregate(s as never).percent).toBe(100);
	});
});

describe("selectInstallProgress", () => {
	test("inactive when no task of the wanted kind is trackable", () => {
		const s = stateFrom([
			task({ id: "a", kind: "model", state: "completed", label: "gemma" }),
		]);
		const sel = selectInstallProgress(["model"], "gemma");
		expect(sel(s as never)).toEqual({ active: false, percent: null });
	});

	test("matches by normalized name so 'whispercpp' finds a 'whisper.cpp' label", () => {
		const s = stateFrom([
			task({ id: "a", kind: "engine", state: "active", label: "whisper.cpp" }),
			task({ id: "b", kind: "engine", state: "active", label: "llama.cpp" }),
		]);
		const sel = selectInstallProgress(["engine"], "whispercpp");
		expect(sel(s as never).active).toBe(true);
	});

	test("falls back to the sole trackable task of the kind when no name matches", () => {
		const s = stateFrom([
			task({
				id: "a",
				kind: "model",
				state: "active",
				label: "unrelated",
				received_bytes: 30,
				total_bytes: 60,
			}),
		]);
		const sel = selectInstallProgress(["model"], "nomatch");
		expect(sel(s as never)).toEqual({ active: true, percent: 50 });
	});

	test("does NOT fall back when several tasks of the kind and none match by name", () => {
		const s = stateFrom([
			task({ id: "a", kind: "model", state: "active", label: "one" }),
			task({ id: "b", kind: "model", state: "active", label: "two" }),
		]);
		const sel = selectInstallProgress(["model"], "zzz");
		expect(sel(s as never)).toEqual({ active: false, percent: null });
	});

	test("paused counts as trackable; an unknown size gives an indeterminate (null) percent", () => {
		const s = stateFrom([
			task({
				id: "a",
				kind: "model",
				state: "paused",
				label: "gemma",
				total_bytes: null,
			}),
		]);
		const sel = selectInstallProgress(["model"], "gemma");
		expect(sel(s as never)).toEqual({ active: true, percent: null });
	});

	test("percent clamps to 100 on overshoot", () => {
		const s = stateFrom([
			task({
				id: "a",
				kind: "model",
				state: "active",
				label: "gemma",
				received_bytes: 200,
				total_bytes: 100,
			}),
		]);
		const sel = selectInstallProgress(["model"], "gemma");
		expect(sel(s as never).percent).toBe(100);
	});

	test("respects the kind filter", () => {
		const s = stateFrom([
			task({ id: "a", kind: "skill", state: "active", label: "gemma" }),
		]);
		// Same label, wrong kind → nothing matches.
		expect(selectInstallProgress(["model"], "gemma")(s as never)).toEqual({
			active: false,
			percent: null,
		});
		// Right kind → matches.
		expect(selectInstallProgress(["skill"], "gemma")(s as never).active).toBe(
			true
		);
	});
});
