// Main-process client for Ryu Core's quests API (:7980).
//
// Core owns the quest brain (it watches Shadow context and judges whether a task
// is done); the island is a thin surface. This module confirms/rejects a detected
// completion and subscribes to Core's `GET /api/quests/events` SSE so the renderer
// can prompt "looks done — mark it?" when Core detects a finished task. Like the
// other Core clients here, every method degrades gracefully and never rejects.

import { z } from "zod";
import type { IslandQuestEvent, IslandQuestResult } from "../../shared/ipc.ts";
import { questEventSchema, questResponseSchema } from "./activity-contract.ts";
import { coreHeaders, loadConfig } from "./config.ts";
import { waitForReconnect } from "./reconnect-delay.ts";
import { withResponseDeadline } from "./response-deadline.ts";
import { readSseFrames, sseDataLines } from "./sse-reader.ts";

/** Reconnect delay for the quest event stream. */
const RECONNECT_DELAY_MS = 3000;
/** Timeout for one-shot accept/dismiss requests. */
const ACTION_TIMEOUT_MS = 10_000;

const failureSchema = z.instanceof(Error).catch(new Error("unreachable"));
function reasonFromError(error: z.infer<typeof failureSchema>): string {
	if (error instanceof Error) {
		return error.message;
	}
	return "unreachable";
}

/** POST a quest suggestion action (accept / dismiss). Never rejects. */
async function postQuestAction(
	id: string,
	path: string
): Promise<IslandQuestResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		return await withResponseDeadline<IslandQuestResult>(
			`${coreBaseUrl}/api/quests/${encodeURIComponent(id)}/${path}`,
			{ method: "POST", headers: coreHeaders() },
			ACTION_TIMEOUT_MS,
			async (resp) => {
				if (!resp.ok) {
					return { available: false, reason: `core responded ${resp.status}` };
				}
				const data = questResponseSchema.parse(await resp.json());
				if (!data.quest) {
					return { available: false, reason: "no quest returned" };
				}
				return { available: true, quest: data.quest };
			}
		);
	} catch (error) {
		return {
			available: false,
			reason: reasonFromError(failureSchema.parse(error)),
		};
	}
}

/** Confirm a detected completion via `POST /api/quests/:id/suggestion/accept`. */
export function acceptQuest(id: string): Promise<IslandQuestResult> {
	return postQuestAction(id, "suggestion/accept");
}

/** Reject the pending suggestion via `POST /api/quests/:id/suggestion/dismiss`. */
export function dismissQuest(id: string): Promise<IslandQuestResult> {
	return postQuestAction(id, "suggestion/dismiss");
}

/**
 * Subscribe to Core's quest-event SSE stream, invoking `onEvent` for each event.
 * Runs until `signal` aborts, auto-reconnecting on drop. Errors are swallowed
 * (the island degrades to no quest prompts when Core is down).
 */
export function subscribeQuestEvents(
	onEvent: (event: IslandQuestEvent) => void,
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
	onEvent: (event: IslandQuestEvent) => void,
	signal: AbortSignal
): Promise<void> {
	const { coreBaseUrl } = loadConfig();
	const resp = await fetch(`${coreBaseUrl}/api/quests/events`, {
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
				onEvent(questEventSchema.parse(JSON.parse(data)));
			} catch {
				// Ignore malformed frames; the next event self-heals the feed.
			}
		},
		signal
	);
}
