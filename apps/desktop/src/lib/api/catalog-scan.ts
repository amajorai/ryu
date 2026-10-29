import { z } from "zod";
// Node-scoped on-demand audit. Core runs the selected agent through its normal
// chat boundary; the static scorecard remains separate from its assessment.

import type {
	CatalogScanInput,
	CatalogScanResult,
} from "@ryu/marketplace/catalog/host";
import { ApiError, type ApiTarget, request } from "./client.ts";

const CATALOG_SCAN_PATH = "/api/catalog/scan";

interface CatalogScanWireResult {
	agent_id: string;
	assessment?: CatalogScanResult["assessment"];
	auditedAt?: string;
	conversationId?: string;
	model?: string;
	report: string;
	status: CatalogScanResult["status"];
}

export const CATALOG_SCAN_AGENT_PREF = "security-scanner-agent";

export async function runCatalogScan(
	target: ApiTarget,
	input: CatalogScanInput
): Promise<CatalogScanResult> {
	const result = await request<CatalogScanWireResult>(
		target,
		CATALOG_SCAN_PATH,
		{
			body: { ...input, execution: "agent" },
			method: "POST",
		},
		catalogScanWireResultResponseSchema
	).catch((error) => {
		if (error instanceof ApiError && error.serverMessage) {
			throw new Error(error.serverMessage, { cause: error });
		}
		throw error;
	});
	return {
		agentId: result.agent_id,
		conversationId: result.conversationId,
		assessment: result.assessment,
		model: result.model,
		auditedAt: result.auditedAt,
		report: result.report,
		status: result.status,
	};
}

const catalogScanWireResultResponseSchema: z.ZodType<CatalogScanWireResult> =
	retainValidatedResponse(
		z
			.object({
				agent_id: z.string(),
				assessment: z
					.union([
						z
							.object({
								confidence: z.union([
									z.literal("low"),
									z.literal("medium"),
									z.literal("high"),
								]),
								evidence: z.array(z.string()),
								limitations: z.array(z.string()),
								recommendations: z.array(
									z
										.object({
											priority: z.union([
												z.literal("high"),
												z.literal("medium"),
												z.literal("low"),
											]),
											action: z.string(),
											reason: z.string(),
										})
										.passthrough()
								),
								score: z.union([z.number(), z.null()]),
								summary: z.string(),
							})
							.passthrough(),
						z.null(),
					])
					.optional()
					.optional(),
				auditedAt: z.string().optional(),
				conversationId: z.string().optional(),
				model: z.string().optional(),
				report: z.string(),
				status: z.union([z.literal("complete"), z.literal("partial")]),
			})
			.passthrough()
	);

function retainValidatedResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>((value) => fields.safeParse(value).success);
}
