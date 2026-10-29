import { z } from "zod";

declare const window: IslandSettingsProofWindow;

import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { GatewayDialog } from "../../src/components/gateway/GatewayDialog.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { type ProofJsonValue, parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

const PREFERENCES_STORAGE_KEY = "island-settings-proof:preferences";
const REQUESTS_STORAGE_KEY = "island-settings-proof:requests";
const SHADOW_STORAGE_KEY = "island-settings-proof:shadow-control";
const TAURI_CALLS_STORAGE_KEY = "island-settings-proof:tauri-store:calls";

interface CapturedRequest {
	body: ProofJsonValue;
	headerAuthorization: string | null;
	method: string;
	path: string;
	status: number;
}

interface TauriStoreCall {
	fileName: string;
	key?: string;
	method: "get" | "load" | "save" | "set";
	value?: unknown;
}

interface ShadowControl {
	app_allowlist: string[];
	frames: boolean;
	history_retention_days: number;
	paused: boolean;
}

interface IslandSettingsSnapshot {
	preferences: Record<string, string>;
	requests: CapturedRequest[];
	shadowControl: ShadowControl;
	shadowStore: {
		frames: boolean | null;
		paused: boolean | null;
		saves: number;
	};
	tauriCalls: TauriStoreCall[];
}

interface IslandSettingsProofWindow extends Window {
	__islandSettingsProof: {
		armFailure: (method: string, path: string, status?: number) => void;
		snapshot: () => IslandSettingsSnapshot;
	};
}

const PreferencesSchema = z.record(z.string(), z.string());
const CapturedRequestSchema = z.object({
	body: z.json(),
	headerAuthorization: z.string().nullable(),
	method: z.string(),
	path: z.string(),
	status: z.number(),
});
const TauriCallSchema = z.object({
	fileName: z.string(),
	key: z.string().optional(),
	method: z.enum(["get", "load", "save", "set"]),
	value: z.json().optional(),
});
const ShadowSchema = z.object({
	app_allowlist: z.array(z.string()),
	frames: z.boolean(),
	history_retention_days: z.number(),
	paused: z.boolean(),
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

const initialPreferences = {
	"island-agents": JSON.stringify({
		proactiveAgent: "ryu",
		voiceAgent: "ryu",
	}),
	"island-appearance": JSON.stringify({ background: "acrylic" }),
	"island-auto-jump": "false",
	"island-command-shortcut": "CommandOrControl+Shift+Space",
	"island-consent": JSON.stringify({
		chat: true,
		contextRead: null,
		proactive: null,
	}),
	"island-edge-offset": "20",
	"island-hide-on-fullscreen": "true",
	"island-screen-privacy": "true",
	"island-tts": JSON.stringify({
		enabled: false,
		engine: "kokoro",
		voice: "af_heart",
	}),
	"voice-input": JSON.stringify({
		enabled: false,
		engine: "parakeet",
		mode: "toggle",
		model: "parakeet-tdt-0.6b-v3",
		shortcut: "CommandOrControl+Shift+A",
	}),
};

const initialShadowControl: ShadowControl = {
	app_allowlist: [],
	frames: true,
	history_retention_days: 30,
	paused: false,
};

const malformedPreferences = {
	"island-agents": JSON.stringify({ proactiveAgent: null, voiceAgent: 5 }),
	"island-appearance": JSON.stringify({ background: "ultraviolet" }),
	"island-auto-jump": "maybe",
	"island-command-shortcut": "   ",
	"island-consent": JSON.stringify({
		chat: "false",
		contextRead: "yes",
		proactive: 1,
	}),
	"island-edge-offset": "not-a-number",
	"island-hide-on-fullscreen": "maybe",
	"island-screen-privacy": "maybe",
	"island-tts": JSON.stringify({ enabled: "no", engine: "", voice: 4 }),
	"voice-input": JSON.stringify({
		enabled: "no",
		engine: "unsupported",
		mode: "hold",
		model: "",
		shortcut: "   ",
	}),
};

const preferenceSeed = new URLSearchParams(window.location.search).get(
	"preferences"
);
const seedPreferences =
	preferenceSeed === "missing"
		? {}
		: preferenceSeed === "malformed"
			? malformedPreferences
			: initialPreferences;

if (localStorage.getItem(PREFERENCES_STORAGE_KEY) === null) {
	writeJson(PREFERENCES_STORAGE_KEY, seedPreferences);
}
if (localStorage.getItem(REQUESTS_STORAGE_KEY) === null) {
	writeJson(REQUESTS_STORAGE_KEY, []);
}
if (localStorage.getItem(SHADOW_STORAGE_KEY) === null) {
	writeJson(SHADOW_STORAGE_KEY, initialShadowControl);
}

const node = {
	name: "island-settings-proof",
	token: "island-settings-proof-token",
	url: window.location.origin,
	userJwt: null,
};
useNodeStore.setState({
	defaultNode: node.name,
	localNodes: [node],
	nodes: [node],
});

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

function capture(request: CapturedRequest): number {
	const requests = readJson(
		REQUESTS_STORAGE_KEY,
		[],
		CapturedRequestSchema.array()
	);
	requests.push(request);
	writeJson(REQUESTS_STORAGE_KEY, requests);
	return requests.length - 1;
}

function updateCapture(index: number, request: CapturedRequest): void {
	const requests = readJson(
		REQUESTS_STORAGE_KEY,
		[],
		CapturedRequestSchema.array()
	);
	if (index < 0 || index >= requests.length) {
		return;
	}
	requests[index] = request;
	writeJson(REQUESTS_STORAGE_KEY, requests);
}

function currentShadowControl(): ShadowControl {
	return readJson(SHADOW_STORAGE_KEY, initialShadowControl, ShadowSchema);
}

const nativeFetch = window.fetch.bind(window);
const failures = new Map<string, number>();
window.fetch = async (input, init) => {
	const rawUrl = input instanceof Request ? input.url : String(input);
	const url = new URL(rawUrl, window.location.href);
	const path = url.pathname;
	const method = (
		init?.method ?? (input instanceof Request ? input.method : "GET")
	).toUpperCase();
	const body = parseBody(init?.body);
	const headers = new Headers(
		init?.headers ?? (input instanceof Request ? input.headers : undefined)
	);
	const capturedRequest: CapturedRequest = {
		body,
		headerAuthorization: headers.get("authorization"),
		method,
		path,
		status: 0,
	};
	const captureIndex = path.startsWith("/api/") ? capture(capturedRequest) : -1;
	const finish = <Payload,>(responseBody: Payload, status = 200): Response => {
		capturedRequest.status = status;
		updateCapture(captureIndex, capturedRequest);
		return jsonResponse(responseBody, status);
	};

	const failureKey = `${method} ${path}`;
	const failureStatus = failures.get(failureKey);
	if (failureStatus !== undefined) {
		failures.delete(failureKey);
		return finish({ error: "fixture_failure" }, failureStatus);
	}

	if (path === "/api/auth/get-session") {
		return finish({ session: null, user: null });
	}
	if (path === "/api/plugins") {
		return finish({
			apps: [
				{
					built_in: true,
					companion: { label: "Island" },
					enabled: true,
					id: "@ryu/island",
					installed: true,
					installed_version: "1.0.0",
					local_only: true,
					name: "Island",
					permission_grants: [],
					runnables: [],
					sidecar_name: "island",
					version: "1.0.0",
					windows_first: false,
				},
			],
		});
	}
	if (path === "/api/plugins/contributions") {
		return finish({
			settings_tabs: [
				{
					app_enabled: true,
					fields: [],
					id: "island-settings",
					plugin: "@ryu/island",
					scope: "node",
					title: "Island",
					view: "island",
				},
			],
		});
	}
	if (path === "/api/gateway/status") {
		return finish({
			health: { providers: [] },
			metrics: {},
			reachable: true,
			url: node.url,
		});
	}
	if (path === "/api/gateway/config") {
		return finish({ providers: {} });
	}
	if (path === "/api/agents") {
		return finish({
			agents: [
				{
					id: "ryu",
					name: "Ryu",
					recommended: true,
					transport: "acp",
				},
				{
					id: "support-agent",
					name: "Support agent",
				},
			],
		});
	}
	if (path === "/api/engines") {
		return finish({ engines: [] });
	}
	if (path === "/api/engine/active") {
		return finish({ active: null, available: [], running: false });
	}
	if (path === "/api/voice/tts-engines") {
		return finish({
			data: [
				{
					default_voice: "af_heart",
					description: "Fixture voice engine",
					display_name: "Kokoro 82M",
					id: "kokoro",
					installed: true,
					languages: ["en"],
					loaded: true,
					sample_rate: 24_000,
					size_mb: 120,
					supports_cloning: false,
					voices: ["af_heart", "af_nova"],
				},
				{
					default_voice: "Mika",
					description: "Fixture alternate voice engine",
					display_name: "OuteTTS",
					id: "outetts",
					installed: true,
					languages: ["en"],
					loaded: true,
					sample_rate: 24_000,
					size_mb: 240,
					supports_cloning: false,
					voices: ["Mika", "Nova"],
				},
			],
		});
	}
	if (path === "/api/shadow/capture/control" && method === "POST") {
		const update = ShadowSchema.partial().parse(body ?? {});
		const current = currentShadowControl();
		const next: ShadowControl = {
			...current,
			...update,
		};
		writeJson(SHADOW_STORAGE_KEY, next);
		return finish(next);
	}
	if (path.startsWith("/api/preferences/")) {
		const key = decodeURIComponent(path.slice("/api/preferences/".length));
		const preferences = readJson(
			PREFERENCES_STORAGE_KEY,
			initialPreferences,
			PreferencesSchema
		);
		if (method === "GET") {
			const value = preferences[key];
			return isNativeText(value)
				? finish({ key, value })
				: finish({ error: "preference_not_found" }, 404);
		}
		if (method === "PUT") {
			const value = z.object({ value: z.string() }).safeParse(body).data?.value;
			if (!isNativeText(value)) {
				return finish({ error: "invalid_preference_value" }, 400);
			}
			writeJson(PREFERENCES_STORAGE_KEY, { ...preferences, [key]: value });
			return finish({ key, value });
		}
	}
	if (path.startsWith("/api/")) {
		return finish({ error: "unhandled_island_fixture_route", path }, 404);
	}
	return nativeFetch(input, init);
};

const proofWindow = window;
proofWindow.__islandSettingsProof = {
	armFailure: (method, path, status = 503) => {
		failures.set(`${method.toUpperCase()} ${path}`, status);
	},
	snapshot: () => {
		const shadowFramesKey =
			"island-settings-proof:tauri-store:companion.bin:companion_frames";
		const shadowPausedKey =
			"island-settings-proof:tauri-store:companion.bin:companion_paused";
		const saveCountKey =
			"island-settings-proof:tauri-store:companion.bin:save-count";
		const readStoredValue = (key: string): boolean | null => {
			const raw = localStorage.getItem(key);
			return raw === null ? null : z.boolean().parse(JSON.parse(raw));
		};
		return {
			preferences: readJson(
				PREFERENCES_STORAGE_KEY,
				initialPreferences,
				PreferencesSchema
			),
			requests: readJson(
				REQUESTS_STORAGE_KEY,
				[],
				CapturedRequestSchema.array()
			),
			shadowControl: currentShadowControl(),
			tauriCalls: readJson(
				TAURI_CALLS_STORAGE_KEY,
				[],
				TauriCallSchema.array()
			),
			shadowStore: {
				frames: readStoredValue(shadowFramesKey),
				paused: readStoredValue(shadowPausedKey),
				saves: Number(localStorage.getItem(saveCountKey) ?? "0"),
			},
		};
	},
};

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
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
if (root) {
	createRoot(root).render(<ProofSurface />);
}

export type IslandSettingsProofPublisher =
	IslandSettingsProofWindow["__islandSettingsProof"];
