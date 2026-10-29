import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";

declare const window: Window;

import { I18nProvider } from "@ryu/i18n/react";
import { I18nDirectionProvider } from "@ryu/ui/components/direction.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { sileo } from "sileo";
import { z } from "zod";
import {
	getDevMetricsText,
	isDevMetricsEnabled,
	recordHttpSample,
	recordTurnSample,
} from "@/src/lib/dev-metrics.ts";
import { AccountTab } from "../../src/components/settings/AccountTab.tsx";
import { DeveloperTab } from "../../src/components/settings/DeveloperTab.tsx";
import { SessionsTab } from "../../src/components/settings/SessionsTab.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

interface ProofCall {
	body: unknown;
	method: string;
	path: string;
}

interface ProofSession {
	createdAt: string;
	expiresAt: string;
	id: string;
	ipAddress?: string;
	isCurrent: boolean;
	userAgent?: string;
	userId: string;
}

interface ProofWindow extends Window {
	__settingsProofAuthCalls: Array<{ body?: unknown; method: string }>;
	__settingsProofCalls: ProofCall[];
	__settingsProofClearToasts: () => void;
	__settingsProofDelayRequest: (path: string, durationMs: number) => void;
	__settingsProofFailCommand: (command: string) => void;
	__settingsProofFailRequest: (path: string) => void;
	__settingsProofReadMetrics: () => {
		devMode: string | null;
		enabled: boolean;
		text: string;
	};
	__settingsProofRecordMetrics: () => void;
	__TAURI_INTERNALS__?: {
		invoke: (
			command: string,
			args?: { enabled?: boolean }
		) => Promise<z.infer<typeof wipeSchema> | string | null>;
		transformCallback: (...args: unknown[]) => number;
	};
}

// SAFETY: This private write view is used below to install the fixture capture arrays and control callbacks before rendering. Request/auth bodies remain unknown; storage decoding assertions are separate.
const proofWindow = window as ProofWindow;
const requestFailures = new Map<string, number>();
const requestDelays = new Map<string, number>();
const commandFailures = new Map<string, number>();
const now = new Date();
let hasPassword =
	new URLSearchParams(location.search).get("passwordless") !== "true";
let emailChangePending = false;
let sessions: ProofSession[] = [
	{
		createdAt: new Date(now.getTime() - 86_400_000).toISOString(),
		expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
		id: "session-current",
		isCurrent: true,
		ipAddress: "192.0.2.10",
		userAgent: "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36",
		userId: "coverage-user",
	},
	{
		createdAt: new Date(now.getTime() - 3_600_000).toISOString(),
		expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
		id: "session-firefox",
		isCurrent: false,
		ipAddress: "192.0.2.11",
		userAgent: "Mozilla/5.0 Firefox/140.0",
		userId: "coverage-user",
	},
	{
		createdAt: new Date(now.getTime() - 7_200_000).toISOString(),
		expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
		id: "session-edge",
		isCurrent: false,
		ipAddress: "192.0.2.12",
		userAgent: "Microsoft Edge/140.0",
		userId: "coverage-user",
	},
].sort(
	(left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)
);

if (new URLSearchParams(location.search).get("sessions-error") === "true") {
	requestFailures.set("/api/sessions", 1);
}

function consumeFailure(map: Map<string, number>, key: string): boolean {
	const remaining = map.get(key) ?? 0;
	if (remaining <= 0) {
		return false;
	}
	map.set(key, remaining - 1);
	return true;
}

function jsonResponse<FixturePayload>(
	value: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(value), {
		headers: { "Content-Type": "application/json" },
		status,
	});
}

proofWindow.__settingsProofCalls = [];
proofWindow.__settingsProofAuthCalls = [];
proofWindow.__settingsProofClearToasts = () => sileo.clear();
proofWindow.__settingsProofFailCommand = (command) => {
	commandFailures.set(command, 1);
};
proofWindow.__settingsProofDelayRequest = (path, durationMs) => {
	requestDelays.set(path, durationMs);
};
proofWindow.__settingsProofFailRequest = (path) => {
	requestFailures.set(path, (requestFailures.get(path) ?? 0) + 1);
};
proofWindow.__settingsProofRecordMetrics = () => {
	recordHttpSample({
		at: Date.now(),
		method: "GET",
		ms: 240,
		path: "/api/sessions",
		status: 200,
	});
	recordTurnSample({
		at: Date.now(),
		bytes: 512,
		chunks: 8,
		ms: 860,
		path: "/api/chat/completions",
		status: 200,
		ttftMs: 180,
	});
};
proofWindow.__settingsProofReadMetrics = () => ({
	devMode: localStorage.getItem("ryu_developer_mode"),
	enabled: isDevMetricsEnabled(),
	text: getDevMetricsText(),
});

const wipeSchema = z.object({
	data_dir: z.string(),
	enabled: z.boolean(),
	last_wipe_date: z.string().nullable(),
	profile: z.string(),
	state_file: z.string(),
	supported: z.boolean(),
});

const wipeDefault = {
	data_dir: "/tmp/ryu-coverage/canary-data",
	enabled: false,
	last_wipe_date: null,
	profile: "canary",
	state_file: "/tmp/ryu-coverage/canary-config/midnight-wipe.json",
	supported: new URLSearchParams(location.search).get("unsupported") !== "true",
};

proofWindow.__TAURI_INTERNALS__ = {
	invoke: async (command, args) => {
		if (consumeFailure(commandFailures, command)) {
			throw new Error(`Fixture ${command} failure`);
		}
		if (command === "get_midnight_wipe") {
			const raw = localStorage.getItem("settings-proof-midnight-wipe");
			return raw ? wipeSchema.parse(JSON.parse(raw)) : wipeDefault;
		}
		if (command === "set_midnight_wipe") {
			const current = wipeSchema.parse(
				JSON.parse(
					localStorage.getItem("settings-proof-midnight-wipe") ??
						JSON.stringify(wipeDefault)
				)
			);
			const updated = { ...current, enabled: args?.enabled === true };
			localStorage.setItem(
				"settings-proof-midnight-wipe",
				JSON.stringify(updated)
			);
			return updated;
		}
		if (command === "plugin:app|version") {
			return "0.9.0-coverage";
		}
		return null;
	},
	transformCallback: () => 0,
};

const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
	const url = input instanceof Request ? input.url : String(input);
	const requestUrl = new URL(url, location.href);
	const method = (init?.method ?? "GET").toUpperCase();
	const path = requestUrl.pathname;
	let body: unknown;
	if (isNativeText(init?.body)) {
		try {
			body = parseProofJson(init.body);
		} catch {
			body = init.body;
		}
	}
	proofWindow.__settingsProofCalls.push({ body, method, path });
	const delayMs = requestDelays.get(path) ?? 0;
	if (delayMs > 0) {
		requestDelays.delete(path);
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}

	if (consumeFailure(requestFailures, path)) {
		return jsonResponse({ error: `Fixture rejected ${path}` }, 500);
	}

	if (path === "/api/user/password-status") {
		return jsonResponse({
			authMethod: hasPassword ? "email" : "magic-link",
			hasPassword,
			provider: null,
		});
	}
	if (path === "/api/user/email-change-status") {
		return jsonResponse({
			hasActive: emailChangePending,
			...(emailChangePending
				? {
						emailChange: {
							createdAt: now.toISOString(),
							expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
							id: "email-change-proof",
							newEmail: "next@example.test",
							oldEmail: "security@example.test",
							status: "pending",
							statusMessage: "Verification emails sent to both addresses.",
						},
					}
				: undefined),
		});
	}
	if (path === "/api/user/initiate-email-change" && method === "POST") {
		emailChangePending = true;
		return jsonResponse({ ok: true });
	}
	if (path === "/api/user/cancel-email-change" && method === "POST") {
		emailChangePending = false;
		return jsonResponse({ ok: true });
	}
	if (path === "/api/user/set-password" && method === "POST") {
		hasPassword = true;
		return jsonResponse({ ok: true });
	}
	if (path === "/api/sessions" && method === "GET") {
		if (new URLSearchParams(location.search).get("sessions-empty") === "true") {
			return jsonResponse({ sessions: [] });
		}
		return jsonResponse({ sessions });
	}
	if (path === "/api/sessions" && method === "DELETE") {
		sessions = sessions.filter((session) => session.isCurrent === true);
		return jsonResponse({ ok: true });
	}
	if (path.startsWith("/api/sessions/") && method === "DELETE") {
		const id = path.slice("/api/sessions/".length);
		const selected = sessions.find((session) => session.id === id);
		if (!selected) {
			return jsonResponse({ error: "Session not found" }, 404);
		}
		if (selected.isCurrent) {
			return jsonResponse({ error: "Cannot revoke current session" }, 400);
		}
		sessions = sessions.filter((session) => session.id !== id);
		return jsonResponse({ ok: true });
	}
	if (path.startsWith("/api/step-up/status")) {
		return jsonResponse({
			action: "change account security settings",
			enrolmentRequired: false,
			methods: ["password"],
			satisfied: true,
			scope: "account.security",
			twoFactorEnabled: false,
			windowMs: 300_000,
		});
	}
	if (requestUrl.hostname === "127.0.0.1" && path === "/api/health") {
		return jsonResponse({ status: "ok" });
	}
	if (requestUrl.hostname === "127.0.0.1" && path === "/api/version") {
		return jsonResponse({ core: "0.9.0-coverage", gateway: "0.9.0-coverage" });
	}
	if (requestUrl.hostname === "127.0.0.1" && path === "/api/system/status") {
		return jsonResponse({ status: "running" });
	}
	if (requestUrl.hostname === "127.0.0.1" && path === "/api/catalog") {
		return jsonResponse([]);
	}
	return originalFetch(input, init);
};

function ProofSurface() {
	const queryClient = useMemo(
		() => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
		[]
	);

	return (
		<QueryClientProvider client={queryClient}>
			<AppSurfaceProvider surface="desktop">
				<I18nProvider>
					<I18nDirectionProvider>
						<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
							<Toaster position="bottom-right" theme="dark" />
							<main className="mx-auto min-h-dvh max-w-5xl space-y-8 bg-background p-8 text-foreground">
								<header className="rounded-2xl border bg-card p-6 shadow-sm">
									<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
										Desktop settings verification
									</p>
									<h1 className="mt-2 font-semibold text-2xl">
										Account and developer controls
									</h1>
								</header>
								<section
									className="rounded-2xl border bg-card p-6 shadow-sm"
									data-testid="developer-tab"
								>
									<DeveloperTab />
								</section>
								<section
									className="rounded-2xl border bg-card p-6 shadow-sm"
									data-testid="account-tab"
								>
									<AccountTab />
								</section>
								<section
									className="rounded-2xl border bg-card p-6 shadow-sm"
									data-testid="sessions-tab"
								>
									<SessionsTab />
								</section>
							</main>
						</ThemeProvider>
					</I18nDirectionProvider>
				</I18nProvider>
			</AppSurfaceProvider>
		</QueryClientProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<ProofSurface />);
}
