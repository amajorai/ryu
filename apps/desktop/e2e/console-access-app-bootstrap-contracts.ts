import type { PluginValue } from "../src/lib/api/plugin-wire-values.ts";

/** Finite empty-node bootstrap transport for the actual Desktop App proof.
 * Wire shapes follow src/lib/api clients and Core server/mod.rs handlers.
 * Authority/session reads, mutations and event streams belong to the host fixture.
 */
const reads = new Map<string, PluginValue>(
	Object.entries<PluginValue>({
		// Backend public feature flags, campaigns, approval queue and teams clients.
		"/api/feature-flags/public": { features: {} },
		"/api/campaigns/mine": { pools: [] },
		"/api/login-approvals/pending": { requests: [] },
		"/api/teams": { teams: [] },
		"/api/approvals": { approvals: [] },
		// Core cloud_environments::Snapshot::default and typed Desktop catalog clients.
		"/api/cloud-environments": {
			schemaVersion: 1,
			revision: 0,
			environments: [],
			vault: [],
		},
		"/api/output-styles": { styles: [], selected: null, forced: null },
		"/api/mcp/servers": { servers: [] },
		"/api/mcp/tools": { tools: [] },
		"/api/models/active": {
			active: "",
			engine: null,
			format: "gguf",
			ref: null,
			repo_id: null,
			default: "",
		},
		"/api/pi-config": {
			config: {
				configDir: "",
				model: null,
				provider: "",
				routing: "",
				thinkingLevel: null,
			},
		},
		"/api/pi-config/catalog": {
			apiTypes: [],
			providers: [],
			thinkingLevels: [],
		},
		"/api/agents/ryu/acp-config": {
			modes: null,
			models: null,
			configOptions: null,
		},
		"/api/agents/ryu": {
			agent: {
				id: "ryu",
				name: "Ryu",
				built_in: true,
				model: "gemma-4-e2b-it",
				tools: [],
				skills: [],
			},
		},
		"/api/drafts/list": { drafts: [] },
		// LaunchConfig defaults omit each unset optional override on the wire.
		"/api/models/gemma-4-e2b-it/launch-config": {},
		"/api/agents/catalog": { agents: [] },
		// PreferencesStore returns null for an absent preference; real readers apply defaults.
		"/api/preferences/voice-input": { value: null },
		"/api/preferences/default-local-agent-selection": { value: null },
		"/api/preferences/default-agent-selection": { value: null },
		"/api/preferences/editor-ai": { value: null },
		"/api/preferences/keybindings": { value: null },
		"/api/preferences/support-access-local-enabled": { value: null },
		"/api/preferences/support-access-local-expiry": { value: null },
		"/api/channels": { channels: [] },
		"/api/catalog": { sidecars: [] },
		"/api/sidecar/status": {
			sidecars: [],
			native_permissions: [],
			node_runtime: null,
			missing_binaries: [],
		},
		"/api/announcements": { announcements: [] },
		"/api/identities": { profiles: [] },
		"/api/sandbox/backend": { active: "wasmtime", available: [] },
		"/api/safe-mode": {
			enabled: false,
			preference_enabled: false,
			source: "off",
			user_clearable: true,
			suppressed: { kernel_plugins: 0, mcp_servers: 0, plugins: 0, skills: 0 },
		},
		"/api/plugins/catalog": { entries: [] },
		"/api/models/updates": { updates: [] },
		"/api/skills/updates": { updates: [] },
		"/api/mcp/updates": { updates: [] },
		// update::VersionInfo, connections::RawConnections and webhook ingress status.
		"/api/version": {
			ryu_version: "1.0.0",
			components: [],
			platform: "macos-aarch64",
		},
		"/api/connections": {
			client_count: 0,
			user_count: 0,
			ttl_secs: 90,
			data: [],
		},
		"/api/webhook-ingress/status": {
			kind: "own-relay",
			public_url: null,
			up: false,
		},
		// gateway.ts GatewayConfig: no configured providers, routes or account keys.
		"/api/gateway/config": {
			providers: {
				openai: null,
				anthropic: null,
				local: null,
				openrouter: null,
				core: null,
				genai: null,
			},
			routing: {
				default_provider: "openai",
				model_map: {},
				fallback_chain: [],
			},
			budgets: { users: {}, agents: {} },
			auth: { api_keys: [], require_auth: true },
			firewall: {
				enabled: false,
				custom_patterns: [],
				locked_fields: [],
				alert: "silent",
			},
			firewall_org_overlays: {},
			firewall_agent_overlays: {},
			acp: {
				idle_timeout_minutes: 5,
				max_parallel_agents: null,
				keep_computer_awake: true,
			},
			computer_use: { locked_use: false },
		},
	})
);

function matchesQuery(url: URL, expected: Record<string, string>): boolean {
	const entries = [...url.searchParams.entries()];
	return (
		entries.length === Object.keys(expected).length &&
		new Set(entries.map(([key]) => key)).size === entries.length &&
		entries.every(([key, value]) => expected[key] === value)
	);
}

/** Node-selector observations: no query, no body, and the selected node's bearer.
 * The identity fields intentionally differ across the two organization nodes.
 */
export function responseForConsoleNodeObservation(
	url: URL,
	method: string,
	authorization: string | undefined,
	body: PluginValue
): PluginValue | undefined {
	const node =
		url.origin === "http://managed-a.example.test"
			? "a"
			: url.origin === "http://managed-b.example.test"
				? "b"
				: null;
	if (
		node === null ||
		method !== "GET" ||
		url.search ||
		body !== null ||
		authorization !== `Bearer node-${node}-token`
	) {
		return undefined;
	}
	// system_info::SystemInfo: undetected hardware stays null/empty; org registration is node-owned.
	if (url.pathname === "/api/system/info") {
		return {
			hostname: `managed-${node}`,
			os: "linux",
			cpu_name: null,
			cpu_cores: null,
			physical_cores: null,
			total_ram_bytes: null,
			used_ram_bytes: null,
			ram_human: "",
			used_ram_human: "",
			total_disk_bytes: null,
			used_disk_bytes: null,
			disk_human: "",
			used_disk_human: "",
			vram_bytes: null,
			vram_human: "",
			gpu_name: null,
			unified_memory: false,
			managed: true,
			org_id: `org-${node}`,
			org_name: `Organization ${node.toUpperCase()}`,
		};
	}
	// Core gateway_status's healthy branch wraps Gateway api/health.rs's exact public health shape.
	// This is finite local transport, not a provider or remote Gateway round trip.
	if (url.pathname === "/api/gateway/status") {
		return {
			reachable: true,
			url: `http://gateway-${node}.example.test`,
			health: { status: "ok", version: "1.0.0" },
			metrics: null,
			effective_config: null,
		};
	}
	// Core system_status merges these same live handler observations.
	if (url.pathname === "/api/system/status") {
		return {
			core: { reachable: true },
			engine: {
				active: null,
				available: [],
				running: false,
				llamacpp_variant: null,
			},
			sidecars: [],
			gateway: { reachable: true },
			mesh: {
				enabled: false,
				reachable: false,
				up: false,
				backend: null,
				backend_state: "Stopped",
				control_server: null,
				magic_dns_name: null,
				tailscale_ips: [],
				tailcat_address: null,
				cloudflaredUrl: null,
				publicUrl: null,
				tunnelProvider: null,
				backendError: null,
				peers: [],
				webhook_ingress_mode: null,
			},
		};
	}
	// engine_concurrency's absent snapshots.
	if (url.pathname === "/api/engine/concurrency") {
		return {
			active_engine: null,
			admission: null,
			engine_busy_slots: null,
			engine_total_slots: null,
		};
	}
	// Core list_capabilities/list_sandboxes with no installed apps or active sandbox runs.
	if (url.pathname === "/api/capabilities") {
		return { capabilities: [], verbs: [] };
	}
	if (url.pathname === "/api/sandboxes") {
		return { sandboxes: [] };
	}
	// PreferencesStore's absent preference value; ryu_mesh::MeshStatus::default.
	if (url.pathname === "/api/preferences/speech-processing") {
		return { value: null };
	}
	// NodeSelector useTunnel reads exactly these two optional preferences after status.
	// Core get_preference returns the key and null for either unset non-default key.
	if (url.pathname === "/api/preferences/mesh-backend") {
		return { key: "mesh-backend", value: null };
	}
	if (url.pathname === "/api/preferences/mesh-login-server") {
		return { key: "mesh-login-server", value: null };
	}
	if (url.pathname === "/api/mesh/status") {
		return {
			enabled: false,
			reachable: false,
			up: false,
			backend: null,
			backend_state: "Stopped",
			control_server: null,
			magic_dns_name: null,
			tailscale_ips: [],
			tailcat_address: null,
			cloudflaredUrl: null,
			publicUrl: null,
			tunnelProvider: null,
			backendError: null,
			peers: [],
			webhook_ingress_mode: null,
		};
	}
	// server/voice.rs always lists the curated Speech Processing engine, even before install.
	if (url.pathname === "/api/voice/speech-processing-engines") {
		return {
			object: "list",
			data: [
				{
					id: "s1-mini",
					display_name: "S1-mini by Superwhisper",
					description:
						"Local transcript cleanup · punctuation, filler removal, corrections, and formatting",
					model: "s1-mini-q4_k_m",
					size_mb: 484,
					languages: ["en"],
					sidecar: "llamacpp-speech",
					installed: false,
					loaded: false,
				},
			],
		};
	}
	// server/voice.rs tts_engines includes these three built-in rows before optional Python engines.
	if (url.pathname === "/api/voice/tts-engines") {
		return {
			object: "list",
			data: [
				{
					id: "outetts",
					display_name: "OuteTTS (built-in)",
					description:
						"Local OuteTTS + WavTokenizer on llama.cpp · CPU-friendly",
					voices: [],
					default_voice: "",
					sample_rate: 24_000,
					supports_cloning: false,
					languages: ["en"],
					size_mb: 0,
					installed: true,
					loaded: false,
				},
				{
					id: "gateway",
					display_name: "Cloud (via gateway)",
					description: "Routed to this node's audio provider · no local model",
					voices: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
					default_voice: "alloy",
					sample_rate: 24_000,
					supports_cloning: false,
					languages: ["en"],
					size_mb: 0,
					installed: true,
					loaded: false,
				},
				{
					id: "audiocpp",
					display_name: "audio.cpp",
					description:
						"Native ggml audio runtime · PocketTTS with Parakeet STT · loopback managed",
					voices: ["alba"],
					default_voice: "alba",
					sample_rate: 24_000,
					supports_cloning: true,
					languages: ["en", "de", "it", "pt", "es"],
					size_mb: 1030,
					installed: false,
					loaded: false,
				},
			],
		};
	}
	return undefined;
}

export function responseForConsoleBootstrapRead(
	url: URL
): PluginValue | undefined {
	if (!url.search) {
		return reads.has(url.pathname)
			? structuredClone(reads.get(url.pathname) ?? null)
			: undefined;
	}
	// inference.ts getModelContextWindow: unknown model hides the meter.
	if (
		url.pathname === "/api/models/context-window" &&
		matchesQuery(url, { model: "gemma-4-e2b-it" })
	) {
		return { contextLength: null };
	}
	if (url.pathname === "/api/activity" && matchesQuery(url, { limit: "24" })) {
		return { items: [] };
	}
	if (
		url.pathname === "/api/catalog/sources" &&
		matchesQuery(url, { kind: "skill" })
	) {
		return { active: "", kind: "skill", sources: [] };
	}
	if (
		url.pathname === "/api/skills/catalog" &&
		matchesQuery(url, { limit: "120", source: "all" })
	) {
		return { skills: [], total: 0, next_cursor: null };
	}
	if (
		url.pathname === "/api/conversations" &&
		matchesQuery(url, { preview: "1" })
	) {
		return { conversations: [] };
	}
	if (
		url.pathname === "/api/notifications" &&
		["owner-one", "member-two"].some((user) =>
			matchesQuery(url, { user_id: user, limit: "50" })
		)
	) {
		return { notifications: [] };
	}
	if (
		url.pathname === "/api/agents/ryu/capabilities" &&
		matchesQuery(url, { model: "gemma-4-e2b-it" })
	) {
		const detected = {
			tools: false,
			reasoning: false,
			vision: false,
			diffusion: false,
		};
		return { ...detected, detected, overrides: {}, source: "default" };
	}
	if (
		url.pathname === "/api/routing/advice" &&
		matchesQuery(url, {
			agent_id: "ryu",
			model: "gemma-4-e2b-it",
			at_conversation_start: "true",
		})
	) {
		const selection = { agent_id: "ryu", model: "gemma-4-e2b-it" };
		return { original: selection, effective: selection, severity: "continue" };
	}
	if (
		url.pathname === "/api/update/check" &&
		matchesQuery(url, { channel: "stable" })
	) {
		return {
			current: "1.0.0",
			latest: "1.0.0",
			channel: "stable",
			update_available: false,
			notes: null,
			html_url: null,
			asset: null,
			tag: null,
			published_at: null,
			latest_unrestricted: "1.0.0",
			restricted_by_cutoff: false,
			cutoff_waived_for_security: false,
			cutoff_unresolved: false,
		};
	}
	return undefined;
}
