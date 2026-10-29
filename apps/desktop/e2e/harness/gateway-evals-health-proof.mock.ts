declare const window: Window;

import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { LinkMetadataPreview } from "../../lib/tauri-bridge.ts";
import { type ProofJsonRecord, parseProofJson } from "../fixture-json.ts";

interface CapturedCall {
	args?: ProofJsonRecord;
	body: unknown;
	method: string;
	path: string;
}

interface ProofState {
	coreStatus: string;
	evalAuthorization: Array<string | null>;
	evalRequests: CapturedCall[];
	failEvalOnce: boolean;
	failSidecarStart: boolean;
	requests: CapturedCall[];
	safeModeSentinel: boolean;
	tauriCalls: Array<{ args?: ProofJsonRecord; command: string }>;
}

declare global {
	interface Window {
		__gatewayEvalsHealthProof: {
			armEvalFailure: () => void;
			setCoreStatus: (status: string) => void;
			snapshot: () => {
				coreStatus: string;
				evalAuthorization: Array<string | null>;
				evalRequests: CapturedCall[];
				requests: CapturedCall[];
				tauriCalls: Array<{ args?: ProofJsonRecord; command: string }>;
			};
		};
	}
}

const params = new URLSearchParams(window.location.search);
const state: ProofState = {
	evalAuthorization: [],
	coreStatus: params.get("core") ?? "running",
	evalRequests: [],
	failEvalOnce: params.get("failFirstEval") === "true",
	failSidecarStart: params.get("failSidecarStart") === "true",
	requests: [],
	safeModeSentinel: false,
	tauriCalls: [],
};

function snapshot() {
	return {
		coreStatus: state.coreStatus,
		evalAuthorization: [...state.evalAuthorization],
		evalRequests: structuredClone(state.evalRequests),
		requests: structuredClone(state.requests),
		tauriCalls: structuredClone(state.tauriCalls),
	};
}

window.__gatewayEvalsHealthProof = {
	armEvalFailure: () => {
		state.failEvalOnce = true;
	},
	setCoreStatus: (status) => {
		state.coreStatus = status;
	},
	snapshot,
};

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function gatewayConfig() {
	return {
		acp: {},
		auth: {},
		budgets: { agents: {}, users: {} },
		computer_use: { locked_use: false },
		firewall: {
			enabled: true,
			scan_inbound: true,
			scan_outbound: true,
			log_detections: true,
			redact_pii: true,
			redact_secrets: true,
			wrap_untrusted_tool_results: true,
			policy: "block",
			custom_patterns: [],
			locked_fields: [],
		},
		firewall_agent_overlays: {},
		firewall_org_overlays: {},
		providers: {},
		routing: {},
	};
}

function doctorReport() {
	return {
		checkedAt: "2026-09-26T00:00:00Z",
		counts: { errors: 0, info: 0, warnings: 0 },
		findings: [],
	};
}

function aggregate() {
	return {
		latency_available_cases: 3,
		mean_latency: 0.8,
		mean_overall: 0.9,
		mean_substring_match: 0.6,
		mean_token_efficiency: 0.7,
		policy_available_cases: 3,
		policy_pass_rate: 2 / 3,
		total_cases: 3,
	};
}

function evalResult() {
	return {
		aggregate: aggregate(),
		cases: [
			{
				assertion_score: 1,
				assertions: [],
				assertions_pass: true,
				latency_available: true,
				latency_score: 0.8,
				overall: 0.9,
				policy_available: true,
				policy_pass: true,
				prompt: "What is 2 + 2?",
				response_text: "4",
				substring_match: 1,
				token_efficiency: 0.7,
			},
			{
				assertion_score: 1,
				assertions: [],
				assertions_pass: true,
				latency_available: false,
				latency_score: 0,
				overall: 0.8,
				policy_available: false,
				policy_pass: true,
				prompt: "Name the primary color of a clear daytime sky.",
				response_text: "Blue",
				substring_match: null,
				token_efficiency: 0.6,
			},
		],
	};
}

window.fetch = async (input, init) => {
	const rawUrl = input instanceof Request ? input.url : String(input);
	const url = new URL(rawUrl, window.location.href);
	const method = (init?.method ?? "GET").toUpperCase();
	const body = isNativeText(init?.body) ? parseProofJson(init.body) : null;
	const call = { args: undefined, body, method, path: url.pathname };
	state.requests.push(call);

	if (url.pathname.endsWith("/api/gateway/status")) {
		return json({
			health: { providers: [] },
			metrics: {},
			reachable: true,
			url: "http://127.0.0.1:7982",
		});
	}
	if (url.pathname.endsWith("/api/gateway/evals/run")) {
		state.evalRequests.push(call);
		state.evalAuthorization.push(
			new Headers(init?.headers).get("authorization")
		);
		if (params.get("denyEvals") === "true") {
			return json({ error: "Evaluation permission denied." }, 403);
		}
		if (state.failEvalOnce) {
			state.failEvalOnce = false;
			return json({ error: "Provider unavailable for this run." }, 503);
		}
		return json(evalResult());
	}
	if (url.pathname.endsWith("/api/control-plane/me/permissions")) {
		return json({ permissions: ["gateway.view", "gateway.configure"] });
	}
	if (url.pathname.endsWith("/api/auth/get-session")) {
		return json({ session: { activeOrganizationId: "eval-health-proof-org" } });
	}
	if (url.pathname.endsWith("/api/control-plane/orgs")) {
		return json({
			organizations: [
				{
					id: "eval-health-proof-org",
					name: "Eval health proof org",
					role: "owner",
				},
			],
		});
	}
	if (url.pathname.endsWith("/api/gateway/config")) {
		return json(gatewayConfig());
	}
	if (url.pathname.endsWith("/api/gateway/doctor")) {
		return json(doctorReport());
	}
	if (url.pathname.endsWith("/api/gateway/coverage")) {
		return json({ claude: false, codex: false });
	}
	if (url.pathname.endsWith("/api/preferences/default-local-agent-selection")) {
		// Gateway → Default agent & model names the node's local-lane model, which
		// the eval panel pre-fills.
		return json({
			key: "default-local-agent-selection",
			value: JSON.stringify({
				access_mode: "",
				agent_id: "",
				effort: "",
				model: "gpt-4o-mini",
				provider: "",
				thinking_level: "",
			}),
		});
	}
	if (url.pathname.endsWith("/api/preferences/approval-mode")) {
		return json({ value: "smart" });
	}
	if (url.pathname.endsWith("/api/preferences/exec-approval-mode")) {
		return json({ value: "enforce" });
	}
	if (url.pathname.endsWith("/api/preferences/gateway-posture")) {
		return json({ value: "balanced" });
	}
	if (url.pathname.endsWith("/api/preferences/claude-gateway-routing")) {
		return json({ value: "false" });
	}
	if (url.pathname.endsWith("/api/preferences/codex-gateway-routing")) {
		return json({ value: "false" });
	}
	if (url.pathname.endsWith("/api/preferences/agent-gateway-routing")) {
		return json({ value: "{}" });
	}
	if (url.pathname.endsWith("/api/health")) {
		return json({ status: "ok", version: "0.9.7", capabilities: [] });
	}
	if (url.pathname.endsWith("/api/system/status")) {
		return json({
			gateway: { reachable: false },
			sidecars: [
				{ name: "example-installed-engine", running: true },
				{ name: "example-installed-stopped", running: false },
				{ name: "example-uninstalled-engine", running: false },
			],
		});
	}
	if (url.pathname.endsWith("/api/update/check")) {
		return json({
			asset: null,
			channel: "stable",
			current: "0.9.7",
			html_url: null,
			latest: "0.9.7",
			notes: null,
			update_available: false,
		});
	}
	if (url.pathname.endsWith("/api/version")) {
		return json({ components: [], platform: "proof", ryu_version: "0.9.7" });
	}
	if (url.pathname.endsWith("/api/catalog")) {
		return json({
			sidecars: [
				["example-installed-engine", "installed"],
				["example-installed-stopped", "installed"],
				["example-uninstalled-engine", "not_installed"],
			].map(([name, installState]) => ({
				category: "provider",
				deprecated: false,
				description: "Proof sidecar",
				display_name: name,
				install_state: installState,
				installed_version: installState === "installed" ? "1.0" : null,
				latest_version: "1.0",
				name,
				platforms: [],
				recommended: false,
				supported: true,
			})),
		});
	}
	if (url.pathname.endsWith("/api/engine/active")) {
		return json({
			active: "example-installed-engine",
			available: [],
			running: true,
		});
	}
	if (url.pathname === "/api/safe-mode" && method === "PUT") {
		throw new Error("Core transport is unavailable");
	}
	if (url.pathname.startsWith("/api/sidecar/") && method === "POST") {
		if (state.failSidecarStart && url.pathname.endsWith("/start")) {
			state.failSidecarStart = false;
			return json({ error: "Sidecar install is unavailable." }, 503);
		}
		return json({ success: true });
	}
	if (url.pathname.startsWith("/api/")) {
		return json({});
	}
	return Response.error();
};

export async function invokeWhenReady(
	command: string,
	args?: ProofJsonRecord
): Promise<boolean | undefined> {
	state.tauriCalls.push({ args, command });
	if (command === "get_safe_mode_sentinel") {
		return state.safeModeSentinel;
	}
	if (command === "set_safe_mode_sentinel") {
		state.safeModeSentinel = args?.enabled === true;
	}
	return undefined;
}

export function isTauriReady(): boolean {
	return true;
}

export class TauriUnavailableError extends Error {}

/** Mirrors tauri-ready.ts: a fixture's own unavailable error means "no backend". */
export function isNoDesktopBackend(error: unknown): boolean {
	return error instanceof TauriUnavailableError;
}

export async function withTauri<T>(
	operation: () => Promise<T>
): Promise<T | null> {
	return operation();
}

export async function listenWhenReady<T>(
	_event: string,
	_callback: (event: T) => void
): Promise<() => void> {
	return () => undefined;
}

export async function getRyuStatus(): Promise<string> {
	state.tauriCalls.push({ command: "get_ryu_status" });
	return state.coreStatus;
}

export async function startRyuCore(): Promise<string> {
	state.tauriCalls.push({ command: "start_ryu_core" });
	return "proof-started";
}

export async function stopRyuCore(): Promise<void> {
	state.tauriCalls.push({ command: "stop_ryu_core" });
	state.coreStatus = "stopped";
}

export async function restartRyuCore(): Promise<string> {
	state.tauriCalls.push({ command: "restart_ryu_core" });
	return "proof-restarted";
}

export async function getVersion(): Promise<string> {
	return "0.9.7-proof";
}

export async function openExternal(url: string): Promise<void> {
	state.tauriCalls.push({ args: { url }, command: "open_external" });
}

export async function openTabWindow(args: ProofJsonRecord): Promise<void> {
	state.tauriCalls.push({ args, command: "open_tab_window" });
}

// The fixture serves no public pages, so the shell's Open Graph fetch fails the
// way the native command does when the page is unreachable.
export async function previewLinkMetadata(
	url: string
): Promise<LinkMetadataPreview> {
	await invokeWhenReady("preview_link_metadata", { url });
	throw new Error(`Fixture serves no page to preview at ${url}`);
}

export async function openStandaloneAppWindow(options: {
	appId: string;
	title: string;
}): Promise<void> {
	await invokeWhenReady("open_standalone_app_window", {
		appId: options.appId,
		title: options.title,
	});
}

export async function closeCurrentWindow(): Promise<void> {
	await invokeWhenReady("close_current_window");
}

export async function relaunch(): Promise<void> {
	state.tauriCalls.push({ command: "relaunch" });
}

export async function applyReleaseUpdate(): Promise<string | null> {
	return null;
}

export async function scheduleReleaseUpdate(): Promise<string> {
	return "Scheduled for 03:00 local time.";
}
