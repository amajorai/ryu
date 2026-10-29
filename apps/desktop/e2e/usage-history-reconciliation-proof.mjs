import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "@playwright/test";

const sources = [
	"../src/components/usage/UsageHistoryDashboard.tsx",
	"../src/lib/api/usage-history.ts",
	"../src/hooks/useUsageHistory.ts",
	"./harness/usage-history-proof.tsx",
	"./harness/vite.usage-history-proof.config.ts",
	"../../core/src/usage_history/fixtures/contract.json",
	"./usage-history-reconciliation-proof.mjs",
];
async function sourceHashes() {
	return Object.fromEntries(
		await Promise.all(
			sources.map(async (source) => [
				source,
				createHash("sha256")
					.update(await readFile(new URL(source, import.meta.url)))
					.digest("hex"),
			])
		)
	);
}

// Deterministic layout fixture mirrors the partial-native-history Rust regression.
// It verifies the actual dashboard/client; it does not claim live vendor access.
await test("unresolved live overlap has a separate responsive view", async () => {
	const sourceBefore = await sourceHashes();
	const contract = JSON.parse(
		await readFile(
			new URL(
				"../../core/src/usage_history/fixtures/contract.json",
				import.meta.url
			),
			"utf8"
		)
	);
	const proofDir = new URL(
		"../../../docs/proof/usage-history/",
		import.meta.url
	);
	await mkdir(proofDir, { recursive: true });
	const browser = await chromium.launch();
	const errors = [];
	const scopes = [];
	try {
		const page = await browser.newPage({
			viewport: { width: 1440, height: 1080 },
		});
		page.setDefaultTimeout(90_000);
		page.on("pageerror", (error) => errors.push(error.message));
		await page.route("**/api/usage/history**", async (route) => {
			const url = new URL(route.request().url());
			if (url.pathname.endsWith("/tracking")) {
				await route.fulfill({ json: { enabled: false } });
				return;
			}
			const scope = url.searchParams.get("scope") ?? "session";
			scopes.push(scope);
			const unresolved = scope === "unreconciled";
			const costOnly = scope === "organization";
			const zeroUsage = scope === "account";
			const partialUsage = scope === "unattributed";
			const summary = structuredClone(contract.summary);
			summary.totals = {
				...summary.totals,
				inputTokens: unresolved ? 200 : 100,
				outputTokens: unresolved ? 50 : 20,
				cacheReadTokens: unresolved ? 100 : 50,
				cacheWriteTokens: unresolved ? 50 : 25,
				reasoningTokens: 0,
			};
			summary.records = unresolved ? 2 : 1;
			if (costOnly || zeroUsage) {
				summary.totals = Object.fromEntries(
					Object.keys(summary.totals).map((key) => [
						key,
						costOnly && key.startsWith("missing") ? 1 : 0,
					])
				);
			}
			summary.estimatedCostUsd = null;
			if (partialUsage) {
				summary.totals = {
					...summary.totals,
					inputTokens: 5,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					missingOutputRecords: 1,
					missingCacheReadRecords: 1,
					missingCacheWriteRecords: 1,
				};
			}
			summary.sessions = costOnly || zeroUsage ? 0 : 1;
			summary.billedCostUsd = costOnly ? 2 : null;
			summary.reportedCostUsd = costOnly ? 2 : null;
			summary.cacheSavingsUsd = null;
			summary.unpricedRecords = summary.records;
			for (const group of [summary.daily, summary.models, summary.sources]) {
				for (const row of group) {
					row.sourceId = costOnly
						? "openai-org-costs"
						: partialUsage
							? "ryu-acp"
							: "claude-code";
					row.modelId = costOnly ? null : "test-model";
					row.totals = summary.totals;
					row.records = summary.records;
					row.sessions = summary.sessions;
					row.billedCostUsd = summary.billedCostUsd;
					row.reportedCostUsd = summary.reportedCostUsd;
					row.estimatedCostUsd = null;
					row.cacheSavingsUsd = null;
					row.unpricedRecords = summary.records;
				}
			}
			summary.accounts = [
				{
					...summary.sources[0],
					accountId: unresolved
						? "account-a"
						: costOnly
							? "org-a"
							: zeroUsage
								? "zero-account"
								: partialUsage
									? "partial-account"
									: null,
				},
			];
			await route.fulfill({ json: { summary, sources: [] } });
		});
		await page.goto("http://127.0.0.1:5192/usage-history-proof.html", {
			waitUntil: "domcontentloaded",
			timeout: 120_000,
		});
		await page
			.getByRole("button", { name: "Unreconciled live usage", exact: true })
			.click();
		await page
			.getByText("These live turns retain their native session identity.", {
				exact: false,
			})
			.waitFor();
		await page.getByText("400", { exact: true }).first().waitFor();
		assert(scopes.includes("unreconciled"));
		await page.getByText("account-a", { exact: true }).waitFor();
		assert.match(
			await page.locator("body").innerText(),
			/Do not add this subtotal to Session history/
		);
		await page.screenshot({
			path: new URL("reconciliation-desktop.png", proofDir).pathname.replace(
				/^\/(\w:)/,
				"$1"
			),
			fullPage: true,
		});
		await page
			.getByRole("button", { name: "Session history", exact: true })
			.click();
		await page.getByText("195", { exact: true }).first().waitFor();
		await page
			.getByRole("button", { name: "Organization reports", exact: true })
			.click();
		await page.getByText("org-a", { exact: true }).waitFor();
		const accountCard = page
			.getByText("Recorded accounts", { exact: true })
			.locator('xpath=ancestor::*[@data-slot="card"][1]');
		assert.match(await accountCard.innerText(), /Unknown tokens/);
		assert.doesNotMatch(await accountCard.innerText(), /0 tokens/);
		await accountCard.screenshot({
			path: new URL(
				"reconciliation-unknown-account.png",
				proofDir
			).pathname.replace(/^\/(\w:)/, "$1"),
		});
		await page
			.getByRole("button", { name: "Account reports", exact: true })
			.click();
		await page.getByText("zero-account", { exact: true }).waitFor();
		assert.match(await accountCard.innerText(), /0 tokens/);
		assert.doesNotMatch(await accountCard.innerText(), /Unknown tokens/);
		await page
			.getByRole("button", { name: "Unattributed usage", exact: true })
			.click();
		await page.getByText("partial-account", { exact: true }).waitFor();
		assert.match(await accountCard.innerText(), /5 tokens · Partial/);
		await page
			.getByRole("button", { name: "Unreconciled live usage", exact: true })
			.click();
		await page.setViewportSize({ width: 390, height: 844 });
		assert(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth
			)
		);
		await page.screenshot({
			path: new URL("reconciliation-mobile.png", proofDir).pathname.replace(
				/^\/(\w:)/,
				"$1"
			),
			fullPage: true,
		});
		assert.deepEqual(errors, []);
		const sourceAfter = await sourceHashes();
		assert.deepEqual(sourceAfter, sourceBefore);
		await writeFile(
			new URL("reconciliation-ui-verification.json", proofDir),
			`${JSON.stringify({ command: "rtk proxy node e2e/usage-history-reconciliation-proof.mjs", cwd: "apps/desktop", result: "1 pass, 0 fail", fixture: "partial native + two distinct bound live turns", nativeProcessedTokens: 195, unreconciledProcessedTokens: 400, additiveTotalExcluded: true, scopes, browserErrors: errors, mobileOverflow: false, sourceBefore, sourceAfter }, null, 2)}\n`
		);
	} finally {
		await browser.close();
	}
});
