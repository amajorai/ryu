import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
import { ApiError, type ApiTarget, request } from "./client.ts";
import { requireGatewayProviderReload } from "./gateway.ts";

export type { GatewaySpeechSettings } from "./speech-settings-contracts.ts";

import {
	type GatewaySpeechEditInput,
	type GatewaySpeechSettings,
	gatewaySpeechEditResultSchema,
	gatewaySpeechSettingsSchema,
} from "./speech-settings-contracts.ts";

export async function fetchGatewaySpeechSettings(
	target: ApiTarget
): Promise<GatewaySpeechSettings | null> {
	try {
		const value = await request(
			target,
			"/api/gateway/speech-settings",
			undefined,
			gatewayJsonValueSchema
		);
		const parsed = gatewaySpeechSettingsSchema.safeParse(value);
		if (!parsed.success) {
			throw new Error(
				"This node returned invalid speech settings. Refresh or update it."
			);
		}
		return parsed.data;
	} catch (error) {
		if (error instanceof ApiError && error.status === 404) {
			return null;
		}
		throw error;
	}
}

export async function saveGatewayAnonymousSpeech(
	target: ApiTarget,
	enabled: boolean,
	revision: string,
	provider: "edge-tts" | "google-translate-tts" = "edge-tts"
): Promise<void> {
	const body: GatewaySpeechEditInput = {
		anonymousConsumerOptIn: enabled,
		expectedRevision: revision,
	};
	if (provider === "google-translate-tts") {
		body.provider = provider;
	}
	const rawResult = await request(
		target,
		"/api/gateway/speech-settings",
		{
			method: "PUT",
			body,
		},
		gatewayJsonValueSchema
	);
	const result = gatewaySpeechEditResultSchema.parse(rawResult);
	if (!(result.success && result.persisted && result.configRevision)) {
		throw new Error("Speech settings were not saved.");
	}
	requireGatewayProviderReload(result);
}
