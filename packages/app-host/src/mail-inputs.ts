import { z } from "zod";
import {
	jsonResponseDocumentSchema,
	jsonResponseValueSchema,
} from "./json-values.ts";

/** Validate endpoint-owned fields without cloning attachments or additive Core metadata. */
function preserveMailInput<S extends z.ZodType>(schema: S) {
	return z.custom<z.output<S>>((value) => schema.safeParse(value).success);
}
export const mailCreateInputSchema = preserveMailInput(
	z.object({
		address: z.string(),
		name: z.string(),
		clientId: z.string().optional(),
		metadata: jsonResponseDocumentSchema.optional(),
		podId: z.string().optional(),
		provider: z.string().optional(),
	})
);
export const mailAttachmentInputSchema = preserveMailInput(
	z.object({
		content: z.string().optional(),
		content_base64: z.string().optional(),
		content_id: z.string().optional(),
		content_type: z.string(),
		filename: z.string(),
		inline: z.boolean().optional(),
	})
);
const ignoredNonArraySchema = z
	.unknown()
	.refine((value) => !Array.isArray(value))
	.transform(() => undefined);
function optionalMailArray<S extends z.ZodType>(item: S) {
	return z
		.union([preserveMailInput(z.array(item)), ignoredNonArraySchema])
		.optional();
}
const mailHeaderRecordSchema = z.custom<Record<string, string>>((value) => {
	if (!z.record(z.string(), z.string()).safeParse(value).success) {
		return false;
	}
	const prototypeEntry = Object.getOwnPropertyDescriptor(value, "__proto__");
	return !prototypeEntry || z.string().safeParse(prototypeEntry.value).success;
});
const ignoredNonHeaderSchema = z
	.unknown()
	.refine(
		(value) => !z.record(z.string(), z.unknown()).safeParse(value).success
	)
	.transform(() => undefined);
const mailSendFieldsSchema = z.object({
	inboxId: z.string().min(1),
	to: preserveMailInput(z.array(z.string()).min(1)),
	subject: z.string(),
	text: z.string().optional(),
	idempotencyKey: z
		.string()
		.regex(/^[\x20-\x7e]{1,256}$/u)
		.refine((key) => key.trim().length > 0)
		.optional(),
	attachments: optionalMailArray(mailAttachmentInputSchema),
	bcc: optionalMailArray(z.string()),
	cc: optionalMailArray(z.string()),
	labels: optionalMailArray(z.string()),
	replyTo: optionalMailArray(z.string()),
	clientId: z.string().optional().catch(undefined),
	html: z.string().optional().catch(undefined),
	inReplyTo: z.string().optional().catch(undefined),
	trackOpens: z.boolean().optional().catch(undefined),
	headers: z.union([mailHeaderRecordSchema, ignoredNonHeaderSchema]).optional(),
	references: z.union([z.string(), optionalMailArray(z.string())]).optional(),
});
export const mailSendInputSchema = mailSendFieldsSchema.transform((input) => {
	const output: z.output<typeof mailSendFieldsSchema> = {
		inboxId: input.inboxId,
		to: input.to,
		subject: input.subject,
	};
	for (const key of [
		"clientId",
		"html",
		"idempotencyKey",
		"inReplyTo",
		"text",
	] as const) {
		if (input[key] !== undefined) {
			output[key] = input[key];
		}
	}
	for (const key of ["bcc", "cc", "labels", "replyTo"] as const) {
		if (input[key] !== undefined) {
			output[key] = input[key];
		}
	}
	if (input.attachments !== undefined) {
		output.attachments = input.attachments;
	}
	if (input.headers !== undefined) {
		output.headers = input.headers;
	}
	if (input.references !== undefined) {
		output.references = input.references;
	}
	if (input.trackOpens !== undefined) {
		output.trackOpens = input.trackOpens;
	}
	return output;
});
const mailRequestFieldsSchema = z.object({
	path: z
		.string()
		.regex(
			/^\/api\/mail\/(?:status|inboxes|messages|attachments|webhooks|lists|pods|domains|events)(?:\/|$)/u
		)
		// URL parsing (and so `fetch`) drops ASCII tab/LF/CR before collapsing dot
		// segments, so `.\t.` would arrive as `..`: refuse every control character.
		.refine(
			(path) =>
				!(
					path.includes("..") ||
					/%(?:2e|2f|5c)/iu.test(path) ||
					path.includes("\\") ||
					/\p{Cc}/u.test(path)
				)
		),
	method: z
		.enum(["DELETE", "GET", "PATCH", "POST"])
		.nullish()
		.transform((method) => method ?? "GET"),
	body: preserveMailInput(jsonResponseValueSchema).optional(),
});
export const mailRequestInputSchema = mailRequestFieldsSchema.transform(
	({ path, method, body }) => {
		const output: z.output<typeof mailRequestFieldsSchema> = { path, method };
		if (body !== undefined) {
			output.body = body;
		}
		return output;
	}
);
export type MailCreatePayload = z.output<typeof mailCreateInputSchema>;
export type MailSendPayload = z.output<typeof mailSendInputSchema>;
export type MailRequestPayload = z.output<typeof mailRequestInputSchema>;
