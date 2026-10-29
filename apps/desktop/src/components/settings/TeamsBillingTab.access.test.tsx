import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type Role = "owner" | "admin" | "member" | "viewer" | null;

let role: Role = "member";
let permissionReads = 0;
let answerPermissions: () => Promise<string[]> = async () => [];

const realTeamsBilling = await import("@/src/lib/api/teams-billing.ts");
mock.module("@/src/lib/api/teams-billing.ts", () => ({
	...realTeamsBilling,
	fetchOrgRole: async () => role,
	fetchSubscriptionStatus: async () => ({
		entitlement: {
			desktopAccess: true,
			managedInference: true,
			monthlyCreditPoolMicroUsd: 0,
			plan: "teams",
		},
		features: {},
		hostedAgents: null,
		organizationId: "org-a",
		plan: "teams",
		scope: "org",
	}),
	fetchTeamsSeatStatus: async () => ({
		allocatedSeats: 2,
		availableSeats: 3,
		billedSeats: 5,
		bonusExpiresAt: null,
		bonusSeats: 0,
		canInvite: true,
		includedCreditPoolMicroUsd: null,
		includedSeats: 5,
		invitationBlockedReason: null,
		memberCount: 2,
		minRequired: 5,
		minSeats: 5,
		organizationId: "org-a",
		overAllocated: false,
		pendingInvitations: 0,
		pendingSeatReservations: 0,
		plan: "teams",
	}),
	fetchWallet: async () => ({
		wallet: {
			balanceMicroUsd: 0,
			currency: "usd",
			id: "wallet-a",
			subscriptionBalanceMicroUsd: 0,
			topupBalanceMicroUsd: 0,
		},
	}),
	hasTeamsBillingAuth: () => true,
}));
const realOrg = await import("@/src/lib/api/org.ts");
mock.module("@/src/lib/api/org.ts", () => ({
	...realOrg,
	fetchMyPermissions: () => {
		permissionReads += 1;
		return answerPermissions();
	},
}));
mock.module("@/src/lib/api/orgs.ts", () => ({
	useActiveOrgId: () => "org-a",
}));
mock.module("@/src/hooks/useBillingStatusStream.ts", () => ({
	useBillingStatusStream: () => null,
}));
mock.module("@/src/hooks/useCreditGrants.ts", () => ({
	useCreditGrants: () => ({ loading: false, pools: [] }),
}));
mock.module("@/src/components/StepUpDialog.tsx", () => ({
	useStepUp: () => ({
		dialog: null,
		guard: <TValue,>(_purpose: string, action: () => Promise<TValue>) =>
			action(),
	}),
}));

const { createRoot } = await import("react-dom/client");
const { TeamsBillingTab } = await import("./TeamsBillingTab.tsx");

let root: Root | null = null;
let host: HTMLDivElement;

beforeEach(() => {
	role = "member";
	permissionReads = 0;
	answerPermissions = async () => [];
	host = document.createElement("div");
	document.body.append(host);
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.replaceChildren();
});

async function flush() {
	await act(async () => {
		await Bun.sleep(20);
	});
}

async function mount() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	root = createRoot(host);
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client}>
				<TeamsBillingTab />
			</QueryClientProvider>
		)
	);
	await flush();
}

function buttonNamed(name: string): HTMLButtonElement | null {
	return (
		[...host.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === name
		) ?? null
	);
}

function accessAlert(): Element | null {
	return host.querySelector('[data-testid="teams-billing-access-unavailable"]');
}

test("a Billing-role member sees a loading state, not hidden controls, while permissions load", async () => {
	let release: (permissions: string[]) => void = () => undefined;
	answerPermissions = () =>
		new Promise<string[]>((resolve) => {
			release = resolve;
		});
	await mount();

	expect(host.querySelector('[data-slot="skeleton"]')).not.toBeNull();
	expect(buttonNamed("Save seats")).toBeNull();
	expect(accessAlert()).toBeNull();

	await act(async () => release(["billing.manage"]));
	await flush();

	expect(buttonNamed("Save seats")).not.toBeNull();
	expect(buttonNamed("Manage billing")).not.toBeNull();
	expect(accessAlert()).toBeNull();
});

test("a failed permission read surfaces an error with retry instead of silently hiding billing controls", async () => {
	answerPermissions = async () => {
		throw new Error("permissions request failed");
	};
	await mount();

	expect(accessAlert()?.getAttribute("role")).toBe("alert");
	expect(buttonNamed("Save seats")).toBeNull();
	const readsBeforeRetry = permissionReads;

	answerPermissions = async () => ["billing.manage"];
	const retry = buttonNamed("Try again");
	expect(retry).not.toBeNull();
	await act(async () => retry?.click());
	await flush();

	expect(permissionReads).toBe(readsBeforeRetry + 1);
	expect(accessAlert()).toBeNull();
	expect(buttonNamed("Save seats")).not.toBeNull();
});

test("controls stay hidden without an error only when the read succeeds without billing.manage", async () => {
	answerPermissions = async () => ["gateway.view"];
	await mount();

	expect(host.querySelector('[data-slot="skeleton"]')).toBeNull();
	expect(host.textContent).toContain("Teams");
	expect(buttonNamed("Save seats")).toBeNull();
	expect(buttonNamed("Manage billing")).toBeNull();
	expect(accessAlert()).toBeNull();
});

test("an owner keeps billing controls when the permission read fails", async () => {
	role = "owner";
	answerPermissions = async () => {
		throw new Error("permissions request failed");
	};
	await mount();

	expect(buttonNamed("Save seats")).not.toBeNull();
	expect(accessAlert()).toBeNull();
});
