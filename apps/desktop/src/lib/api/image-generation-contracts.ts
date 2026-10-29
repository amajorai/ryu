import type { RyuJsonValue } from "@ryu/app-host/rpc";
import { z } from "zod";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";

/** Complete request authored by this client; engine business validation stays in Core. */
export interface ImageGenerationInput {
	denoising_strength?: number;
	input_images?: string[];
	input_mask?: string;
	model?: string;
	n: number;
	prompt: string;
	provider?: string;
	provider_input?: Record<string, RyuJsonValue>;
	request_id?: string;
	size?: string;
}
const imageFieldsSchema = z.object({
	b64_json: z.string().nullable().optional(),
	media_type: z.string().nullable().optional(),
	url: z.string().nullable().optional(),
});
const generationFieldsSchema = z.object({
	data: z.array(imageFieldsSchema).nullable().optional(),
});
/** Core proxies native image JSON; validate consumed fields and retain all engine metadata. */
export const imageGenerationReplySchema = z.custom<
	z.output<typeof generationFieldsSchema>
>(
	(value) =>
		generationFieldsSchema.safeParse(value).success &&
		gatewayJsonValueSchema.safeParse(value).success
);
const RASTER_IMAGE_MEDIA_TYPE = /^image\/(?:png|jpeg|webp|gif|avif|bmp)$/;

/**
 * A renderable `data:` URL for one base64 image. Providers that report the
 * image's `media_type` (OpenRouter's Images API returns WebP or JPEG) keep it;
 * a missing or non-raster type falls back to PNG, the local engine's format.
 */
export function imageDataUrl(
	base64: string,
	mediaType: string | null | undefined
): string {
	const normalized = mediaType?.trim().toLowerCase() ?? "";
	const type = RASTER_IMAGE_MEDIA_TYPE.test(normalized)
		? normalized
		: "image/png";
	return `data:${type};base64,${base64}`;
}
export const imageGenerationErrorSchema = z.object({
	error: z.string().nullable().optional(),
});
export const imageReaderResultSchema = z.string();
