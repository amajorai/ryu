import { z } from "zod";

const ProofJsonSchema = z.json();
const ProofJsonRecordSchema = z.record(z.string(), ProofJsonSchema);

export type ProofJsonValue = z.infer<typeof ProofJsonSchema>;
export type ProofJsonRecord = z.infer<typeof ProofJsonRecordSchema>;

/** Decode captured JSON while retaining malformed domain values for negative tests. */
export function parseProofJson(raw: string): ProofJsonValue {
	const value = JSON.parse(raw);
	ProofJsonSchema.parse(value);
	// Keep the captured bytes' own fields: schema output drops keys such as __proto__.
	return value;
}

export function parseProofJsonRecord(raw: string): ProofJsonRecord {
	const value = JSON.parse(raw);
	ProofJsonRecordSchema.parse(value);
	return value;
}
