import { z } from "zod";
import { nativeJsonSchema, nativeNumberSchema } from "./native-json.ts";

const optionalString = z.string().optional().catch(undefined);
export const githubCommitResponseSchema = z.object({
	sha: optionalString,
	tree: z.object({ sha: optionalString }).optional().catch(undefined),
});
export const githubTreeEntrySchema = z.object({
	path: optionalString,
	sha: optionalString,
	size: nativeNumberSchema.optional().catch(undefined),
	type: optionalString,
});
export type GithubTreeEntry = z.infer<typeof githubTreeEntrySchema>;
export const githubTreeResponseSchema = z
	.object({
		truncated: z.literal(true).optional().catch(undefined),
		tree: z.array(nativeJsonSchema).optional().catch(undefined),
	})
	.transform((value) => {
		const entries: GithubTreeEntry[] = [];
		for (const raw of value.tree ?? []) {
			const entry = githubTreeEntrySchema.safeParse(raw);
			if (entry.success) {
				entries.push(entry.data);
			}
		}
		return { truncated: value.truncated, tree: entries };
	});
