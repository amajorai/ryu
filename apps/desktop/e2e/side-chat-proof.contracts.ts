import { z } from "zod";
import type { BtwEntry, BtwMessage } from "../src/lib/api/btw.ts";
import {
	type PluginDocument,
	pluginDocumentSchema,
} from "../src/lib/api/plugin-wire-values.ts";

function sideChatDocument<S extends z.ZodType>(schema: S) {
	return z.custom<z.output<S> & PluginDocument>(
		(value) =>
			pluginDocumentSchema.safeParse(value).success &&
			schema.safeParse(value).success
	);
}
const messageSchema = sideChatDocument(
	z.object({
		role: z.enum(["user", "assistant"]),
		content: z.string(),
	}) satisfies z.ZodType<BtwMessage>
);
export const sideChatRequestSchema = sideChatDocument(
	z.object({
		conversation_id: z.string(),
		question: z.string(),
		messages: z.array(messageSchema).optional(),
		model: z.string().optional(),
	})
);
const entrySchema = sideChatDocument(
	z.object({
		id: z.string(),
		conversation_id: z.string(),
		question: z.string(),
		answer: z.string(),
		created_at: z.number(),
		model: z.string().nullable().optional(),
		kind: z.string().optional(),
		agent_id: z.string().nullable().optional(),
		child_conversation_id: z.string().nullable().optional(),
		preset: z.string().nullable().optional(),
	}) satisfies z.ZodType<BtwEntry>
);
export const sideChatEntriesSchema = z.custom<z.output<typeof entrySchema>[]>(
	(value) => z.array(entrySchema).safeParse(value).success
);
const contributionEntriesSchema = z.array(pluginDocumentSchema);
export const sideChatManifestSchema = sideChatDocument(
	z.object({
		id: z.string(),
		contributes: z.record(z.string(), contributionEntriesSchema),
	})
);
export type SideChatManifest = z.output<typeof sideChatManifestSchema>;
export type SideChatRequest = z.output<typeof sideChatRequestSchema>;
export type SideChatCodecs = Pick<
	typeof import("./side-chat-proof.contracts.ts"),
	"sideChatRequestSchema" | "sideChatEntriesSchema"
>;
