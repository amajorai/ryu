import { z } from "zod";
import { ApiError, type ApiTarget, request } from "./client.ts";
import {
	type CloudSpeechAccountsInput,
	cloudSpeechAccountsSchema,
} from "./cloud-account-wire-contracts.ts";
import {
	type GatewayProviderEditResult,
	requireGatewayProviderReload,
} from "./gateway.ts";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";

export interface CloudSpeechAccounts {
	cloudSpeechAccountsSchema: 1;
	configRevision: string;
	googleTts: {
		accountId: string;
		quotaProject: string;
		expiresAtUnixSecs: number | null;
		policy: CloudSpeechPolicy;
	}[];
	polly: {
		region: string;
		accounts: {
			accountId: string;
			accessKeyHint: string;
			hasSessionToken: boolean;
			expiresAtUnixSecs: number | null;
			policy: CloudSpeechPolicy;
		}[];
	};
}

export interface CloudSpeechPolicy {
	enabled: boolean;
	name: string;
	priority: number;
}

export async function getCloudSpeechAccounts(
	target: ApiTarget
): Promise<CloudSpeechAccounts | null> {
	try {
		const value = await request<CloudSpeechAccountsInput>(
			target,
			"/api/gateway/cloud-speech-accounts",
			{},
			gatewayJsonValueSchema
		);
		const parsed = cloudSpeechAccountsSchema.safeParse(value);
		if (!parsed.success) {
			throw new Error("This node returned invalid cloud speech accounts.");
		}
		return parsed.data;
	} catch (error) {
		if (error instanceof ApiError && error.status === 404) {
			return null;
		}
		throw error;
	}
}

export type CloudSpeechEdit =
	| {
			action: "configure";
			provider: "google-tts" | "polly";
			accountId: string;
			accountPolicy: CloudSpeechPolicy;
	  }
	| {
			action: "add";
			provider: "google-tts";
			accessToken: string;
			quotaProject: string;
			expiresAtUnixSecs?: number;
	  }
	| {
			action: "add";
			provider: "polly";
			region: string;
			accessKeyId: string;
			secretAccessKey: string;
			sessionToken?: string;
			expiresAtUnixSecs?: number;
	  }
	| { action: "remove"; provider: "google-tts" | "polly"; accountId: string };

export async function editCloudSpeechAccounts(
	target: ApiTarget,
	revision: string,
	edit: CloudSpeechEdit
): Promise<void> {
	const result = await request<GatewayProviderEditResult>(
		target,
		"/api/gateway/cloud-speech-accounts",
		{
			method: "PUT",
			body: { ...edit, expectedRevision: revision },
		},
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
				// Core's cloud speech PUT reports live application only through
				// `gateway_application`; unlike the sibling provider routes it
				// sends no `gateway_restarted`, so an absent flag means false.
				gateway_restarted: z.boolean().default(false),
				persisted: z.boolean().optional(),
				success: z.boolean(),
			})
			.passthrough()
	);
	if (!(result.success && result.persisted && result.configRevision)) {
		throw new Error("Cloud speech account was not saved.");
	}
	requireGatewayProviderReload(result);
}
