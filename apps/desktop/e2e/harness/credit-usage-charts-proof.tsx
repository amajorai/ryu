import {
	type UsageRow,
	type UsageSummaryData,
	UsageView,
} from "@ryu/blocks/desktop/usage.tsx";
import {
	aggregateUsageEvents,
	type UsageDateRange,
	type UsageEvent,
	type UsageGranularity,
	type UsageScope,
} from "@ryu/blocks/desktop/usage-analytics.ts";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { SubscriptionUsageDashboard } from "../../src/components/usage/SubscriptionUsageDashboard.tsx";
import type { SubscriptionUsageAccount } from "../../src/hooks/useSubscriptionUsage.ts";
import type { UsageSnapshot } from "../../src/lib/api/usage.ts";
import "../../src/index.css";

const summary: UsageSummaryData = {
	byModel: [
		{ amountMicroUsd: 4_200_000, count: 19, key: "claude-sonnet-4" },
		{ amountMicroUsd: 1_290_000, count: 7, key: "gpt-4.1-mini" },
		{ amountMicroUsd: 160_000, count: 1, key: "google/gemini-2.5-flash" },
		{ amountMicroUsd: 600_000, count: 3, key: null },
	],
	byProvider: [
		{ amountMicroUsd: 4_200_000, count: 19, key: "Anthropic" },
		{ amountMicroUsd: 1_290_000, count: 7, key: "OpenAI" },
		{ amountMicroUsd: 160_000, count: 1, key: "openrouter" },
		{ amountMicroUsd: 600_000, count: 3, key: null },
	],
	byReason: [
		{ amountMicroUsd: 5_050_000, count: 27, key: "gateway_usage" },
		{ amountMicroUsd: 1_200_000, count: 3, key: "composio" },
		// Credits are visible in the transaction list but never counted as spend.
		{ amountMicroUsd: 0, count: 1, key: "topup" },
	],
	creditedMicroUsd: 25_000_000,
	durationMs: 184_000,
	inputTokens: 182_400,
	outputTokens: 64_200,
	spentMicroUsd: 6_250_000,
	transactions: 31,
};

const rows: UsageRow[] = [
	{
		balanceAfter: 18_750_000,
		createdAtLabel: "Aug 17, 2026, 10:32 AM",
		delta: -420_000,
		durationMs: 8400,
		id: "usage-1",
		inputTokens: 18_240,
		isCredit: false,
		model: "claude-sonnet-4",
		outputTokens: 6420,
		provider: "Anthropic",
		upstreamProvider: null,
		reason: "gateway_usage",
		taskLabel: "Summarize release notes",
	},
	{
		balanceAfter: 19_170_000,
		createdAtLabel: "Aug 17, 2026, 10:12 AM",
		delta: -160_000,
		durationMs: 2100,
		id: "usage-2",
		inputTokens: 9800,
		isCredit: false,
		model: "google/gemini-2.5-flash",
		outputTokens: 2900,
		provider: "openrouter",
		upstreamProvider: "Google Vertex",
		reason: "gateway_usage",
		taskLabel: null,
	},
	{
		balanceAfter: 19_330_000,
		createdAtLabel: "Aug 16, 2026, 4:05 PM",
		delta: 25_000_000,
		durationMs: null,
		id: "credit-1",
		inputTokens: null,
		isCredit: true,
		model: null,
		outputTokens: null,
		provider: null,
		upstreamProvider: null,
		reason: "topup",
		taskLabel: null,
	},
];

const analyticsEvents: UsageEvent[] = [
	{
		agentSeconds: 3,
		bucketSeconds: 900,
		costMicroUsd: 160_000,
		errorCount: 0,
		feature: "Chat",
		inputTokens: 9800,
		latencySamples: 1,
		latencyTotalMs: 2100,
		memberId: "jiawei",
		model: "google/gemini-2.5-flash",
		nodeId: "node-local",
		organizationId: "org-acme",
		outputTokens: 2900,
		provider: "openrouter",
		requestCount: 1,
		source: "managed",
		timestamp: "2026-08-17T22:10:00.000Z",
	},
	{
		agentSeconds: 12,
		bucketSeconds: 900,
		costMicroUsd: null,
		errorCount: 1,
		feature: "Chat",
		inputTokens: 80,
		latencySamples: 3,
		latencyTotalMs: 600,
		memberId: "jiawei",
		model: "gpt-4.1-mini",
		nodeId: "node-local",
		organizationId: "org-acme",
		outputTokens: 20,
		provider: "openai",
		requestCount: 4,
		source: "byok",
		timestamp: "2026-08-17T22:00:00.000Z",
	},
	{
		agentSeconds: 8,
		bucketSeconds: 900,
		costMicroUsd: 0,
		errorCount: 2,
		feature: "Agents",
		inputTokens: 40,
		latencySamples: 1,
		latencyTotalMs: 900,
		memberId: "min",
		model: "gpt-4.1-mini",
		nodeId: "node-local",
		organizationId: "org-acme",
		outputTokens: 10,
		provider: "openai",
		requestCount: 2,
		source: "byok",
		timestamp: "2026-08-17T22:15:00.000Z",
	},
];

const providerOptions = ["openai", "anthropic", "openrouter"];
const modelOptions = [
	"gpt-4.1-mini",
	"claude-sonnet-4",
	"google/gemini-2.5-flash",
];

function snapshot(
	overrides: Partial<UsageSnapshot> & Pick<UsageSnapshot, "agentId" | "engine">
): UsageSnapshot {
	return {
		agentId: overrides.agentId,
		available: true,
		engine: overrides.engine,
		extraUsageUsd: null,
		meters: [],
		plan: null,
		reason: null,
		retryAfterSeconds: null,
		windows: [],
		...overrides,
	};
}

const subscriptionAccounts: SubscriptionUsageAccount[] = [
	{
		accountId: "claude-work",
		accountLabel: "Work account",
		active: true,
		category: "Claude",
		gatewayActive: false,
		kind: "oauth",
		loading: false,
		providerId: "claude-pro-max",
		providerLabel: "Claude (Pro/Max · login)",
		snapshot: snapshot({
			extraUsageUsd: 2.5,
			plan: "Max 20x",
			agentId: "claude-pro-max",
			engine: "claude",
			windows: [
				{
					label: "Session",
					model: null,
					resetsAt: "2026-09-01T18:00:00Z",
					usedPercent: 28,
					windowSeconds: 18_000,
				},
				{
					label: "Weekly",
					model: null,
					resetsAt: "2026-09-05T00:00:00Z",
					usedPercent: 62,
					windowSeconds: 604_800,
				},
			],
		}),
		error: null,
	},
	{
		accountId: "claude-personal",
		accountLabel: "Personal account",
		active: false,
		category: "Claude",
		gatewayActive: false,
		kind: "oauth",
		loading: false,
		providerId: "claude-pro-max",
		providerLabel: "Claude (Pro/Max · login)",
		snapshot: snapshot({
			plan: "Max 20x",
			agentId: "claude-pro-max",
			engine: "claude",
			windows: [
				{
					label: "Session",
					model: null,
					resetsAt: "2026-09-01T12:00:00Z",
					usedPercent: 84,
					windowSeconds: 18_000,
				},
				{
					label: "Weekly",
					model: null,
					resetsAt: "2026-09-05T00:00:00Z",
					usedPercent: 74,
					windowSeconds: 604_800,
				},
			],
		}),
		error: null,
	},
	{
		accountId: "chatgpt-team",
		accountLabel: "Team account",
		active: false,
		category: "ChatGPT",
		gatewayActive: true,
		kind: "oauth",
		loading: false,
		providerId: "openai-codex",
		providerLabel: "ChatGPT (Plus/Pro · login)",
		snapshot: snapshot({
			plan: "Pro 5x",
			agentId: "openai-codex",
			engine: "codex",
			meters: [
				{
					expiresAt: ["2026-09-02T00:00:00Z"],
					label: "Rate limit resets",
					resetsAt: "2026-09-02T00:00:00Z",
					values: [
						{ kind: "count", number: 3, unit: "available" },
						{ kind: "count", number: 10, unit: "cap" },
					],
				},
			],
			windows: [
				{
					label: "Session",
					model: null,
					resetsAt: "2026-09-01T16:00:00Z",
					usedPercent: 41,
					windowSeconds: 18_000,
				},
				{
					label: "Weekly",
					model: null,
					resetsAt: "2026-09-05T00:00:00Z",
					usedPercent: 73,
					windowSeconds: 604_800,
				},
			],
		}),
		error: null,
	},
	{
		accountId: "copilot-old",
		accountLabel: "Legacy account",
		active: false,
		category: "GitHub Copilot",
		gatewayActive: false,
		kind: "oauth",
		loading: false,
		providerId: "github-copilot",
		providerLabel: "GitHub Copilot (login)",
		snapshot: snapshot({
			agentId: "github-copilot",
			available: false,
			engine: "copilot",
			plan: "Pro",
			reason: "token_expired",
		}),
		error: null,
	},
];

const proofRange: UsageDateRange = {
	from: new Date("2026-08-01T00:00:00.000Z"),
	to: new Date("2026-08-18T00:00:00.000Z"),
};

function eventsForScope(scope: UsageScope): UsageEvent[] {
	if (scope === "organization") {
		return analyticsEvents.filter(
			(event) => event.organizationId === "org-acme"
		);
	}
	if (scope === "node") {
		return analyticsEvents.filter((event) => event.nodeId === "node-local");
	}
	return analyticsEvents;
}

function CreditUsageChartsProof() {
	const [scope, setScope] = useState<UsageScope>("organization");
	const [granularity, setGranularity] = useState<UsageGranularity>("daily");
	const [range, setRange] = useState<UsageDateRange>(proofRange);
	const [provider, setProvider] = useState<string | null>(null);
	const [model, setModel] = useState<string | null>(null);
	const analytics = useMemo(() => {
		const filteredEvents = eventsForScope(scope).filter(
			(event) =>
				(!provider || event.provider === provider) &&
				(!model || event.model === model)
		);
		return aggregateUsageEvents({
			caption:
				scope === "you"
					? "Everything you’ve consumed, regardless of org or node."
					: scope === "organization"
						? "All members and nodes in the active organization."
						: "Only usage routed through the selected node.",
			events: filteredEvents,
			from: range.from,
			granularity,
			scope,
			scopeLabel:
				scope === "you"
					? "You"
					: scope === "organization"
						? "Organization"
						: "This node",
			to: range.to,
		});
	}, [granularity, model, provider, range, scope]);

	return (
		<main className="min-h-screen bg-background px-6 py-10 text-foreground">
			<div className="mx-auto flex max-w-5xl flex-col gap-6">
				<header className="flex flex-col gap-2">
					<p className="font-medium text-primary text-xs uppercase tracking-(--tracking-section)">
						Ryu desktop verification artifact
					</p>
					<h1 className="font-semibold text-3xl tracking-tight">
						Usage & subscription analytics
					</h1>
					<p className="text-muted-foreground">
						Explore connected subscription accounts alongside requests, tokens,
						latency, errors, providers, models, and the credit ledger.
					</p>
				</header>

				<SubscriptionUsageDashboard
					accounts={subscriptionAccounts}
					catalogLoading={false}
					onRefresh={() => undefined}
				/>

				<UsageView
					analyticsDashboard={{
						analytics,
						granularity,
						loading: false,
						model,
						modelOptions,
						onGranularityChange: setGranularity,
						onModelChange: setModel,
						onProviderChange: setProvider,
						onRangeChange: setRange,
						onScopeChange: setScope,
						provider,
						providerOptions,
						range,
						scope,
					}}
					hasMore={false}
					loading={false}
					loadingMore={false}
					onLoadMore={() => undefined}
					onRefresh={() => undefined}
					rows={rows}
					summary={summary}
				/>

				<p className="text-muted-foreground text-xs" data-testid="proof-status">
					Verified presentation: scoped analytics, provider/model filters, date
					range + granularity controls, diverse shadcn charts, and the credit
					transaction list are visible together.
				</p>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<CreditUsageChartsProof />);
}
