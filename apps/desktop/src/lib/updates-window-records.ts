import { z } from "zod";

/** Only the persisted fields consumed by the account-scoped updater. */
export const updatesWindowRecordSchema = z.object({
	accountId: z.string(),
	windowEndsAt: z.string(),
});

export const updatesNagRecordSchema = z.object({
	accountId: z.string(),
	version: z.string(),
});

export type WindowRecord = z.infer<typeof updatesWindowRecordSchema>;
export type NagRecord = z.infer<typeof updatesNagRecordSchema>;

/** Corrupt or foreign records never restrict updates or suppress a prompt. */
export function parseScopedUpdatesRecord<T extends { accountId: string }>(
	raw: string | null,
	activeId: string | null,
	schema: z.ZodType<T>
): T | null {
	if (activeId === null || !raw) {
		return null;
	}
	try {
		const parsed = schema.safeParse(JSON.parse(raw));
		return parsed.success && parsed.data.accountId === activeId
			? parsed.data
			: null;
	} catch {
		return null;
	}
}
