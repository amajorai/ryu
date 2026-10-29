import { hostedAgentIncludedCreditUsd } from "@ryu/blocks/web/pricing.tsx";
import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { z } from "zod";
import { FRONTEND_URL, TOKEN_KEY } from "../../lib/auth-client.ts";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { queryClient as appQueryClient } from "../../src/lib/query-client.ts";
import type { ProofJsonRecord } from "../fixture-json.ts";
import { parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

const STORAGE_KEY = "teams-billing-settings-proof:state";
const ORGANIZATION_ID = "teams-billing-proof-org";
const USER_ID = "teams-billing-proof-user";

interface RequestRecord {
	body: unknown;
	headers: Record<string, string>;
	method: string;
	path: string;
}

interface FailureRule {
	message: string;
	needsUpgrade?: boolean;
	remaining: number;
	status: number;
}

interface FixtureState {
	activeOrganizationId: string | null;
	billedSeats: number;
	/** The member also holds the additive Billing role (`billing.manage`). */
	billingManager: boolean;
	checkoutCount: number;
	externalUrls: string[];
	failures: Record<string, FailureRule>;
	organizationPlan: "business" | "teams" | "teams-lite" | null;
	portalCount: number;
	requests: RequestRecord[];
	role: "admin" | "member" | "owner" | "viewer";
	serverRole: "admin" | "member" | "owner" | "viewer";
	tauriCalls: { args: ProofJsonRecord | null; command: string }[];
}

interface TauriInternalsBridge {
	invoke: (command: string, args?: ProofJsonRecord) => Promise<null>;
	transformCallback: () => number;
}

// The spec reads this object through the same declaration, so the two cannot
// disagree about a signature.
declare global {
	interface Window {
		__teamsBillingSettingsProof: {
			armFailure: (
				operation: string,
				status: number,
				message: string,
				needsUpgrade?: boolean
			) => void;
			expectedOrganizationsUrl: string;
			setServerRole: (role: FixtureState["serverRole"]) => void;
			snapshot: () => FixtureState;
		};
	}
}

const RoleSchema = z.enum(["admin", "member", "owner", "viewer"]);
const FixtureStateSchema = z.object({
	activeOrganizationId: z.string().nullable(),
	billedSeats: z.number(),
	billingManager: z.boolean(),
	checkoutCount: z.number(),
	externalUrls: z.string().array(),
	failures: z.record(
		z.string(),
		z.object({
			message: z.string(),
			needsUpgrade: z.boolean().optional(),
			remaining: z.number(),
			status: z.number(),
		})
	),
	organizationPlan: z.enum(["business", "teams", "teams-lite"]).nullable(),
	portalCount: z.number(),
	requests: z.array(
		z.object({
			body: z.json(),
			headers: z.record(z.string(), z.string()),
			method: z.string(),
			path: z.string(),
		})
	),
	role: RoleSchema,
	serverRole: RoleSchema,
	tauriCalls: z.array(
		z.object({
			args: z.record(z.string(), z.json()).nullable(),
			command: z.string(),
		})
	),
}) satisfies z.ZodType<FixtureState>;

/** Mirrors the server: owners and Billing-role holders manage billing; admins do not. */
function managesBilling(state: FixtureState): boolean {
	return state.serverRole === "owner" || state.billingManager;
}

function freshState(): FixtureState {
	const params = new URLSearchParams(window.location.search);
	const scenario = params.get("scenario") ?? "teams";
	const noOrg = scenario === "no-org";
	const signedOut = scenario === "signed-out";
	const role = RoleSchema.parse(params.get("role") ?? "owner");
	const state: FixtureState = {
		activeOrganizationId: noOrg || signedOut ? null : ORGANIZATION_ID,
		billedSeats: 5,
		billingManager: params.get("billing") === "true",
		checkoutCount: 0,
		externalUrls: [],
		failures: {},
		organizationPlan:
			noOrg || signedOut || scenario === "checkout"
				? null
				: scenario === "business"
					? "business"
					: scenario === "teams-lite"
						? "teams-lite"
						: "teams",
		portalCount: 0,
		requests: [],
		role,
		serverRole: role,
		tauriCalls: [],
	};
	if (params.get("failSeatsReadOnce") === "true") {
		state.failures["GET /api/billing/seats"] = {
			message: "The billing seat service is temporarily unavailable.",
			remaining: 1,
			status: 503,
		};
	}
	return state;
}

function writeState(state: FixtureState): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function readState(): FixtureState {
	const saved = localStorage.getItem(STORAGE_KEY);
	return saved ? FixtureStateSchema.parse(JSON.parse(saved)) : freshState();
}

function jsonResponse<FixturePayload>(
	body: FixturePayload,
	status = 200
): Response {
	return Response.json(body, { status });
}

function parseBody(value: BodyInit | null | undefined) {
	if (!isNativeText(value)) {
		return null;
	}
	try {
		return parseProofJson(value);
	} catch {
		return value;
	}
}

function captureRequest<Body>(
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
		path: `${url.pathname}${url.search}`,
	});
	writeState(state);
}

function consumeFailure(path: string, method: string): FailureRule | null {
	const state = readState();
	const key = `${method} ${path}`;
	const failure = state.failures[key];
	if (!failure || failure.remaining < 1) {
		return null;
	}
	failure.remaining -= 1;
	writeState(state);
	return failure;
}

function subscriptionStatus(state: FixtureState) {
	const plan = state.organizationPlan;
	const includedCreditMicroUsd = plan
		? Math.round(
				hostedAgentIncludedCreditUsd(plan, state.billedSeats) * 1_000_000
			)
		: 0;
	return {
		entitlement: {
			desktopAccess: plan !== null,
			managedInference: plan !== null,
			monthlyCreditPoolMicroUsd: includedCreditMicroUsd,
			plan,
		},
		features: {},
		giftSubscription: null,
		hostedAgents: null,
		organizationId: state.activeOrganizationId,
		plan,
		scope: "org",
	};
}

function seatStatus(state: FixtureState) {
	const includedCreditMicroUsd = state.organizationPlan
		? Math.round(
				hostedAgentIncludedCreditUsd(
					state.organizationPlan,
					state.billedSeats
				) * 1_000_000
			)
		: 0;
	return {
		allocatedSeats: 5,
		availableSeats: Math.max(0, state.billedSeats - 5),
		billedSeats: state.billedSeats,
		bonusExpiresAt: null,
		bonusSeats: 0,
		canInvite: true,
		includedCreditPoolMicroUsd: includedCreditMicroUsd,
		includedSeats: state.billedSeats,
		invitationBlockedReason: null,
		memberCount: 4,
		minRequired: 5,
		minSeats: 5,
		organizationId: ORGANIZATION_ID,
		overAllocated: false,
		pendingInvitations: 1,
		pendingSeatReservations: 1,
		plan: state.organizationPlan,
	};
}

function installFixture(): void {
	const params = new URLSearchParams(window.location.search);
	if (params.get("reset") === "true") {
		localStorage.removeItem(STORAGE_KEY);
		params.delete("reset");
		const search = params.toString();
		window.history.replaceState(
			null,
			"",
			`${window.location.pathname}${search ? `?${search}` : ""}`
		);
	}
	const state = localStorage.getItem(STORAGE_KEY) ? readState() : freshState();
	writeState(state);
	if (state.activeOrganizationId) {
		localStorage.setItem(TOKEN_KEY, "teams-billing-proof-session-token");
	} else if (
		new URLSearchParams(window.location.search).get("scenario") === "no-org"
	) {
		localStorage.setItem(TOKEN_KEY, "teams-billing-proof-session-token");
	} else {
		localStorage.removeItem(TOKEN_KEY);
	}
	appQueryClient.clear();

	const proof: Window["__teamsBillingSettingsProof"] = {
		armFailure: (operation, status, message, needsUpgrade) => {
			const current = readState();
			const rule = current.failures[operation];
			current.failures[operation] = {
				message,
				needsUpgrade,
				remaining: (rule?.remaining ?? 0) + 1,
				status,
			};
			writeState(current);
		},
		expectedOrganizationsUrl: `${FRONTEND_URL.replace(/\/$/u, "")}/organizations`,
		setServerRole: (role) => {
			const current = readState();
			current.serverRole = role;
			writeState(current);
		},
		snapshot: () => structuredClone(readState()),
	};
	window.__teamsBillingSettingsProof = proof;
	const tauriInternals: TauriInternalsBridge = {
		invoke: async (command, args) => {
			const current = readState();
			const recordedArgs = args ?? null;
			current.tauriCalls.push({ args: recordedArgs, command });
			if (command === "open_external" && isNativeText(args?.url)) {
				current.externalUrls.push(args.url);
			}
			writeState(current);
			return null;
		},
		transformCallback: () => 0,
	};
	Object.assign(window, { __TAURI_INTERNALS__: tauriInternals });

	const nativeFetch = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const rawUrl = input instanceof Request ? input.url : String(input);
		const url = new URL(rawUrl, window.location.href);
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		const rawBody =
			init?.body ??
			(input instanceof Request ? await input.clone().text() : null);
		const body = parseBody(rawBody);
		const headers = new Headers(
			input instanceof Request ? input.headers : undefined
		);
		new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
		if (!url.pathname.startsWith("/api/")) {
			return nativeFetch(input, init);
		}
		captureRequest(url, method, body, headers);

		if (url.pathname === "/api/billing/status/stream") {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					init?.signal?.addEventListener(
						"abort",
						() => {
							try {
								controller.close();
							} catch {
								// The page may already have cancelled the response body.
							}
						},
						{ once: true }
					);
				},
			});
			return new Response(stream, {
				headers: { "content-type": "text/event-stream" },
			});
		}

		const failure = consumeFailure(url.pathname, method);
		if (failure) {
			return jsonResponse(
				{
					error: failure.message,
					message: failure.message,
					needsUpgrade: failure.needsUpgrade ?? false,
				},
				failure.status
			);
		}

		if (url.pathname === "/api/auth/get-session" && method === "GET") {
			const current = readState();
			return jsonResponse({
				session: {
					activeOrganizationId: current.activeOrganizationId,
					activeTeamId: null,
					userId: USER_ID,
				},
				user: {
					email: "owner@example.test",
					id: USER_ID,
					name: "Billing owner",
				},
			});
		}
		if (
			url.pathname === "/api/billing/subscription-status" &&
			method === "GET"
		) {
			return jsonResponse(subscriptionStatus(readState()));
		}
		if (url.pathname === "/api/credits/wallet" && method === "GET") {
			const current = readState();
			const subscriptionBalanceMicroUsd = current.organizationPlan
				? Math.round(
						hostedAgentIncludedCreditUsd(
							current.organizationPlan,
							current.billedSeats
						) * 1_000_000
					)
				: 0;
			const giftBalanceMicroUsd = 42_500_000;
			const topupBalanceMicroUsd = 200_000_000;
			// `GET /api/credits/wallet` answers `{ wallet, ledger }` with the
			// stored wallet document; the shared wallet contract requires the
			// ledger and the wallet's owner and update stamp.
			return jsonResponse({
				ledger: [],
				wallet: {
					balanceBreakdownAvailable: true,
					balanceMicroUsd:
						subscriptionBalanceMicroUsd +
						giftBalanceMicroUsd +
						topupBalanceMicroUsd,
					currency: "usd",
					giftBalanceMicroUsd,
					id: "wallet-teams-billing-fixture",
					ownerId: current.activeOrganizationId ?? ORGANIZATION_ID,
					ownerType: "org",
					providerAllocations: [],
					subscriptionBalanceMicroUsd,
					topupBalanceMicroUsd,
					updatedAt: "2026-10-01T00:00:00.000Z",
				},
			});
		}
		if (url.pathname === "/api/control-plane/orgs" && method === "GET") {
			const current = readState();
			return jsonResponse({
				organizations: current.activeOrganizationId
					? [
							{
								id: current.activeOrganizationId,
								name: "Teams Billing Workspace",
								role: current.role,
							},
						]
					: [],
			});
		}
		if (
			url.pathname === "/api/control-plane/me/permissions" &&
			method === "GET"
		) {
			return jsonResponse({
				permissions: managesBilling(readState()) ? ["billing.manage"] : [],
			});
		}
		if (url.pathname === "/api/billing/seats" && method === "GET") {
			return jsonResponse(seatStatus(readState()));
		}
		if (url.pathname === "/api/billing/seats" && method === "POST") {
			const current = readState();
			if (!managesBilling(current)) {
				return jsonResponse(
					{
						message:
							"Only an organization owner or billing manager can do that.",
					},
					403
				);
			}
			const payload = z.object({ seats: z.number() }).parse(body);
			if (payload.seats > 50) {
				return jsonResponse(
					{
						message:
							"Teams self-serve covers up to 50 seats. Contact Enterprise for larger organizations.",
						needsUpgrade: true,
					},
					422
				);
			}
			current.billedSeats = payload.seats;
			writeState(current);
			return jsonResponse({
				memberCount: 4,
				pendingSeatCount: 1,
				prorationBehavior: "invoice",
				prorationLabel: "Prorated and charged now",
				seats: payload.seats,
			});
		}
		if (url.pathname === "/api/billing/portal" && method === "GET") {
			const current = readState();
			if (!managesBilling(current)) {
				return jsonResponse(
					{
						message:
							"Only an organization owner or billing manager can do that.",
					},
					403
				);
			}
			current.portalCount += 1;
			writeState(current);
			return jsonResponse({
				url: `https://billing.fixture.test/portal/${current.portalCount}`,
			});
		}
		if (
			url.pathname === "/api/billing/checkout/organization" &&
			method === "POST"
		) {
			const current = readState();
			if (!managesBilling(current)) {
				return jsonResponse(
					{
						message:
							"Only an organization owner or billing manager can do that.",
					},
					403
				);
			}
			const payload = z
				.object({
					interval: z.enum(["monthly", "yearly"]),
					organizationId: z.string(),
					planId: z.enum(["business", "teams", "teams-lite"]),
					seats: z.number(),
				})
				.parse(body);
			if (payload.seats > 50) {
				return jsonResponse(
					{
						message:
							"Teams self-serve covers up to 50 seats. Contact Enterprise for larger organizations.",
						needsUpgrade: true,
					},
					422
				);
			}
			current.checkoutCount += 1;
			writeState(current);
			return jsonResponse({
				monthlyPriceMicroUsd: payload.seats * 50_000_000,
				plan: payload.planId,
				seats: payload.seats,
				url: `https://checkout.fixture.test/organization/${current.checkoutCount}`,
			});
		}
		if (url.pathname === "/api/campaigns/mine" && method === "GET") {
			return jsonResponse({ pools: [] });
		}
		if (url.pathname === "/api/step-up/status" && method === "GET") {
			return jsonResponse({
				action: "Manage Teams billing",
				enrolmentRequired: false,
				methods: ["totp"],
				satisfied: true,
				scope: "billing",
				twoFactorEnabled: true,
				windowMs: 300_000,
			});
		}
		return jsonResponse(
			{ message: `No Teams billing fixture for ${method} ${url.pathname}.` },
			404
		);
	};
}

installFixture();

// StepUp's production client captures global fetch when it is initialized, so
// import the production tab only after installing the local service fixture.
const { TeamsBillingTab } = await import(
	"../../src/components/settings/TeamsBillingTab.tsx"
);

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			refetchOnWindowFocus: false,
			retry: false,
			// Resolving the active org remounts the production tab. Keep the fixture's
			// one-shot failure visible until the test explicitly clicks Try again.
			retryOnMount: false,
			staleTime: 0,
		},
	},
});

function ProofSurface() {
	return (
		<AppSurfaceProvider surface="desktop">
			<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
				<main className="mx-auto min-h-screen max-w-4xl bg-background px-8 py-10 text-foreground">
					<header className="mb-7">
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
							Production component proof
						</p>
						<h1 className="mt-2 font-semibold text-3xl tracking-tight">
							Teams billing settings
						</h1>
						<p className="mt-3 max-w-2xl text-muted-foreground text-sm">
							Rendered TeamsBillingTab with stateful organization billing,
							member-seat, wallet, and native navigation fixtures.
						</p>
					</header>
					<TeamsBillingTab />
					<Toaster position="bottom-right" theme="system" />
				</main>
			</ThemeProvider>
		</AppSurfaceProvider>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Teams billing settings proof root not found");
}

createRoot(root).render(
	<QueryClientProvider client={queryClient}>
		<I18nProvider>
			<MemoryRouter>
				<ProofSurface />
			</MemoryRouter>
		</I18nProvider>
	</QueryClientProvider>
);
document.body.dataset.harnessReady = "1";
