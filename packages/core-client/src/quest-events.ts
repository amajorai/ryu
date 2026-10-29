import {
	QUEST_EVENT_NAMES,
	QUEST_EVENT_SURFACES,
	type QuestEventName,
	type QuestEventRequest,
	type QuestEventSurface,
} from "@ryuhq/protocol/quest-events";
import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";
import { type ApiTarget, request } from "./client.ts";

export type {
	QuestEventName,
	QuestEventRequest,
	QuestEventSurface,
} from "@ryuhq/protocol/quest-events";

export interface QuestEventResponse {
	accepted?: boolean;
	event: QuestEventName;
	ok: boolean;
	progress?: number | null;
	questKey?: string;
	referralId?: string | null;
	referralStatus?: string;
	status?: string;
	surface: QuestEventSurface;
}
// Complete controlled publisher footprint: result9 plus the route's ok flag.
// Native JSON serialization turns a non-finite legacy stored progress into null.
const questEventResponseFields = z.object({
	ok: z.boolean(),
	accepted: z.boolean(),
	event: z.enum(QUEST_EVENT_NAMES),
	surface: z.enum(QUEST_EVENT_SURFACES),
	progress: z.number().nullable().optional(),
	questKey: z.string().optional(),
	referralId: z.string().nullable().optional(),
	referralStatus: z.string().optional(),
	status: z.string().optional(),
});
export const questEventResponseSchema = z.custom<
	z.output<typeof questEventResponseFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		questEventResponseFields.safeParse(value).success
);

/**
 * Report a first-party waitlist event to the control plane.
 *
 * The caller must provide the Better Auth bearer, not a Core node token. The
 * endpoint is best-effort at the surface layer; a network failure should never
 * prevent the app from opening.
 */
export function recordQuestEvent(
	target: ApiTarget,
	event: QuestEventName,
	surface: QuestEventSurface
): Promise<QuestEventResponse> {
	const body: QuestEventRequest = { event, surface };
	return request(
		target,
		"/api/quests/events",
		{
			body,
			method: "POST",
		},
		questEventResponseSchema
	);
}
