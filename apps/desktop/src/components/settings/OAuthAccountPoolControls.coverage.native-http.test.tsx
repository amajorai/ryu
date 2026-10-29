// biome-ignore-all lint/suspicious/noMisplacedAssertion: the shared teardown asserts every case left no undeclared Core request.
// OAuthAccountPoolControls against a loopback Core peer that serves the real
// account-pool policy and per-account usage routes. The active node comes from
// the real node store; strategy, drain, per-account switches, priorities,
// drain overrides and the quota refresh are all driven through the rendered
// controls, and every effect is read back from what Core received or holds.
import {
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import type {
	OAuthAccountPoolPolicy,
	PiAccount,
	PiProvider,
} from "@/src/lib/api/pi-config.ts";
import {
	button,
	byName,
	type CorePeer,
	choose,
	click,
	fill,
	flush,
	installAnimationApis,
	isDisabled,
	maybeButton,
	type PeerCall,
	registerDomWithNativeNetworking,
	startCorePeer,
	text,
	until,
} from "./models-plugins-settings.test-support.ts";

registerDomWithNativeNetworking();
installAnimationApis();
setDefaultTimeout(30_000);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { OAuthAccountPoolControls } = await import(
	"./OAuthAccountPoolControls.tsx"
);

type Policy = OAuthAccountPoolPolicy;
type Account = PiAccount;
type Capabilities = NonNullable<PiProvider["accountRouting"]>;

const TOKEN = "account-pool-token";
const PROVIDER = "claude-pro-max";
const POLICY_PATH = `/api/pi-config/providers/${PROVIDER}/account-pool`;
const initialNodeState = useNodeStore.getState();

const ACCOUNTS: Account[] = [
	{
		accountId: "work",
		label: "Work",
		kind: "oauth",
		active: true,
		gatewayActive: false,
		updatedAt: 0,
	},
	{
		accountId: "home",
		label: "Home",
		kind: "oauth",
		active: false,
		gatewayActive: false,
		updatedAt: 0,
	},
	{
		accountId: "stale",
		label: "Stale",
		kind: "oauth",
		active: false,
		gatewayActive: false,
		needsReauth: true,
		updatedAt: 0,
	},
];

interface CoreState {
	policy: Policy;
	usage: Record<string, { status: number; body: unknown }>;
}

let core: CoreState;
let peer: CorePeer;
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement;
let client: InstanceType<typeof QueryClient>;

function seededPolicy(): Policy {
	return {
		strategy: "round_robin",
		drainThresholdPercent: 80,
		accounts: {
			work: { enabled: true, priority: 1, drainThresholdPercent: null },
			home: { enabled: true, priority: 2, drainThresholdPercent: null },
			stale: { enabled: true, priority: 3, drainThresholdPercent: null },
		},
	};
}

function usage(windows: { model: string | null; used_percent: number }[]) {
	return {
		status: 200,
		body: {
			providerId: PROVIDER,
			engine: "claude",
			available: true,
			reason: null,
			meters: [],
			windows: windows.map((window) => ({
				targetId: `window:5h:${window.model ?? ""}:18000`,
				label: "5h",
				scope: window.model === null ? "account" : "model",
				model: window.model,
				usedPercent: window.used_percent,
				remainingPercent: 100 - window.used_percent,
				windowSeconds: 18_000,
				window: "5h",
			})),
		},
	};
}

/**
 * Core's forced provider read: every enabled, signed-in account is read (the
 * account that needs a new sign-in never is). A failed vendor read fails the
 * whole request, as Core's snapshot route answers it.
 */
function subscriptionsSnapshot() {
	const refused = Object.values(core.usage).find(
		(entry) => entry.status !== 200
	);
	if (refused) {
		return refused;
	}
	return {
		status: 200,
		body: {
			version: 1,
			generatedAt: "2026-10-14T00:00:00Z",
			providers: [
				{
					providerId: PROVIDER,
					label: "Claude Pro/Max",
					kind: "subscription",
					managed: false,
					capabilities: {
						accountUsage: true,
						accountPing: true,
						accountPinning: "none",
						poolStrategies: ["round_robin"],
						quotaObservations: true,
					},
					policy: null,
					activeAccountId: "work",
					accounts: ACCOUNTS.map((account) => ({
						...account,
						gatewayActive: false,
						needsReauth: account.needsReauth === true,
						poolEnabled: true,
						state: account.needsReauth ? "needs_reauth" : "ok",
						usage: account.needsReauth
							? null
							: (core.usage[account.accountId]?.body ?? null),
					})),
				},
			],
		},
	};
}

function route(call: PeerCall) {
	if (call.authorization !== `Bearer ${TOKEN}`) {
		return { status: 401, body: { error: "unauthorized" } };
	}
	if (call.path === POLICY_PATH && call.method === "GET") {
		return { body: core.policy };
	}
	if (call.path === POLICY_PATH && call.method === "PUT") {
		core.policy = structuredClone(call.body as Policy);
		return { body: core.policy };
	}
	if (
		call.method === "GET" &&
		`${call.path}${call.search}` ===
			`/api/usage/subscriptions?provider=${PROVIDER}&usage=force`
	) {
		return subscriptionsSnapshot();
	}
	return;
}

async function mount(
	capabilities: Capabilities = {
		credentialKinds: ["oauth"],
		quotaObservations: true,
		strategies: ["manual", "round_robin", "quota_first", "fill_first"],
	}
) {
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client}>
				<OAuthAccountPoolControls
					accounts={ACCOUNTS}
					capabilities={capabilities}
					providerId={PROVIDER}
				/>
				<Toaster />
			</QueryClientProvider>
		)
	);
	await until(() => maybeButton("Save routing") !== null, "policy loaded");
}

function puts() {
	return peer.calls.filter((call) => call.method === "PUT");
}

function input(name: string): HTMLInputElement {
	return byName<HTMLInputElement>(name, "input");
}

function save() {
	return button("Save routing");
}

beforeEach(() => {
	core = { policy: seededPolicy(), usage: {} };
	peer = startCorePeer(route);
	client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: "account-pool-coverage",
		nodes: [
			{
				name: "account-pool-coverage",
				token: TOKEN,
				url: peer.url,
				userJwt: "account-pool-user",
			},
		],
		tabOverrides: {},
	});
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	await act(async () => {
		root?.unmount();
		sileo.clear();
	});
	root = null;
	client.clear();
	container.remove();
	document.body.replaceChildren();
	useNodeStore.setState(initialNodeState, true);
	peer.stop();
	expect(peer.unexpected).toEqual([]);
});

test("strategy, drain point, account switch and drain override save as one policy and read back after a fresh mount", async () => {
	await mount();
	expect(isDisabled(save())).toBe(true);
	// The drain point only exists for Fill first.
	expect(container.querySelector(`#oauth-drain-${PROVIDER}`)).toBeNull();
	const strategy = container.querySelector<HTMLElement>(
		`#oauth-strategy-${PROVIDER}`
	);
	if (!strategy) {
		throw new Error("Missing strategy select");
	}
	const offered = await choose(strategy, "Fill first");
	expect(offered).toEqual([
		"Manual",
		"Round robin",
		"Quota first",
		"Fill first",
	]);
	const drain = container.querySelector<HTMLInputElement>(
		`#oauth-drain-${PROVIDER}`
	);
	if (!drain) {
		throw new Error("Missing drain input");
	}
	await fill(drain, "65");
	await click(byName("Use Home for claude-pro-max", '[role="switch"]'));
	await fill(input("Drain override for Work on claude-pro-max"), "0");
	await click(save());
	await until(() => puts().length === 1, "policy write");
	await until(() => text().includes("Account routing saved"), "save toast");
	expect(puts()[0].body).toEqual({
		strategy: "fill_first",
		drainThresholdPercent: 65,
		accounts: {
			work: { enabled: true, priority: 1, drainThresholdPercent: 0 },
			home: { enabled: false, priority: 2, drainThresholdPercent: null },
			stale: { enabled: true, priority: 3, drainThresholdPercent: null },
		},
	});
	expect(core.policy.strategy).toBe("fill_first");
	expect(isDisabled(save())).toBe(true);

	await act(async () => root?.unmount());
	client.clear();
	await mount();
	await until(
		() =>
			container.querySelector<HTMLInputElement>(`#oauth-drain-${PROVIDER}`)
				?.value === "65",
		"saved drain point"
	);
	expect(
		byName("Use Home for claude-pro-max", '[role="switch"]').getAttribute(
			"aria-checked"
		)
	).toBe("false");
	expect(input("Drain override for Work on claude-pro-max").value).toBe("0");
	expect(input("Drain override for Home on claude-pro-max").value).toBe("");
});

test("out-of-range drain points, priorities and overrides keep Save locked and never reach Core; clearing an override restores the provider default", async () => {
	core.policy = {
		...seededPolicy(),
		strategy: "fill_first",
		accounts: {
			...seededPolicy().accounts,
			work: { enabled: true, priority: 1, drainThresholdPercent: 40 },
		},
	};
	await mount();
	const drain = () => {
		const element = container.querySelector<HTMLInputElement>(
			`#oauth-drain-${PROVIDER}`
		);
		if (!element) {
			throw new Error("Missing drain input");
		}
		return element;
	};
	await until(() => drain().value === "80", "saved drain point");
	for (const value of ["0", "101", "12.5"]) {
		await fill(drain(), value);
		expect(isDisabled(save())).toBe(true);
	}
	await fill(drain(), "80");
	await fill(input("Priority for Work on claude-pro-max"), "101");
	expect(isDisabled(save())).toBe(true);
	await fill(input("Priority for Work on claude-pro-max"), "1");
	await fill(input("Drain override for Work on claude-pro-max"), "-1");
	expect(isDisabled(save())).toBe(true);
	await click(save());
	expect(puts()).toEqual([]);

	// Blank means "inherit the provider drain point", sent as null.
	await fill(input("Drain override for Work on claude-pro-max"), "");
	expect(isDisabled(save())).toBe(false);
	await click(save());
	await until(() => puts().length === 1, "policy write");
	expect(
		(puts()[0].body as Policy).accounts.work.drainThresholdPercent
	).toBeNull();
	expect(core.policy.accounts.work).toEqual({
		enabled: true,
		priority: 1,
		drainThresholdPercent: null,
	});
});

test("Refresh quota reads each enabled, signed-in account separately and reports only complete account-wide readings", async () => {
	core.usage = {
		// Account-wide window within 0..100: counted.
		work: usage([
			{ model: null, used_percent: 42 },
			{ model: "opus", used_percent: 99 },
		]),
		// Only a per-model window: no account-wide reading, not counted.
		home: usage([{ model: "opus", used_percent: 10 }]),
	};
	await mount();
	expect(text()).toContain(
		"Reads each enabled account separately. Quota readings expire after five minutes."
	);
	await click(button("Refresh quota"));
	await until(
		() =>
			text().includes(
				"Account-wide usage returned for 1 of 2 accounts. Missing readings remain unknown."
			),
		"quota summary"
	);
	// One forced provider read; the account that needs a new sign-in is
	// listed without a reading and is not counted.
	expect(
		peer.calls
			.filter((call) => call.path === "/api/usage/subscriptions")
			.map((call) => `${call.path}${call.search}`)
	).toEqual([`/api/usage/subscriptions?provider=${PROVIDER}&usage=force`]);
	expect(puts()).toEqual([]);

	// A refused reading is reported without touching the saved routing.
	core.usage.work = { status: 503, body: { error: "quota upstream down" } };
	await click(button("Refresh quota"));
	await until(
		() =>
			text().includes(
				"Could not refresh account quota. Existing logins are unchanged."
			),
		"quota refusal"
	);
	expect(core.policy).toEqual(seededPolicy());
	expect(maybeButton("Refresh quota")?.disabled).toBe(false);
});

test("without quota observations the pool offers no quota refresh, no drain override and says rotation cannot read quota", async () => {
	await mount({
		credentialKinds: ["oauth"],
		quotaObservations: false,
		strategies: ["manual", "fill_first"],
	});
	expect(text()).toContain("Quota observations are unavailable.");
	expect(text()).toContain(
		"Fill first keeps the first eligible account until availability or priority changes."
	);
	expect(maybeButton("Refresh quota")).toBeNull();
	expect(
		container.querySelector(
			'[aria-label="Drain override for Work on claude-pro-max"]'
		)
	).toBeNull();
	await flush();
	expect(
		peer.calls.some((call) => call.path === "/api/usage/subscriptions")
	).toBe(false);
});
