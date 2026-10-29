import type { UIMessage } from "ai";
import { z } from "zod";

/** Core hydration/live collaboration project the verified identity into SDK
 * metadata; the transcript validates that opaque metadata at its boundary. */
const messageAuthorSchema = z.object({
	avatar: z.string().optional(),
	id: z.string().optional(),
	name: z.string().optional(),
});
const messageAuthorMetadataSchema = z.object({
	author: messageAuthorSchema.optional(),
});
export type MessageAuthor = z.infer<typeof messageAuthorSchema>;

export function getAuthor(message: UIMessage): MessageAuthor | null {
	const parsed = messageAuthorMetadataSchema.safeParse(message.metadata);
	if (!parsed.success) {
		return null;
	}
	const author = parsed.data.author;
	return author && (author.name || author.id) ? author : null;
}
