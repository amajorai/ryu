// Main-process client for Ryu Core's meeting-notes API (:7980).
//
// Core owns the meeting brain; the island is a thin surface. This module starts a
// meeting, finalizes one, and subscribes to Core's `GET /api/meetings/stream` SSE
// so the renderer can prompt "start notes?" when Core auto-detects a meeting.
// Like the other Core clients here, every method degrades gracefully and never
// rejects to the caller.

import type {
	IslandMeeting,
	IslandMeetingEvent,
	IslandMeetingResult,
	IslandStartMeetingInput,
} from "../../shared/ipc.ts";
import { coreHeaders, loadConfig } from "./config.ts";

/** Reconnect delay for the meeting event stream. */
const RECONNECT_DELAY_MS = 3000;
/** Timeout for one-shot start/finalize requests. */
const ACTION_TIMEOUT_MS = 10_000;

function reasonFromError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return "unreachable";
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

/** Start a meeting via `POST /api/meetings`. Never rejects. */
export async function startMeeting(
	input: IslandStartMeetingInput
): Promise<IslandMeetingResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		const resp = await fetchWithTimeout(
			`${coreBaseUrl}/api/meetings`,
			{
				method: "POST",
				headers: coreHeaders({ "Content-Type": "application/json" }),
				body: JSON.stringify(input),
			},
			ACTION_TIMEOUT_MS
		);
		if (!resp.ok) {
			return { available: false, reason: `core responded ${resp.status}` };
		}
		const data = (await resp.json()) as { meeting?: IslandMeeting };
		if (!data.meeting) {
			return { available: false, reason: "no meeting returned" };
		}
		return { available: true, meeting: data.meeting };
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}

/** Finalize a meeting via `POST /api/meetings/:id/finalize`. Never rejects. */
export async function finalizeMeeting(
	id: string
): Promise<IslandMeetingResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		const resp = await fetchWithTimeout(
			`${coreBaseUrl}/api/meetings/${encodeURIComponent(id)}/finalize`,
			{ method: "POST", headers: coreHeaders() },
			ACTION_TIMEOUT_MS
		);
		if (!resp.ok) {
			return { available: false, reason: `core responded ${resp.status}` };
		}
		const data = (await resp.json()) as { meeting?: IslandMeeting };
		if (!data.meeting) {
			return { available: false, reason: "no meeting returned" };
		}
		return { available: true, meeting: data.meeting };
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}

/**
 * Subscribe to Core's meeting-event SSE stream, invoking `onEvent` for each
 * event. Runs until `signal` aborts, auto-reconnecting on drop. Errors are
 * swallowed (the island degrades to no auto-detection when Core is down).
 */
export function subscribeMeetingEvents(
	onEvent: (event: IslandMeetingEvent) => void,
	signal: AbortSignal
): void {
	const run = async (): Promise<void> => {
		while (!signal.aborted) {
			try {
				await pumpEventStream(onEvent, signal);
			} catch {
				// Transient failure — fall through to the reconnect delay.
			}
			if (signal.aborted) {
				return;
			}
			await new Promise<void>((resolve) =>
				setTimeout(resolve, RECONNECT_DELAY_MS)
			);
		}
	};
	run().catch(() => undefined);
}

const SSE_FRAME_SEPARATOR = "\n\n";
const DATA_PREFIX = "data:";

async function pumpEventStream(
	onEvent: (event: IslandMeetingEvent) => void,
	signal: AbortSignal
): Promise<void> {
	const { coreBaseUrl } = loadConfig();
	const resp = await fetch(`${coreBaseUrl}/api/meetings/stream`, {
		method: "GET",
		headers: coreHeaders(),
		signal,
	});
	if (!(resp.ok && resp.body)) {
		throw new Error(`core responded ${resp.status}`);
	}
	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			return;
		}
		buffer += decoder.decode(value, { stream: true });
		let sep = buffer.indexOf(SSE_FRAME_SEPARATOR);
		while (sep !== -1) {
			const frame = buffer.slice(0, sep);
			const data = frame
				.split("\n")
				.filter((line) => line.startsWith(DATA_PREFIX))
				.map((line) => line.slice(DATA_PREFIX.length).trim())
				.join("\n");
			if (data) {
				try {
					onEvent(JSON.parse(data) as IslandMeetingEvent);
				} catch {
					// Ignore malformed frames; the next event self-heals the feed.
				}
			}
			buffer = buffer.slice(sep + SSE_FRAME_SEPARATOR.length);
			sep = buffer.indexOf(SSE_FRAME_SEPARATOR);
		}
	}
}
