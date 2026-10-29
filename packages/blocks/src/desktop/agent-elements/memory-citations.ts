import { z } from "zod";

/** The data part emitted when Core injects built-in memory into a chat turn. */
export const MEMORY_CITATIONS_PART = "data-ryu-memory-citations";

/** A durable memory fact that was actually included in the model context. */
export interface MemoryCitation {
	content: string;
	id: string;
}

const memoryCitationsPartSchema = z.object({
	type: z.literal(MEMORY_CITATIONS_PART),
	data: z.object({ citations: z.array(z.unknown()) }),
});

const memoryCitationSchema = z.object({
	id: z.string().trim().min(1),
	content: z.string().trim().min(1),
});

/**
 * Read memory citations from a UIMessage's opaque parts without trusting the
 * wire shape. Malformed or duplicate entries are ignored so one bad provider
 * frame cannot break the message toolbar.
 */
export function extractMemoryCitations(
	parts: readonly unknown[] | undefined
): MemoryCitation[] {
	if (!parts) {
		return [];
	}

	const citations: MemoryCitation[] = [];
	const seen = new Set<string>();
	for (const part of parts) {
		const envelope = memoryCitationsPartSchema.safeParse(part);
		if (!envelope.success) {
			continue;
		}
		for (const candidate of envelope.data.data.citations) {
			const parsed = memoryCitationSchema.safeParse(candidate);
			if (!parsed.success) {
				continue;
			}
			const { content, id } = parsed.data;
			if (seen.has(id)) {
				continue;
			}
			seen.add(id);
			citations.push({ content, id });
		}
	}
	return citations;
}
