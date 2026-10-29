import { type RyuJsonValue, rpcJsonResponseSchema } from "@ryu/app-host/rpc";
import { z } from "zod";
import type {
	GatewayGovernanceValues,
	GitGovernanceSettings,
	HookPolicyOverride,
	WorktreeGovernanceSettings,
} from "./governance.ts";

export type GovernanceJsonValue = RyuJsonValue | undefined;
type GovernanceJsonRecord = Record<string, RyuJsonValue>;
const objectInputSchema = z.record(z.string(), z.unknown());
export const governanceRecordSchema = z.custom<GovernanceJsonRecord>(
	(value) =>
		rpcJsonResponseSchema.safeParse(value).success &&
		objectInputSchema.safeParse(value).success
);
export const governanceScopeSchema = z.enum([
	"node",
	"organization",
	"team",
	"user",
]);
const booleanFieldSchema = z.boolean().optional().catch(undefined);
const stringFieldSchema = z.string().optional().catch(undefined);
const gitSchema = z
	.object({
		branchPrefix: stringFieldSchema,
		mergeMethod: z.enum(["merge", "squash"]).optional().catch(undefined),
		alwaysForcePush: booleanFieldSchema,
		createDraftPullRequests: booleanFieldSchema,
		reviewDelivery: z.enum(["inline", "detached"]).optional().catch(undefined),
		autoMergeWhenReady: booleanFieldSchema,
		autoAddressPullRequestComments: booleanFieldSchema,
		autoArchiveClosedPullRequestChats: booleanFieldSchema,
		watchInstructions: stringFieldSchema,
		commitInstructions: stringFieldSchema,
		pullRequestInstructions: stringFieldSchema,
	})
	.transform(
		(value): GitGovernanceSettings => ({
			branchPrefix: value.branchPrefix,
			mergeMethod: value.mergeMethod,
			alwaysForcePush: value.alwaysForcePush,
			createDraftPullRequests: value.createDraftPullRequests,
			reviewDelivery: value.reviewDelivery,
			autoMergeWhenReady: value.autoMergeWhenReady,
			autoAddressPullRequestComments: value.autoAddressPullRequestComments,
			autoArchiveClosedPullRequestChats:
				value.autoArchiveClosedPullRequestChats,
			watchInstructions: value.watchInstructions,
			commitInstructions: value.commitInstructions,
			pullRequestInstructions: value.pullRequestInstructions,
		})
	)
	.optional()
	.catch(undefined);
const worktreesSchema = z
	.object({
		root: stringFieldSchema,
		fetchUpstream: booleanFieldSchema,
		autoDelete: booleanFieldSchema,
		autoDeleteLimit: z
			.number()
			.refine(Number.isInteger)
			.optional()
			.catch(undefined),
	})
	.transform(
		(value): WorktreeGovernanceSettings => ({
			root: value.root,
			fetchUpstream: value.fetchUpstream,
			autoDelete: value.autoDelete,
			autoDeleteLimit: value.autoDeleteLimit,
		})
	)
	.optional()
	.catch(undefined);
type HookPolicyOverrides = Record<string, HookPolicyOverride>;
function parseHooks(value: GovernanceJsonValue): HookPolicyOverrides {
	const input = governanceRecordSchema.safeParse(value);
	if (!input.success) {
		return {};
	}
	const hooks: HookPolicyOverrides = Object.create(null);
	for (const [key, raw] of Object.entries(input.data)) {
		const override = governanceRecordSchema.safeParse(raw);
		if (!override.success) {
			continue;
		}
		const enabled = booleanFieldSchema.parse(override.data.enabled);
		const trusted = booleanFieldSchema.parse(override.data.trusted);
		const policy: HookPolicyOverride = {};
		if (enabled !== undefined) {
			policy.enabled = enabled;
		}
		if (trusted !== undefined) {
			policy.trusted = trusted;
		}
		hooks[key] = policy;
	}
	return hooks;
}
export function parseGovernanceValues(
	value: GovernanceJsonValue
): GatewayGovernanceValues {
	const parsed = governanceRecordSchema.safeParse(value);
	if (!parsed.success) {
		return {};
	}
	const git = gitSchema.parse(parsed.data.git);
	const worktrees = worktreesSchema.parse(parsed.data.worktrees);
	const hooks = parseHooks(parsed.data.hooks);
	const values: GatewayGovernanceValues = {};
	if (git) {
		values.git = git;
	}
	if (Object.keys(hooks).length) {
		values.hooks = hooks;
	}
	if (worktrees) {
		values.worktrees = worktrees;
	}
	return values;
}
export const governanceRevisionSchema = z.number().refine(Number.isInteger);
export const governanceWritableSchema = z.boolean();
export const governanceReasonSchema = stringFieldSchema;
export const governanceLayersSchema = z.array(rpcJsonResponseSchema);
/** Lock lists are optional: Cores that predate governance locks omit them. */
export const governanceLockedFieldsSchema = z
	.array(z.string())
	.optional()
	.catch(undefined)
	.transform((value) => value ?? []);
