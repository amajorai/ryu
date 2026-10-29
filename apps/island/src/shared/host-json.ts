import { z } from "zod";

export const hostJsonSchema = z.json().optional();

/** Match the HTTP bridge's JSON serialization, including omitted optional fields. */
export function parseHostArguments(
	raw: Parameters<typeof hostJsonSchema.parse>[0]
) {
	const serialized = JSON.stringify(raw);
	return serialized === undefined
		? undefined
		: hostJsonSchema.parse(JSON.parse(serialized));
}
