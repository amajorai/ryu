// Main-process client for Ryu Core's meeting-notes API (:7980).
//
// Core owns the meeting brain; the island is a thin surface. This module starts a
// meeting, finalizes one, and subscribes to Core's `GET /api/meetings/stream` SSE
// so the renderer can prompt "start notes?" when Core auto-detects a meeting.
// Like the other Core clients here, every method degrades gracefully and never
// rejects to the caller.

import { z } from "zod";
import type {
	IslandMeetingEvent,
	IslandMeetingResult,
	IslandStartMeetingInput,
} from "../../shared/ipc.ts";
import {
	meetingEventSchema,
	meetingResponseSchema,
} from "./activity-contract.ts";
import { coreHeaders, loadConfig } from "./config.ts";
import { waitForReconnect } from "./reconnect-delay.ts";
import { withResponseDeadline } from "./response-deadline.ts";
import { readSseFrames, sseDataLines } from "./sse-reader.ts";

/** Reconnect delay for the meeting event stream. */
const RECONNECT_DELAY_MS = 3000;
/** Timeout for one-shot start/finalize requests. */
const ACTION_TIMEOUT_MS = 10_000;

const failureSchema = z.instanceof(Error).catch(new Error("unreachable"));
function reasonFromError(error: z.infer<typeof failureSchema>): string {
	if (error instanceof Error) {
		return error.message;
	}
	return "unreachable";
}

/** Start a meeting via `POST /api/meetings`. Never rejects. */
export async function startMeeting(
	input: IslandStartMeetingInput
): Promise<IslandMeetingResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		return await withResponseDeadline<IslandMeetingResult>(
			`${coreBaseUrl}/api/meetings`,
			{
				method: "POST",
				headers: coreHeaders({ "Content-Type": "application/json" }),
				body: JSON.stringify(input),
			},
			ACTION_TIMEOUT_MS,
			async (resp) => {
				if (!resp.ok) {
					return { available: false, reason: `core responded ${resp.status}` };
				}
				const data = meetingResponseSchema.parse(await resp.json());
				if (!data.meeting) {
					return { available: false, reason: "no meeting returned" };
				}
				return { available: true, meeting: data.meeting };
			}
		);
	} catch (error) {
		return {
			available: false,
			reason: reasonFromError(failureSchema.parse(error)),
		};
	}
}

/** Finalize a meeting via `POST /api/meetings/:id/finalize`. Never rejects. */
export async function finalizeMeeting(
	id: string
): Promise<IslandMeetingResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		return await withResponseDeadline<IslandMeetingResult>(
			`${coreBaseUrl}/api/meetings/${encodeURIComponent(id)}/finalize`,
			{ method: "POST", headers: coreHeaders() },
			ACTION_TIMEOUT_MS,
			async (resp) => {
				if (!resp.ok) {
					return { available: false, reason: `core responded ${resp.status}` };
				}
				const data = meetingResponseSchema.parse(await resp.json());
				if (!data.meeting) {
					return { available: false, reason: "no meeting returned" };
				}
				return { available: true, meeting: data.meeting };
			}
		);
	} catch (error) {
		return {
			available: false,
			reason: reasonFromError(failureSchema.parse(error)),
		};
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
			await waitForReconnect(signal, RECONNECT_DELAY_MS);
		}
	};
	run().catch(() => undefined);
}

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
		await resp.body?.cancel();
		throw new Error(`core responded ${resp.status}`);
	}
	await readSseFrames(
		resp.body,
		(frame) => {
			const data = sseDataLines(frame).join("\n");
			if (!data) {
				return;
			}
			try {
				onEvent(meetingEventSchema.parse(JSON.parse(data)));
			} catch {
				// Ignore malformed frames; the next event self-heals the feed.
			}
		},
		signal
	);
}
