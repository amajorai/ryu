import { type UIMessageChunk, uiMessageChunkSchema } from "ai";
import { z } from "zod";
import type { CoreStreamPartEvent } from "../../shared/ipc.ts";

export const commandStreamPartSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("text-delta"), delta: z.string() }),
	z.object({ type: z.literal("error"), errorText: z.string() }),
]);

/** Validate IPC chunks with the SDK's own contract, in their original order. */
export function validateCoreUiChunkStream(
	stream: ReadableStream<CoreStreamPartEvent["part"]>
): ReadableStream<UIMessageChunk> {
	return stream.pipeThrough(
		new TransformStream<CoreStreamPartEvent["part"], UIMessageChunk>({
			async transform(part, controller) {
				const parsed = await uiMessageChunkSchema().validate?.(part);
				if (parsed === undefined) {
					throw new Error("The AI SDK chunk validator is unavailable.");
				}
				if (!parsed.success) {
					throw parsed.error;
				}
				controller.enqueue(parsed.value);
			},
		})
	);
}
