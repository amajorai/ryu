// The control-plane peer behind the BillingTab native-HTTP suites: one HTTP
// server that keeps auto-recharge and alert records per organization (resolved
// from the session, as `credits.ts` does), gates card-funded changes behind
// a billing step-up grant, publishes the rollout flags, and issues checkouts.
// test-exempt: test-support peer, exercised by both BillingTab native-HTTP suites
// through BillingTab.native-http.harness.ts.
// Shared by `BillingTab.native-http.harness.ts`, which resets its state.

export type OrgId = "org-north" | "org-south";
export interface AutoTopup {
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
interface Call {
	body: unknown;
	headers: Record<string, string>;
	method: string;
	org: OrgId;
	path: string;
	status: number;
}

export const TOKEN = "billing-owner-session";
export const GOOD_CODE = "246810";
export const BUDGET_KEY = "sandbox-default-run-budget-micro-usd";
export const ENTITLEMENT_MIRROR_PATHS = [
	"/api/preferences/entitlement-active",
	"/api/preferences/managed-inference-entitled",
];
export const calls: Call[] = [];
export const unknown: string[] = [];
export const tauri: Array<{ args: unknown; command: string }> = [];
export const refusals = new Map<string, number>();
/** Per-case control-plane state; `beforeEach` resets it. */
export const harness: {
	activeOrg: OrgId;
	autoTopups: Partial<Record<OrgId, AutoTopup>>;
	/** Rollout flags `/subscription-status` publishes; Lifetime is an individual plan. */
	features: Record<string, boolean>;
	grants: number;
	/**
	 * When set, GET /api/auth/get-session answers this body verbatim instead of
	 * the signed-in owner, so a case can send the shapes a degraded auth service
	 * returns.
	 */
	sessionReply: unknown;
} = {
	activeOrg: "org-north",
	autoTopups: {},
	features: { "billing.individual_plans": true },
	grants: 0,
	sessionReply: undefined,
};

export function northRecharge(): AutoTopup {
	return {
		amountCents: 2000,
		consecutiveFailures: 0,
		cooldownSec: 600,
		enabled: true,
		lastAttemptAt: null,
		lastError: null,
		monthChargedMicroUsd: 0,
		monthKey: "2026-10",
		monthlyCapCents: 10_000,
		thresholdCents: 700,
	};
}

export const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	idleTimeout: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const raw = request.method === "GET" ? "" : await request.text();
		const call: Call = {
			body: raw ? JSON.parse(raw) : null,
			headers: Object.fromEntries(request.headers.entries()),
			method: request.method,
			org: harness.activeOrg,
			path: url.pathname + url.search,
			status: 0,
		};
		calls.push(call);
		const reply = (payload: unknown, status = 200) => {
			call.status = status;
			return Response.json(payload, { status });
		};
		if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
			unknown.push(`${request.method} ${url.pathname}: unauthenticated`);
			return reply({ error: "Unauthorized" }, 401);
		}
		const route = `${request.method} ${url.pathname}`;
		const refusal = refusals.get(route);
		if (refusal) {
			refusals.delete(route);
			return reply({ message: "Billing service unavailable" }, refusal);
		}
		const at = "2026-10-11T00:00:00.000Z";
		if (route === "GET /api/auth/get-session") {
			if (harness.sessionReply !== undefined) {
				return reply(harness.sessionReply);
			}
			return reply({
				session: {
					activeOrganizationId: harness.activeOrg,
					activeTeamId: null,
					createdAt: at,
					expiresAt: "2027-10-11T00:00:00.000Z",
					id: "billing-session",
					token: TOKEN,
					updatedAt: at,
					userId: "billing-owner",
				},
				user: {
					createdAt: at,
					email: "owner@billing.example.test",
					emailVerified: true,
					id: "billing-owner",
					image: null,
					name: "Billing Owner",
					updatedAt: at,
				},
			});
		}
		if (route === "GET /api/control-plane/orgs") {
			return reply({
				organizations: [
					{ id: "org-north", name: "North Workspace", role: "owner" },
					{ id: "org-south", name: "South Workspace", role: "owner" },
				],
			});
		}
		if (route === "GET /api/billing/subscription-status") {
			return reply({
				entitlement: {
					desktopAccess: true,
					managedInference: true,
					marketplaceApps: true,
					monthlyCreditPoolMicroUsd: 0,
					plan: "pro",
					seats: 1,
				},
				features: harness.features,
				giftSubscription: null,
				hostedAgents: null,
				lifetime: null,
				organizationId: harness.activeOrg,
				plan: "pro",
				scope: "org",
				seats: 1,
				subscription: {
					currentPeriodEnd: "2026-11-11T00:00:00.000Z",
					id: `sub-${harness.activeOrg}`,
					interval: "month",
					status: "active",
				},
			});
		}
		if (route === "GET /api/auth/token") {
			// No realtime JWT is issued here; the wallet's realtime room then
			// joins anonymously, as it does when the jwt plugin refuses.
			return reply({ error: "Realtime tokens are not issued" }, 404);
		}
		if (route === "POST /api/billing/trial") {
			return reply({ firstLaunchAt: "2026-10-01T00:00:00.000Z" });
		}
		if (route === "GET /api/billing/invoices") {
			return reply({ invoices: [] });
		}
		if (route === "GET /api/campaigns/mine") {
			return reply({ pools: [] });
		}
		if (route === "GET /api/credits/wallet") {
			return reply({
				ledger: [],
				wallet: {
					balanceMicroUsd:
						harness.activeOrg === "org-north" ? 42_500_000 : 7_000_000,
					currency: "usd",
					id: `wallet-${harness.activeOrg}`,
					ownerId: harness.activeOrg,
					ownerType: "org",
					subscriptionBalanceMicroUsd: 0,
					topupBalanceMicroUsd: 0,
					updatedAt: at,
				},
			});
		}
		if (route === "GET /api/credits/wallet/stream") {
			return new Response(new ReadableStream<Uint8Array>({}), {
				headers: { "content-type": "text/event-stream" },
			});
		}
		if (route === "GET /api/credits/alert") {
			return reply({ settings: null });
		}
		if (route === "GET /api/credits/autotopup") {
			return reply({ settings: harness.autoTopups[harness.activeOrg] ?? null });
		}
		if (route === "GET /api/step-up/status") {
			return reply({
				action: "complete this billing action",
				enrolmentRequired: false,
				methods: ["totp"],
				satisfied: harness.grants > 0,
				scope: url.searchParams.get("scope"),
				twoFactorEnabled: true,
				windowMs: 300_000,
			});
		}
		if (route === "POST /api/step-up/verify") {
			const input = call.body as { code?: string; scope?: string };
			if (input?.scope !== "billing") {
				unknown.push(`verify ${raw}`);
				return reply({ error: "Undeclared verification" }, 400);
			}
			if (input.code !== GOOD_CODE) {
				return reply({ error: "That code didn't work." }, 400);
			}
			harness.grants += 1;
			return reply({ ok: true });
		}
		if (route === "PUT /api/credits/autotopup") {
			if (harness.grants === 0) {
				return reply({ error: "STEP_UP_REQUIRED", scope: "billing" }, 403);
			}
			const input = call.body as Partial<AutoTopup>;
			const current = harness.autoTopups[harness.activeOrg];
			harness.autoTopups[harness.activeOrg] = {
				consecutiveFailures: 0,
				cooldownSec: input.cooldownSec ?? current?.cooldownSec ?? 3600,
				lastAttemptAt: null,
				lastError: null,
				monthChargedMicroUsd: 0,
				monthKey: "2026-10",
				amountCents: input.amountCents ?? 0,
				enabled: Boolean(input.enabled),
				monthlyCapCents: input.monthlyCapCents ?? 0,
				thresholdCents: input.thresholdCents ?? 0,
			};
			return reply({ settings: harness.autoTopups[harness.activeOrg] });
		}
		if (route === "POST /api/billing/checkout/lifetime") {
			if (harness.grants === 0) {
				return reply({ error: "STEP_UP_REQUIRED", scope: "billing" }, 403);
			}
			return reply({
				url: `https://checkout.example.test/lifetime/${harness.activeOrg}`,
			});
		}
		unknown.push(route);
		return reply({ error: "Undeclared billing contract" }, 404);
	},
});
