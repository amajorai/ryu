import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";

// Rollout flags are audience-targeted per user AND per role in the active
// organization, so a map fetched for one (account, org) scope must never be
// stored or served under another scope that became active while the request
// was in flight. The auth vault, the billing client and the org-session read are
// the only seams replaced; the real app query client carries the active org.

const TOKEN_KEY = "ryu_session_token";
let activeUserId: string | null = "user-a";
let serverOrgId: string | null = null;
let orgLookups = 0;
interface SnapshotReply {
	features: Record<string, boolean>;
	organizationId?: string | null;
}
const pendingSnapshots: Array<(value: SnapshotReply) => void> = [];

const storage = new Map<string, string>();
const originalLocalStorage = globalThis.localStorage;
Object.defineProperty(globalThis, "localStorage", {
	configurable: true,
	value: {
		getItem: (key: string) => storage.get(key) ?? null,
		removeItem: (key: string) => storage.delete(key),
		setItem: (key: string, value: string) => storage.set(key, value),
	},
});

mock.module("@/lib/auth-client.ts", () => ({
	BACKEND_URL: "https://control.example",
	getActiveUserId: () => activeUserId,
	TOKEN_KEY,
	getActiveToken: () => globalThis.localStorage?.getItem(TOKEN_KEY) ?? null,
}));
mock.module("@/src/lib/api/billing.ts", () => ({
	fetchEntitlementSnapshot: () =>
		new Promise((resolve) => {
			pendingSnapshots.push(resolve);
		}),
}));
const orgsModule = await import("@/src/lib/api/orgs.ts");
mock.module("@/src/lib/api/orgs.ts", () => ({
	...orgsModule,
	getActiveOrgId: () => {
		orgLookups += 1;
		return Promise.resolve(serverOrgId);
	},
}));

const { ACTIVE_ORG_KEY, activeOrgQueryKey, activeOrgSwitchState } = orgsModule;
const { queryClient } = await import("@/src/lib/query-client.ts");
const {
	captureFeatureFlagScope,
	featureFlagScopeKey,
	isFeatureFlagStale,
	publishFeatureFlags,
	readFeatureFlag,
	refreshFeatureFlags,
} = await import("./feature-flags.ts");

const BOX_FLAG = "cloud_tasks.box_backend";
const FLAGS_KEY = "ryu.feature-flags";

/** The active org of the active account's session, as the app caches it. */
function setActiveOrg(orgId: string | null): void {
	queryClient.setQueryData(activeOrgQueryKey(activeUserId), orgId);
}

function signInWithOrg(orgId: string | null): void {
	storage.set(TOKEN_KEY, "token");
	setActiveOrg(orgId);
}

/** A request scope captured now, as `captureFeatureFlagScope` would. */
function scope(accountId: string, orgId: string | null) {
	return {
		accountId,
		orgId,
		orgSwitchGeneration: activeOrgSwitchState().generation,
	};
}

function storedScopes(): Array<{
	accountId: string;
	features: Record<string, boolean>;
	orgId: string | null;
}> {
	return JSON.parse(storage.get(FLAGS_KEY) ?? "{}").records ?? [];
}

function resolveNextSnapshot(
	features: Record<string, boolean>,
	servedOrgId?: string | null
): void {
	const resolve = pendingSnapshots.shift();
	if (!resolve) {
		throw new Error("no flags request is in flight");
	}
	resolve(
		servedOrgId === undefined
			? { features }
			: { features, organizationId: servedOrgId }
	);
}

async function settle(): Promise<void> {
	for (let turn = 0; turn < 10; turn += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

afterAll(() => {
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: originalLocalStorage,
	});
});

beforeEach(() => {
	storage.clear();
	pendingSnapshots.length = 0;
	queryClient.removeQueries({ queryKey: ACTIVE_ORG_KEY });
	serverOrgId = null;
	orgLookups = 0;
	// Reading under a scope nobody published drops any in-memory record left by
	// the previous test.
	activeUserId = "reset";
	readFeatureFlag(BOX_FLAG);
	activeUserId = "user-a";
});

describe("account scope", () => {
	test("a refresh that lands after an account switch is dropped", async () => {
		const refresh = refreshFeatureFlags();
		activeUserId = "user-b";
		resolveNextSnapshot({ [BOX_FLAG]: true });
		await refresh;
		expect(readFeatureFlag(BOX_FLAG)).toBeNull();
		activeUserId = "user-a";
		expect(readFeatureFlag(BOX_FLAG)).toBeNull();
	});

	test("a refresh for the still-active account is published", async () => {
		const refresh = refreshFeatureFlags();
		resolveNextSnapshot({ [BOX_FLAG]: true });
		await refresh;
		expect(readFeatureFlag(BOX_FLAG)).toBe(true);
		activeUserId = "user-b";
		expect(readFeatureFlag(BOX_FLAG)).toBeNull();
	});

	test("publishing for a different account than the active one writes nothing", () => {
		publishFeatureFlags({ [BOX_FLAG]: true }, scope("user-b", null));
		expect(readFeatureFlag(BOX_FLAG)).toBeNull();
		publishFeatureFlags({ [BOX_FLAG]: false }, scope("user-a", null));
		expect(readFeatureFlag(BOX_FLAG)).toBe(false);
		publishFeatureFlags({ [BOX_FLAG]: true }, null);
		expect(readFeatureFlag(BOX_FLAG)).toBe(false);
	});
});

describe("organization scope", () => {
	test("an org switch drops the old org's values and its stored record", () => {
		signInWithOrg("org-admin");
		publishFeatureFlags({ [BOX_FLAG]: true }, scope("user-a", "org-admin"));
		expect(readFeatureFlag(BOX_FLAG)).toBe(true);
		expect(isFeatureFlagStale()).toBe(false);

		setActiveOrg("org-member");
		expect(readFeatureFlag(BOX_FLAG)).toBeNull();
		expect(isFeatureFlagStale()).toBe(true);
		setActiveOrg(null);
		expect(readFeatureFlag(BOX_FLAG)).toBeNull();

		// The record is still on disk, but only its own scope can read it.
		expect(storedScopes().map((record) => record.orgId)).toEqual(["org-admin"]);
		setActiveOrg("org-admin");
		expect(readFeatureFlag(BOX_FLAG)).toBe(true);
	});

	test("the scope key changes on an org switch so readers refetch", () => {
		signInWithOrg("org-one");
		const before = featureFlagScopeKey();
		setActiveOrg("org-two");
		expect(featureFlagScopeKey()).not.toBe(before);
		setActiveOrg("org-one");
		expect(featureFlagScopeKey()).toBe(before);
	});

	test("a refresh that lands after an org switch is discarded", async () => {
		signInWithOrg("org-admin");
		const refresh = refreshFeatureFlags();
		setActiveOrg("org-member");
		resolveNextSnapshot({ [BOX_FLAG]: true });
		await refresh;
		expect(readFeatureFlag(BOX_FLAG)).toBeNull();
		setActiveOrg("org-admin");
		expect(readFeatureFlag(BOX_FLAG)).toBeNull();
		expect(storage.has(FLAGS_KEY)).toBe(false);
	});

	test("a refresh in flight for the old org does not satisfy the new org", async () => {
		signInWithOrg("org-admin");
		const stale = refreshFeatureFlags();
		expect(refreshFeatureFlags()).toBe(stale);
		setActiveOrg("org-member");
		const fresh = refreshFeatureFlags();
		expect(fresh).not.toBe(stale);
		expect(pendingSnapshots).toHaveLength(2);

		resolveNextSnapshot({ [BOX_FLAG]: true });
		resolveNextSnapshot({ [BOX_FLAG]: false });
		await Promise.all([stale, fresh]);
		expect(readFeatureFlag(BOX_FLAG)).toBe(false);
	});

	test("a captured scope is published only while that scope is active", async () => {
		signInWithOrg("org-one");
		const captured = await captureFeatureFlagScope();
		expect(captured).toEqual(scope("user-a", "org-one"));
		setActiveOrg("org-two");
		publishFeatureFlags({ [BOX_FLAG]: true }, captured);
		expect(readFeatureFlag(BOX_FLAG)).toBeNull();
		setActiveOrg("org-one");
		publishFeatureFlags({ [BOX_FLAG]: true }, captured);
		expect(readFeatureFlag(BOX_FLAG)).toBe(true);
	});

	test("a legacy record without an org is unscoped and ignored inside an org", () => {
		storage.set(
			FLAGS_KEY,
			JSON.stringify({
				accountId: "user-a",
				features: { [BOX_FLAG]: true },
				fetchedAtMs: Date.now(),
			})
		);
		expect(readFeatureFlag(BOX_FLAG)).toBe(true);
		signInWithOrg("org-one");
		expect(readFeatureFlag(BOX_FLAG)).toBeNull();
		setActiveOrg(null);
		expect(readFeatureFlag(BOX_FLAG)).toBe(true);
	});

	test("nothing is readable until the active org is known, and a refresh resolves it first", async () => {
		storage.set(TOKEN_KEY, "token");
		storage.set(
			FLAGS_KEY,
			JSON.stringify({
				accountId: "user-a",
				features: { [BOX_FLAG]: true },
				fetchedAtMs: Date.now(),
				orgId: "org-one",
			})
		);
		serverOrgId = "org-two";
		expect(readFeatureFlag(BOX_FLAG)).toBeNull();

		const refresh = refreshFeatureFlags();
		await settle();
		expect(orgLookups).toBe(1);
		expect(pendingSnapshots).toHaveLength(1);
		resolveNextSnapshot({ [BOX_FLAG]: false });
		await refresh;
		expect(readFeatureFlag(BOX_FLAG)).toBe(false);
		expect(storedScopes()[0]?.orgId).toBe("org-two");
	});

	test("an offline org lookup rides this account's last-good record and publishes nothing", async () => {
		storage.set(TOKEN_KEY, "token");
		storage.set(
			FLAGS_KEY,
			JSON.stringify({
				accountId: "user-a",
				features: { [BOX_FLAG]: true },
				fetchedAtMs: 1,
				orgId: "org-one",
			})
		);
		await queryClient
			.fetchQuery({
				queryFn: () => Promise.reject(new Error("offline")),
				queryKey: activeOrgQueryKey("user-a"),
				retry: false,
			})
			.catch(() => undefined);
		expect(readFeatureFlag(BOX_FLAG)).toBe(true);
		publishFeatureFlags({ [BOX_FLAG]: false }, scope("user-a", "org-one"));
		expect(readFeatureFlag(BOX_FLAG)).toBe(true);

		activeUserId = "user-b";
		expect(readFeatureFlag(BOX_FLAG)).toBeNull();
	});
});

describe("several scopes", () => {
	test("switching back to an earlier org restores its flags at once and still revalidates", async () => {
		signInWithOrg("org-admin");
		publishFeatureFlags({ [BOX_FLAG]: true }, scope("user-a", "org-admin"));
		setActiveOrg("org-member");
		publishFeatureFlags({ [BOX_FLAG]: false }, scope("user-a", "org-member"));
		expect(readFeatureFlag(BOX_FLAG)).toBe(false);

		setActiveOrg("org-admin");
		expect(readFeatureFlag(BOX_FLAG)).toBe(true);
		// Inside the TTL, but a switch back is revalidated once.
		expect(isFeatureFlagStale()).toBe(true);
		const refresh = refreshFeatureFlags();
		expect(pendingSnapshots).toHaveLength(1);
		resolveNextSnapshot({ [BOX_FLAG]: false }, "org-admin");
		await refresh;
		expect(readFeatureFlag(BOX_FLAG)).toBe(false);
		expect(isFeatureFlagStale()).toBe(false);

		setActiveOrg("org-member");
		expect(readFeatureFlag(BOX_FLAG)).toBe(false);
		expect(storedScopes().map((record) => record.orgId)).toEqual([
			"org-admin",
			"org-member",
		]);
	});

	test("each account keeps its eight most recently published orgs", () => {
		activeUserId = "user-b";
		signInWithOrg("org-b");
		publishFeatureFlags({ [BOX_FLAG]: true }, scope("user-b", "org-b"));
		activeUserId = "user-a";
		for (let index = 0; index < 9; index += 1) {
			setActiveOrg(`org-${index}`);
			publishFeatureFlags(
				{ [BOX_FLAG]: index % 2 === 0 },
				scope("user-a", `org-${index}`)
			);
		}
		const records = storedScopes();
		expect(
			records
				.filter((record) => record.accountId === "user-a")
				.map((record) => record.orgId)
		).toEqual([
			"org-8",
			"org-7",
			"org-6",
			"org-5",
			"org-4",
			"org-3",
			"org-2",
			"org-1",
		]);
		// Another account's scopes are not evicted by this account's.
		expect(
			records.filter((record) => record.accountId === "user-b")
		).toHaveLength(1);

		setActiveOrg("org-0");
		expect(readFeatureFlag(BOX_FLAG)).toBeNull();
		setActiveOrg("org-2");
		expect(readFeatureFlag(BOX_FLAG)).toBe(true);
		activeUserId = "user-b";
		expect(readFeatureFlag(BOX_FLAG)).toBe(true);
	});

	test("a single record written before several scopes were kept still reads", () => {
		signInWithOrg("org-one");
		storage.set(
			FLAGS_KEY,
			JSON.stringify({
				accountId: "user-a",
				features: { [BOX_FLAG]: true },
				fetchedAtMs: Date.now(),
				orgId: "org-one",
			})
		);
		expect(readFeatureFlag(BOX_FLAG)).toBe(true);
		setActiveOrg("org-two");
		publishFeatureFlags({ [BOX_FLAG]: false }, scope("user-a", "org-two"));
		expect(storedScopes().map((record) => record.orgId)).toEqual([
			"org-two",
			"org-one",
		]);
	});
});

describe("active org is keyed by account", () => {
	test("an account switch never pairs the new account with the old account's org", async () => {
		signInWithOrg("org-admin");
		publishFeatureFlags({ [BOX_FLAG]: true }, scope("user-a", "org-admin"));
		expect(readFeatureFlag(BOX_FLAG)).toBe(true);

		activeUserId = "user-b";
		// user-b's org is unknown until looked up; user-a's org is not borrowed.
		expect(featureFlagScopeKey()).toBe(JSON.stringify(["pending", "user-b"]));
		expect(readFeatureFlag(BOX_FLAG)).toBeNull();
		serverOrgId = "org-b";
		expect(await captureFeatureFlagScope()).toEqual(scope("user-b", "org-b"));
		expect(orgLookups).toBe(1);
		expect(
			queryClient.getQueryData<string | null>(activeOrgQueryKey("user-a"))
		).toBe("org-admin");

		activeUserId = "user-a";
		expect(readFeatureFlag(BOX_FLAG)).toBe(true);
	});

	test("an org lookup that lands after an account switch is not cached for either account", async () => {
		storage.set(TOKEN_KEY, "token");
		let finishLookup: (orgId: string | null) => void = () => undefined;
		const lookup = orgsModule.getActiveOrgIdForAccount(
			"user-a",
			() =>
				new Promise<string | null>((resolve) => {
					finishLookup = resolve;
				})
		);
		activeUserId = "user-b";
		finishLookup("org-b");
		await expect(lookup).rejects.toThrow("active account changed");
	});
});

describe("server-side org switch races", () => {
	test("flags the server says it served for another org are discarded", async () => {
		signInWithOrg("org-one");
		const refresh = refreshFeatureFlags();
		resolveNextSnapshot({ [BOX_FLAG]: true }, "org-two");
		await refresh;
		expect(readFeatureFlag(BOX_FLAG)).toBeNull();
		expect(storage.has(FLAGS_KEY)).toBe(false);

		const matching = refreshFeatureFlags();
		resolveNextSnapshot({ [BOX_FLAG]: true }, "org-one");
		await matching;
		expect(readFeatureFlag(BOX_FLAG)).toBe(true);
	});

	test("a response that lands while an org switch is in flight is discarded", async () => {
		signInWithOrg(null);
		let finishSwitch: (response: Response) => void = () => undefined;
		const switchCalls: string[] = [];
		globalThis.fetch = Object.assign(
			(input: RequestInfo | URL) => {
				switchCalls.push(String(input));
				return new Promise<Response>((resolve) => {
					finishSwitch = resolve;
				});
			},
			{ preconnect: originalFetch.preconnect }
		);

		const refresh = refreshFeatureFlags();
		const switching = orgsModule.setActiveOrg("org-two");
		expect(activeOrgSwitchState().switching).toBe(true);
		// The server already answers for the new org, while the cache still
		// names no org: storing it under "no org" would be wrong.
		resolveNextSnapshot({ [BOX_FLAG]: true }, "org-two");
		await refresh;
		expect(readFeatureFlag(BOX_FLAG)).toBeNull();

		finishSwitch(Response.json({}));
		await switching;
		expect(switchCalls).toEqual([
			"https://control.example/api/auth/organization/set-active",
		]);
		expect(activeOrgSwitchState().switching).toBe(false);
		// The switch itself names the new org, without waiting for a refetch.
		expect(featureFlagScopeKey()).toBe(
			JSON.stringify(["resolved", "user-a", "org-two"])
		);
		expect(readFeatureFlag(BOX_FLAG)).toBeNull();
		expect(storage.has(FLAGS_KEY)).toBe(false);
	});

	test("a request captured before a switch is discarded even if the org is switched back", async () => {
		signInWithOrg("org-one");
		globalThis.fetch = Object.assign(() => Promise.resolve(Response.json({})), {
			preconnect: originalFetch.preconnect,
		});
		const captured = await captureFeatureFlagScope();
		await orgsModule.setActiveOrg("org-two");
		await orgsModule.setActiveOrg("org-one");
		expect(featureFlagScopeKey()).toBe(
			JSON.stringify(["resolved", "user-a", "org-one"])
		);
		publishFeatureFlags({ [BOX_FLAG]: true }, captured, "org-one");
		expect(readFeatureFlag(BOX_FLAG)).toBeNull();
		publishFeatureFlags(
			{ [BOX_FLAG]: true },
			await captureFeatureFlagScope(),
			"org-one"
		);
		expect(readFeatureFlag(BOX_FLAG)).toBe(true);
	});
});
