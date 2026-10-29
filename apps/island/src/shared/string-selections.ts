import { z } from "zod";

/** Keep valid persisted selections when one sibling entry is corrupt. */
export const stringSelectionsSchema = z
	.record(z.string(), z.string().optional().catch(undefined))
	.transform((values) =>
		Object.fromEntries(
			Object.entries(values).flatMap(([key, value]) =>
				value === undefined ? [] : [[key, value]]
			)
		)
	)
	.pipe(z.record(z.string(), z.string()))
	.catch({});

export const groupedStringSelectionsSchema = z
	.record(z.string(), stringSelectionsSchema)
	.catch({});
