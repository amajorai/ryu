import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import { type Node, useNodeStore } from "../../src/store/useNodeStore.ts";

interface ApiCall {
	authorization: string | null;
	body: { backend?: string; value?: string } | null;
	method: string;
	path: string;
}

interface Failure {
	message: string;
	remaining: number;
	status: number;
}

export interface GatewayIntegrationsProofState {
	calls: ApiCall[];
	failures: Record<string, Failure>;
	ingress: { available: string[]; backend: string; default: string };
	preferences: Record<string, string>;
}

declare global {
	interface Window {
		__GATEWAY_INTEGRATIONS_PROOF__?: GatewayIntegrationsProofState;
		__GATEWAY_INTEGRATIONS_STORES__?: {
			openSettings: () => void;
			snapshot: () => {
				gatewayOpen: boolean;
				gatewaySection: string;
				settingsOpen: boolean;
			};
		};
	}
}

function createState(): GatewayIntegrationsProofState {
	const search = new URLSearchParams(window.location.search);
	return {
		calls: [],
		failures: {},
		ingress: {
			available: ["ryu-relay", "tailscale-funnel", "cloudflared", "own-relay"],
			backend: search.get("backend") ?? "ryu-relay",
			default: "ryu-relay",
		},
		preferences: {
			"hf-token": "hf-existing-token",
			"aa-api-key": "aa-existing-key",
			"aa-mode": "cached",
			"webhook.ingress.url": "",
		},
	};
}

const state = window.__GATEWAY_INTEGRATIONS_PROOF__ ?? createState();

window.__GATEWAY_INTEGRATIONS_PROOF__ = state;

function proofNode(): Node {
	return {
		name: "Integrations proof node",
		token: "integrations-proof-token",
		url: "http://integrations.test:7980",
	};
}

// Exercise the real callable Zustand store: nested settings panels use its
// selector hook as well as the imperative getState interface.
const node = proofNode();
useNodeStore.setState({
	nodes: [node],
	defaultNode: node.name,
	tabOverrides: {},
});

function json<FixturePayload>(value: FixturePayload, status = 200): Response {
	return Response.json(value, { status });
}

export function installIntegrationsProofFetch(): () => void {
	const originalFetch = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const url = isNativeText(input)
			? new URL(input, window.location.href)
			: input instanceof URL
				? input
				: new URL(input.url);
		if (!url.pathname.startsWith("/api/")) {
			return originalFetch(input, init);
		}
		const method = (init?.method ?? "GET").toUpperCase();
		let body: { backend?: string; value?: string } | null = null;
		if (isNativeText(init?.body)) {
			body = z
				.object({
					backend: z.string().optional(),
					value: z.string().optional(),
				})
				.parse(JSON.parse(init.body));
		}
		const headers = new Headers(init?.headers);
		const path = url.pathname;
		state.calls.push({
			authorization: headers.get("Authorization"),
			body,
			method,
			path,
		});
		const failureKey = `${method} ${path}`;
		const failure = state.failures[failureKey];
		if (failure && failure.remaining > 0) {
			failure.remaining -= 1;
			return json({ error: failure.message }, failure.status);
		}

		if (method === "GET" && path === "/api/gateway/config") {
			return json({
				composioBillingActive: {
					zeroDataRetention: false,
					baa: false,
					ipAllowlist: false,
				},
			});
		}
		if (method === "GET" && path === "/api/webhook-ingress/backend") {
			if (new URLSearchParams(window.location.search).has("oldCore")) {
				return json({ error: "Unknown route" }, 404);
			}
			return json(state.ingress);
		}
		const preference = path.match(/^\/api\/preferences\/(.+)$/u);
		if (preference) {
			const key = decodeURIComponent(preference[1] ?? "");
			if (method === "GET") {
				return json({ value: state.preferences[key] ?? null });
			}
			if (method === "PUT") {
				const value = isNativeText(body?.value) ? body.value : "";
				state.preferences[key] = value;
				return json({ ok: true });
			}
		}
		if (method === "POST" && path === "/api/webhook-ingress/backend") {
			const backend = isNativeText(body?.backend) ? body.backend : "";
			state.ingress.backend = backend;
			return json({ ok: true, backend });
		}
		return json({ error: `Unexpected proof request: ${method} ${path}` }, 404);
	};
	return () => {
		window.fetch = originalFetch;
	};
}
