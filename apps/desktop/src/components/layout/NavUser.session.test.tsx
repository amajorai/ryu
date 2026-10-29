import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!("document" in globalThis)) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");

// The signed-in session the auth client reports. Better Auth's contract is
// `{ user, session } | null`; a proxy or misconfigured backend can answer the
// session route with something else, and that must not take the shell down.
let session: unknown = null;
const subscriptionQueries: Array<{ accountId: string | null }> = [];

// Real modules are loaded before any is mocked: a factory that imports its own
// path would wait on itself.
const realAuthClient = await import("@/lib/auth-client.ts");
const realSettings = await import("@ryu/settings");
const realAuthContext = await import("@/contexts/auth-context.tsx");
const realStepUp = await import("@/src/components/StepUpDialog.tsx");
const realEntitlement = await import("@/src/contexts/entitlement-context.tsx");
const realCredits = await import("@/src/hooks/useCreditsWallet.ts");
const realOrgBilling = await import("@/src/hooks/useOrgBillingStatus.ts");
const realAvailability = await import("@/src/hooks/useUserAvailability.ts");
const realOrgs = await import("@/src/lib/api/orgs.ts");
const realCompanionAlias = await import(
	"@/src/contributions/use-companion-alias.ts"
);

// Only the hooks the account menu reads are replaced; every module keeps its
// other exports so unrelated importers still resolve.
mock.module("@/lib/auth-client.ts", () => ({
	...realAuthClient,
	useSession: () => ({ data: session, isPending: false }),
}));
mock.module("@ryu/settings", () => ({
	...realSettings,
	useSubscription: (query: { accountId: string | null }) => {
		subscriptionQueries.push({ accountId: query.accountId });
		return {
			hasProSubscription: false,
			isTrialing: false,
			daysLeftInTrial: null,
			isLifetime: false,
			lifetime: null,
			planInterval: null,
			isLoading: false,
		};
	},
}));
mock.module("@/contexts/auth-context.tsx", () => ({
	...realAuthContext,
	useAuthContext: () => ({ handleSignOut: () => undefined }),
}));
mock.module("@/src/components/StepUpDialog.tsx", () => ({
	...realStepUp,
	useStepUp: () => ({
		guard: async (_scope: string, run: () => unknown) => run(),
	}),
}));
mock.module("@/src/contexts/entitlement-context.tsx", () => ({
	...realEntitlement,
	useEntitlementContext: () => ({ verdict: null }),
}));
mock.module("@/src/hooks/useCreditsWallet.ts", () => ({
	...realCredits,
	useCreditsWallet: () => ({
		wallet: null,
		entitlement: null,
		loading: false,
		error: null,
	}),
}));
mock.module("@/src/hooks/useOrgBillingStatus.ts", () => ({
	...realOrgBilling,
	useOrgBillingStatus: () => ({
		billing: null,
		organization: null,
		plan: null,
	}),
}));
mock.module("@/src/hooks/useUserAvailability.ts", () => ({
	...realAvailability,
	useUserAvailability: () => ({
		availability: "online",
		setAvailability: () => undefined,
	}),
}));
mock.module("@/src/lib/api/orgs.ts", () => ({
	...realOrgs,
	useActiveOrgId: () => null,
}));
mock.module("@/src/contributions/use-companion-alias.ts", () => ({
	...realCompanionAlias,
	useCompanionAlias: () => null,
}));

const { NavUser } = await import("./NavUser.tsx");
const { useAppStore } = await import("../../store/useAppStore.ts");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
	subscriptionQueries.length = 0;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	useAppStore.setState({ isAuthenticated: true, oidcUser: null });
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

async function renderNavUser() {
	await act(async () => {
		root.render(createElement(NavUser, { presentation: "menubar" }));
	});
}

test("a session that carries no user does not crash the account menu", async () => {
	// What an array or empty-object answer from the session route parses to:
	// truthy, with no `user` on it.
	session = [];
	await renderNavUser();

	expect(
		container.querySelector("[data-testid='ryu-os-user-navigation']")
	).not.toBeNull();
	expect(subscriptionQueries.at(-1)).toEqual({ accountId: null });
});

test("a session with a user hands that account to the subscription lookup", async () => {
	session = {
		user: { id: "user-1", name: "Ada", email: "ada@example.test", image: null },
	};
	await renderNavUser();

	expect(subscriptionQueries.at(-1)).toEqual({ accountId: "user-1" });
});
