import { z } from "zod";

/** Values accepted by Core's JSON HTTP and event-stream contracts. */
export const JsonValueSchema = z.json();
export const JsonRecordSchema = z.record(z.string(), JsonValueSchema);
export type JsonValue = z.infer<typeof JsonValueSchema>;
export type JsonRecord = z.infer<typeof JsonRecordSchema>;

export function jsonRecord(value: JsonValue | undefined): JsonRecord | null {
	const parsed = JsonRecordSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

export function nonemptyString(value: JsonValue | undefined): string | null {
	const parsed = z.string().min(1).safeParse(value);
	return parsed.success ? parsed.data : null;
}
