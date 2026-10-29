declare const window: Window;

import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import type { LinkMetadataPreview } from "../../lib/tauri-bridge.ts";

interface ApiCall {
	authorization: string | null;
	body: unknown;
	method: string;
	path: string;
	status?: number;
	url: string;
}

interface TauriCall {
	args?: Record<string, z.infer<ReturnType<typeof z.json>>>;
	command: string;
	origin?: "automatic" | "manual" | "restart";
}

interface PreflightProofState {
	analyticsEvents: unknown[];
	apiCalls: ApiCall[];
	clipboardText: string | null;
	coreStatus: "running" | "stopped";
	failCoreStartOnce: boolean;
	failGatewayRestartOnce: boolean;
	failSafeModeOnce: boolean;
	failSidecarRestartOnce: boolean;
	failUpdateApplyOnce: boolean;
	gatewayRestartSuccess: boolean;
	nonNodeFetches: string[];
	safeModeEnabled: boolean;
	safeModeSentinel: boolean;
	scheduledUpdates: unknown[];
	serviceStatus: { name: string; running: boolean }[];
	tauriCalls: TauriCall[];
	telemetryReports: string[];
}

declare global {
	interface Window {
		__preflightPageProof: {
			snapshot: () => PreflightProofState;
		};
		__preflightPageProofState?: PreflightProofState;
	}
}

const NODE_URL = "http://127.0.0.1:5319";

const params = new URLSearchParams(window.location.search);
const initialFailures = new Set((params.get("fail") ?? "").split(","));
const initialState: PreflightProofState = {
	apiCalls: [],
	nonNodeFetches: [],
	clipboardText: null,
	coreStatus: params.get("core") === "stopped" ? "stopped" : "running",
	failCoreStartOnce: initialFailures.has("core-start"),
	failGatewayRestartOnce: initialFailures.has("gateway-restart"),
	failSafeModeOnce: initialFailures.has("safe-mode"),
	failSidecarRestartOnce: initialFailures.has("sidecar-restart"),
	failUpdateApplyOnce: initialFailures.has("update-apply"),
	gatewayRestartSuccess: false,
	safeModeSentinel: false,
	safeModeEnabled: false,
	scheduledUpdates: [],
	serviceStatus: [
		{ name: "preflight-proof-running-sidecar", running: true },
		{ name: "preflight-proof-stopped-sidecar", running: false },
	],
	telemetryReports: [],
	analyticsEvents: [],
	tauriCalls: [],
};
const state = window.__preflightPageProofState ?? initialState;
window.__preflightPageProofState = state;

function clone<T>(value: T): T {
	return structuredClone(value);
}

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function recordApiCall(call: ApiCall): void {
	state.apiCalls.push(call);
}

function apiResponse<CapturedBody>(
	url: URL,
	method: string,
	body: CapturedBody
): Response {
	if (url.pathname.endsWith("/api/gateway/status")) {
		return json({
			health: { providers: [] },
			metrics: {},
			reachable: true,
			url: NODE_URL,
		});
	}
	if (url.pathname.endsWith("/api/control-plane/me/permissions")) {
		return json({ permissions: ["gateway.view", "gateway.configure"] });
	}
	if (url.pathname.endsWith("/api/auth/get-session")) {
		return json({ session: { activeOrganizationId: "preflight-proof-org" } });
	}
	if (url.pathname.endsWith("/api/control-plane/orgs")) {
		return json({
			organizations: [
				{
					id: "preflight-proof-org",
					name: "Preflight Proof Org",
					role: "owner",
				},
			],
		});
	}
	if (url.pathname.endsWith("/api/gateway/config")) {
		return json({
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
		});
	}
	if (url.pathname.endsWith("/api/gateway/doctor")) {
		return json({
			checkedAt: "2026-10-02T00:00:00.000Z",
			counts: { errors: 0, info: 0, warnings: 0 },
			findings: [],
		});
	}
	if (url.pathname.endsWith("/api/gateway/coverage")) {
		return json({ claude: false, codex: false });
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
		return json({ status: "ok", version: "0.9.7-proof", capabilities: [] });
	}
	if (url.pathname.endsWith("/api/version")) {
		return json({
			components: [{ name: "gateway", version: "0.9.7-proof" }],
			platform: "preflight-proof",
			ryu_version: "0.9.7-proof",
		});
	}
	if (url.pathname.endsWith("/api/system/status")) {
		return json({
			gateway: { reachable: state.gatewayRestartSuccess },
			sidecars: clone(state.serviceStatus),
		});
	}
	if (url.pathname.endsWith("/api/catalog")) {
		return json({
			sidecars: state.serviceStatus.map((sidecar) => ({
				category: "provider",
				deprecated: false,
				description: "Local preflight fixture sidecar",
				display_name: sidecar.name,
				install_state: "installed",
				installed_version: "1.0.0",
				latest_version: "1.0.0",
				name: sidecar.name,
				platforms: [],
				recommended: false,
				supported: true,
			})),
		});
	}
	if (url.pathname.endsWith("/api/engine/active")) {
		return json({ active: "preflight-proof-running-sidecar", running: true });
	}
	if (url.pathname.endsWith("/api/update/check")) {
		return json({
			asset: {
				kind: "core",
				name: "ryu-core-proof-linux-x64.tar.gz",
				size: 4096,
				url: "https://updates.example.invalid/releases/ryu-core-proof.tar.gz",
			},
			channel: url.searchParams.get("channel") ?? "stable",
			current: "0.9.7-proof",
			html_url: "https://updates.example.invalid/releases/ryu-core-proof",
			latest: "0.9.8-proof",
			notes: "Local preflight fixture update.",
			published_at: "2026-10-01T00:00:00Z",
			tag: "v0.9.8-proof",
			update_available: true,
		});
	}
	if (url.pathname === "/api/safe-mode" && method === "GET") {
		return json({
			enabled: state.safeModeEnabled,
			preference_enabled: state.safeModeEnabled,
			source: state.safeModeEnabled ? "preference" : "off",
			suppressed: { kernel_plugins: 2, mcp_servers: 1, plugins: 4, skills: 3 },
			user_clearable: true,
		});
	}
	if (url.pathname === "/api/safe-mode" && method === "PUT") {
		if (state.failSafeModeOnce) {
			state.failSafeModeOnce = false;
			return json(
				{ error: "Safe Mode is controlled by the host policy." },
				409
			);
		}
		// SAFETY: The mounted safe-mode API helper authors the enabled boolean body for this exact PUT route; the fixture observes enabled === true. This controlled request view is not validation of arbitrary JSON.
		const requestBody = body as { enabled?: boolean } | null;
		state.safeModeEnabled = requestBody?.enabled === true;
		return json({ success: true, enabled: state.safeModeEnabled });
	}
	if (url.pathname === "/api/update/apply" && method === "POST") {
		if (state.failUpdateApplyOnce) {
			state.failUpdateApplyOnce = false;
			return json({ error: "Node update staging is unavailable." }, 503);
		}
		return json({
			applied: false,
			message: "Proof update staged on the local fixture.",
			restart_required: true,
			staged_path: "/proof/staged/ryu-core-proof.tar.gz",
		});
	}
	if (url.pathname === "/api/update/schedule" && method === "POST") {
		// SAFETY: The mounted scheduleUpdate helper authors asset and version on this exact POST path; the fixture preserves the raw asset and requested version in its scheduled observation. This view does not validate foreign payloads.
		const requestBody = body as { asset?: unknown; version?: string } | null;
		const scheduled = {
			asset: requestBody?.asset ?? null,
			scheduled_for: "2026-10-03T03:00:00.000Z",
			time_zone: "Etc/UTC",
			version: requestBody?.version ?? "",
		};
		state.scheduledUpdates.push(clone(scheduled));
		return json(scheduled);
	}
	if (url.pathname.startsWith("/api/sidecar/") && method === "POST") {
		if (url.pathname.endsWith("/restart") && state.failSidecarRestartOnce) {
			state.failSidecarRestartOnce = false;
			return json({ error: "Sidecar restart is unavailable." }, 503);
		}
		return json({ success: true });
	}
	if (url.pathname === "/api/gateway/restart" && method === "POST") {
		if (state.failGatewayRestartOnce) {
			state.failGatewayRestartOnce = false;
			return json({ success: false });
		}
		state.gatewayRestartSuccess = true;
		return json({ success: true });
	}
	if (url.pathname.startsWith("/api/preferences/")) {
		return json({ value: "{}" });
	}
	if (url.pathname.startsWith("/api/")) {
		return json({});
	}
	return new Response(null, { status: 204 });
}

window.__preflightPageProof = {
	snapshot: () => clone(state),
};

Object.defineProperty(navigator, "clipboard", {
	configurable: true,
	value: {
		writeText: async (text: string) => {
			state.clipboardText = text;
		},
	},
});

window.fetch = async (input, init) => {
	const rawUrl = input instanceof Request ? input.url : String(input);
	const url = new URL(rawUrl, window.location.href);
	const method = (init?.method ?? "GET").toUpperCase();
	const headers = new Headers(
		init?.headers ?? (input instanceof Request ? input.headers : undefined)
	);
	let body: z.infer<ReturnType<typeof z.json>> = null;
	if (isNativeText(init?.body)) {
		try {
			body = z.json().parse(JSON.parse(init.body));
		} catch {
			body = init.body;
		}
	}
	if (url.origin !== NODE_URL) {
		state.nonNodeFetches.push(url.toString());
	}
	const response = apiResponse(url, method, body);
	recordApiCall({
		authorization: headers.get("authorization"),
		body: clone(body),
		method,
		path: url.pathname,
		status: response.status,
		url: url.toString(),
	});
	return response;
};

export async function invokeWhenReady(
	command: string,
	args?: Record<string, z.infer<ReturnType<typeof z.json>>>
): Promise<string | boolean | undefined> {
	return invoke(command, args);
}

export function isTauriReady(): boolean {
	return true;
}

export class TauriUnavailableError extends Error {}

/** Mirrors tauri-ready.ts: a fixture's own unavailable error means "no backend". */
export function isNoDesktopBackend(error: unknown): boolean {
	return error instanceof TauriUnavailableError;
}

export async function withTauri<T>(operation: () => Promise<T>): Promise<T> {
	return operation();
}

export async function listenWhenReady<T>(
	_event: string,
	_callback: (event: T) => void
): Promise<() => void> {
	return () => undefined;
}

export async function getRyuStatus(): Promise<string> {
	return invoke("get_ryu_status");
}

export async function startRyuCore(): Promise<string> {
	return invoke("start_ryu_core");
}

export async function stopRyuCore(): Promise<void> {
	return invoke("stop_ryu_core");
}

export async function restartRyuCore(): Promise<string> {
	await stopRyuCore();
	await getRyuStatus();
	await startRyuCore();
	state.coreStatus = "running";
	return "proof-restarted";
}

export async function getVersion(): Promise<string> {
	return "0.9.7-proof";
}

export async function openExternal(url: string): Promise<void> {
	state.tauriCalls.push({ args: { url }, command: "open_external" });
}

export async function openTabWindow(
	args: Record<string, z.infer<ReturnType<typeof z.json>>>
): Promise<void> {
	state.tauriCalls.push({ args: clone(args), command: "open_tab_window" });
}

// The fixture serves no public pages, so the shell's Open Graph fetch fails the
// way the native command does when the page is unreachable.
export async function previewLinkMetadata(
	url: string
): Promise<LinkMetadataPreview> {
	state.tauriCalls.push({ args: { url }, command: "preview_link_metadata" });
	throw new Error(`Fixture serves no page to preview at ${url}`);
}

export async function openStandaloneAppWindow(options: {
	appId: string;
	title: string;
}): Promise<void> {
	state.tauriCalls.push({
		args: { appId: options.appId, title: options.title },
		command: "open_standalone_app_window",
	});
}

export async function closeCurrentWindow(): Promise<void> {
	state.tauriCalls.push({ command: "close_current_window" });
}

export async function relaunch(): Promise<void> {
	state.tauriCalls.push({ command: "plugin:process|relaunch" });
}

export function invoke(
	command: "get_ryu_status" | "start_ryu_core" | "plugin:app|version",
	args?: Record<string, z.infer<ReturnType<typeof z.json>>>
): Promise<string>;
export function invoke(
	command: "get_safe_mode_sentinel",
	args?: Record<string, z.infer<ReturnType<typeof z.json>>>
): Promise<boolean>;
export function invoke(
	command: "stop_ryu_core" | "set_safe_mode_sentinel",
	args?: Record<string, z.infer<ReturnType<typeof z.json>>>
): Promise<undefined>;
export function invoke(
	command: string,
	args?: Record<string, z.infer<ReturnType<typeof z.json>>>
): Promise<string | boolean | undefined>;
export async function invoke(
	command: string,
	args?: Record<string, z.infer<ReturnType<typeof z.json>>>
): Promise<string | boolean | undefined> {
	if (command === "get_ryu_status") {
		state.tauriCalls.push({ command });
		return state.coreStatus;
	}
	if (command === "start_ryu_core") {
		const priorStarts = state.tauriCalls.filter(
			(call) => call.command === "start_ryu_core"
		).length;
		const automatic = state.coreStatus === "stopped" && priorStarts === 0;
		state.tauriCalls.push({
			command,
			origin: automatic ? "automatic" : "manual",
		});
		if (!automatic && state.failCoreStartOnce) {
			state.failCoreStartOnce = false;
			throw new Error("Core start is unavailable.");
		}
		if (!automatic) {
			state.coreStatus = "running";
		}
		return automatic ? "proof-auto-start" : "proof-manual-start";
	}
	if (command === "stop_ryu_core") {
		state.tauriCalls.push({ command });
		state.coreStatus = "stopped";
		// SAFETY: The guarded stop_ryu_core and set_safe_mode_sentinel callers await native void commands. This fixture authors the undefined acknowledgement; the unrelated unknown-command fallback remains unclaimed.
		return undefined;
	}
	if (command === "get_safe_mode_sentinel") {
		state.tauriCalls.push({ command });
		return state.safeModeSentinel;
	}
	if (command === "set_safe_mode_sentinel") {
		state.tauriCalls.push({ command, args: clone(args ?? {}) });
		state.safeModeSentinel = args?.enabled === true;
		// SAFETY: The guarded stop_ryu_core and set_safe_mode_sentinel callers await native void commands. This fixture authors the undefined acknowledgement; the unrelated unknown-command fallback remains unclaimed.
		return undefined;
	}
	state.tauriCalls.push({ command: `api:${command}`, args: clone(args ?? {}) });
	if (command === "plugin:app|version") {
		return "0.9.7-proof";
	}
	return undefined;
}

export function track<Payload>(payload: Payload): void {
	state.analyticsEvents.push(clone(payload));
}

// `crashReports=on` models a build with a crash-report sink whose user opted
// in; the sink then acknowledges each report with an event id, as Sentry does.
const crashReportsOn = params.get("crashReports") === "on";

export function reportError<ErrorInput>(error: ErrorInput): string | null {
	state.telemetryReports.push(
		error instanceof Error ? error.message : String(error)
	);
	return crashReportsOn
		? `preflight-proof-report-${state.telemetryReports.length}`
		: null;
}

export function reportCrashEvent<EventInput>(_event: EventInput): void {}

export function isCrashReportingConfigured(): boolean {
	return crashReportsOn;
}

export function isCrashReportingEnabled(): boolean {
	return crashReportsOn;
}

export function initCrashReporting(): void {}

export async function crashReportingReady(): Promise<boolean> {
	return crashReportsOn;
}

export const ANALYTICS_EVENT_NAMES = ["error_shown"] as const;
export const ANALYTICS_EVENT_CATALOG = {
	error_shown: { description: "A local preflight proof event." },
};

export function clearEgressLog(): void {}

export function getEgressLog(): Record<
	string,
	z.infer<ReturnType<typeof z.json>>
>[] {
	return [];
}

export function getInstallId(): string {
	return "preflight-proof-install";
}

export function isAnalyticsConfigured(): boolean {
	return false;
}

export function isAnalyticsEnabled(): boolean {
	return false;
}

export function initAnalytics(): void {}

export function setAnalyticsEnabled(_enabled: boolean): void {}

export function setCrashReportingEnabled(_enabled: boolean): void {}

export class Resource {
	rid: number;

	constructor(rid = 0) {
		this.rid = rid;
	}
}
