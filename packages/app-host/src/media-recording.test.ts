import { expect, test } from "bun:test";
import { parseMediaRecordingInput } from "./media-recording.ts";
import type { RouteClaim } from "./rpc.ts";
import { capabilitiesFromGrants, dispatchRpc } from "./rpc.ts";

test("microphone action parser rejects path traversal and extra authority", () => {
	expect(
		parseMediaRecordingInput({ action: "read", id: "../../audio" })
	).toBeNull();
	expect(
		parseMediaRecordingInput({ action: "start", owner: "another-app" })
	).toBeNull();
	expect(parseMediaRecordingInput({ action: "discard" })).toBeNull();
	expect(
		parseMediaRecordingInput({ action: "stop", id: "recording-1" })
	).toEqual({ action: "stop", id: "recording-1" });
});
test("microphone action parser returns canonical actions and preserves rewind bounds", () => {
	for (const action of ["status", "start"] as const) {
		expect(
			parseMediaRecordingInput({ action, id: undefined, seconds: undefined })
		).toEqual({ action });
	}
	for (const action of ["ack", "stop", "read", "discard"] as const) {
		expect(
			parseMediaRecordingInput({
				action,
				id: "recording-1",
				seconds: undefined,
			})
		).toEqual({ action, id: "recording-1" });
	}
	for (const seconds of [15, 300] as const) {
		expect(
			parseMediaRecordingInput({ action: "rewind", id: "recording-1", seconds })
		).toEqual({ action: "rewind", id: "recording-1", seconds });
	}
	expect(
		parseMediaRecordingInput({
			action: "rewind",
			id: "recording-1",
			seconds: 16,
		})
	).toBeNull();
	expect(
		parseMediaRecordingInput({ action: "status", id: "recording-1" })
	).toBeNull();
	expect(
		parseMediaRecordingInput({ action: "read", id: "recording-1", seconds: 15 })
	).toBeNull();
});

test("recording requires its own approved grant before requesting the OS microphone", async () => {
	let calls = 0;
	const services = {
		listAgents: async () => [],
		mediaRecording: async () => {
			calls += 1;
			return {
				available: true,
				background: false,
				state: "recording" as const,
			};
		},
		registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
	};
	await expect(
		dispatchRpc(
			"media.recording",
			[{ action: "start" }],
			capabilitiesFromGrants(["media:transcribe"]),
			services
		)
	).rejects.toThrow();
	expect(calls).toBe(0);
	await dispatchRpc(
		"media.recording",
		[{ action: "start" }],
		capabilitiesFromGrants(["media:record"]),
		services
	);
	expect(calls).toBe(1);
});
test("missing capture implementation reports unavailable without claiming recording", async () => {
	expect(
		await dispatchRpc(
			"media.recording",
			[{ action: "status" }],
			capabilitiesFromGrants(["media:record"]),
			{
				listAgents: async () => [],
				registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
			}
		)
	).toMatchObject({ available: false, state: "idle" });
});
test("speech history rejects unbounded requests before touching Shadow", async () => {
	let called = false;
	const service = {
		listAgents: async () => [],
		registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
		timelineTranscripts: async () => {
			called = true;
			return { segments: [], nextOffset: null };
		},
	};
	await expect(
		dispatchRpc(
			"timeline.transcripts",
			[{ start: "2026-01-01T00:00:00Z", end: "2026-09-12T00:00:00Z" }],
			capabilitiesFromGrants(["timeline:speech"]),
			service
		)
	).rejects.toThrow();
	expect(called).toBe(false);
});
