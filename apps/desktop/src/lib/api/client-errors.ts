import { z } from "zod";

/** Only safe message/code strings are projected from the Core error envelope. */
const structuredErrorSchema = z.object({
	message: z.string().optional().catch(undefined),
	code: z.string().optional().catch(undefined),
});
const errorEnvelopeSchema = z.object({
	// A control-plane refusal Core passes through: `{ code, error: "text" }`.
	code: z.string().optional().catch(undefined),
	error: z.union([
		z.string(),
		structuredErrorSchema,
		// Legacy malformed object errors still produce an empty structured projection.
		z
			.array(z.json())
			.transform(() => ({ message: undefined, code: undefined })),
	]),
});
export interface ApiErrorDetails {
	code?: string;
	message?: string;
}

/** Decode both legacy string errors and the structured Core error contract. */
export function parseApiErrorBody(text: string): ApiErrorDetails {
	if (!text) {
		return {};
	}
	try {
		const envelope = errorEnvelopeSchema.safeParse(JSON.parse(text));
		if (!envelope.success) {
			return {};
		}
		const { code } = envelope.data;
		const message = z.string().safeParse(envelope.data.error);
		if (message.success) {
			return code ? { code, message: message.data } : { message: message.data };
		}
		const error = structuredErrorSchema.parse(envelope.data.error);
		return { message: error.message, code: error.code ?? code };
	} catch {
		return {};
	}
}
