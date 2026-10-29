import { rpcJsonResponseSchema } from "@ryu/app-host/rpc";
import { z } from "zod";
import type { GeneratedVideo } from "./video.ts";

const videoStringFieldSchema = z.string().optional().catch(undefined);
const clipObjectInputSchema = z.object({
	url: videoStringFieldSchema,
	mediaType: videoStringFieldSchema,
	mime_type: videoStringFieldSchema,
	b64_json: videoStringFieldSchema,
	video: videoStringFieldSchema,
});
const clipEntrySchema = z
	.union([
		z.string().transform(
			(value): GeneratedVideo => ({
				url:
					value.startsWith("http") || value.startsWith("data:")
						? value
						: `data:video/mp4;base64,${value}`,
				mediaType: "video/mp4",
			})
		),
		clipObjectInputSchema.transform((value): GeneratedVideo | null => {
			if (value.url !== undefined) {
				return {
					url: value.url,
					mediaType: value.mediaType ?? value.mime_type ?? "video/mp4",
				};
			}
			const encoded = value.b64_json ?? value.video;
			return encoded
				? { url: `data:video/mp4;base64,${encoded}`, mediaType: "video/mp4" }
				: null;
		}),
	])
	.nullable()
	.catch(null);
export const videoClipsSchema = z
	.union([
		z.array(clipEntrySchema),
		clipObjectInputSchema
			.extend({
				data: z.array(clipEntrySchema).optional().catch(undefined),
				videos: z.array(clipEntrySchema).optional().catch(undefined),
			})
			.transform(
				(value) => value.data ?? value.videos ?? [clipEntrySchema.parse(value)]
			),
	])
	.transform((entries) => entries.flatMap((entry) => (entry ? [entry] : [])))
	.catch([]);

export const videoJobFieldsSchema = z
	.object({
		id: videoStringFieldSchema,
		status: videoStringFieldSchema,
		error: rpcJsonResponseSchema.optional(),
	})
	.catch({ id: undefined, status: undefined, error: undefined });
export const videoFailureSchema = z.object({
	error: rpcJsonResponseSchema.optional(),
});
