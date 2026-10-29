import {
	speechProcessingEngineSchema,
	ttsEngineSchema,
	ttsModelSchema,
} from "@ryuhq/core-client/voice.ts";
import { z } from "zod";
import { pluginDocumentSchema } from "./plugin-wire-values.ts";

/** Validate the complete SDK engine DTO while retaining additive server JSON. */
function voiceWireRecord<S extends z.ZodObject>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			pluginDocumentSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
const speechProcessingEngineWireSchema = voiceWireRecord(
	speechProcessingEngineSchema
);
const ttsEngineWireSchema = voiceWireRecord(ttsEngineSchema);
const ttsModelWireSchema = voiceWireRecord(ttsModelSchema);
export const speechProcessingEnginesWireSchema = voiceWireRecord(
	z.object({ data: z.array(speechProcessingEngineWireSchema).nullish() })
);
export const ttsEnginesWireSchema = voiceWireRecord(
	z.object({ data: z.array(ttsEngineWireSchema).nullish() })
);
export const ttsModelsWireSchema = voiceWireRecord(
	z.object({ data: z.array(ttsModelWireSchema).nullish() })
);
export const voiceErrorProjectionSchema = z.object({
	error: z.string().nullish(),
});
export const voiceEngineInstallErrorProjectionSchema = z.object({
	error: z.string().nullish(),
	detail: z.string().nullish(),
});
export const voiceTextProjectionSchema = z.object({
	text: z.string().nullish(),
});
export const transcriptionTextProjectionSchema = z.object({ text: z.string() });
export const voiceEngineInstallWireSchema = z.object({
	already_installed: z.boolean().nullish(),
	engine: z.string().nullish(),
	installed: z.boolean().nullish(),
});
