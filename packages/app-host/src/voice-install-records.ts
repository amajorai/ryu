import { z } from "zod";
import { jsonResponseDocumentSchema } from "./json-values.ts";

/** The host's managed TTS installer confirms these normalized fields.
 * Preserve the original response and any additive JSON metadata. */
const voiceEngineInstallFieldsSchema = z.object({
	already_installed: z.boolean(),
	engine: z.string(),
	installed: z.literal(true),
});
export const voiceEngineInstallRecordSchema = z.custom<
	z.output<typeof voiceEngineInstallFieldsSchema>
>(
	(value) =>
		jsonResponseDocumentSchema.safeParse(value).success &&
		voiceEngineInstallFieldsSchema.safeParse(value).success
);
export type VoiceEngineInstallRecord = z.output<
	typeof voiceEngineInstallRecordSchema
>;
