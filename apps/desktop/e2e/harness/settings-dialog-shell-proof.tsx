import { HotkeysProvider } from "@ryu/hotkeys/react";
import { I18nProvider } from "@ryu/i18n/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { GatewayDialog } from "../../src/components/gateway/GatewayDialog.tsx";
import { SettingsDialog } from "../../src/components/settings/SettingsDialog.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import type { SubscriptionCostUsageSummary } from "../../src/lib/api/subscription-costs.ts";
import type { UsageHistoryReport } from "../../src/lib/api/usage-history.ts";
import { DESKTOP_HOTKEYS } from "../../src/lib/hotkeys/actions.ts";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { useGatewayDialog } from "../../src/store/useGatewayDialog.ts";
import "../../src/index.css";

// Gateway opens only in Console; grant the access App's ProductModeAccessSync
// would grant a local node.
useProductModeStore.setState({ requestedMode: "console", consoleAccess: true });

declare global {
	interface Window {
		__settingsDialogShellApiCalls: Array<{
			method: string;
			path: string;
		}>;
	}
}

const referralDashboard = {
	defaultCommission: null,
	enabled: false,
	payout: {
		stripeConnectAccountId: null,
		payoutsEnabled: false,
		onboardingStatus: "none",
	},
	payoutOrgId: null,
	provider: "ryu",
	recentCommissions: [],
	referralCode: "LOCAL7",
	referralLink: "http://localhost:3000/r/LOCAL7",
	stats: {
		approvedMinor: 0,
		currency: "USD",
		paidMinor: 0,
		pendingMinor: 0,
		reversedMinor: 0,
	},
};

const referralCredits = {
	cap: {
		capMicroUsd: 1_000_000,
		earnedMicroUsd: 250_000,
		paidCount: 1,
		remainingMicroUsd: 750_000,
		uncapped: false,
	},
	referrals: [],
	reward: { refereeMicroUsd: 100_000, referrerMicroUsd: 250_000 },
};

// Current Core usage DTOs: an empty node still supplies complete aggregates.
const emptySubscriptionCostUsage: SubscriptionCostUsageSummary = {
	accounts: [],
	enabled: false,
	month: "2026-10",
};
const emptyUsageHistory: UsageHistoryReport = {
	sources: [],
	summary: {
		accounts: [],
		daily: [],
		models: [],
		sources: [],
		sessions: 0,
		records: 0,
		unpricedRecords: 0,
		estimatedCostUsd: null,
		billedCostUsd: null,
		sourceEstimatedCostUsd: null,
		reportedCostUsd: null,
		cacheSavingsUsd: null,
		totals: {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			cachedOutputTokens: 0,
			reasoningTokens: 0,
			missingInputRecords: 0,
			missingOutputRecords: 0,
			missingCacheReadRecords: 0,
			missingCacheWriteRecords: 0,
			missingCachedOutputRecords: 0,
			missingReasoningRecords: 0,
		},
	},
};

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const now = new Date(Date.now() + 60 * 60 * 1000).toISOString();
localStorage.setItem("ryu_session_token", "settings-shell-local-fixture-token");
window.__settingsDialogShellApiCalls = [];
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
	const requestUrl = input instanceof Request ? input.url : String(input);
	const url = new URL(requestUrl, window.location.origin);
	if (
		url.origin === window.location.origin &&
		!url.pathname.startsWith("/api/")
	) {
		return realFetch(input, init);
	}

	const method = (
		init?.method ?? (input instanceof Request ? input.method : "GET")
	).toUpperCase();
	window.__settingsDialogShellApiCalls.push({ method, path: url.pathname });
	const headers = { "content-type": "application/json" };
	const json = <FixturePayload,>(data: FixturePayload) =>
		new Response(JSON.stringify(data), { headers, status: 200 });

	switch (url.pathname) {
		case "/api/auth/get-session":
			return json({
				session: {
					createdAt: now,
					expiresAt: now,
					id: "settings-shell-session",
					userId: "settings-shell-user",
				},
				user: {
					createdAt: now,
					email: "ada@example.test",
					emailVerified: true,
					id: "settings-shell-user",
					name: "Ada Lovelace",
					updatedAt: now,
				},
			});
		case "/api/plugins":
			return json({ apps: [], plugins: [] });
		case "/api/plugins/contributions":
			return json({ settings_tabs: [] });
		case "/api/gateway/status":
			return json({ reachable: false, url: null });
		case "/api/sessions":
			return json({ sessions: [] });
		case "/api/control-plane/orgs":
			return json({ organizations: [] });
		case "/api/pi-config":
			return json({
				config: {
					configDir: "/fixture/pi-config",
					model: null,
					provider: "gateway",
					providerRouting: {},
					routing: "gateway",
					thinkingLevel: null,
				},
			});
		case "/api/pi-config/catalog":
			return json({ apiTypes: [], providers: [], thinkingLevels: [] });
		case "/api/usage/subscription-costs":
		case "/api/usage/history":
		case "/api/usage/history/tracking":
			if (method !== "GET") {
				return new Response("Unexpected usage mutation", { status: 405 });
			}
			if (url.pathname === "/api/usage/subscription-costs") {
				return json(emptySubscriptionCostUsage);
			}
			if (url.pathname === "/api/usage/history") {
				return json(emptyUsageHistory);
			}
			return json({ enabled: false });
		case "/api/credits/usage":
			return json({
				entries: [],
				nextCursor: null,
				stats: {
					byModel: [],
					byProvider: [],
					byReason: [],
					creditedMicroUsd: 0,
					durationMs: 0,
					inputTokens: 0,
					outputTokens: 0,
					spentMicroUsd: 0,
					transactions: 0,
				},
			});
		case "/api/affiliate":
			return json(referralDashboard);
		case "/api/referrals/credits":
			return json(referralCredits);
		default:
			// API traffic in this story is always local fixture traffic. Empty 200s
			// let unrelated read-only panes render their own empty states without
			// reaching account, billing, provider, or node services.
			return json({});
	}
};

function SettingsDialogShellProof() {
	const [open, setOpen] = useState(false);
	const handleOpenChange = (next: boolean) => {
		document.body.dataset.settingsDialogOpenChange = String(next);
		setOpen(next);
	};
	const gatewayOpen = useGatewayDialog((state) => state.open);
	const gatewaySection = useGatewayDialog((state) => state.section);
	const setGatewayOpen = useGatewayDialog((state) => state.setOpen);

	return (
		<AppSurfaceProvider surface="desktop">
			<EntitlementProvider>
				<ThemeProvider
					attribute="class"
					defaultTheme="light"
					enableSystem={false}
				>
					<HotkeysProvider registry={DESKTOP_HOTKEYS}>
						<QueryClientProvider client={queryClient}>
							<I18nProvider>
								<MemoryRouter>
									<main className="min-h-screen bg-background p-8 text-foreground">
										<div className="mx-auto max-w-3xl rounded-2xl border bg-card p-6 shadow-sm">
											<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
												Desktop settings verification
											</p>
											<h1 className="mt-2 font-semibold text-2xl">
												Settings dialog shell
											</h1>
											<p className="mt-2 text-muted-foreground text-sm">
												All account and billing responses are local fixtures.
											</p>
											<div className="mt-5 flex items-center gap-3">
												<button
													className="rounded-lg border bg-background px-3 py-2 text-sm"
													data-testid="settings-shell-open"
													onClick={() => setOpen(true)}
													type="button"
												>
													Open settings
												</button>
												<output data-testid="settings-shell-open-state">
													{open ? "open" : "closed"}
												</output>
											</div>
										</div>
									</main>
									<SettingsDialog
										defaultSection="general"
										onOpenChange={handleOpenChange}
										open={open}
									/>
									<GatewayDialog
										defaultSection={gatewaySection}
										onOpenChange={setGatewayOpen}
										open={gatewayOpen}
									/>
								</MemoryRouter>
							</I18nProvider>
						</QueryClientProvider>
					</HotkeysProvider>
				</ThemeProvider>
			</EntitlementProvider>
		</AppSurfaceProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<SettingsDialogShellProof />);
}
