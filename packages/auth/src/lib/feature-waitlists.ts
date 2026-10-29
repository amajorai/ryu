import { z } from "zod";
import { PLAN_IDS } from "./plans.ts";

export const FEATURE_WAITLIST_FIELD_TYPES = [
	"short_text",
	"long_text",
	"single_select",
	"checkbox",
] as const;

export const FEATURE_FLAG_TARGET_OPERATORS = [
	"equals",
	"not_equals",
	"contains",
	"in",
	"greater_than_or_equal",
	"less_than_or_equal",
] as const;

const featureFlagTargetValueSchema = z.union([
	z.string().trim().min(1).max(160),
	z.number().finite(),
	z
		.array(z.union([z.string().trim().min(1).max(160), z.number().finite()]))
		.min(1)
		.max(20),
]);

/**
 * Plan gate values. `free` names a caller the server resolved to no paid plan;
 * every other value is a billing `PlanId`, and a lifetime-order owner with no
 * subscription resolves to `desktop-license` on every server plan source. A
 * caller whose plan the server could not resolve (an anonymous visitor, a
 * billing-provider failure) matches none of them.
 */
export const FEATURE_FLAG_FREE_PLAN = "free" as const;
export const FEATURE_FLAG_PLAN_GATES = [
	FEATURE_FLAG_FREE_PLAN,
	...PLAN_IDS,
] as const;
export type FeatureFlagPlanGate = (typeof FEATURE_FLAG_PLAN_GATES)[number];

export const featureFlagTargetConditionSchema = z.object({
	attribute: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/u),
	operator: z.enum(FEATURE_FLAG_TARGET_OPERATORS),
	value: featureFlagTargetValueSchema,
});

export const featureFlagTargetRuleSchema = z.object({
	allocationPercent: z.number().int().min(0).max(100),
	conditions: z.array(featureFlagTargetConditionSchema).min(1).max(12),
	enabled: z.boolean(),
	id: z
		.string()
		.trim()
		.min(1)
		.max(48)
		.regex(/^[a-zA-Z0-9_-]+$/u),
	name: z.string().trim().min(1).max(80),
});

export const featureFlagRolloutSchema = z
	.object({
		allocationPercent: z.number().int().min(0).max(100).default(100),
		endsAt: z.string().datetime().nullable().default(null),
		// Empty means every plan. Non-empty is a hard eligibility gate evaluated
		// against the SERVER-resolved plan, before waitlist grants and rules.
		plans: z
			.array(z.enum(FEATURE_FLAG_PLAN_GATES))
			.max(FEATURE_FLAG_PLAN_GATES.length)
			.default([]),
		rules: z.array(featureFlagTargetRuleSchema).max(20).default([]),
		startsAt: z.string().datetime().nullable().default(null),
	})
	.superRefine((rollout, context) => {
		if (new Set(rollout.plans).size !== rollout.plans.length) {
			context.addIssue({
				code: "custom",
				message: "Plan gates must be unique.",
				path: ["plans"],
			});
		}
		const ids = rollout.rules.map((rule) => rule.id);
		if (new Set(ids).size !== ids.length) {
			context.addIssue({
				code: "custom",
				message: "Targeting rule IDs must be unique.",
				path: ["rules"],
			});
		}
		if (
			rollout.startsAt &&
			rollout.endsAt &&
			Date.parse(rollout.endsAt) <= Date.parse(rollout.startsAt)
		) {
			context.addIssue({
				code: "custom",
				message: "The end time must be after the start time.",
				path: ["endsAt"],
			});
		}
	});

const featureWaitlistFieldSchema = z
	.object({
		id: z
			.string()
			.trim()
			.min(1)
			.max(48)
			.regex(/^[a-zA-Z0-9_-]+$/u),
		label: z.string().trim().min(1).max(100),
		required: z.boolean(),
		type: z.enum(FEATURE_WAITLIST_FIELD_TYPES),
		options: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
	})
	.superRefine((field, context) => {
		if (field.type === "single_select") {
			if (!field.options || field.options.length < 2) {
				context.addIssue({
					code: "custom",
					message: "Select questions need at least two options.",
					path: ["options"],
				});
				return;
			}
			if (new Set(field.options).size !== field.options.length) {
				context.addIssue({
					code: "custom",
					message: "Select options must be unique.",
					path: ["options"],
				});
			}
		}
	});

export const featureWaitlistFormSchema = z
	.object({
		title: z.string().trim().min(1).max(100),
		description: z.string().trim().max(500),
		successMessage: z.string().trim().min(1).max(240),
		fields: z.array(featureWaitlistFieldSchema).max(10),
	})
	.superRefine((form, context) => {
		const ids = form.fields.map((field) => field.id);
		if (new Set(ids).size !== ids.length) {
			context.addIssue({
				code: "custom",
				message: "Question IDs must be unique.",
				path: ["fields"],
			});
		}
	});

export type FeatureWaitlistFieldType =
	(typeof FEATURE_WAITLIST_FIELD_TYPES)[number];

export type FeatureWaitlistField = z.infer<typeof featureWaitlistFieldSchema>;

export type FeatureWaitlistForm = z.infer<typeof featureWaitlistFormSchema>;

export type FeatureFlagTargetCondition = z.infer<
	typeof featureFlagTargetConditionSchema
>;
export type FeatureFlagTargetRule = z.infer<typeof featureFlagTargetRuleSchema>;
export type FeatureFlagRollout = z.infer<typeof featureFlagRolloutSchema>;

export const featureWaitlistScopeSchema = z.enum(["platform", "app"]);
export type FeatureWaitlistScope = z.infer<typeof featureWaitlistScopeSchema>;

export const featureWaitlistApplicationStatusSchema = z.enum([
	"new",
	"reviewed",
	"approved",
	"declined",
]);
export type FeatureWaitlistApplicationStatus = z.infer<
	typeof featureWaitlistApplicationStatusSchema
>;

export interface AppFeatureFlagView {
	accessGranted: boolean;
	allocationPercent: number;
	description: string;
	enabled: boolean;
	key: string;
	name: string;
	updatedAt: string | null;
	waitlistUrl: string | null;
}

export interface FeatureWaitlistSubmissionView {
	answers: Array<{ label: string; value: string | boolean }>;
	createdAt: string | null;
	email: string;
	formTitle: string;
	id: string;
	name: string | null;
	status: FeatureWaitlistApplicationStatus;
}

export const MAX_FEATURE_WAITLIST_ANSWER_LENGTH = 2000;
