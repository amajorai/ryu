import { z } from "zod";

/** "Continued on <computer>": set on the source after an RNP handoff. */
export interface ContinuedOn {
	at: number;
	nodeLabel: string;
}

const continuedOnSchema = z.object({
	nodeLabel: z.string().trim().min(1).max(256),
	at: z.number().int().nonnegative(),
});

/** Core's `continued_on` summary field, or `undefined` when absent or malformed. */
export function parseContinuedOn(value: unknown): ContinuedOn | undefined {
	const parsed = continuedOnSchema.safeParse(value);
	return parsed.success
		? { nodeLabel: parsed.data.nodeLabel, at: parsed.data.at }
		: undefined;
}
