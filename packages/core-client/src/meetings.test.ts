// packages/core-client/src/meetings.test.ts
//
// Tests for the meeting-notes client. Two halves:
//   1. Error-envelope CRUD: getMeeting/startMeeting/finalizeMeeting/renameMeeting
//      all throw when the `meeting` field is absent (server error surfaced), and
//      return it otherwise; list/transcript/detection-config apply `?? default`.
//   2. streamMeetingEvents — a fetch + ReadableStream SSE reader. Unlike
//      downloads/delegation it has NO post-loop flush, so an UNTERMINATED trailing
//      frame (no closing "\n\n") is DROPPED. That is spec-compliant SSE (a block is
//      dispatched on the blank line; EOF discards a pending block), so it is pinned
//      as intended behavior, not flagged as a bug.

import { afterEach, describe, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import {
	deleteMeeting,
	finalizeMeeting,
	getDetectionConfig,
	getMeeting,
	getTranscript,
	listMeetings,
	type MeetingEvent,
	renameMeeting,
	setDetectionConfig,
	startMeeting,
	streamMeetingEvents,
} from "./meetings.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const target: ApiTarget = { url: "http://127.0.0.1:7980", token: "t" };

interface Captured {
	init?: RequestInit;
	url?: string;
}

function stub(bodyText: string, status = 200): Captured {
	const cap: Captured = {};
	globalThis.fetch = ((url: string, init: RequestInit) => {
		cap.url = url;
		cap.init = init;
		return Promise.resolve(new Response(bodyText, { status }));
	}) as typeof fetch;
	return cap;
}

function streamOnce(chunks: string[], init?: ResponseInit): void {
	const encoder = new TextEncoder();
	globalThis.fetch = (() =>
		Promise.resolve(
			new Response(
				new ReadableStream<Uint8Array>({
					start(c) {
						for (const chunk of chunks) {
							c.enqueue(encoder.encode(chunk));
						}
						c.close();
					},
				}),
				init
			)
		)) as typeof fetch;
}

async function collect(chunks: string[]): Promise<MeetingEvent[]> {
	streamOnce(chunks);
	const seen: MeetingEvent[] = [];
	await streamMeetingEvents(target, (e) => seen.push(e));
	return seen;
}

const meeting = { id: "m1", title: "Sync" };

describe("listMeetings", () => {
	test("returns the meetings array", async () => {
		stub(JSON.stringify({ meetings: [meeting] }));
		expect(await listMeetings(target)).toEqual([meeting]);
	});

	test("falls back to [] when absent", async () => {
		stub("{}");
		expect(await listMeetings(target)).toEqual([]);
	});
});

describe("single-meeting endpoints throw on an absent meeting", () => {
	test("getMeeting returns the meeting when present", async () => {
		const cap = stub(JSON.stringify({ meeting }));
		expect(await getMeeting(target, "m1")).toEqual(meeting);
		expect(cap.url).toBe("http://127.0.0.1:7980/api/meetings/m1");
	});

	test("getMeeting throws the server error when meeting is absent", async () => {
		stub(JSON.stringify({ error: "gone" }));
		await expect(getMeeting(target, "m1")).rejects.toThrow("gone");
	});

	test("getMeeting throws a default when neither field is present", async () => {
		stub("{}");
		await expect(getMeeting(target, "m1")).rejects.toThrow(
			"meeting not found"
		);
	});

	test("startMeeting POSTs the input and returns the meeting", async () => {
		const cap = stub(JSON.stringify({ meeting }));
		await startMeeting(target, { title: "Sync", source: "manual" });
		expect(cap.init?.method).toBe("POST");
		expect(JSON.parse(cap.init?.body as string)).toEqual({
			title: "Sync",
			source: "manual",
		});
	});

	test("startMeeting throws when the meeting is absent", async () => {
		stub(JSON.stringify({ error: "busy" }));
		await expect(startMeeting(target)).rejects.toThrow("busy");
	});

	test("finalizeMeeting hits the finalize path and throws on absence", async () => {
		const cap = stub(JSON.stringify({ meeting }));
		await finalizeMeeting(target, "m1");
		expect(cap.url).toBe("http://127.0.0.1:7980/api/meetings/m1/finalize");
		stub("{}");
		await expect(finalizeMeeting(target, "m1")).rejects.toThrow(
			"failed to finalize meeting"
		);
	});

	test("renameMeeting POSTs the title and throws on absence", async () => {
		const cap = stub(JSON.stringify({ meeting }));
		await renameMeeting(target, "m1", "New");
		expect(cap.url).toBe("http://127.0.0.1:7980/api/meetings/m1/title");
		expect(JSON.parse(cap.init?.body as string)).toEqual({ title: "New" });
		stub(JSON.stringify({ error: "locked" }));
		await expect(renameMeeting(target, "m1", "New")).rejects.toThrow("locked");
	});
});

describe("deleteMeeting / transcript / detection-config", () => {
	test("deleteMeeting issues a DELETE", async () => {
		const cap = stub("");
		await deleteMeeting(target, "m1");
		expect(cap.init?.method).toBe("DELETE");
		expect(cap.url).toBe("http://127.0.0.1:7980/api/meetings/m1");
	});

	test("getTranscript defaults segments + text when absent", async () => {
		stub("{}");
		expect(await getTranscript(target, "m1")).toEqual({
			segments: [],
			text: "",
		});
	});

	test("getDetectionConfig defaults enabled=true and apps=[]", async () => {
		stub("{}");
		expect(await getDetectionConfig(target)).toEqual({
			enabled: true,
			apps: [],
		});
	});

	test("getDetectionConfig honors an explicit disabled config", async () => {
		stub(JSON.stringify({ enabled: false, apps: ["Zoom"] }));
		expect(await getDetectionConfig(target)).toEqual({
			enabled: false,
			apps: ["Zoom"],
		});
	});

	test("setDetectionConfig PUTs the partial config", async () => {
		const cap = stub("");
		await setDetectionConfig(target, { enabled: false });
		expect(cap.init?.method).toBe("PUT");
		expect(JSON.parse(cap.init?.body as string)).toEqual({ enabled: false });
	});
});

describe("streamMeetingEvents — SSE parsing", () => {
	test("parses each meeting event type in order", async () => {
		const seen = await collect([
			'data: {"type":"detected","app":"Zoom","title":"T","detected_at":"now"}\n\n',
			'data: {"type":"status","meeting_id":"m1","status":"recording"}\n\n',
		]);
		expect(seen.map((e) => e.type)).toEqual(["detected", "status"]);
	});

	test("stitches a payload split across two reader chunks", async () => {
		const seen = await collect([
			'data: {"type":"sta',
			'tus","meeting_id":"m1","status":"done"}\n\n',
		]);
		expect(seen).toEqual([
			{ type: "status", meeting_id: "m1", status: "done" },
		]);
	});

	test("skips a malformed frame and continues", async () => {
		const seen = await collect([
			"data: {bad\n\n",
			'data: {"type":"status","meeting_id":"m1","status":"done"}\n\n',
		]);
		expect(seen).toEqual([
			{ type: "status", meeting_id: "m1", status: "done" },
		]);
	});

	test("DROPS an unterminated trailing frame (no post-loop flush)", async () => {
		// Spec-compliant SSE: a block without its terminating blank line is pending
		// at EOF and discarded — meetings has no trailing flush, unlike downloads.
		const seen = await collect([
			'data: {"type":"status","meeting_id":"m1","status":"recording"}\n\n',
			'data: {"type":"status","meeting_id":"m1","status":"done"}',
		]);
		expect(seen).toEqual([
			{ type: "status", meeting_id: "m1", status: "recording" },
		]);
	});

	test("throws with the status on a non-2xx connect", async () => {
		streamOnce([], { status: 502 });
		await expect(
			streamMeetingEvents(target, () => {
				// no-op
			})
		).rejects.toThrow("meeting stream failed: 502");
	});
});
