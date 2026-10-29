import { useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { ByokCard } from "../../src/components/gateway/ByokCard.tsx";
import type {
	ByokProvider,
	GatewayProvidersConfig,
} from "../../src/lib/api/gateway.ts";
import { fetchGatewayConfig } from "../../src/lib/api/gateway.ts";
import "../../src/index.css";

const providerIds: ByokProvider[] = [
	"openai",
	"anthropic",
	"openrouter",
	"gemini",
];
const params = new URL(window.location.href).searchParams;
const initialConfigured = params.get("configured") === "true";
type ByokWriteStore = "gateway" | "keychain";
type ByokWriteOperation = "delete" | "set";
/** One write in the order the card performed it, across both stores. */
type ByokWriteOrderEntry =
	`${ByokWriteStore}:${ByokWriteOperation}:${ByokProvider}`;
interface ByokIntegrationCapturedState {
	configReads: number;
	credentials: Partial<Record<ByokProvider, string>>;
	failGatewayWrite: boolean;
	failSecretDelete: boolean;
	failSecretWrite: boolean;
	gatewayWrites: Array<{ api_key: string | null; provider: ByokProvider }>;
	secretCalls: Array<{
		key?: string;
		operation: ByokWriteOperation;
		provider: ByokProvider;
	}>;
	writeOrder: ByokWriteOrderEntry[];
}

const state: ByokIntegrationCapturedState = {
	credentials: Object.fromEntries(
		providerIds.map((provider) => [
			provider,
			initialConfigured ? `${provider}-existing-key` : undefined,
		])
	),
	failGatewayWrite: params.get("failGateway") === "true",
	failSecretDelete: params.get("failSecretDelete") === "true",
	failSecretWrite: params.get("failSecretWrite") === "true",
	configReads: 0,
	gatewayWrites: [],
	secretCalls: [],
	writeOrder: [],
};

declare global {
	interface Window {
		__gatewayByokIntegrationProof: typeof state;
	}
}

window.__gatewayByokIntegrationProof = state;

function providersView(): GatewayProvidersConfig {
	return {
		anthropic: state.credentials.anthropic
			? { api_key: "***", base_url: "https://api.anthropic.com" }
			: null,
		core: null,
		genai: state.credentials.gemini ? { keys: ["gemini"] } : { keys: [] },
		local: null,
		openai: state.credentials.openai
			? { api_key: "***", base_url: "https://api.openai.com" }
			: null,
		openrouter: state.credentials.openrouter
			? { api_key: "***", base_url: "https://openrouter.ai/api/v1" }
			: null,
	};
}

window.fetch = async (input, init) => {
	const requestUrl = input instanceof Request ? input.url : String(input);
	const url = new URL(requestUrl, window.location.origin);
	if (
		url.pathname === "/api/gateway/config" &&
		(init?.method ?? "GET") === "GET"
	) {
		state.configReads += 1;
		// The Gateway always serves its auth section beside the providers; the
		// config response codec requires both.
		return Response.json({
			auth: { api_keys: [], require_auth: false },
			providers: providersView(),
		});
	}
	if (url.pathname !== "/api/gateway/providers" || init?.method !== "PUT") {
		return Response.json({ error: "Unexpected request" }, { status: 404 });
	}
	const body = z
		.object({
			api_key: z.string().nullable().optional(),
			provider: z
				.enum(["openai", "anthropic", "openrouter", "gemini"])
				.optional(),
		})
		.parse(JSON.parse(String(init.body ?? "{}")));
	if (!body.provider || body.api_key === undefined) {
		return Response.json({ error: "Invalid provider update" }, { status: 400 });
	}
	state.gatewayWrites.push({ api_key: body.api_key, provider: body.provider });
	state.writeOrder.push(
		`gateway:${body.api_key === null ? "delete" : "set"}:${body.provider}`
	);
	if (state.failGatewayWrite) {
		return Response.json(
			{ error: "Gateway config write denied" },
			{ status: 500 }
		);
	}
	if (body.api_key === null) {
		delete state.credentials[body.provider];
	} else {
		state.credentials[body.provider] = body.api_key;
	}
	return Response.json({ success: true, gateway_restarted: true });
};

function ProofSurface() {
	const [providers, setProviders] =
		useState<GatewayProvidersConfig>(providersView);
	const managed = params.get("managed") === "true";
	const canConfigure = params.get("canConfigure") !== "false";
	const target = { token: null, url: "http://gateway.test:7980" };
	return (
		<main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
			<h1 className="font-semibold text-2xl">
				Gateway provider key integration
			</h1>
			<ByokCard
				canConfigure={canConfigure}
				managed={managed}
				onRefresh={async () => {
					const config = await fetchGatewayConfig(target);
					setProviders(config.providers ?? providersView());
				}}
				providers={providers}
				target={target}
			/>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<ProofSurface />);
