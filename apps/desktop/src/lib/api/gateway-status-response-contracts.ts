// Response schemas for the gateway status, evaluator, doctor and provider-edit
// endpoints that `gateway.ts` reads, plus the shared `retainValidatedResponse`
// helper. Split out of `gateway.ts`; the public client API stays there.

import { z } from "zod";
import type {
	Evaluator,
	GatewayDoctorFixResult,
	GatewayDoctorReport,
	GatewayProviderEditResult,
	RawStatus,
} from "./gateway.ts";

export const rawStatusResponseSchema: z.ZodType<RawStatus> =
	retainValidatedResponse(
		z
			.object({
				health: z
					.union([
						z
							.object({
								auth_required: z.boolean().optional(),
								providers: z.array(z.string()).optional(),
								status: z.string().optional(),
								version: z.union([z.string(), z.null()]).optional(),
							})
							.passthrough(),
						z.null(),
					])
					.optional(),
				metrics: z
					.union([
						z
							.object({
								cache: z
									.object({
										exact_hits: z.number().optional(),
										semantic_hits: z.number().optional(),
										misses: z.number().optional(),
										hit_rate: z.number().optional(),
									})
									.passthrough()
									.optional(),
								composio: z
									.object({ calls: z.number().optional() })
									.passthrough()
									.optional(),
								provider_health: z
									.record(
										z.string(),
										z
											.object({
												circuit: z.string().optional(),
												consecutive_failures: z.number().optional(),
												open_for_secs: z
													.union([z.number(), z.null()])
													.optional(),
											})
											.passthrough()
									)
									.optional(),
								provider_quota: z
									.record(
										z.string(),
										z
											.object({
												limit: z.union([z.number(), z.null()]).optional(),
												rate_limited: z
													.union([z.boolean(), z.null()])
													.optional(),
												remaining: z.union([z.number(), z.null()]).optional(),
												reset_at: z.union([z.number(), z.null()]).optional(),
												reset_in_secs: z
													.union([z.number(), z.null()])
													.optional(),
												retry_after: z.union([z.number(), z.null()]).optional(),
												updated_at: z.union([z.number(), z.null()]).optional(),
											})
											.passthrough()
									)
									.optional(),
								providers: z
									.object({
										requests: z.record(z.string(), z.number()).optional(),
										errors: z.record(z.string(), z.number()).optional(),
									})
									.passthrough()
									.optional(),
								requests: z
									.object({
										total: z.number().optional(),
										errors: z.number().optional(),
										rate_limited: z.number().optional(),
										firewall_blocked: z.number().optional(),
										budget_exceeded: z.number().optional(),
										budget_notified: z.number().optional(),
										budget_downgraded: z.number().optional(),
										budget_restricted: z.number().optional(),
									})
									.passthrough()
									.optional(),
								tokens: z
									.object({
										input: z.number().optional(),
										output: z.number().optional(),
									})
									.passthrough()
									.optional(),
							})
							.passthrough(),
						z.null(),
					])
					.optional(),
				reachable: z.boolean().optional(),
				url: z.union([z.string(), z.null()]).optional(),
			})
			.passthrough()
	);

export const fetchClassifyWeightsPresentResponseSchema: z.ZodType<{
	models?: { stem?: string }[];
}> = retainValidatedResponse(
	z
		.object({
			models: z
				.array(z.object({ stem: z.string().optional() }).passthrough())
				.optional(),
		})
		.passthrough()
);

export const fetchEvaluatorsResponseSchema: z.ZodType<{
	evaluators?: Evaluator[];
}> = retainValidatedResponse(
	z
		.object({
			evaluators: z
				.array(
					z
						.object({
							builtin: z.boolean(),
							capabilities: z
								.object({ inline: z.boolean(), offline: z.boolean() })
								.passthrough(),
							category: z.union([
								z.literal("security"),
								z.literal("safety"),
								z.literal("quality"),
								z.literal("conversation"),
								z.literal("trajectory"),
								z.literal("image"),
								z.literal("voice"),
								z.literal("custom"),
							]),
							description: z.string(),
							enforced: z.boolean(),
							higherIsBetter: z.boolean(),
							id: z.string(),
							impl: z.union([
								z
									.object({
										kind: z.literal("regex"),
										patterns: z.array(z.string()),
									})
									.passthrough(),
								z.object({ kind: z.literal("heuristic") }).passthrough(),
								z
									.object({
										kind: z.literal("llm_judge"),
										rubric: z.string(),
									})
									.passthrough(),
								z
									.object({
										kind: z.literal("code"),
										lang: z.union([z.literal("js"), z.literal("python")]),
										source: z.string(),
									})
									.passthrough(),
								z
									.object({
										kind: z.literal("builtin"),
										detector: z.string(),
									})
									.passthrough(),
							]),
							inline: z
								.union([
									z
										.object({
											action: z.union([
												z.literal("block"),
												z.literal("warn_and_continue"),
												z.literal("sanitize"),
											]),
										})
										.passthrough(),
									z.null(),
								])
								.optional(),
							name: z.string(),
							offline: z
								.union([
									z
										.object({
											judgeModel: z.union([z.string(), z.null()]).optional(),
											threshold: z.number(),
										})
										.passthrough(),
									z.null(),
								])
								.optional(),
							target: z.union([
								z.literal("input"),
								z.literal("output"),
								z.literal("conversation"),
								z.literal("trajectory"),
								z.literal("image"),
								z.literal("audio"),
							]),
						})
						.passthrough()
				)
				.optional(),
		})
		.passthrough()
);

export const gatewayDoctorReportResponseSchema: z.ZodType<GatewayDoctorReport> =
	retainValidatedResponse(
		z
			.object({
				counts: z
					.object({
						errors: z.number(),
						warnings: z.number(),
						info: z.number(),
					})
					.passthrough(),
				error: z.string().optional(),
				findings: z.array(
					z
						.object({
							canAutoFix: z.boolean(),
							category: z.union([
								z.union([
									z.literal("configuration"),
									z.literal("security"),
									z.literal("performance"),
									z.literal("connectivity"),
									z.literal("coverage"),
								]),
								z.string(),
							]),
							checkId: z.string(),
							detail: z.string(),
							recommendedAction: z.string().optional(),
							settingPath: z.string().optional(),
							severity: z.union([
								z.literal("info"),
								z.literal("warning"),
								z.literal("error"),
							]),
							summary: z.string(),
						})
						.passthrough()
				),
				generatedAt: z.number().optional(),
				posture: z.string().optional(),
				profile: z.string().optional(),
				reachable: z.boolean().optional(),
				readOnly: z.boolean().optional(),
				rulesetVersion: z.string().optional(),
				schemaVersion: z.string().optional(),
			})
			.passthrough()
	);

export const gatewayDoctorFixResultResponseSchema: z.ZodType<GatewayDoctorFixResult> =
	retainValidatedResponse(
		z
			.object({
				appliedFixes: z.array(
					z
						.object({
							action: z.string(),
							checkId: z.string(),
							settingPath: z.string(),
							summary: z.string(),
						})
						.passthrough()
				),
				dryRun: z.boolean(),
				plannedFixes: z.array(
					z
						.object({
							action: z.string(),
							checkId: z.string(),
							settingPath: z.string(),
							summary: z.string(),
						})
						.passthrough()
				),
				report: z
					.object({
						counts: z
							.object({
								errors: z.number(),
								warnings: z.number(),
								info: z.number(),
							})
							.passthrough(),
						error: z.string().optional(),
						findings: z.array(
							z
								.object({
									canAutoFix: z.boolean(),
									category: z.union([
										z.union([
											z.literal("configuration"),
											z.literal("security"),
											z.literal("performance"),
											z.literal("connectivity"),
											z.literal("coverage"),
										]),
										z.string(),
									]),
									checkId: z.string(),
									detail: z.string(),
									recommendedAction: z.string().optional(),
									settingPath: z.string().optional(),
									severity: z.union([
										z.literal("info"),
										z.literal("warning"),
										z.literal("error"),
									]),
									summary: z.string(),
								})
								.passthrough()
						),
						generatedAt: z.number().optional(),
						posture: z.string().optional(),
						profile: z.string().optional(),
						reachable: z.boolean().optional(),
						readOnly: z.boolean().optional(),
						rulesetVersion: z.string().optional(),
						schemaVersion: z.string().optional(),
					})
					.passthrough(),
			})
			.passthrough()
	);

export const updateGatewayConfigResponseSchema: z.ZodType<{ ok: boolean }> =
	retainValidatedResponse(z.object({ ok: z.boolean() }).passthrough());

export const gatewayProviderEditResultResponseSchema: z.ZodType<GatewayProviderEditResult> =
	retainValidatedResponse(
		z
			.object({
				accountsApplied: z.boolean().optional(),
				configRevision: z.string().optional(),
				gateway_application: z
					.union([
						z
							.object({
								status: z.union([
									z.literal("applied"),
									z.literal("already_applied"),
								]),
								requestedRevision: z.string(),
								appliedRevision: z.string(),
								epoch: z
									.object({ boot: z.string(), sequence: z.number() })
									.passthrough(),
							})
							.passthrough(),
						z
							.object({
								status: z.literal("superseded"),
								requestedRevision: z.string(),
								currentRevision: z.string(),
							})
							.passthrough(),
						z
							.object({
								status: z.literal("failed"),
								requestedRevision: z.string(),
								activeRevision: z.union([z.string(), z.null()]).optional(),
								code: z.string(),
							})
							.passthrough(),
						z
							.object({
								status: z.union([z.literal("offline"), z.literal("unmanaged")]),
								requestedRevision: z.string(),
							})
							.passthrough(),
					])
					.optional(),
				gateway_outcome: z.string().optional(),
				gateway_restarted: z.boolean(),
				persisted: z.boolean().optional(),
				success: z.boolean(),
			})
			.passthrough()
	);

export function retainValidatedResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>((value) => fields.safeParse(value).success);
}
