import { z } from "zod";

declare const window: Window;

import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { LOCAL_FALLBACK, useNodeStore } from "../../src/store/useNodeStore.ts";
import { parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

const NATIVE_STATE_KEY = "connections-tab-proof:native";
const CALLS_KEY = "connections-tab-proof:calls";
const ACCOUNTS_KEY = "connections-tab-proof:accounts";
const CONNECTIONS_KEY = "connections-tab-proof:connected-clients";
const SESSION_KEY = "ryu_session_token";

interface ProofNode {
	managed?: boolean;
	name: string;
	orgId?: string | null;
	serverId?: string | null;
	token: string | null;
	url: string;
	userJwt?: string | null;
}

interface NativeState {
	defaultNode: string;
	nodes: ProofNode[];
}

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
}

interface CapturedTauriCall {
	args: unknown;
	command: string;
}

interface ProofConnection {
	client_id: string;
	client_label: string | null;
	first_seen: number;
	last_seen: number;
	surface: string | null;
	user_id: string | null;
	user_name: string | null;
}

interface FixtureState {
	armFailure: (key: string) => void;
	consumeFailure: (key: string) => boolean;
	recordRequest: (request: CapturedRequest) => void;
	replaceAccounts: (accounts: unknown[]) => void;
	replaceConnections: (connections: ProofConnection[]) => void;
	snapshot: () => {
		accounts: unknown[];
		calls: CapturedRequest[];
		connections: ProofConnection[];
		defaultNode: string;
		nodes: ProofNode[];
		sshProfiles: unknown;
		tauriCalls: CapturedTauriCall[];
	};
}

declare global {
	interface Window {
		__connectionsTabProof: FixtureState;
	}
}

const nodeSchema = z.object({
	managed: z.boolean().optional(),
	name: z.string(),
	orgId: z.string().nullable().optional(),
	serverId: z.string().nullable().optional(),
	token: z.string().nullable(),
	url: z.string(),
	userJwt: z.string().nullable().optional(),
});
const nativeStateSchema = z.object({
	defaultNode: z.string(),
	nodes: z.array(nodeSchema),
});
const accountSchema = z.object({
	accountId: z.string(),
	createdAt: z.string(),
	id: z.string(),
	providerId: z.string(),
});
const accountsSchema = z.array(accountSchema);
const connectionSchema = z.object({
	client_id: z.string(),
	client_label: z.string().nullable(),
	first_seen: z.number(),
	last_seen: z.number(),
	surface: z.string().nullable(),
	user_id: z.string().nullable(),
	user_name: z.string().nullable(),
});
const connectionsSchema = z.array(connectionSchema);
const callsSchema = z.object({
	requests: z.array(
		z.object({ body: z.json(), method: z.string(), path: z.string() })
	),
	tauriCalls: z.array(z.object({ args: z.json(), command: z.string() })),
});

function readJson<T>(key: string, fallback: T, schema: z.ZodType<T>): T {
	try {
		const raw = localStorage.getItem(key);
		return raw === null ? fallback : schema.parse(JSON.parse(raw));
	} catch {
		return fallback;
	}
}

function writeJson<FixturePayload>(key: string, value: FixturePayload): void {
	localStorage.setItem(key, JSON.stringify(value));
}

function readNativeState(): NativeState {
	return readJson(
		NATIVE_STATE_KEY,
		{ defaultNode: "local", nodes: [LOCAL_FALLBACK] },
		nativeStateSchema
	);
}

function jsonResponse<FixturePayload>(
	body: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function parseBody(body: BodyInit | null | undefined) {
	if (!isNativeText(body)) {
		return null;
	}
	try {
		return parseProofJson(body);
	} catch {
		return body;
	}
}

function installFixtures(): void {
	const params = new URLSearchParams(window.location.search);
	if (params.get("reset") === "true") {
		for (const key of [
			NATIVE_STATE_KEY,
			CALLS_KEY,
			ACCOUNTS_KEY,
			CONNECTIONS_KEY,
			SESSION_KEY,
		]) {
			localStorage.removeItem(key);
		}
		params.delete("reset");
		window.history.replaceState(
			null,
			"",
			`${window.location.pathname}${params.size ? `?${params}` : ""}`
		);
	}
	if (localStorage.getItem(NATIVE_STATE_KEY) === null) {
		const nativeState: NativeState = {
			defaultNode: "local",
			nodes:
				params.get("emptyNodes") === "true"
					? [LOCAL_FALLBACK]
					: [
							LOCAL_FALLBACK,
							{
								name: "Private build node",
								token: "private-node-token",
								url: "https://build.internal:7980",
							},
							{
								managed: true,
								name: "Managed cloud node",
								orgId: "proof-org",
								serverId: "proof-server",
								token: null,
								url: "https://cloud.example.test:7980",
								userJwt: "fixture-managed-user-jwt",
							},
						],
		};
		writeJson(NATIVE_STATE_KEY, nativeState);
	}
	if (localStorage.getItem(CALLS_KEY) === null) {
		writeJson(CALLS_KEY, { requests: [], tauriCalls: [] });
	}
	if (localStorage.getItem(ACCOUNTS_KEY) === null) {
		writeJson(ACCOUNTS_KEY, [
			{
				accountId: "google-account-1",
				createdAt: "2026-09-01T00:00:00.000Z",
				id: "google-row-1",
				providerId: "google",
			},
		]);
	}
	if (localStorage.getItem(CONNECTIONS_KEY) === null) {
		writeJson(CONNECTIONS_KEY, []);
	}
	if (localStorage.getItem("ryu_client_id") === null) {
		localStorage.setItem("ryu_client_id", "connections-proof-desktop");
	}
	// The auth and billing endpoints remain deterministic local fixtures. The
	// opaque value only represents an authenticated account inside this harness.
	localStorage.setItem(SESSION_KEY, "connections-tab-proof-session");

	let armedFailure =
		params.get("connectionsError") === "true" ? "connections" : "";
	const state: FixtureState = {
		armFailure: (key) => {
			armedFailure = key;
		},
		consumeFailure: (key) => {
			if (armedFailure !== key) {
				return false;
			}
			armedFailure = "";
			return true;
		},
		recordRequest: (request) => {
			const calls = readJson(
				CALLS_KEY,
				{ requests: [], tauriCalls: [] },
				callsSchema
			);
			calls.requests.push(callsSchema.shape.requests.element.parse(request));
			writeJson(CALLS_KEY, calls);
		},
		replaceAccounts: (accounts) => writeJson(ACCOUNTS_KEY, accounts),
		replaceConnections: (connections) =>
			writeJson(CONNECTIONS_KEY, connections),
		snapshot: () => {
			const native = readNativeState();
			const calls = readJson(
				CALLS_KEY,
				{ requests: [], tauriCalls: [] },
				callsSchema
			);
			return {
				accounts: readJson(ACCOUNTS_KEY, [], accountsSchema),
				calls: structuredClone(calls.requests),
				connections: readJson(CONNECTIONS_KEY, [], connectionsSchema),
				defaultNode: native.defaultNode,
				nodes: structuredClone(native.nodes),
				sshProfiles: localStorage.getItem("ryu:ssh-connections"),
				tauriCalls: structuredClone(calls.tauriCalls),
			};
		},
	};
	window.__connectionsTabProof = state;

	const recordTauriCall = (
		command: string,
		args: z.infer<typeof callsSchema>["tauriCalls"][number]["args"]
	): void => {
		const calls = readJson(
			CALLS_KEY,
			{ requests: [], tauriCalls: [] },
			callsSchema
		);
		calls.tauriCalls.push({ args, command });
		writeJson(CALLS_KEY, calls);
	};

	const bridge = {
		invoke: async (
			command: string,
			args?: { name?: string; url?: string; token?: string | null }
		) => {
			recordTauriCall(command, args ?? null);
			if (armedFailure === command) {
				armedFailure = "";
				throw new Error(`Fixture denied ${command}`);
			}
			const current = readNativeState();
			if (command === "list_nodes") {
				return structuredClone({
					default: current.defaultNode,
					nodes: current.nodes,
				});
			}
			if (command === "local_node_token") {
				return { source: "file", token: "fixture-owner-node-token" };
			}
			if (command === "get_lan_ip") {
				return "192.168.10.24";
			}
			if (command === "set_default_node") {
				const name = args?.name;
				if (!isNativeText(name)) {
					throw new Error("Expected a node name");
				}
				writeJson(NATIVE_STATE_KEY, { ...current, defaultNode: name });
				return undefined;
			}
			if (command === "add_node") {
				const name = args?.name;
				const url = args?.url;
				const token = args?.token;
				if (
					!(
						isNativeText(name) &&
						isNativeText(url) &&
						(isNativeText(token) || token === null)
					)
				) {
					throw new Error("Invalid node payload");
				}
				writeJson(NATIVE_STATE_KEY, {
					...current,
					nodes: [...current.nodes, { name, token, url }],
				});
				return undefined;
			}
			if (command === "remove_node") {
				const name = args?.name;
				if (!isNativeText(name)) {
					throw new Error("Expected a node name");
				}
				const nodes = current.nodes.filter((node) => node.name !== name);
				writeJson(NATIVE_STATE_KEY, {
					defaultNode:
						current.defaultNode === name ? "local" : current.defaultNode,
					nodes,
				});
				return undefined;
			}
			return undefined;
		},
		transformCallback: () => 1,
	};
	Object.defineProperty(window, "__TAURI_INTERNALS__", {
		value: bridge,
		configurable: true,
		writable: true,
	});

	const realFetch = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const rawUrl = input instanceof Request ? input.url : String(input);
		const url = new URL(rawUrl, window.location.href);
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		const bodyInit =
			init?.body ??
			(input instanceof Request ? await input.clone().text() : null);
		const body = parseBody(bodyInit);
		if (
			url.pathname.startsWith("/api/") &&
			!url.pathname.startsWith("/api/auth/")
		) {
			const calls = readJson(
				CALLS_KEY,
				{ requests: [], tauriCalls: [] },
				callsSchema
			);
			calls.requests.push({ body, method, path: url.pathname });
			writeJson(CALLS_KEY, calls);
		}

		if (url.pathname.startsWith("/api/auth/")) {
			return realFetch(input, init);
		}
		if (url.pathname === "/api/gateway/status") {
			return jsonResponse({
				health: {
					auth_required: false,
					providers: [],
					status: "ok",
					version: "connections-proof",
				},
				metrics: {},
				reachable: true,
				url: LOCAL_FALLBACK.url,
			});
		}
		if (url.pathname === "/api/gateway/config") {
			return jsonResponse({ providers: {} });
		}
		if (url.pathname === "/api/plugins") {
			return jsonResponse({ apps: [] });
		}
		if (url.pathname === "/api/plugins/contributions") {
			return jsonResponse({ settings_tabs: [] });
		}
		if (url.pathname === "/api/connections") {
			if (state.consumeFailure("connections")) {
				return jsonResponse({ message: "Presence service unavailable" }, 503);
			}
			const connections = readJson(CONNECTIONS_KEY, [], connectionsSchema);
			return jsonResponse({
				client_count: connections.length,
				data: connections,
				ttl_secs: 90,
				user_count: new Set(
					connections
						.map((connection) => connection.user_id)
						.filter((userId) => userId !== null)
				).size,
			});
		}
		if (url.pathname === "/api/pair/requests") {
			return jsonResponse({ requests: [] });
		}
		if (url.pathname === "/api/pair/clients") {
			return jsonResponse({ clients: [] });
		}
		if (url.pathname === "/api/preferences/cloud-sync-enabled") {
			if (method === "PUT") {
				const preference = z.object({ value: z.string() }).safeParse(body);
				const value = preference.success ? preference.data.value : "false";
				return jsonResponse({ key: "cloud-sync-enabled", value });
			}
			return jsonResponse({ key: "cloud-sync-enabled", value: "false" });
		}
		if (url.pathname === "/api/node/auth") {
			return jsonResponse({ required: false });
		}
		if (url.pathname === "/api/billing/trial") {
			return jsonResponse({ firstLaunchAt: null });
		}
		if (url.pathname === "/api/billing/subscription-status") {
			return jsonResponse({ entitlement: null, lifetime: null });
		}
		if (url.pathname === "/api/upsell/state") {
			return jsonResponse({ lastUpsellShownAt: "2026-09-25T00:00:00.000Z" });
		}
		if (url.pathname === "/api/upsell/pitch") {
			return jsonResponse({ cards: [] });
		}
		if (url.pathname.startsWith("/api/")) {
			return jsonResponse({});
		}
		return realFetch(input, init);
	};

	const native = readNativeState();
	useNodeStore.setState({
		activeNodeOnline: null,
		cloudNodes: [],
		defaultNode: native.defaultNode,
		localNodes: native.nodes,
		nodes: native.nodes,
	});
	void useNodeStore.getState().refresh();
}

installFixtures();

const [{ EntitlementProvider }, { GatewayDialog }] = await Promise.all([
	import("../../src/contexts/entitlement-context.tsx"),
	import("../../src/components/gateway/GatewayDialog.tsx"),
]);

const queryClient = new QueryClient({
	defaultOptions: {
		queries: { refetchOnWindowFocus: false, retry: false },
	},
});

function ProofSurface() {
	return (
		<QueryClientProvider client={queryClient}>
			<I18nProvider>
				<MemoryRouter>
					<AppSurfaceProvider surface="desktop">
						<EntitlementProvider>
							<ThemeProvider
								attribute="class"
								defaultTheme="light"
								enableSystem
							>
								<Toaster />
								<GatewayDialog
									defaultSection="overview"
									onOpenChange={() => undefined}
									open
								/>
							</ThemeProvider>
						</EntitlementProvider>
					</AppSurfaceProvider>
				</MemoryRouter>
			</I18nProvider>
		</QueryClientProvider>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Connections proof root not found");
}

document.documentElement.classList.add("dark");
createRoot(root).render(<ProofSurface />);
document.body.dataset.harnessReady = "1";
