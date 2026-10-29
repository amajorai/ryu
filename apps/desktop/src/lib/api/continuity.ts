import {
	parseRnpContinuityBundle,
	type RnpContextBundleV0,
	type RnpContinuityBundleV0,
	type RnpExportRequestV0,
	type RnpResumeResultV0,
} from "@ryuhq/protocol/continuity";
import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";
import {
	type GatewayJsonValue,
	gatewayJsonValueSchema,
} from "./gateway-json-contracts.ts";

export interface ContinuityTransport {
	send: (input: {
		body: RnpExportRequestV0 | RnpContinuityBundleV0;
		path: string;
		target: ApiTarget;
	}) => Promise<GatewayJsonValue | RnpContinuityBundleV0>;
}

export interface TransferConversationInput {
	context?: RnpContextBundleV0;
	conversationId: string;
	destination: ApiTarget;
	ifUpdatedAt?: number;
	includeAgentHint?: boolean;
	source: ApiTarget;
	transcript?: RnpExportRequestV0["transcript"];
}

// This is the complete destination reply declared by the RNP v0 owner.
// As before, parse strips additive fields and the caller reports one stable error.
const resumeResultSchema = z.object({
	version: z.literal(0),
	conversationId: z.string(),
	status: z.enum(["created", "merged", "unchanged"]),
	imported: z.object({
		messages: z.number().refine(Number.isSafeInteger).nonnegative(),
		contextItems: z.number().refine(Number.isSafeInteger).nonnegative(),
	}),
	warnings: z.array(z.enum(["agent-unavailable", "earlier-messages-omitted"])),
}) satisfies z.ZodType<RnpResumeResultV0>;
function parseResumeResult(
	value: Parameters<typeof resumeResultSchema.parse>[0]
): RnpResumeResultV0 {
	const parsed = resumeResultSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error("The destination returned an invalid continuity response.");
	}
	return parsed.data;
}

const httpTransport: ContinuityTransport = {
	send: ({ body, path, target }) =>
		request(
			target,
			path,
			{ method: "POST", body },
			gatewayJsonValueSchema
		).then(gatewayJsonValueSchema.parse),
};

export function createContinuityClient(transport: ContinuityTransport) {
	const exportConversation = async (
		target: ApiTarget,
		conversationId: string,
		exportRequest: RnpExportRequestV0
	): Promise<RnpContinuityBundleV0> => {
		const path = `/api/rnp/v0/conversations/${encodeURIComponent(conversationId)}/export`;
		const raw = await transport.send({ target, path, body: exportRequest });
		const parsed = parseRnpContinuityBundle(raw);
		if (!parsed.ok) {
			throw new Error(
				`The source returned an invalid continuity bundle: ${parsed.error.message}`
			);
		}
		if (parsed.value.source.conversationId !== conversationId) {
			throw new Error("The source returned a different conversation.");
		}
		return parsed.value;
	};

	const resumeConversation = async (
		target: ApiTarget,
		bundle: RnpContinuityBundleV0
	): Promise<RnpResumeResultV0> => {
		const path = `/api/rnp/v0/conversations/${encodeURIComponent(bundle.source.conversationId)}/resume`;
		const raw = await transport.send({ target, path, body: bundle });
		const result = parseResumeResult(raw);
		if (result.conversationId !== bundle.source.conversationId) {
			throw new Error("The destination resumed a different conversation.");
		}
		return result;
	};

	const transferConversation = async (
		input: TransferConversationInput
	): Promise<RnpResumeResultV0> => {
		const bundle = await exportConversation(
			input.source,
			input.conversationId,
			{
				version: 0,
				ifUpdatedAt: input.ifUpdatedAt,
				transcript: input.transcript ?? { mode: "recent", maxMessages: 50 },
				context: input.context,
				includeAgentHint: input.includeAgentHint ?? false,
			}
		);
		return resumeConversation(input.destination, bundle);
	};

	return { exportConversation, resumeConversation, transferConversation };
}

const client = createContinuityClient(httpTransport);

export const exportRnpConversation = client.exportConversation;
export const resumeRnpConversation = client.resumeConversation;
export const transferRnpConversation = client.transferConversation;
