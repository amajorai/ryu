import { describe, expect, test } from "bun:test";
import type { RunSummary } from "@/src/hooks/useRuns.ts";
import type { RunStreamFrame } from "@/src/lib/api/runStream.ts";
import type { Conversation } from "@/types/chat.ts";
import { buildInterfaceSnapshot } from "./snapshot.ts";
import {
	EMPTY_RUN_LIVE_STATE,
	interfacePrivacy,
	type RunLiveState,
	reduceRunFrame,
	unreadCounts,
} from "./use-interface-live.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Realistic epoch ms: a seconds/ms mix-up fails loudly. */
const T = 1_760_000_000_000;

function run(id: string, status: string, updatedAt: number): RunSummary {
	return {
		agent_id: "coder",
		branch: null,
		created_at: T - 30 * 24 * HOUR,
		folder_path: null,
		id,
		message_count: 4,
		run_status: status,
		title: id,
		updated_at: updatedAt,
		worktree_path: null,
	};
}

const delta = (row: RunSummary): RunStreamFrame => ({ run: row, type: "run" });
const snapshotFrame = (...rows: RunSummary[]): RunStreamFrame => ({
	runs: rows,
	type: "snapshot",
});

function fold(frames: [RunStreamFrame, number][]): RunLiveState {
	let state = EMPTY_RUN_LIVE_STATE;
	for (const [frame, at] of frames) {
		state = reduceRunFrame(state, frame, at).state;
	}
	return state;
}

describe("reduceRunFrame", () => {
	test("a completed delta after running records the exact end time", () => {
		const state = fold([
			[delta(run("c", "running", T)), T + 100],
			[delta(run("c", "completed", T + 10 * MINUTE)), T + 10 * MINUTE + 300],
		]);
		expect(state.terminalSeen.get("c")).toMatchObject({
			approx: false,
			atMs: T + 10 * MINUTE,
		});
		expect(state.firstSeenRunning.has("c")).toBe(false);
	});

	test("snapshot frames and ids never seen running set no exact end", () => {
		const replay = fold([[snapshotFrame(run("c", "completed", T)), T + 5]]);
		expect(replay.terminalSeen.has("c")).toBe(false);
		const unseen = fold([[delta(run("c", "completed", T)), T + 5]]);
		expect(unseen.terminalSeen.has("c")).toBe(false);
		const reconnect = fold([
			[delta(run("c", "running", T)), T],
			[snapshotFrame(run("c", "completed", T + HOUR)), T + 2 * HOUR],
		]);
		expect(reconnect.terminalSeen.get("c")).toMatchObject({
			approx: true,
			atMs: T + 2 * HOUR,
		});
		expect(reconnect.firstSeenRunning.has("c")).toBe(false);
	});

	test("an interrupted delta records the receipt time, approximate", () => {
		const state = fold([
			[delta(run("c", "running", T)), T],
			[delta(run("c", "interrupted", T)), T + HOUR],
		]);
		expect(state.terminalSeen.get("c")).toMatchObject({
			approx: true,
			atMs: T + HOUR,
		});
	});

	test("a run that started and ended out of sight drops the old exact end", () => {
		const state = fold([
			[delta(run("c", "running", T)), T],
			[delta(run("c", "completed", T + 10 * MINUTE)), T + 10 * MINUTE],
			[snapshotFrame(run("c", "failed", T + 2 * HOUR)), T + 2 * HOUR + 5],
		]);
		expect(state.terminalSeen.has("c")).toBe(false);
		const replay = fold([
			[delta(run("c", "running", T)), T],
			[delta(run("c", "completed", T + 10 * MINUTE)), T + 10 * MINUTE],
			[snapshotFrame(run("c", "completed", T + 10 * MINUTE)), T + HOUR],
		]);
		expect(replay.terminalSeen.get("c")?.atMs).toBe(T + 10 * MINUTE);
	});

	test("each run gets its own first sighting; running again clears the end", () => {
		const state = fold([
			[delta(run("c", "running", T)), T],
			[delta(run("c", "completed", T + 10 * MINUTE)), T + 10 * MINUTE],
			[delta(run("c", "running", T + 3 * HOUR)), T + 3 * HOUR],
		]);
		expect(state.firstSeenRunning.get("c")).toBe(T + 3 * HOUR);
		expect(state.terminalSeen.has("c")).toBe(false);
	});

	test("reports a terminal transition so the host can refresh the list", () => {
		const first = reduceRunFrame(
			EMPTY_RUN_LIVE_STATE,
			delta(run("c", "running", T)),
			T
		);
		expect(first.terminal).toBe(false);
		expect(
			reduceRunFrame(first.state, delta(run("c", "failed", T + 1)), T + 1)
				.terminal
		).toBe(true);
	});

	test("awaiting_input keeps its first receipt time", () => {
		const state = fold([
			[delta(run("c", "awaiting_input", T)), T + 1],
			[delta(run("c", "awaiting_input", T + 5)), T + 9],
		]);
		expect(state.awaitingSince.get("c")).toBe(T + 1);
	});

	test("end to end: the second run's start, and no runStartedAt from created_at", () => {
		const state = fold([
			[delta(run("c", "running", T)), T],
			[delta(run("c", "completed", T + 10 * MINUTE)), T + 10 * MINUTE],
			[delta(run("c", "running", T + 3 * HOUR)), T + 3 * HOUR + 50],
		]);
		const conversation: Conversation = {
			agentId: "coder",
			createdAt: T - 30 * 24 * HOUR,
			id: "c",
			messages: [],
			runStatus: "completed",
			title: "Chat",
			updatedAt: T + 10 * MINUTE,
		};
		const snapshot = buildInterfaceSnapshot({
			agents: [],
			conversations: [conversation],
			live: {
				firstSeenRunning: state.firstSeenRunning,
				privacy: "full",
				runs: state.runs,
				terminalSeen: state.terminalSeen,
				unread: new Map(),
			},
			nowMs: T + 3 * HOUR + MINUTE,
			teams: [],
		});
		expect(snapshot.threads[0]).toMatchObject({
			runStartedApprox: true,
			runStartedAt: new Date(T + 3 * HOUR + 50).toISOString(),
			running: true,
		});
	});
});

describe("live inputs", () => {
	test("unread counts", () => {
		expect(
			unreadCounts(
				new Set(["a", "b"]),
				new Map([
					["a", 3],
					["c", 2],
				])
			)
		).toEqual(
			new Map([
				["a", 3],
				["b", 1],
				["c", 2],
			])
		);
	});

	test("privacy: streaming or the preference redacts; nothing else does", () => {
		expect(interfacePrivacy(false, false)).toBe("full");
		expect(interfacePrivacy(true, false)).toBe("redacted");
		expect(interfacePrivacy(false, true)).toBe("redacted");
	});
});
