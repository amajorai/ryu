import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	spyOn,
} from "bun:test";
import { TauriUnavailableError } from "@/src/lib/tauri-ready.ts";
import {
	dialog,
	hasDialog,
	input,
	installAccountBillingDom,
	settle,
	signInVaultAccount,
	text,
	type,
	until as untilPage,
} from "./account-billing.native-http.dom.ts";
import { startNodePeer } from "./account-billing.native-http.helpers.ts";
import {
	calls,
	harness,
	northRecharge,
	type OrgId,
	refusals,
	server,
	TOKEN,
	tauri,
	unknown,
} from "./BillingTab.native-http.control-plane.ts";

export {
	button,
	click,
	input,
	maybeButton,
	settle,
	text,
	type,
} from "./account-billing.native-http.dom.ts";
export {
	BUDGET_KEY,
	calls,
	ENTITLEMENT_MIRROR_PATHS,
	GOOD_CODE,
	harness,
	northRecharge,
	refusals,
	tauri,
} from "./BillingTab.native-http.control-plane.ts";

// Shared harness for the BillingTab native-HTTP suites (no cases of its own;
// importing it registers the per-case hooks).
//
// Mounts the shipping Billing tab inside the shipping EntitlementProvider with
// the shipping session, orgs, subscription, credits, step-up, preference and
// native-bridge clients. One control-plane peer keeps auto-recharge and alert
// records per organization (resolved from the session, as `credits.ts`
// does), gates card-funded changes behind a billing step-up grant and
// streams the wallet; two Core node peers hold the per-node sandbox budget.
installAccountBillingDom();
setDefaultTimeout(30_000);

export const nodes = startNodePeer(["north", "south"]);
process.env.VITE_APP_BACKEND_URL = server.url.origin;
Object.defineProperty(window, "__TAURI_INTERNALS__", {
	configurable: true,
	value: {
		invoke: async (command: string, args: unknown) => {
			// This harness has no sealed auth-vault slot: the vault seeded in
			// localStorage below is read as a host without one would.
			if (command.startsWith("desktop_secret_")) {
				return Promise.reject(new TauriUnavailableError(command));
			}
			tauri.push({ args, command });
			if (command === "open_external") {
				return null;
			}
			// The entitlement store is best-effort and falls back without it.
			throw new Error(`Undeclared native command ${command}`);
		},
		transformCallback: () => 0,
	},
});

const { act, createElement } = await import("react");

export { act };

const { createRoot } = await import("react-dom/client");
const { QueryClientProvider } = await import("@tanstack/react-query");
const { sileo } = await import("sileo");
const { queryClient } = await import("@/src/lib/query-client.ts");
const { authClient, TOKEN_KEY } = await import("@/lib/auth-client.ts");

export { authClient };

const { ACTIVE_ORG_KEY } = await import("@/src/lib/api/orgs.ts");
const { LOCAL_FALLBACK, useNodeStore } = await import(
	"@/src/store/useNodeStore.ts"
);
const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
const { BillingTab } = await import("./BillingTab.tsx");

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;
let errorToast: ReturnType<typeof spyOn<typeof sileo, "error">>;
export const runtimeErrors: string[] = [];
// React logs a render-phase update ("Cannot update a component while rendering
// a different component") once per component pair per process, so it is
// captured for the whole file: the flag readers subscribe to the query cache,
// which sibling sections write during render.
const renderPhaseUpdates: string[] = [];
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
	const line = args.map(String).join(" ");
	if (line.includes("Cannot update a component")) {
		renderPhaseUpdates.push(line);
	}
	originalConsoleError(...args);
};

export function until(predicate: () => boolean, reason: string, ms = 8000) {
	return untilPage(predicate, reason, ms, () =>
		[...calls.slice(-6), ...nodes.calls.slice(-4)]
			.map((call) => `${call.method} ${call.path} ${call.status}`)
			.join("\n")
	);
}
export function errorTitles() {
	return errorToast.mock.calls.map((call) => String(call[0]?.title ?? ""));
}
export function rechargeSwitch() {
	const found = document.querySelector<HTMLElement>(
		'[role="switch"][aria-label="Automatic recharge"]'
	);
	if (!found) {
		throw new Error(`Automatic recharge switch missing\n${text()}`);
	}
	return found;
}
export function rechargeOn() {
	return rechargeSwitch().getAttribute("aria-checked") === "true";
}
export function cap() {
	return input('input[placeholder="0 = no limit"]');
}
export function budget() {
	return input('input[aria-label="Default sandbox run budget"]');
}
export function autoTopupWrites() {
	return calls
		.filter(
			(call) => call.method === "PUT" && call.path === "/api/credits/autotopup"
		)
		.map((call) => ({ body: call.body, org: call.org, status: call.status }));
}
export async function blur(element: HTMLElement) {
	await act(async () => {
		element.focus();
		element.blur();
	});
}
function nodeFor(name: string) {
	return {
		...LOCAL_FALLBACK,
		name,
		token: nodes.tokenFor(name),
		url: nodes.urlFor(name),
		userJwt: null,
	};
}
export async function selectNode(name: string) {
	const list = [nodeFor("north"), nodeFor("south")];
	await act(async () => {
		useNodeStore.setState({
			autoSelect: false,
			autoSelectedNode: null,
			cloudNodes: [],
			defaultNode: name,
			localNodes: list,
			nodes: list,
			tabOverrides: {},
		});
	});
}
export async function switchWorkspace(org: OrgId) {
	harness.activeOrg = org;
	await act(async () => {
		await queryClient.invalidateQueries({ queryKey: ACTIVE_ORG_KEY });
	});
}
export async function enterCode(code: string) {
	await until(() => hasDialog("Confirm it's you"), "billing step-up not shown");
	const field = () =>
		input('input[aria-label="Confirmation code"]', dialog("Confirm it's you"));
	// A rejected code re-enables the field once the prompt has reset it.
	await until(() => !field().disabled, "confirmation field stayed busy");
	await settle(20);
	await type(field(), code);
}
export async function mount() {
	signInVaultAccount(TOKEN_KEY, TOKEN, "billing-owner");
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container, {
		onCaughtError: (error) => runtimeErrors.push(String(error)),
		onRecoverableError: (error) => runtimeErrors.push(String(error)),
		onUncaughtError: (error) => runtimeErrors.push(String(error)),
	});
	await act(async () =>
		root?.render(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(EntitlementProvider, null, createElement(BillingTab))
			)
		)
	);
}
export async function unmount() {
	await act(async () => root?.unmount());
	root = null;
	container?.remove();
	container = null;
	document.body.replaceChildren();
}
export function settledRecharge() {
	const toggle = document.querySelector<HTMLElement>(
		'[role="switch"][aria-label="Automatic recharge"]'
	);
	return Boolean(
		toggle &&
			toggle.getAttribute("aria-disabled") !== "true" &&
			!toggle.hasAttribute("data-disabled")
	);
}

beforeEach(async () => {
	harness.activeOrg = "org-north";
	harness.grants = 0;
	harness.autoTopups = { "org-north": northRecharge() };
	refusals.clear();
	harness.sessionReply = undefined;
	harness.features = { "billing.individual_plans": true };
	calls.length = 0;
	unknown.length = 0;
	nodes.calls.length = 0;
	nodes.unknown.length = 0;
	for (const store of Object.values(nodes.preferences)) {
		store.clear();
	}
	tauri.length = 0;
	runtimeErrors.length = 0;
	localStorage.clear();
	await act(async () => {
		await queryClient.cancelQueries();
		queryClient.clear();
	});
	errorToast = spyOn(sileo, "error");
	await selectNode("north");
});

afterEach(async () => {
	await unmount();
	errorToast.mockRestore();
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case refuses undeclared routes and wrong authority.
	expect([...unknown, ...nodes.unknown]).toEqual([]);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must render without React errors.
	expect(runtimeErrors).toEqual([]);
	// biome-ignore lint/suspicious/noMisplacedAssertion: no case may update a component during another's render.
	expect(renderPhaseUpdates).toEqual([]);
});

afterAll(() => {
	console.error = originalConsoleError;
	server.stop(true);
	nodes.stop();
	localStorage.clear();
});
