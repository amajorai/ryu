import { describe, expect, test } from "bun:test";
import {
	type GhostRecordingCaller,
	type GhostRecordingServices,
	type GhostRecordingSessions,
	gateGhostRecording,
	isReviewedRecordingOwner,
} from "./ghost-record-gate.ts";
import { dispatchRpc, type HostServices } from "./rpc.ts";

// The gate driven through the bridge dispatcher against a stand-in recorder.
// The stand-in keeps one fake session in memory and captures nothing: no node,
// no recorder process and no input hook is involved anywhere in this file.

const GRANTED = new Set(["ghost.record"] as const);
const STARTED = "2026-01-01T00:00:00Z";
const NODE = "http://node.test";

function standInRecorder() {
	const calls: string[] = [];
	let task: string | null = null;
	const services: GhostRecordingServices = {
		ghostRecordStart: (input) => {
			calls.push("start");
			task = input.task;
			return Promise.resolve({
				recording: true,
				started_at: STARTED,
				task: input.task,
			});
		},
		ghostRecordStatus: () => {
			calls.push("status");
			return Promise.resolve(
				task === null
					? { recording: false }
					: {
							recording: true,
							started_at: STARTED,
							status: { event_count: 3 },
							task,
						}
			);
		},
		ghostRecordStop: () => {
			calls.push("stop");
			if (task === null) {
				return Promise.reject(new Error("no active recording session to stop"));
			}
			const stopped = {
				event_count: 1,
				events: [{ event_type: "typeText", key: "stand-in text", ts_ms: 1 }],
				recording: false as const,
				started_at: STARTED,
				task,
			};
			task = null;
			return Promise.resolve(stopped);
		},
	};
	return { calls, services };
}

function caller(
	pluginId: string,
	compiledManifest: boolean,
	frame = "tab-1"
): GhostRecordingCaller {
	return { compiledManifest, frame, node: NODE, pluginId };
}

function host(
	who: GhostRecordingCaller,
	services: GhostRecordingServices,
	sessions: GhostRecordingSessions
): HostServices {
	return gateGhostRecording(who, services, sessions) as HostServices;
}

const start = (services: HostServices, task = "stand-in task") =>
	dispatchRpc("ghost.recordStart", [{ task }], GRANTED, services);
const status = (services: HostServices) =>
	dispatchRpc("ghost.recordStatus", [], GRANTED, services);
const stop = (services: HostServices) =>
	dispatchRpc("ghost.recordStop", [], GRANTED, services);

describe("ghost recording gate", () => {
	test("a third-party app holding ghost:record reaches no recording verb", async () => {
		const recorder = standInRecorder();
		const services = host(
			caller("@acme/x", false),
			recorder.services,
			new Map()
		);
		await expect(start(services)).rejects.toThrow("reviewed Workflows");
		await expect(status(services)).rejects.toThrow("reviewed Workflows");
		await expect(stop(services)).rejects.toThrow("reviewed Workflows");
		expect(recorder.calls).toEqual([]);
	});

	test("an installed app that only claims a reviewed id is refused", async () => {
		const recorder = standInRecorder();
		const sessions: GhostRecordingSessions = new Map();
		const copy = host(
			caller("@ryu/workflows", false),
			recorder.services,
			sessions
		);
		const otherCompiled = host(
			caller("@ryu/whiteboard", true),
			recorder.services,
			sessions
		);
		await expect(start(copy)).rejects.toThrow("reviewed Workflows");
		await expect(stop(copy)).rejects.toThrow("reviewed Workflows");
		await expect(start(otherCompiled)).rejects.toThrow("reviewed Workflows");
		expect(recorder.calls).toEqual([]);
	});

	test("reviewed ids match exactly and only with compiled provenance", () => {
		const reviewed = (pluginId: string, compiledManifest: boolean) =>
			isReviewedRecordingOwner({ compiledManifest, pluginId });
		expect(reviewed("@ryu/workflows", true)).toBe(true);
		expect(reviewed("@ryu/recipes", true)).toBe(true);
		expect(reviewed("@ryu/workflows", false)).toBe(false);
		expect(reviewed(" @RYU/Workflows ", true)).toBe(false);
		expect(reviewed("@ryu/workflows-evil", true)).toBe(false);
		expect(reviewed("@acme/workflows", true)).toBe(false);
	});

	test("the compiled Workflows app still records and reads its own result", async () => {
		const recorder = standInRecorder();
		const services = host(
			caller("@ryu/workflows", true),
			recorder.services,
			new Map()
		);
		expect(await start(services)).toMatchObject({
			recording: true,
			task: "stand-in task",
		});
		expect(await status(services)).toMatchObject({
			recording: true,
			status: { event_count: 3 },
			task: "stand-in task",
		});
		expect(await stop(services)).toMatchObject({
			events: [{ event_type: "typeText", key: "stand-in text" }],
			recording: false,
			task: "stand-in task",
		});
		expect(recorder.calls).toEqual(["start", "status", "stop"]);
	});

	test("a frame that did not start the recording learns only that the recorder is busy", async () => {
		const recorder = standInRecorder();
		const sessions: GhostRecordingSessions = new Map();
		const starter = host(
			caller("@ryu/workflows", true, "tab-1"),
			recorder.services,
			sessions
		);
		const other = host(
			caller("@ryu/workflows", true, "tab-2"),
			recorder.services,
			sessions
		);
		await start(starter, "private task");
		expect(await status(other)).toEqual({ recording: true });
		expect(await status(starter)).toMatchObject({ task: "private task" });
	});

	test("a frame that did not start the recording gets no events from stop", async () => {
		const recorder = standInRecorder();
		const sessions: GhostRecordingSessions = new Map();
		const starter = host(
			caller("@ryu/workflows", true, "tab-1"),
			recorder.services,
			sessions
		);
		const other = host(
			caller("@ryu/recipes", true, "tab-2"),
			recorder.services,
			sessions
		);
		await start(starter);
		const refusal = await stop(other).catch((error: unknown) => error);
		expect(refusal).toBeInstanceOf(Error);
		expect(String(refusal)).toContain("started somewhere else");
		expect(JSON.stringify(refusal)).not.toContain("stand-in text");
		// The capture itself ended, and its result reaches nobody.
		expect(await status(other)).toEqual({ recording: false });
		await expect(stop(starter)).rejects.toThrow("no active recording");
	});

	test("a recording started outside the host stays opaque to every frame", async () => {
		const recorder = standInRecorder();
		const services = host(
			caller("@ryu/workflows", true),
			recorder.services,
			new Map()
		);
		await recorder.services.ghostRecordStart?.({ task: "started elsewhere" });
		expect(await status(services)).toEqual({ recording: true });
		await expect(stop(services)).rejects.toThrow("started somewhere else");
		expect(await status(services)).toEqual({ recording: false });
	});

	test("a failed start leaves no session behind", async () => {
		const sessions: GhostRecordingSessions = new Map();
		const services = host(
			caller("@ryu/workflows", true),
			{
				ghostRecordStart: () => Promise.reject(new Error("recorder busy")),
			},
			sessions
		);
		await expect(start(services)).rejects.toThrow("recorder busy");
		expect(sessions.size).toBe(0);
		await expect(status(services)).rejects.toThrow("not available");
	});
});
