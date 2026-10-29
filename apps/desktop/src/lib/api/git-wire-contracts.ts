import { z } from "zod";
import {
	pluginDocumentSchema,
	type pluginValueSchema,
} from "./plugin-wire-values.ts";

function gitWireRecord<S extends z.ZodObject>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			pluginDocumentSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
export type GitResponseInput = Parameters<typeof pluginValueSchema.parse>[0];
const gitPathListSchema = z.custom<string[]>(
	(value) => z.array(z.string()).safeParse(value).success
);
export const gitFileDiffSchema = z.object({
	patch: z.string(),
	paths: gitPathListSchema,
});
export const gitReverseEditsSchema = z.union([
	z.object({ kind: z.literal("applied"), paths: gitPathListSchema }),
	z.object({
		kind: z.literal("conflict"),
		paths: gitPathListSchema,
		reason: z.enum([
			"changed_since_turn",
			"staged_changes",
			"unsupported_file",
		]),
	}),
]);
export const gitStatusWireSchema = gitWireRecord(
	z.object({
		ahead: z.number().nullish(),
		behind: z.number().nullish(),
		branch: z.string().nullish(),
		changed_files_count: z.number().nullish(),
		deletions: z.number().nullish(),
		dirty: z.boolean().nullish(),
		insertions: z.number().nullish(),
		is_repo: z.boolean().nullish(),
	})
).nullish();
export const gitBranchesWireSchema = gitWireRecord(
	z.object({
		branches: gitPathListSchema.nullish(),
		current: z.string().nullish(),
		is_repo: z.boolean().nullish(),
	})
).nullish();
export const gitWorktreeStatusWireSchema = gitWireRecord(
	z.object({
		active: z.boolean().nullish(),
		branch: z.string().nullish(),
		changed_files: z.number().nullish(),
		has_changes: z.boolean().nullish(),
		path: z.string().nullish(),
	})
).nullish();
export const gitFileSummaryWireSchema = gitWireRecord(
	z.object({
		additions: z.number(),
		deletions: z.number(),
		kind: z.enum(["added", "modified", "deleted", "renamed"]),
		path: z.string(),
	})
);
export const gitWorktreeDiffWireSchema = gitWireRecord(
	z.object({
		files: z.array(gitFileSummaryWireSchema).nullish(),
		has_changes: z.boolean().nullish(),
		unified_diff: z.string().nullish(),
	})
).nullish();
export const gitInitResultWireSchema = gitWireRecord(
	z.object({
		branch: z.string().nullish(),
		initialized: z.boolean().nullish(),
		success: z.boolean().nullish(),
	})
).nullish();
export const gitCheckoutResultWireSchema = gitWireRecord(
	z.object({ branch: z.string().nullish(), success: z.boolean().nullish() })
).nullish();
export const gitCommitPushResultWireSchema = gitWireRecord(
	z.object({
		commit: z.string().nullish(),
		committed: z.boolean().nullish(),
		pushed: z.boolean().nullish(),
		success: z.boolean().nullish(),
	})
).nullish();
export const gitRemoteResultWireSchema = gitWireRecord(
	z.object({
		commit: z.string().nullish(),
		pulled: z.boolean().nullish(),
		pushed: z.boolean().nullish(),
		success: z.boolean().nullish(),
	})
).nullish();
export const gitPullRequestResultWireSchema = gitWireRecord(
	z.object({
		already_exists: z.boolean().nullish(),
		base: z.string().nullish(),
		branch: z.string().nullish(),
		comments_count: z.number().nullish(),
		head_sha: z.string().nullish(),
		is_draft: z.boolean().nullish(),
		number: z.number().nullish(),
		pr_url: z.string().nullish(),
		repository: z.string().nullish(),
		state: z.string().nullish(),
		success: z.boolean().nullish(),
		title: z.string().nullish(),
	})
).nullish();
export const gitApplyWireSchema = gitWireRecord(
	z.object({
		conflicted_files: gitPathListSchema.nullish(),
		commit: z.string().nullish(),
		pr_url: z.string().nullish(),
	})
).nullish();
