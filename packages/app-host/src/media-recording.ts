import { z } from "zod";

/** Host-owned microphone capture. The app sees opaque IDs, never device file paths. */
export type MediaRecordingInput =
	| { action: "status" }
	| { action: "start" }
	| { action: "rewind"; id: string; seconds: 15 | 300 }
	| { action: "stop" | "read" | "discard" | "ack"; id: string };

export interface MediaRecordingResult {
	audio?: string;
	available: boolean;
	background: boolean;
	chunkId?: string;
	chunkStartedAt?: string;
	continuous?: boolean;
	durationMs?: number;
	filename?: string;
	id?: string;
	message?: string;
	pendingChunks?: number;
	startedAt?: string;
	state: "idle" | "recording" | "pending";
}

const recordingIdSchema = z.string().regex(/^[a-zA-Z0-9-]{1,80}$/);

const mediaRecordingInputSchema = z.union([
	z
		.strictObject({
			action: z.enum(["status", "start"]),
			id: z.undefined().optional(),
			seconds: z.undefined().optional(),
		})
		.transform(({ action }) => ({ action })),
	z.strictObject({
		action: z.literal("rewind"),
		id: recordingIdSchema,
		seconds: z.union([z.literal(15), z.literal(300)]),
	}),
	z
		.strictObject({
			action: z.enum(["ack", "stop", "read", "discard"]),
			id: recordingIdSchema,
			seconds: z.undefined().optional(),
		})
		.transform(({ action, id }) => ({ action, id })),
]);

// Keep the bridge's nullable decoding API while the schema owns raw input.
const mediaRecordingBoundarySchema = z
	.unknown()
	.transform((value): MediaRecordingInput | null => {
		const parsed = mediaRecordingInputSchema.safeParse(value);
		return parsed.success ? parsed.data : null;
	});

export const parseMediaRecordingInput = mediaRecordingBoundarySchema.parse;

export type MediaRecordingService = (
	input: MediaRecordingInput
) => Promise<MediaRecordingResult>;
