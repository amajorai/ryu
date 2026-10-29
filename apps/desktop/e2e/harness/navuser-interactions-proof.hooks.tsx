import type { RecentUpdateItem } from "../../src/lib/api/updates.ts";

const updates: RecentUpdateItem[] = [
	{
		date: "2026-09-20T12:00:00.000Z",
		id: "navuser-blog-fixture",
		kind: "blog",
		slug: "fixture-desktop-navigation",
		tag: "Desktop",
		title: "Desktop navigation fixture",
	},
	{
		date: "2026-09-19T12:00:00.000Z",
		id: "navuser-release-fixture",
		kind: "changelog",
		slug: "1-2-3",
		title: "Ryu 1.2.3",
		type: "patch",
		version: "1.2.3",
	},
];

export function useCreditsWallet() {
	const noWallet =
		new URLSearchParams(window.location.search).get("wallet") === "empty";
	return {
		authed: true,
		entitlement: null,
		error: null,
		grantPools: [],
		ledger: [],
		loading: false,
		refresh: async () => undefined,
		wallet: noWallet
			? null
			: {
					balanceMicroUsd: 12_345_000,
					currency: "usd",
					id: "navuser-wallet-fixture",
					ownerId: "navuser-org-fixture",
					ownerType: "organization",
					subscriptionBalanceMicroUsd: 12_345_000,
					topupBalanceMicroUsd: 0,
					updatedAt: "2026-09-27T00:00:00.000Z",
				},
		walletEmpty: false,
	};
}

export function useOrgBillingStatus() {
	const noUsage =
		new URLSearchParams(window.location.search).get("usage") === "off";
	return {
		activeOrgId: noUsage ? null : "navuser-org-fixture",
		billing: noUsage
			? null
			: { subscription: { currentPeriodEnd: "2026-12-31T00:00:00.000Z" } },
		loading: false,
		organization: noUsage
			? null
			: { id: "navuser-org-fixture", name: "Fixture workspace" },
		plan: noUsage ? null : "pro",
	};
}

export function useRecentUpdates() {
	return {
		error: null,
		items: updates,
		loading: false,
		refresh: async () => undefined,
	};
}

export function useApprovals() {
	return {
		approvals: [],
		approve: async () => undefined,
		deciding: null,
		error: null,
		loading: false,
		reject: async () => undefined,
	};
}

export function useQuests() {
	return {
		acceptSuggestion: async () => undefined,
		complete: async () => undefined,
		create: async () => null,
		creating: false,
		deleting: null,
		dismiss: async () => undefined,
		dismissSuggestion: async () => undefined,
		error: null,
		judge: async () => ({ accepted: false }),
		judging: null,
		loading: false,
		quests: [],
		refetch: () => undefined,
		remove: async () => undefined,
		update: async () => null,
	};
}

export function useNotifications() {
	return {
		ack: async () => false,
		acking: null,
		archive: async () => undefined,
		error: null,
		loading: false,
		markRead: async () => undefined,
		meId: "navuser-user-alex",
		notifications: [],
		unarchive: async () => undefined,
	};
}

export function useAnnouncements() {
	return {
		announcements: [],
		authed: true,
		dismiss: async () => undefined,
		loading: false,
		markRead: async () => undefined,
		refresh: async () => undefined,
		unreadCount: 0,
	};
}

export function useSystemAnnouncements() {
	return [];
}

export function installedAppsQuery() {
	return {
		queryFn: async () => [],
		queryKey: ["navuser-proof-installed-apps"],
	};
}

export function useAvailableUpdates() {
	return { refresh: async () => undefined, updates: [] };
}

export function useDownloadBulkActions() {
	return {
		clearFinished: async () => undefined,
		clearUnfinished: async () => undefined,
		pending: false,
	};
}
