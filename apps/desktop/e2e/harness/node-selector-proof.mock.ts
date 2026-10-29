import type { LinkMetadataPreview } from "../../lib/tauri-bridge.ts";
import type { AgentSummary } from "../../src/lib/api/agents.ts";
import {
	pluginRecord,
	pluginStringField,
} from "../../src/lib/api/plugin-wire-values.ts";
import type { Node } from "../../src/store/useNodeStore.ts";
import { type ProofJsonValue, parseProofJson } from "../fixture-json.ts";
import {
	type NodeSelectorNativeArgs,
	readProofBooleans,
	readProofDiscoveredNodes,
	readProofNodes,
	readProofNumbers,
	readProofSandboxes,
	readProofSidecars,
} from "../node-selector-proof.contracts.ts";

const NODE_LIST_KEY = "node-selector-proof-nodes";
const NODE_DEFAULT_KEY = "node-selector-proof-default";
const NODE_CLOUD_KEY = "node-selector-proof-cloud";
const NODE_SUGGESTIONS_KEY = "node-selector-proof-suggestions";
const NODE_HEALTH_KEY = "node-selector-proof-health";
const NODE_DEPENDENCIES_KEY = "node-selector-proof-dependencies";
const NODE_SIDECARS_KEY = "node-selector-proof-sidecars";
const NODE_SANDBOXES_KEY = "node-selector-proof-sandboxes";
const NODE_MESH_ENABLED_KEY = "node-selector-proof-mesh-enabled";
const NODE_DISCOVERY_KEY = "node-selector-proof-discovered";
const NATIVE_FAILURES_KEY = "node-selector-proof-native-failures";
const AGENT_AUTO_ROUTING_KEY = "node-selector-proof-agent-auto-routing";

export const ROUTING_PROOF_AGENTS: AgentSummary[] = [
	{
		avatarGlyph: null,
		avatarUrl: null,
		builtIn: true,
		createdAt: null,
		description: null,
		engine: "pi",
		id: "ryu",
		installed: true,
		installHint: null,
		latestVersion: null,
		lifecycleStatus: "active",
		locked: true,
		model: null,
		name: "Ryu",
		recommended: true,
		safetyProfile: "autonomous",
		systemPrompt: null,
		title: "Ryu",
		transport: "acp",
		version: null,
		versionStatus: null,
	},
	{
		avatarGlyph: null,
		avatarUrl: null,
		builtIn: true,
		createdAt: null,
		description: "A fixture coding agent.",
		engine: "claude",
		id: "claude-code",
		installed: true,
		installHint: null,
		latestVersion: null,
		lifecycleStatus: "active",
		locked: true,
		model: null,
		name: "Claude Code",
		recommended: false,
		safetyProfile: "approval_required",
		systemPrompt: null,
		title: "Claude Code",
		transport: "acp",
		version: null,
		versionStatus: null,
	},
	{
		avatarGlyph: null,
		avatarUrl: null,
		builtIn: false,
		createdAt: null,
		description: "A draft fixture agent excluded from routing.",
		engine: null,
		id: "draft-only",
		installed: null,
		installHint: null,
		latestVersion: null,
		lifecycleStatus: "draft",
		locked: false,
		model: null,
		name: "Draft only",
		recommended: false,
		safetyProfile: "autonomous",
		systemPrompt: null,
		title: "Draft only",
		transport: null,
		version: null,
		versionStatus: null,
	},
];

export interface NodeSelectorApiCall {
	authorization: string | null;
	body: ProofJsonValue | null;
	method: string;
	path: string;
	status: number | null;
	url: string;
}

export interface NodeSelectorNativeCall {
	args: NodeSelectorNativeArgs | null;
	command: string;
	result: "failed" | "ok";
}

export interface NodeSelectorProofSnapshot {
	apiCalls: NodeSelectorApiCall[];
	clipboardWrites: string[];
	defaultNode: string;
	externalUrls: string[];
	nativeCalls: NodeSelectorNativeCall[];
	nodes: Node[];
}

interface NodeSelectorProofState
	extends Omit<NodeSelectorProofSnapshot, "nodes" | "defaultNode"> {
	armApiFailure: (method: string, path: string, status?: number) => void;
	armClipboardFailure: () => void;
	armNativeFailure: (command: string) => void;
	clipboardFailureCount: number;
	setNodeOnline: (name: string, online: boolean) => void;
	snapshot: () => NodeSelectorProofSnapshot;
}

export interface NodeSelectorFixtureSeed {
	cloudNodes: Node[];
	defaultNode: string;
	discoveredNodes: Array<{
		latency_ms: number;
		profile?: string;
		url: string;
	}>;
	localNodes: Node[];
	meshEnabled: boolean;
	suggestedCloudNodes: Node[];
}

declare global {
	interface Window {
		__NODE_SELECTOR_PROOF__?: NodeSelectorProofState;
	}
}

function readStored<FixtureValue>(
	key: string,
	fallback: FixtureValue,
	decode: (raw: string) => FixtureValue
): FixtureValue {
	try {
		const raw = localStorage.getItem(key);
		return raw === null ? fallback : decode(raw);
	} catch {
		return fallback;
	}
}

function writeStored<FixturePayload>(key: string, value: FixturePayload): void {
	localStorage.setItem(key, JSON.stringify(value));
}

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function persistedNodes() {
	return {
		default: localStorage.getItem(NODE_DEFAULT_KEY) ?? "local",
		nodes: readStored(NODE_LIST_KEY, [], readProofNodes),
	};
}

function allKnownNodes(): Node[] {
	const localNodes = persistedNodes().nodes;
	const localUrls = new Set(
		localNodes.map((node) => node.url.replace(/\/$/, ""))
	);
	return [
		...localNodes,
		...readStored(NODE_CLOUD_KEY, [], readProofNodes).filter(
			(node) => !localUrls.has(node.url.replace(/\/$/, ""))
		),
	];
}

function nodeByName(name: string): Node | undefined {
	return [
		...persistedNodes().nodes,
		...readStored(NODE_CLOUD_KEY, [], readProofNodes),
		...readStored(NODE_SUGGESTIONS_KEY, [], readProofNodes),
	].find((node) => node.name === name);
}

function nodeOnline(url: string): boolean {
	return readStored(NODE_HEALTH_KEY, {}, readProofBooleans)[url] ?? true;
}

function sidecars(): Record<string, { running: boolean; version: string }> {
	return readStored(
		NODE_SIDECARS_KEY,
		{
			core: { running: true, version: "1.2.3" },
			gateway: { running: true, version: "1.2.3" },
			shadow: { running: true, version: "1.2.3" },
			llamacpp: { running: true, version: "b1234" },
		},
		readProofSidecars
	);
}

export function installNodeSelectorFixture(
	reset: boolean,
	seed: NodeSelectorFixtureSeed
): void {
	if (reset) {
		for (const key of [
			NODE_LIST_KEY,
			NODE_DEFAULT_KEY,
			NODE_CLOUD_KEY,
			NODE_SUGGESTIONS_KEY,
			NODE_HEALTH_KEY,
			NODE_DEPENDENCIES_KEY,
			NODE_SIDECARS_KEY,
			NODE_SANDBOXES_KEY,
			NODE_MESH_ENABLED_KEY,
			NODE_DISCOVERY_KEY,
			NATIVE_FAILURES_KEY,
			AGENT_AUTO_ROUTING_KEY,
			"ryu:node-auto-select",
			"ryu:node-selector-detail",
			"ryu:node-dismissed-cloud",
			"ryu_client_id",
		]) {
			localStorage.removeItem(key);
		}
	}
	if (reset || !localStorage.getItem(NODE_LIST_KEY)) {
		writeStored(NODE_LIST_KEY, seed.localNodes);
	}
	if (reset || !localStorage.getItem(NODE_DEFAULT_KEY)) {
		localStorage.setItem(NODE_DEFAULT_KEY, seed.defaultNode);
	}
	if (reset || !localStorage.getItem(NODE_CLOUD_KEY)) {
		writeStored(NODE_CLOUD_KEY, seed.cloudNodes);
	}
	if (reset || !localStorage.getItem(NODE_SUGGESTIONS_KEY)) {
		writeStored(NODE_SUGGESTIONS_KEY, seed.suggestedCloudNodes);
	}
	if (reset || !localStorage.getItem(NODE_HEALTH_KEY)) {
		writeStored(
			NODE_HEALTH_KEY,
			Object.fromEntries(
				[
					...seed.localNodes,
					...seed.cloudNodes,
					...seed.suggestedCloudNodes,
				].map((node) => [node.url, true])
			)
		);
	}
	if (reset || !localStorage.getItem(NODE_DEPENDENCIES_KEY)) {
		writeStored(NODE_DEPENDENCIES_KEY, {
			git: true,
			npm: true,
			python: false,
			rust: true,
		});
	}
	if (reset || !localStorage.getItem(NODE_SIDECARS_KEY)) {
		writeStored(NODE_SIDECARS_KEY, sidecars());
	}
	if (reset || !localStorage.getItem(NODE_SANDBOXES_KEY)) {
		writeStored(NODE_SANDBOXES_KEY, [
			{
				elapsed_seconds: 18,
				org_id: "org-fixture",
				run_id: "sandbox-running",
				spec: { gpu: null, mem_gib: 4, os: "linux", vcpu: 2 },
			},
		]);
	}
	if (reset || !localStorage.getItem(NODE_MESH_ENABLED_KEY)) {
		localStorage.setItem(NODE_MESH_ENABLED_KEY, String(seed.meshEnabled));
	}
	if (reset || !localStorage.getItem(NODE_DISCOVERY_KEY)) {
		writeStored(NODE_DISCOVERY_KEY, seed.discoveredNodes);
	}
	if (reset || !localStorage.getItem("ryu_client_id")) {
		localStorage.setItem("ryu_client_id", "node-selector-proof-client");
	}

	const apiCalls: NodeSelectorApiCall[] = [];
	const nativeCalls: NodeSelectorNativeCall[] = [];
	const clipboardWrites: string[] = [];
	const externalUrls: string[] = [];
	const apiFailures = new Map<string, number[]>();
	const decisionModelsFixture =
		new URLSearchParams(window.location.search).get("decisionModels") ===
		"true";
	let ollayaEnabled = false;
	let selectedDecisionProvider: ProofJsonValue = "@ryu/laya";
	const state: NodeSelectorProofState = {
		apiCalls,
		clipboardWrites,
		externalUrls,
		nativeCalls,
		armApiFailure: (method, path, status = 503) => {
			const key = `${method.toUpperCase()} ${path}`;
			apiFailures.set(key, [...(apiFailures.get(key) ?? []), status]);
		},
		armClipboardFailure: () => {
			state.clipboardFailureCount = (state.clipboardFailureCount ?? 0) + 1;
		},
		armNativeFailure: (command) => {
			const failures = readStored(NATIVE_FAILURES_KEY, {}, readProofNumbers);
			failures[command] = (failures[command] ?? 0) + 1;
			writeStored(NATIVE_FAILURES_KEY, failures);
		},
		setNodeOnline: (name, online) => {
			const node = nodeByName(name);
			if (node) {
				const health = readStored(NODE_HEALTH_KEY, {}, readProofBooleans);
				health[node.url] = online;
				writeStored(NODE_HEALTH_KEY, health);
			}
		},
		snapshot: () => ({
			apiCalls: structuredClone(apiCalls),
			clipboardWrites: structuredClone(clipboardWrites),
			defaultNode: persistedNodes().default,
			externalUrls: structuredClone(externalUrls),
			nativeCalls: structuredClone(nativeCalls),
			nodes: structuredClone(allKnownNodes()),
		}),
		clipboardFailureCount: 0,
	};
	window.__NODE_SELECTOR_PROOF__ = state;

	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: {
			writeText: async (text: string) => {
				if ((state.clipboardFailureCount ?? 0) > 0) {
					state.clipboardFailureCount = (state.clipboardFailureCount ?? 1) - 1;
					throw new Error("fixture clipboard denied");
				}
				clipboardWrites.push(text);
			},
		},
	});

	window.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = input instanceof Request ? input : null;
			const inputText = pluginStringField(input);
			const rawUrl =
				inputText === undefined
					? input instanceof URL
						? input.toString()
						: (request?.url ?? input.toString())
					: inputText;
			const url = new URL(rawUrl, window.location.href);
			const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
			const serializedBody = pluginStringField(init?.body);
			const body =
				serializedBody === undefined ? null : parseProofJson(serializedBody);
			const headers = new Headers(init?.headers ?? request?.headers);
			const record: NodeSelectorApiCall = {
				authorization: headers.get("authorization"),
				body,
				method,
				path: url.pathname + url.search,
				status: null,
				url: url.origin,
			};
			if (
				url.pathname.startsWith("/api/") ||
				url.pathname.endsWith("/control")
			) {
				apiCalls.push(record);
			}
			if (url.pathname.endsWith("/control")) {
				record.status = 404;
				return json({ error: "Island fixture unavailable" }, 404);
			}

			const planned = apiFailures.get(`${method} ${url.pathname}`);
			if (planned?.length) {
				const status = planned.shift() ?? 503;
				if (planned.length === 0) {
					apiFailures.delete(`${method} ${url.pathname}`);
				}
				record.status = status;
				return json({ error: "Node selector fixture denied" }, status);
			}

			if (
				url.pathname === "/api/health" ||
				url.pathname === "/api/system/status"
			) {
				if (!nodeOnline(url.origin)) {
					record.status = 0;
					throw new TypeError("fixture node offline");
				}
				if (url.pathname === "/api/health") {
					record.status = 200;
					return json({ capabilities: [], status: "ok", version: "1.2.3" });
				}
				const meshEnabled =
					localStorage.getItem(NODE_MESH_ENABLED_KEY) === "true";
				const live = sidecars();
				record.status = 200;
				return json({
					engine: {
						active: "llamacpp",
						running: live.llamacpp?.running ?? false,
					},
					gateway: { reachable: live.gateway?.running ?? false },
					mesh: meshEnabled
						? {
								backend: "tailscale",
								backend_state: "Running",
								enabled: true,
								magic_dns_name: "selector.fixture.ts.net",
								reachable: true,
								tailscale_ips: ["100.64.0.5"],
							}
						: { enabled: false },
					sidecars: Object.entries(live).map(([name, value]) => ({
						name,
						running: value.running,
					})),
				});
			}
			if (url.pathname === "/api/agents" && method === "GET") {
				record.status = 200;
				const autoRoutingProof =
					new URLSearchParams(window.location.search).get("agentAuto") ===
					"true";
				return json({
					agents: autoRoutingProof
						? ROUTING_PROOF_AGENTS.map((agent) => ({
								built_in: agent.builtIn,
								description: agent.description,
								engine: agent.engine,
								id: agent.id,
								installed: agent.installed,
								lifecycle_status: agent.lifecycleStatus,
								locked: agent.locked,
								name: agent.name,
								recommended: agent.recommended,
								safety_profile: agent.safetyProfile,
								title: agent.title,
								transport: agent.transport,
							}))
						: [],
				});
			}
			if (url.pathname === "/api/system/info" && method === "GET") {
				record.status = 200;
				return json({
					cpu_cores: 8,
					cpu_name: "Node selector fixture CPU",
					disk_human: "1 TB",
					gpu_name: "NVIDIA A10G",
					hostname: "selector-fixture",
					managed: url.hostname === "managed.fixture",
					org_id: "org-fixture",
					org_name: "Fixture workspace",
					os: "Linux",
					physical_cores: 4,
					ram_human: "32 GB",
					total_disk_bytes: 1_000_000_000_000,
					total_ram_bytes: 32_000_000_000,
					unified_memory: false,
					used_disk_bytes: 300_000_000_000,
					used_disk_human: "300 GB",
					used_ram_bytes: 12_000_000_000,
					used_ram_human: "12 GB",
					vram_bytes: 24_000_000_000,
					vram_human: "24 GB",
				});
			}
			if (url.pathname === "/api/dependencies/check" && method === "GET") {
				record.status = 200;
				const dependencies = readStored(
					NODE_DEPENDENCIES_KEY,
					{ git: true, npm: true, python: false, rust: true },
					readProofBooleans
				);
				return json({
					dependencies,
					all_installed: Object.values(dependencies).every(Boolean),
				});
			}
			if (url.pathname === "/api/dependencies/install" && method === "POST") {
				const dependencies = {
					git: true,
					npm: true,
					python: true,
					rust: true,
				};
				writeStored(NODE_DEPENDENCIES_KEY, dependencies);
				record.status = 200;
				return json({
					all_installed: true,
					dependencies,
					results: { python: { status: "installed", success: true } },
					success: true,
				});
			}
			if (url.pathname === "/api/catalog" && method === "GET") {
				record.status = 200;
				return json({
					sidecars: [
						{
							category: "provider",
							deprecated: false,
							description: "Fixture local chat engine.",
							display_name: "llama.cpp",
							installed_version: "b1234",
							install_state: "installed",
							latest_version: "b1234",
							name: "llamacpp",
							platforms: ["linux", "macos", "windows"],
							recommended: true,
							supported: true,
							update_available: false,
						},
						{
							category: "media",
							deprecated: false,
							description: "Fixture local image engine.",
							display_name: "Fixture image engine",
							installed_version: "1.0.0",
							install_state: "installed",
							latest_version: "1.0.0",
							name: "image-engine",
							platforms: ["linux"],
							recommended: false,
							supported: true,
							update_available: false,
						},
					],
				});
			}
			if (url.pathname === "/api/sidecar/status" && method === "GET") {
				record.status = 200;
				const sidecarState = { ...sidecars() };
				const autoRoutingProof = new URLSearchParams(
					window.location.search
				).get("agentAuto");
				const classifierState = new URLSearchParams(window.location.search).get(
					"classifier"
				);
				if (autoRoutingProof === "true" && classifierState !== "absent") {
					sidecarState["llamacpp-classify"] = {
						running: classifierState === "ready",
						version: "fixture",
					};
				}
				return json({
					sidecars: Object.entries(sidecarState).map(([name, value]) => ({
						cpu_percent: value.running ? 11 : 0,
						memory_bytes: value.running ? 640_000_000 : 0,
						name,
						// Core's `SidecarStatus.pid` is `skip_serializing_if = "Option::is_none"`
						// (apps/core/src/sidecar/mod.rs): a stopped sidecar OMITS `pid`, never
						// sends `null`, and the response codec rejects a `null` there.
						...(value.running ? { pid: 401 } : {}),
						running: value.running,
					})),
				});
			}
			const sidecarAction = url.pathname.match(
				/^\/api\/sidecar\/([^/]+)\/(start|stop)$/
			);
			if (sidecarAction && method === "POST") {
				const [, name, action] = sidecarAction;
				const next = sidecars();
				next[name] = { running: action === "start", version: "1.2.3" };
				writeStored(NODE_SIDECARS_KEY, next);
				record.status = 200;
				return json({ success: true });
			}
			if (url.pathname.startsWith("/api/setup/") && method === "POST") {
				record.status = 200;
				return json({ success: true });
			}
			if (url.pathname === "/api/engine/active" && method === "GET") {
				record.status = 200;
				return json({ active: "llamacpp" });
			}
			if (url.pathname === "/api/engine/concurrency" && method === "GET") {
				record.status = 200;
				return json({ engine_busy_slots: 1, engine_total_slots: 4 });
			}
			if (url.pathname === "/api/sandboxes" && method === "GET") {
				record.status = 200;
				return json({
					sandboxes: readStored(NODE_SANDBOXES_KEY, [], readProofSandboxes),
				});
			}
			if (url.pathname === "/api/sandboxes" && method === "POST") {
				const sandboxes = readStored(
					NODE_SANDBOXES_KEY,
					[],
					readProofSandboxes
				);
				const created = {
					elapsed_seconds: 12,
					org_id: "org-fixture",
					run_id: "sandbox-created",
					spec: { gpu: null, mem_gib: 4, os: "linux", vcpu: 2 },
				};
				writeStored(NODE_SANDBOXES_KEY, [...sandboxes, created]);
				record.status = 200;
				return json({
					backend: "fixture",
					run_id: created.run_id,
					workspace_id: "workspace-fixture",
				});
			}
			const sandboxId = url.pathname.match(/^\/api\/sandboxes\/([^/]+)$/)?.[1];
			if (sandboxId && method === "DELETE") {
				const sandboxes = readStored(
					NODE_SANDBOXES_KEY,
					[],
					readProofSandboxes
				);
				writeStored(
					NODE_SANDBOXES_KEY,
					sandboxes.filter((run) => run.run_id !== sandboxId)
				);
				record.status = 200;
				return json({});
			}
			if (url.pathname === "/api/connections" && method === "GET") {
				record.status = 200;
				return json({
					client_count: 1,
					data: [
						{
							client_id: "node-selector-cli-proof",
							client_label: "Fixture CLI",
							first_seen: Math.floor(Date.now() / 1000) - 60,
							last_seen: Math.floor(Date.now() / 1000),
							surface: "cli",
							user_id: null,
							user_name: null,
						},
					],
					ttl_secs: 90,
					user_count: 1,
				});
			}
			if (url.pathname === "/api/webhook-ingress/status" && method === "GET") {
				record.status = 200;
				return json({ kind: null, up: false });
			}
			if (url.pathname === "/api/mesh/status" && method === "GET") {
				const enabled = localStorage.getItem(NODE_MESH_ENABLED_KEY) === "true";
				record.status = 200;
				return json({
					backend: "tailscale",
					backend_state: enabled ? "Running" : "Stopped",
					enabled,
					magic_dns_name: enabled ? "selector.fixture.ts.net" : null,
					reachable: enabled,
					tailscale_ips: enabled ? ["100.64.0.5"] : [],
				});
			}
			if (url.pathname === "/api/mesh/peers" && method === "GET") {
				const enabled = localStorage.getItem(NODE_MESH_ENABLED_KEY) === "true";
				record.status = 200;
				return json({
					bearer_source: "shared-mesh-token",
					enabled,
					note: null,
					peers: enabled
						? [
								{
									bearer: "mesh-fixture-token",
									bearer_available: true,
									host_or_dns: "mesh-peer.fixture.ts.net",
									magic_dns_name: "mesh-peer.fixture.ts.net",
									name: "mesh-peer",
									online: true,
									os: "linux",
									port: 7980,
									url: "http://mesh-peer.fixture.ts.net:7980",
								},
								{
									bearer: null,
									bearer_available: false,
									host_or_dns: "needs-token.fixture.ts.net",
									magic_dns_name: "needs-token.fixture.ts.net",
									name: "needs-token",
									online: true,
									os: "linux",
									port: 7980,
									url: "http://needs-token.fixture.ts.net:7980",
								},
							]
						: [],
					reachable: enabled,
				});
			}
			if (url.pathname === "/api/sandbox/backend" && method === "GET") {
				record.status = 200;
				return json({
					active: "wasmtime",
					available: [
						{
							name: "wasmtime",
							display_name: "Wasmtime",
							detected: true,
							supported: true,
						},
					],
				});
			}
			if (url.pathname === "/api/voice/tts-engines" && method === "GET") {
				record.status = 200;
				return json({ data: [] });
			}
			if (
				url.pathname === "/api/voice/speech-processing-engines" &&
				method === "GET"
			) {
				record.status = 200;
				return json({ data: [] });
			}
			if (url.pathname === "/api/preferences/agent-auto-routing") {
				if (method === "GET") {
					const value = localStorage.getItem(AGENT_AUTO_ROUTING_KEY);
					if (value === null) {
						record.status = 404;
						return json({ error: "preference_not_found" }, 404);
					}
					record.status = 200;
					return json({ key: "agent-auto-routing", value });
				}
				if (method === "PUT") {
					const value = pluginStringField(pluginRecord(body)?.value);
					if (value === undefined) {
						record.status = 400;
						return json({ error: "preference_value_must_be_a_string" }, 400);
					}
					localStorage.setItem(AGENT_AUTO_ROUTING_KEY, value);
					record.status = 200;
					return json({ key: "agent-auto-routing", value });
				}
			}
			if (
				url.pathname === "/api/models/installed" &&
				method === "GET" &&
				new URLSearchParams(window.location.search).get("agentAuto") === "true"
			) {
				const classifierState = new URLSearchParams(window.location.search).get(
					"classifier"
				);
				record.status = 200;
				return json({
					models:
						classifierState === "unweighted"
							? []
							: [{ stem: "gemma-3-270m-it-qat-Q4_0" }],
				});
			}
			if (url.pathname.startsWith("/api/preferences/") && method === "GET") {
				record.status = 200;
				return json({ key: url.pathname.split("/").at(-1), value: null });
			}
			if (url.pathname === "/api/version" && method === "GET") {
				record.status = 200;
				return json({ ryu_version: "1.2.3" });
			}
			if (url.pathname === "/api/update/check" && method === "GET") {
				record.status = 200;
				return json({ update_available: false });
			}
			if (url.pathname === "/api/gateway/status" && method === "GET") {
				record.status = 200;
				return json({ health: { providers: [] }, status: "ok" });
			}
			if (
				url.pathname === "/api/plugins/%40ryu%2Follaya/enable" &&
				method === "POST"
			) {
				ollayaEnabled = true;
				record.status = 200;
				return json({
					app: {
						approved_grants: ["tool:http-egress:127.0.0.1"],
						created_at: "2026-09-29T00:00:00Z",
						enabled: true,
						id: "@ryu/ollaya",
						updated_at: "2026-09-29T00:00:00Z",
						version: "0.1.0",
					},
				});
			}
			if (url.pathname === "/api/capabilities/bindings" && method === "GET") {
				record.status = 200;
				return json({
					overrides:
						selectedDecisionProvider === "@ryu/laya"
							? {}
							: { "decision.typed": selectedDecisionProvider },
				});
			}
			if (url.pathname === "/api/capabilities/bindings" && method === "PUT") {
				const overrides = pluginRecord(body)?.overrides;
				selectedDecisionProvider =
					pluginRecord(overrides)?.["decision.typed"] ?? "@ryu/laya";
				record.status = 200;
				return json({ overrides: overrides ?? {} });
			}
			if (url.pathname === "/api/capabilities" && method === "GET") {
				record.status = 200;
				if (!decisionModelsFixture) {
					return json({ capabilities: [], verbs: [] });
				}
				const laya = {
					id: "@ryu/laya",
					is_default: true,
					name: "Laya Local Decisions",
					serves_route: false,
					serves_verbs: true,
					verbs: ["decision.predict"],
					version: "1.0.0",
				};
				const ollaya = {
					id: "@ryu/ollaya",
					is_default: false,
					name: "Ollaya Decision Models",
					serves_route: false,
					serves_verbs: true,
					verbs: ["decision.predict"],
					version: "1.0.0",
				};
				const providers = ollayaEnabled ? [laya, ollaya] : [laya];
				return json({
					capabilities: [
						{
							available: ollayaEnabled ? [] : [ollaya],
							bound: selectedDecisionProvider,
							capability: "decision.typed",
							decisionModel: true,
							overridden: selectedDecisionProvider !== "@ryu/laya",
							providers,
							selectable: true,
							title: "Typed Decisions",
							toolkit: false,
						},
					],
					verbs: [
						{
							capability: "decision.typed",
							id: "decision.predict",
							provider: selectedDecisionProvider,
							target:
								selectedDecisionProvider === "@ryu/ollaya"
									? "ollaya.predict"
									: "laya.predict",
						},
					],
				});
			}
			if (url.pathname === "/api/auth/get-session" && method === "GET") {
				record.status = 200;
				return json({ session: null, user: null });
			}
			if (url.pathname.startsWith("/api/")) {
				record.status = 200;
				return json({});
			}
			record.status = 404;
			return json({ error: "unhandled local UI fixture" }, 404);
		},
		{ preconnect: window.fetch.preconnect }
	);
}

export function invoke(
	command:
		| "close_current_window"
		| "open_external"
		| "open_standalone_app_window"
		| "open_tab_window",
	args?: NodeSelectorNativeArgs
): Promise<undefined>;
export function invoke(
	command: string,
	args?: NodeSelectorNativeArgs
): Promise<
	| ReturnType<typeof persistedNodes>
	| { token: string | null }
	| { online: boolean }
	| ReturnType<typeof readProofDiscoveredNodes>
	| undefined
>;
export async function invoke(
	command: string,
	args?: NodeSelectorNativeArgs
): Promise<
	| ReturnType<typeof persistedNodes>
	| { token: string | null }
	| { online: boolean }
	| ReturnType<typeof readProofDiscoveredNodes>
	| undefined
> {
	const proof = window.__NODE_SELECTOR_PROOF__;
	if (!proof) {
		throw new Error("Node selector fixture was not initialized");
	}
	const failures = readStored(NATIVE_FAILURES_KEY, {}, readProofNumbers);
	if ((failures[command] ?? 0) > 0) {
		failures[command] -= 1;
		writeStored(NATIVE_FAILURES_KEY, failures);
		proof.nativeCalls.push({
			args: structuredClone(args ?? null),
			command,
			result: "failed",
		});
		throw new Error(`fixture refused ${command}`);
	}
	if (command === "add_node") {
		const name = pluginStringField(args?.name)?.trim() ?? "";
		const url = pluginStringField(args?.url)?.trim() ?? "";
		let error: Error | null = null;
		try {
			const parsed = new URL(url);
			if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) {
				error = new Error("Node URL must use http or https");
			}
		} catch {
			error = new Error("Invalid node URL");
		}
		if (
			!error &&
			persistedNodes().nodes.some(
				(node) => node.name.toLowerCase() === name.toLowerCase()
			)
		) {
			error = new Error(`Node ${name} already exists`);
		}
		if (error) {
			proof.nativeCalls.push({
				args: structuredClone(args ?? null),
				command,
				result: "failed",
			});
			throw error;
		}
	}
	proof.nativeCalls.push({
		args: structuredClone(args ?? null),
		command,
		result: "ok",
	});
	if (command === "list_nodes") {
		return persistedNodes();
	}
	if (command === "local_node_token") {
		return {
			token:
				persistedNodes().nodes.find((node) => node.name === "local")?.token ??
				null,
		};
	}
	if (command === "set_default_node") {
		localStorage.setItem(NODE_DEFAULT_KEY, String(args?.name ?? "local"));
		return undefined;
	}
	if (command === "add_node") {
		const name = pluginStringField(args?.name)?.trim() ?? "";
		const url = pluginStringField(args?.url)?.trim() ?? "";
		const token = pluginStringField(args?.token) ?? null;
		const nodes = persistedNodes().nodes;
		writeStored(NODE_LIST_KEY, [...nodes, { name, url, token }]);
		const health = readStored(NODE_HEALTH_KEY, {}, readProofBooleans);
		health[url] ??= true;
		writeStored(NODE_HEALTH_KEY, health);
		return undefined;
	}
	if (command === "remove_node") {
		const name = String(args?.name ?? "");
		writeStored(
			NODE_LIST_KEY,
			persistedNodes().nodes.filter((node) => node.name !== name)
		);
		if (localStorage.getItem(NODE_DEFAULT_KEY) === name) {
			localStorage.setItem(NODE_DEFAULT_KEY, "local");
		}
		return undefined;
	}
	if (command === "test_node") {
		const node = nodeByName(String(args?.name ?? ""));
		return { online: node ? nodeOnline(node.url) : false };
	}
	if (command === "discover_lan_nodes") {
		return readStored(NODE_DISCOVERY_KEY, [], readProofDiscoveredNodes);
	}
	if (command === "open_external") {
		proof.externalUrls.push(String(args?.url ?? ""));
	}
	return undefined;
}

export function openExternal(url: string): Promise<void> {
	return invoke("open_external", { url });
}

export function openTabWindow(options: {
	conversationId?: string;
	entityKey?: string;
	node?: string;
	path?: string;
	title?: string;
}): Promise<void> {
	return invoke("open_tab_window", {
		conversationId: options.conversationId ?? null,
		entityKey: options.entityKey ?? null,
		node: options.node ?? null,
		path: options.path ?? null,
		title: options.title ?? null,
	});
}

// The fixture serves no public pages, so the shell's Open Graph fetch fails the
// way the native command does when the page is unreachable.
export async function previewLinkMetadata(
	url: string
): Promise<LinkMetadataPreview> {
	const proof = window.__NODE_SELECTOR_PROOF__;
	if (!proof) {
		throw new Error("Node selector fixture was not initialized");
	}
	proof.nativeCalls.push({
		args: { url },
		command: "preview_link_metadata",
		result: "failed",
	});
	throw new Error(`fixture serves no page to preview at ${url}`);
}

export function openStandaloneAppWindow(options: {
	appId: string;
	title: string;
}): Promise<void> {
	return invoke("open_standalone_app_window", {
		appId: options.appId,
		title: options.title,
	});
}

export function closeCurrentWindow(): Promise<void> {
	return invoke("close_current_window");
}

export function startRyuCore() {
	return invoke("start_ryu_core");
}

export function getRyuStatus() {
	return invoke("get_ryu_status");
}

export async function restartRyuCore() {
	return invoke("restart_ryu_core");
}

export async function relaunch(): Promise<void> {
	return undefined;
}

export async function listen(): Promise<() => void> {
	return () => undefined;
}

export async function open(): Promise<null> {
	return null;
}

export async function save(): Promise<null> {
	return null;
}

export async function exit(): Promise<void> {
	return undefined;
}

export class Resource {
	readonly rid: number;

	constructor(rid: number) {
		this.rid = rid;
	}
}
