// Interface snapshots label a ledger transaction by its task label. A system
// label (a Box slug, a metered service window) is rendered as readable copy
// through `localizeUsageTaskLabel`; a user's task name stays as written.

import { expect, test } from "bun:test";
import { usageWindowRange } from "@ryu/blocks/desktop/usage-task-label.ts";
import { activeLocale } from "@ryu/i18n/core";
import { toInterfaceAccount } from "./snapshot-account.ts";

const base = {
	balanceAfter: 1_000_000,
	createdAt: "2026-11-06T12:00:00.000Z",
	delta: -1000,
	durationMs: null,
	estimated: false,
	inputTokens: null,
	model: null,
	orgId: null,
	outputTokens: null,
	provider: null,
	reason: "box",
	refId: null,
	upstreamProvider: null,
	userId: null,
	walletId: "wallet-1",
};

test("system task labels become readable copy; task names stay as written", () => {
	const account = toInterfaceAccount(
		{
			ledger: [
				{ ...base, id: "a", taskLabel: "box-storage" },
				{
					...base,
					createdAt: "2026-11-06T11:00:00.000Z",
					id: "b",
					taskLabel:
						"notify usage 2026-11-06T10:00:00.000Z–2026-11-06T11:00:00.000Z",
				},
				{
					...base,
					createdAt: "2026-11-06T10:00:00.000Z",
					id: "c",
					taskLabel: "Draft release notes",
				},
				{
					...base,
					createdAt: "2026-11-06T09:00:00.000Z",
					id: "d",
					taskLabel: null,
				},
			],
			wallet: {
				balanceMicroUsd: 1_000_000,
				currency: "USD",
				id: "wallet-1",
				ownerId: "org-1",
				ownerType: "org",
				subscriptionBalanceMicroUsd: null,
				topupBalanceMicroUsd: null,
				updatedAt: "2026-11-06T12:00:00.000Z",
			},
		},
		new Set()
	);
	const range = usageWindowRange(
		"2026-11-06T10:00:00.000Z",
		"2026-11-06T11:00:00.000Z",
		activeLocale()
	);
	expect(account.transactions.map((row) => row.label)).toEqual([
		"Box storage",
		`Notify usage, ${range}`,
		"Draft release notes",
		"Box compute and storage",
	]);
});
