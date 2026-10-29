import { z } from "zod";

const storedRowsSchema = z.array(z.unknown());
const storedIdSchema = z.string();
const storedCountSchema = z.tuple([
	z.string().min(1),
	z.number().int().nonnegative(),
]);

function parseStoredRows(stored: ReturnType<Storage["getItem"]>) {
	if (!stored) {
		return [];
	}
	const rows = storedRowsSchema.safeParse(JSON.parse(stored));
	return rows.success ? rows.data : [];
}

/** Decode only the string cells emitted by the conversation flag store. */
export function parseStoredConversationIds(
	stored: ReturnType<Storage["getItem"]>
) {
	const ids = new Set<string>();
	try {
		for (const entry of parseStoredRows(stored)) {
			const id = storedIdSchema.safeParse(entry);
			if (id.success) {
				ids.add(id.data);
			}
		}
		return ids;
	} catch {
		return new Set<string>();
	}
}

/** Keep valid count rows in order, with the last valid duplicate winning. */
export function parseStoredConversationCounts(
	stored: ReturnType<Storage["getItem"]>
) {
	const counts = new Map<string, number>();
	try {
		for (const entry of parseStoredRows(stored)) {
			const count = storedCountSchema.safeParse(entry);
			if (count.success) {
				counts.set(count.data[0], count.data[1]);
			}
		}
		return counts;
	} catch {
		return new Map<string, number>();
	}
}
