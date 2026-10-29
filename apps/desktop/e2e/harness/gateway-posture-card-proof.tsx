import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import {
	doctorProofSchema,
	firewallProofSchema,
	routingProofSchema,
} from "./gateway-configuration-proof.contracts.ts";

declare const window: Window;

import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { GatewayPostureCard } from "../../src/components/gateway/GatewayPostureCard.tsx";
import type { ApiTarget } from "../../src/lib/api/client.ts";
import {
	DEFAULT_INSPECTOR,
	type GatewayAuthConfig,
	type GatewayDoctorFinding,
	type GatewayDoctorFix,
	type GatewayDoctorFixResult,
	type GatewayDoctorReport,
	type GatewayFirewallConfig,
	type GatewayProvidersConfig,
	type GatewayRoutingConfig,
} from "../../src/lib/api/gateway.ts";
import { parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

const TARGET: ApiTarget = {
	token: "gateway-posture-card-proof-token",
	url: "http://127.0.0.1:7980",
};

const STORAGE_KEY = "gateway-posture-card-proof-state";

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
	status: number;
}

interface PersistedState {
	config: { firewall: GatewayFirewallConfig; routing: GatewayRoutingConfig };
	doctor: GatewayDoctorReport;
	preferences: Record<string, string>;
}

interface GatewayPostureProofState {
	doctorHealthyOnNextRead: boolean;
	doctorReads: number;
	failNextConfigRead: boolean;
	failNextConfigWrite: boolean;
	failNextDoctorFix: boolean;
	failPreferenceWriteKey: string | null;
	requests: CapturedRequest[];
	snapshot: () => PersistedState & {
		doctorReads: number;
		requests: CapturedRequest[];
	};
}

declare global {
	interface Window {
		__gatewayPostureProof: GatewayPostureProofState;
	}
}

const SAFE_FIX: GatewayDoctorFix = {
	action: "Enable personally identifiable information redaction.",
	checkId: "firewall.redact_pii",
	settingPath: "firewall.redact_pii",
	summary: "Turn on PII redaction",
};

function warningFinding(): GatewayDoctorFinding {
	return {
		canAutoFix: true,
		category: "security",
		checkId: "firewall.redact_pii",
		detail: "Gateway redaction for PII is disabled.",
		recommendedAction: "Enable PII redaction.",
		settingPath: "firewall.redact_pii",
		severity: "warning",
		summary: "PII redaction is disabled",
	};
}

function infoFinding(): GatewayDoctorFinding {
	return {
		canAutoFix: false,
		category: "configuration",
		checkId: "config.pipeline",
		detail: "The local Gateway fixture is running its expected stages.",
		recommendedAction: "No action is needed.",
		settingPath: "pipeline_stages",
		severity: "info",
		summary: "Configuration loaded",
	};
}

function initialDoctor(): GatewayDoctorReport {
	return {
		counts: { errors: 0, warnings: 1, info: 1 },
		findings: [warningFinding(), infoFinding()],
		generatedAt: 1_790_000_000_000,
		posture: "balanced",
		reachable: true,
		rulesetVersion: "posture-proof-1",
		schemaVersion: "1",
	};
}

function healthyDoctor(): GatewayDoctorReport {
	return {
		...initialDoctor(),
		counts: { errors: 0, warnings: 0, info: 1 },
		findings: [infoFinding()],
		generatedAt: 1_790_000_001_000,
	};
}

function initialFirewall(): GatewayFirewallConfig {
	return {
		alert: "silent",
		custom_patterns: [],
		enabled: true,
		inspector: { ...DEFAULT_INSPECTOR },
		locked_fields: [],
		log_detections: true,
		policy: "block",
		redact_pii: false,
		redact_secrets: true,
		scan_inbound: true,
		scan_outbound: true,
		wrap_untrusted_tool_results: true,
	};
}

function initialPersistedState(): PersistedState {
	return {
		config: {
			firewall: initialFirewall(),
			routing: {
				default_provider: "anthropic",
				fallback_chain: ["openai"],
				model_map: {},
			},
		},
		doctor: initialDoctor(),
		preferences: {
			"agent-gateway-routing": JSON.stringify({ "local-agent": true }),
			"approval-mode": "smart",
			"claude-gateway-routing": "false",
			"codex-gateway-routing": "false",
			"exec-approval-mode": "enforce",
			"gateway-posture": "balanced",
		},
	};
}

function readPersistedState(): PersistedState {
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored) {
		return z
			.object({
				config: z.object({
					firewall: firewallProofSchema,
					routing: routingProofSchema,
				}),
				doctor: doctorProofSchema,
				preferences: z.record(z.string(), z.string()),
			})
			.parse(JSON.parse(stored));
	}
	const initial = initialPersistedState();
	localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
	return initial;
}

function writePersistedState(next: PersistedState): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

// The Gateway always serves its redacted auth and providers sections beside the
// firewall, and the config response codec requires both.
const REDACTED_AUTH: GatewayAuthConfig = { api_keys: [], require_auth: false };
const REDACTED_PROVIDERS: GatewayProvidersConfig = {
	anthropic: null,
	core: null,
	genai: { keys: [] },
	local: { base_url: "http://127.0.0.1:11434" },
	openai: { api_key: "***", base_url: "https://api.openai.com" },
	openrouter: null,
};

function jsonResponse<FixturePayload>(
	body: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function parseBody(value: BodyInit | null | undefined) {
	if (!isNativeText(value)) {
		return null;
	}
	try {
		return parseProofJson(value);
	} catch {
		return null;
	}
}

function installFixture(): void {
	const query = new URLSearchParams(window.location.search);
	const state: GatewayPostureProofState = {
		doctorHealthyOnNextRead: false,
		doctorReads: 0,
		failNextDoctorFix: false,
		failNextConfigRead: query.get("failRead") === "true",
		failNextConfigWrite: false,
		failPreferenceWriteKey: null,
		requests: [],
		snapshot: () => ({
			...readPersistedState(),
			doctorReads: state.doctorReads,
			requests: structuredClone(state.requests),
		}),
	};
	window.__gatewayPostureProof = state;

	const nativeFetch = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const request = input instanceof Request ? input : null;
		const url = new URL(request?.url ?? String(input), window.location.href);
		if (
			url.origin === window.location.origin &&
			!url.pathname.startsWith("/api/")
		) {
			return nativeFetch(input, init);
		}

		const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
		const body = parseBody(
			init?.body ?? (request ? await request.clone().text() : null)
		);
		const path = url.pathname;
		const saved = readPersistedState();

		if (path === "/api/gateway/config" && method === "GET") {
			if (state.failNextConfigRead) {
				state.failNextConfigRead = false;
				state.requests.push({ body, method, path, status: 503 });
				return jsonResponse({ message: "gateway_fixture_read_failed" }, 503);
			}
			state.requests.push({ body, method, path, status: 200 });
			return jsonResponse({
				auth: REDACTED_AUTH,
				providers: REDACTED_PROVIDERS,
				...saved.config,
			});
		}

		if (path === "/api/gateway/config" && method === "PUT") {
			if (state.failNextConfigWrite) {
				state.failNextConfigWrite = false;
				state.requests.push({ body, method, path, status: 503 });
				return jsonResponse({ message: "gateway_fixture_write_failed" }, 503);
			}
			const patch = z
				.object({ firewall: firewallProofSchema.optional() })
				.parse(body);
			writePersistedState({
				...saved,
				config: {
					...saved.config,
					...(patch.firewall ? { firewall: patch.firewall } : undefined),
				},
			});
			state.requests.push({ body, method, path, status: 200 });
			return jsonResponse({ ok: true });
		}

		if (path.startsWith("/api/preferences/")) {
			const key = decodeURIComponent(path.slice("/api/preferences/".length));
			if (method === "GET") {
				state.requests.push({ body, method, path, status: 200 });
				return jsonResponse({ key, value: saved.preferences[key] ?? null });
			}
			if (method === "PUT") {
				if (state.failPreferenceWriteKey === key) {
					state.failPreferenceWriteKey = null;
					state.requests.push({ body, method, path, status: 503 });
					return jsonResponse(
						{ message: "preference_fixture_write_failed" },
						503
					);
				}
				const value = z.object({ value: z.string() }).parse(body).value;
				writePersistedState({
					...saved,
					preferences: { ...saved.preferences, [key]: value },
				});
				state.requests.push({ body, method, path, status: 200 });
				return jsonResponse({ ok: true });
			}
		}

		if (path === "/api/gateway/doctor" && method === "GET") {
			state.doctorReads += 1;
			const report = state.doctorHealthyOnNextRead
				? healthyDoctor()
				: saved.doctor;
			if (state.doctorHealthyOnNextRead) {
				state.doctorHealthyOnNextRead = false;
				writePersistedState({ ...saved, doctor: report });
			}
			state.requests.push({ body, method, path, status: 200 });
			return jsonResponse(report);
		}

		if (path === "/api/gateway/doctor/fix" && method === "POST") {
			if (state.failNextDoctorFix) {
				state.failNextDoctorFix = false;
				state.requests.push({ body, method, path, status: 503 });
				return jsonResponse({ message: "doctor_fix_fixture_failed" }, 503);
			}
			const dryRun = z.object({ dryRun: z.boolean() }).parse(body).dryRun;
			if (dryRun) {
				state.requests.push({ body, method, path, status: 200 });
				return jsonResponse({
					appliedFixes: [],
					dryRun: true,
					plannedFixes: [SAFE_FIX],
					report: saved.doctor,
				} satisfies GatewayDoctorFixResult);
			}
			const next = {
				...saved,
				config: {
					...saved.config,
					firewall: { ...saved.config.firewall, redact_pii: true },
				},
				doctor: healthyDoctor(),
			};
			writePersistedState(next);
			state.requests.push({ body, method, path, status: 200 });
			return jsonResponse({
				appliedFixes: [SAFE_FIX],
				dryRun: false,
				plannedFixes: [],
				report: next.doctor,
			} satisfies GatewayDoctorFixResult);
		}

		if (path === "/api/catalog/scan" && method === "POST") {
			state.requests.push({ body, method, path, status: 200 });
			return jsonResponse({
				agent_id: "local-posture-audit-agent",
				auditedAt: "2026-09-28T08:00:00.000Z",
				conversationId: "posture-audit-conversation",
				model: "local-fixture-model",
				report: "Local audit fixture confirmed the current Gateway posture.",
				status: "complete",
			});
		}

		state.requests.push({ body, method, path, status: 404 });
		return jsonResponse(
			{ message: `No local fixture for ${method} ${path}` },
			404
		);
	};
}

function ProofArtifact() {
	const [continueCount, setContinueCount] = useState(0);
	const [openedConversation, setOpenedConversation] = useState("none");
	const queryClient = useMemo(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: { retry: false, refetchOnWindowFocus: false },
				},
			}),
		[]
	);
	const query = new URLSearchParams(window.location.search);

	return (
		<QueryClientProvider client={queryClient}>
			<Toaster position="bottom-right" theme="dark" />
			<main className="dark min-h-screen bg-background px-8 py-8 text-foreground">
				<div className="mx-auto max-w-4xl">
					<header className="mb-6">
						<div className="text-primary text-xs tracking-(--tracking-table-label)">
							RYU · LIVE REACT PROOF
						</div>
						<h1 className="mt-2 font-semibold text-3xl">
							Gateway safety posture
						</h1>
						<p className="mt-2 max-w-2xl text-base text-muted-foreground leading-6">
							The production posture card uses local Gateway config, preference,
							Doctor, and audit fixtures. No provider or account is contacted.
						</p>
					</header>
					<section className="rounded-2xl border border-border bg-card p-5">
						<GatewayPostureCard
							canConfigure={query.get("readOnly") !== "true"}
							compact={false}
							onContinue={() => setContinueCount((count) => count + 1)}
							onOpenAuditConversation={setOpenedConversation}
							reachable
							target={TARGET}
						/>
					</section>
					<p className="mt-4 text-muted-foreground text-xs">
						Continue calls:{" "}
						<span data-testid="continue-count">{continueCount}</span>
						{" · "}Opened audit conversation:{" "}
						<span data-testid="opened-conversation">{openedConversation}</span>
					</p>
				</div>
			</main>
		</QueryClientProvider>
	);
}

installFixture();
createRoot(document.getElementById("root")!).render(<ProofArtifact />);
