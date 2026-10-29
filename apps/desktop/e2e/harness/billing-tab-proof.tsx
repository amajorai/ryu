import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { z } from "zod";
import { SettingsDialog } from "../../src/components/settings/SettingsDialog.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { type ProofJsonRecord, parseProofJson } from "../fixture-json.ts";
import { answerDesktopSecretSlot } from "./desktop-secret-slots.ts";
import "../../src/index.css";

const autoTopupSchema = z.object({
	amountCents: z.number(),
	consecutiveFailures: z.number(),
	cooldownSec: z.number(),
	enabled: z.boolean(),
	lastAttemptAt: z.string().nullable(),
	lastError: z.string().nullable(),
	monthChargedMicroUsd: z.number(),
	monthKey: z.string().nullable(),
	monthlyCapCents: z.number(),
	thresholdCents: z.number(),
});
const creditAlertSchema = z.object({
	belowSince: z.string().nullable(),
	lastError: z.string().nullable(),
	notifiedAt: z.string().nullable(),
	recipients: z.enum(["none", "owners", "owners_admins"]),
	thresholdCents: z.number(),
});
const billingStateSchema = z.object({
	alert: creditAlertSchema.nullable(),
	autoTopup: autoTopupSchema,
	externalUrls: z.array(z.string()),
	failures: z.object({
		alert: z.number(),
		autotopup: z.number(),
		budget: z.number(),
		portal: z.number(),
	}),
	invoices: z.array(
		z.object({
			amount: z.number(),
			createdAt: z.string(),
			currency: z.string(),
			id: z.string(),
			productId: z.string(),
			status: z.string(),
		})
	),
	portalCount: z.number(),
	preferences: z.record(z.string(), z.string()),
	requests: z.array(
		z.object({
			body: z.json().optional(),
			headers: z.record(z.string(), z.string()),
			method: z.string(),
			url: z.string(),
		})
	),
	scenario: z.enum(["paid", "trial"]),
	tauriCalls: z.array(
		z.object({
			args: z.record(z.string(), z.json()).nullable(),
			command: z.string(),
		})
	),
});

const STATE_STORAGE_KEY = "billing-tab-proof:state";
const FIXTURE_ORG_ID = "org-billing-fixture";
const FIXTURE_USER_ID = "billing-tab-proof-user";

type FailureKind = "alert" | "autotopup" | "budget" | "portal";

interface CapturedRequest {
	body?: unknown;
	headers: Record<string, string>;
	method: string;
	url: string;
}

interface AutoTopupSettings {
	amountCents: number;
	consecutiveFailures: number;
	cooldownSec: number;
	enabled: boolean;
	lastAttemptAt: string | null;
	lastError: string | null;
	monthChargedMicroUsd: number;
	monthKey: string | null;
	monthlyCapCents: number;
	thresholdCents: number;
}

interface CreditAlertSettings {
	belowSince: string | null;
	lastError: string | null;
	notifiedAt: string | null;
	recipients: "none" | "owners" | "owners_admins";
	thresholdCents: number;
}

interface InvoiceFixture {
	amount: number;
	createdAt: string;
	currency: string;
	id: string;
	productId: string;
	status: string;
}

interface BillingFixtureState {
	alert: CreditAlertSettings | null;
	autoTopup: AutoTopupSettings;
	externalUrls: string[];
	failures: Record<FailureKind, number>;
	invoices: InvoiceFixture[];
	portalCount: number;
	preferences: Record<string, string>;
	requests: CapturedRequest[];
	scenario: "paid" | "trial";
	tauriCalls: { args: ProofJsonRecord | null; command: string }[];
}

interface TauriInternalsBridge {
	invoke: (command: string, args?: ProofJsonRecord) => Promise<unknown>;
	transformCallback: () => number;
}

declare global {
	interface Window {
		__billingTabProof: {
			configureFailures: (
				failures: Partial<Record<FailureKind, number>>
			) => void;
			snapshot: () => BillingFixtureState;
		};
	}
}

function readState(): BillingFixtureState {
	const raw = localStorage.getItem(STATE_STORAGE_KEY);
	if (raw) {
		return billingStateSchema.parse(JSON.parse(raw));
	}
	const scenario = new URLSearchParams(window.location.search).get("scenario");
	const state: BillingFixtureState = {
		alert: null,
		autoTopup: {
			amountCents: 1000,
			consecutiveFailures: 0,
			cooldownSec: 60,
			enabled: false,
			lastAttemptAt: null,
			lastError: null,
			monthChargedMicroUsd: 0,
			monthKey: "2026-09",
			monthlyCapCents: 0,
			thresholdCents: 500,
		},
		externalUrls: [],
		failures: { alert: 0, autotopup: 0, budget: 0, portal: 0 },
		invoices: [
			{
				amount: 1999,
				createdAt: "2026-09-01T00:00:00.000Z",
				currency: "USD",
				id: "invoice-fixture-paid",
				productId: "desktop-pro",
				status: "paid",
			},
			{
				amount: 500,
				createdAt: "2026-08-01T00:00:00.000Z",
				currency: "USD",
				id: "invoice-fixture-open",
				productId: "desktop-pro",
				status: "open",
			},
		],
		portalCount: 0,
		preferences: { "sandbox-default-run-budget-micro-usd": "15000000" },
		requests: [],
		scenario: scenario === "paid" ? "paid" : "trial",
		tauriCalls: [],
	};
	localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(state));
	return state;
}

function writeState(state: BillingFixtureState): void {
	localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(state));
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

function subscriptionStatus(state: BillingFixtureState) {
	if (state.scenario === "trial") {
		return {
			entitlement: null,
			features: {},
			lifetime: null,
			organizationId: FIXTURE_ORG_ID,
			plan: null,
			scope: "org",
			subscription: null,
		};
	}
	return {
		entitlement: {
			desktopAccess: true,
			managedInference: true,
			marketplaceApps: true,
			monthlyCreditPoolMicroUsd: 500_000_000,
			plan: "pro",
			seats: 1,
		},
		features: {},
		// The billing router always publishes these two fields; the settings
		// client's subscription-status contract requires them.
		hostedAgents: null,
		lifetime: null,
		organizationId: FIXTURE_ORG_ID,
		plan: "pro",
		scope: "org",
		seats: 1,
		subscription: {
			currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
			id: "subscription-fixture",
			interval: "month",
			status: "active",
		},
	};
}

function capture<Body>(
	url: URL,
	method: string,
	body: Body,
	headers: Headers
): void {
	const state = readState();
	state.requests.push({
		body,
		headers: Object.fromEntries(headers.entries()),
		method,
		url: `${url.pathname}${url.search}`,
	});
	writeState(state);
}

function consumeFailure(kind: FailureKind): boolean {
	const state = readState();
	if (state.failures[kind] < 1) {
		return false;
	}
	state.failures[kind] -= 1;
	writeState(state);
	return true;
}

const initialNode = {
	name: "billing-tab-proof",
	token: "billing-node-fixture-token",
	url: window.location.origin,
	userJwt: null,
};
useNodeStore.setState({
	defaultNode: initialNode.name,
	localNodes: [initialNode],
	nodes: [initialNode],
});

const tauriInternals: TauriInternalsBridge = {
	invoke: async (command, args) => {
		// The sealed vault slots billing-tab-proof-native.ts answered at load.
		const slot = answerDesktopSecretSlot(sessionStorage, command, args);
		if (slot.handled) {
			return slot.value;
		}
		const state = readState();
		const recordedArgs = args ?? null;
		state.tauriCalls.push({ args: recordedArgs, command });
		if (command === "open_external" && isNativeText(args?.url)) {
			state.externalUrls.push(args.url);
		}
		writeState(state);
		return null;
	},
	transformCallback: () => 0,
};
Object.assign(window, { __TAURI_INTERNALS__: tauriInternals });

const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
	const rawUrl = input instanceof Request ? input.url : String(input);
	const url = new URL(rawUrl, window.location.href);
	const method = (init?.method ?? "GET").toUpperCase();
	const body = parseBody(init?.body);
	const headers = new Headers(
		input instanceof Request ? input.headers : undefined
	);
	new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
	if (url.pathname.startsWith("/api/")) {
		capture(url, method, body, headers);
	}

	if (url.pathname === "/api/auth/get-session") {
		return jsonResponse({
			session: {
				activeOrganizationId: FIXTURE_ORG_ID,
				createdAt: new Date().toISOString(),
				expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
				id: "session-billing-fixture",
				userId: FIXTURE_USER_ID,
			},
			user: {
				email: "billing@example.test",
				id: FIXTURE_USER_ID,
				image: null,
				name: "Billing fixture",
			},
		});
	}
	if (url.pathname === "/api/control-plane/orgs") {
		return jsonResponse({
			organizations: [
				{
					createdAt: "2026-01-01T00:00:00.000Z",
					id: FIXTURE_ORG_ID,
					isPersonal: true,
					logo: null,
					name: "Fixture workspace",
					role: "owner",
					slug: "billing-fixture",
				},
			],
		});
	}
	if (url.pathname === "/api/plugins") {
		return jsonResponse({ apps: [] });
	}
	if (url.pathname === "/api/plugins/contributions") {
		return jsonResponse({ settings_tabs: [] });
	}
	if (url.pathname === "/api/step-up/status") {
		return jsonResponse({
			action: "Open the billing portal",
			enrolmentRequired: false,
			methods: ["totp"],
			satisfied: true,
			scope: "billing",
			twoFactorEnabled: true,
			windowMs: 300_000,
		});
	}
	if (url.pathname === "/api/billing/subscription-status") {
		return jsonResponse(subscriptionStatus(readState()));
	}
	if (url.pathname === "/api/billing/trial" && method === "POST") {
		const state = readState();
		const firstLaunchAt =
			state.scenario === "trial"
				? new Date(Date.now() - 60 * 86_400_000).toISOString()
				: new Date(Date.now() - 2 * 86_400_000).toISOString();
		return jsonResponse({ firstLaunchAt });
	}
	if (url.pathname === "/api/billing/invoices") {
		return jsonResponse({ invoices: readState().invoices });
	}
	if (url.pathname === "/api/billing/portal") {
		if (consumeFailure("portal")) {
			return jsonResponse(
				{ error: "billing_portal_fixture_temporarily_unavailable" },
				503
			);
		}
		const state = readState();
		state.portalCount += 1;
		writeState(state);
		return jsonResponse({
			url: `https://billing.fixture.test/portal/${state.portalCount}`,
		});
	}
	if (url.pathname === "/api/billing/checkout/lifetime" && method === "POST") {
		return jsonResponse({ url: "https://checkout.fixture.test/lifetime" });
	}
	if (url.pathname === "/api/upsell/state") {
		return jsonResponse({ lastUpsellShownAtMs: Date.now() });
	}
	if (url.pathname === "/api/upsell/pitch") {
		return jsonResponse({ cards: [] });
	}
	if (url.pathname === "/api/credits/wallet") {
		return jsonResponse({
			ledger: [],
			wallet: {
				balanceBreakdownAvailable: true,
				balanceMicroUsd: 42_500_000,
				currency: "usd",
				giftBalanceMicroUsd: 0,
				id: "wallet-billing-fixture",
				ownerId: FIXTURE_ORG_ID,
				ownerType: "org",
				subscriptionBalanceMicroUsd: 0,
				topupBalanceMicroUsd: 42_500_000,
				updatedAt: new Date().toISOString(),
			},
		});
	}
	if (url.pathname === "/api/credits/wallet/stream") {
		const encoder = new TextEncoder();
		const payload = JSON.stringify({
			balanceMicroUsd: 42_500_000,
			currency: "usd",
			id: "wallet-billing-fixture",
			ownerId: FIXTURE_ORG_ID,
			updatedAt: new Date().toISOString(),
		});
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(`event: wallet\ndata: ${payload}\n\n`)
				);
			},
		});
		return new Response(stream, {
			headers: { "content-type": "text/event-stream" },
		});
	}
	if (url.pathname === "/api/campaigns/mine") {
		return jsonResponse({ pools: [] });
	}
	if (url.pathname === "/api/credits/autotopup") {
		if (method === "GET") {
			return jsonResponse({ settings: readState().autoTopup });
		}
		if (method === "PUT") {
			if (consumeFailure("autotopup")) {
				return jsonResponse(
					{ message: "billing_fixture_temporarily_unavailable" },
					503
				);
			}
			const state = readState();
			state.autoTopup = {
				...state.autoTopup,
				...autoTopupSchema.partial().parse(body),
			};
			writeState(state);
			return jsonResponse({ settings: state.autoTopup });
		}
	}
	if (url.pathname === "/api/credits/alert") {
		if (method === "GET") {
			return jsonResponse({ settings: readState().alert });
		}
		if (method === "PUT") {
			if (consumeFailure("alert")) {
				return jsonResponse(
					{ message: "billing_fixture_temporarily_unavailable" },
					503
				);
			}
			const input = creditAlertSchema
				.pick({ recipients: true, thresholdCents: true })
				.parse(body);
			const state = readState();
			state.alert = {
				belowSince: null,
				lastError: null,
				notifiedAt: null,
				recipients: input.recipients,
				thresholdCents: input.thresholdCents,
			};
			writeState(state);
			return jsonResponse({ settings: state.alert });
		}
	}
	if (url.pathname.startsWith("/api/preferences/")) {
		const key = decodeURIComponent(
			url.pathname.slice("/api/preferences/".length)
		);
		const state = readState();
		if (method === "GET") {
			const value = state.preferences[key];
			return isNativeText(value)
				? jsonResponse({ key, value })
				: jsonResponse({ error: "preference_not_found" }, 404);
		}
		if (method === "PUT") {
			if (
				key === "sandbox-default-run-budget-micro-usd" &&
				consumeFailure("budget")
			) {
				return jsonResponse(
					{ error: "billing_budget_fixture_temporarily_unavailable" },
					503
				);
			}
			const preference = z.object({ value: z.string() }).safeParse(body);
			const value = preference.success ? preference.data.value : undefined;
			if (!isNativeText(value)) {
				return jsonResponse({ error: "invalid_preference_value" }, 400);
			}
			state.preferences[key] = value;
			writeState(state);
			return jsonResponse({ key, value });
		}
	}
	if (url.pathname.startsWith("/api/")) {
		return jsonResponse(
			{ error: "unhandled_billing_fixture_route", path: url.pathname },
			404
		);
	}
	return nativeFetch(input, init);
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
								<SettingsDialog
									defaultSection="general"
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

window.__billingTabProof = {
	configureFailures: (failures) => {
		const state = readState();
		state.failures = { ...state.failures, ...failures };
		writeState(state);
	},
	snapshot: () => readState(),
};
