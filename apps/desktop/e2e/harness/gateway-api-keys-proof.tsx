import { z } from "zod";

declare const window: Window;

import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { createRoot } from "react-dom/client";
import { ApiSection } from "../../src/components/gateway/ApiSection.tsx";
import type { GatewayConfig } from "../../src/lib/api/gateway.ts";
import "../../src/index.css";

const ConfigSchema = z.object({
	auth: z.object({
		api_keys: z.array(
			z.object({
				key: z.string(),
				name: z.string(),
				trusted_forwarder: z.boolean(),
			})
		),
		require_auth: z.boolean().optional(),
	}),
});
interface ApiKeyProofState {
	config: Pick<GatewayConfig, "auth">;
	createFailure: boolean;
	lastWrite: z.infer<typeof ConfigSchema> | null;
	revokeFailure: boolean;
}
const state: ApiKeyProofState = {
	config: {
		auth: {
			api_keys: [
				{
					key: "sk-ryu-existing-secret",
					name: "Cursor",
					trusted_forwarder: false,
				},
			],
			require_auth: true,
		},
	},
	createFailure: false,
	lastWrite: null,
	revokeFailure: false,
};

declare global {
	interface Window {
		__gatewayApiKeyProof: typeof state;
	}
}

window.__gatewayApiKeyProof = state;
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = isNativeText(input)
		? input
		: input instanceof Request
			? input.url
			: input.toString();
	if (!url.endsWith("/api/gateway/config")) {
		return new Response(JSON.stringify({ error: "Unexpected request" }), {
			headers: { "Content-Type": "application/json" },
			status: 404,
		});
	}
	if ((init?.method ?? "GET") === "GET") {
		const redacted = structuredClone(state.config);
		if (redacted.auth?.api_keys) {
			redacted.auth.api_keys = redacted.auth.api_keys.map((entry) => ({
				...entry,
				key: "***",
			}));
		}
		return Response.json(redacted);
	}
	const patch = ConfigSchema.parse(JSON.parse(String(init?.body ?? "{}")));
	state.lastWrite = patch;
	if (
		state.createFailure &&
		patch.auth?.api_keys?.some((key) => key.name !== "Cursor")
	) {
		return Response.json({ error: "Key store unavailable" }, { status: 500 });
	}
	if (state.revokeFailure && patch.auth?.api_keys?.length === 0) {
		return Response.json({ error: "Revoke denied" }, { status: 500 });
	}
	state.config = {
		...state.config,
		...patch,
		auth: { ...state.config.auth, ...patch.auth },
	};
	return Response.json({ ok: true });
};

createRoot(document.getElementById("root")!).render(
	<main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
		<h1 className="font-semibold text-2xl">Gateway API</h1>
		<ApiSection
			managed={new URL(window.location.href).searchParams.has("managed")}
			reachable={false}
			statusUrl="http://gateway.test:7980"
			target={{ token: null, url: "http://gateway.test:7980" }}
		/>
	</main>
);
