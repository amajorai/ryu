import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";

const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let account: string | null = "owner";
let organization: string | null = "A";
let enabled = true;
let calls: string[] = [];
let hold = false;
let refused = false;
let legacyBody = false;
let release: (() => void) | null = null;
let egress: string[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		if (new URL(request.url).pathname !== "/api/billing/subscription-status") {
			egress.push(`unexpected route ${new URL(request.url).pathname}`);
			return new NativeResponse("Unexpected route", { status: 500 });
		}
		const token = request.headers.get("authorization") ?? "";
		calls.push(token);
		if (hold && token === "Bearer owner:A") {
			await new Promise<void>((done) => {
				release = done;
			});
		}
		if (refused) {
			return NativeResponse.json(
				{ error: "Billing access denied" },
				{ status: 403 }
			);
		}
		if (legacyBody) {
			const { subscription, lifetime } = subscriptionStatus(token);
			return NativeResponse.json({ subscription, lifetime });
		}
		return NativeResponse.json(subscriptionStatus(token));
	},
});
// The complete `GET /api/billing/subscription-status` payload published by
// `computeSubscriptionStatus` (packages/api/src/routers/billing.ts); the shipping
// client admits only this contract, so a legacy two-field body is refused.
function subscriptionStatus(token: string) {
	const [, organizationId = null] = token.replace("Bearer ", "").split(":");
	const paid = token === "Bearer owner:A";
	const lifetime = token === "Bearer other:B";
	const plan = paid ? "pro" : lifetime ? "desktop-license" : null;
	return {
		subscription: paid
			? {
					id: "sub_owner_a",
					status: "active",
					interval: "year",
					currentPeriodEnd: "2030-01-01",
				}
			: null,
		lifetime: lifetime
			? {
					purchasedAt: "2025-01-01",
					updatesExpiresAt: "2030-01-01",
					expired: false,
				}
			: null,
		plan,
		seats: 1,
		entitlement: {
			desktopAccess: plan !== null,
			managedInference: paid,
			marketplaceApps: paid,
			monthlyCreditPoolMicroUsd: 0,
			plan,
			seats: 1,
		},
		hostedAgents: null,
		scope: "org",
		organizationId,
		features: {},
		giftSubscription: null,
	};
}
const { configureSettingsApi } = await import(
	"../../../../../packages/settings/src/utils/api-client.ts"
);
// The shipping Desktop host binds the settings client to its backend origin
// (`apps/desktop/lib/auth-client.ts` passes `baseUrl: BACKEND_URL`); there is no
// implicit localhost fallback, and happy-dom's about:blank origin is opaque.
configureSettingsApi({
	baseUrl: server.url.origin,
	getToken: () => (account ? `${account}:${organization}` : null),
});
const { useSubscription } = await import(
	"../../../../../packages/settings/src/hooks/useSubscription.ts"
);
const { createRoot } = await import("react-dom/client");
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
let latestRefetch: ReturnType<typeof useSubscription>["refetch"] | null = null;
function Reader() {
	const state = useSubscription({
		accountId: account,
		organizationId: organization,
		enabled,
	});
	latestRefetch = state.refetch;
	return (
		<div>
			<output>
				{JSON.stringify({
					pro: state.hasProSubscription,
					lifetime: state.isLifetime,
					interval: state.planInterval ?? null,
					error: state.error?.message ?? null,
				})}
			</output>
			<button
				onClick={() => {
					void state.refetch();
				}}
			>
				Retry
			</button>
		</div>
	);
}
async function render() {
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<Reader />
				<Reader />
			</QueryClientProvider>
		)
	);
}
async function waitFor(check: () => boolean) {
	for (let i = 0; i < 100 && !check(); i += 1) {
		await act(async () => {
			await Bun.sleep(5);
		});
	}
	if (!check()) {
		throw new Error(`Subscription view never reached ${check.toString()}`);
	}
}
function state() {
	const output = host.querySelector("output");
	if (!output) {
		throw new Error("Missing subscription view");
	}
	return JSON.parse(output.textContent ?? "{}");
}
beforeEach(() => {
	account = "owner";
	organization = "A";
	enabled = true;
	calls = [];
	hold = false;
	refused = false;
	legacyBody = false;
	release = null;
	egress = [];
	// Forward the client's own URL unchanged: a request to any origin other than
	// the configured backend is recorded and refused, never rewritten.
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const outgoing = input instanceof Request ? input.url : String(input);
			if (
				!URL.canParse(outgoing) ||
				new URL(outgoing).origin !== server.url.origin
			) {
				egress.push(outgoing);
				throw new Error(`Unowned subscription egress: ${outgoing}`);
			}
			return nativeFetch(outgoing, init);
		},
		{ preconnect: nativeFetch.preconnect }
	);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	client = new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
				staleTime: Number.POSITIVE_INFINITY,
				gcTime: Number.POSITIVE_INFINITY,
			},
		},
	});
});
afterEach(async () => {
	release?.();
	await act(async () => root.unmount());
	client.clear();
	host.remove();
	if (egress.length > 0) {
		throw new Error(`Unowned subscription egress: ${JSON.stringify(egress)}`);
	}
});
afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
	configureSettingsApi({ getToken: () => null });
});
test("same-authority readers share one actual authenticated request", async () => {
	await render();
	await waitFor(() => state().pro === true);
	expect(calls).toEqual(["Bearer owner:A"]);
	expect(
		client.getQueryData(["subscription-status", "owner", "A"])
	).toMatchObject({ subscription: { status: "active" } });
});
test("organization and account transitions read their own billing rather than reuse paid flags", async () => {
	await render();
	await waitFor(() => state().pro === true);
	organization = "B";
	await render();
	expect(state().pro).toBe(false);
	await waitFor(() => calls.length === 2);
	account = "other";
	await render();
	expect(state().lifetime).toBe(false);
	await waitFor(() => state().lifetime === true);
	expect(state().pro).toBe(false);
	expect(calls).toEqual(["Bearer owner:A", "Bearer owner:B", "Bearer other:B"]);
});
test("held old-organization success cannot populate the new authority", async () => {
	hold = true;
	await render();
	await waitFor(() => release !== null);
	organization = "B";
	await render();
	await waitFor(() => calls.length === 2);
	release?.();
	await waitFor(
		() =>
			client.getQueryState(["subscription-status", "owner", "A"])?.status ===
			"success"
	);
	expect(state().pro).toBe(false);
	expect(state().interval).toBe(null);
	expect(calls).toEqual(["Bearer owner:A", "Bearer owner:B"]);
});
test("pending authentication and logout hide cached paid data and do not issue requests", async () => {
	await render();
	await waitFor(() => state().pro === true);
	enabled = false;
	await render();
	expect(state().pro).toBe(false);
	expect(state().interval).toBe(null);
	const retry = host.querySelector("button");
	if (!retry) {
		throw new Error("Missing retry action");
	}
	await act(async () => retry.click());
	expect(calls).toHaveLength(1);
	enabled = true;
	await render();
	expect(state().pro).toBe(true);
	expect(calls).toHaveLength(1);
	account = null;
	enabled = true;
	await render();
	expect(state().pro).toBe(false);
	await act(async () => {
		await Bun.sleep(10);
	});
	expect(calls).toHaveLength(1);
});
test("prefix invalidation refetches the current authority once across readers", async () => {
	await render();
	await waitFor(() => state().pro === true);
	await act(async () => {
		await client.invalidateQueries({ queryKey: ["subscription-status"] });
	});
	expect(calls).toEqual(["Bearer owner:A", "Bearer owner:A"]);
	expect(state().pro).toBe(true);
});
test("actual HTTP refusal exposes error and manual retry reads the selected authority", async () => {
	refused = true;
	await render();
	await waitFor(() => state().error === "Billing access denied");
	expect(state().pro).toBe(false);
	refused = false;
	const retry = host.querySelector("button");
	if (!retry) {
		throw new Error("Missing retry action");
	}
	await act(async () => retry.click());
	await waitFor(() => state().pro === true);
	expect(calls).toEqual(["Bearer owner:A", "Bearer owner:A"]);
});
test("a 200 body outside the published contract never grants paid flags; retry admits the complete payload", async () => {
	legacyBody = true;
	await render();
	await waitFor(() => state().error !== null);
	expect(state()).toMatchObject({
		pro: false,
		lifetime: false,
		interval: null,
	});
	expect(
		client.getQueryState(["subscription-status", "owner", "A"])?.status
	).toBe("error");
	legacyBody = false;
	const retry = host.querySelector("button");
	if (!retry) {
		throw new Error("Missing retry action");
	}
	await act(async () => retry.click());
	await waitFor(() => state().pro === true);
	expect(state()).toMatchObject({ interval: "year", error: null });
	expect(calls).toEqual(["Bearer owner:A", "Bearer owner:A"]);
});

for (const transition of ["organization", "account", "pending", "logout"]) {
	test(`a retained refresh callback cannot request billing after ${transition}`, async () => {
		await render();
		await waitFor(() => state().pro === true);
		const retained = latestRefetch;
		if (!retained) {
			throw new Error("Missing rendered refresh callback");
		}
		if (transition === "organization") {
			organization = "B";
		}
		if (transition === "account") {
			account = "other";
		}
		if (transition === "pending") {
			enabled = false;
		}
		if (transition === "logout") {
			account = null;
		}
		await render();
		if (transition === "organization" || transition === "account") {
			await waitFor(
				() =>
					client.getQueryState(["subscription-status", account, organization])
						?.status === "success"
			);
		}
		const before = [...calls];
		await act(async () => {
			await retained();
		});
		expect(calls).toEqual(before);
	});
}

test("a retained refresh callback cannot request billing after its reader unmounts", async () => {
	await render();
	await waitFor(() => state().pro === true);
	const retained = latestRefetch;
	if (!retained) {
		throw new Error("Missing rendered refresh callback");
	}
	await act(async () => root.render(<QueryClientProvider client={client} />));
	account = "other";
	const before = [...calls];
	await act(async () => {
		await retained();
	});
	expect(calls).toEqual(before);
});
