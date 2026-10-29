import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "@playwright/test";

await test("live retained usage history controls and responsive proof", async () => {
	const proofDir = new URL(
		"../../../docs/proof/usage-history/",
		import.meta.url
	);
	await mkdir(proofDir, { recursive: true });
	const proofCapability = process.env.RYU_PROOF_CLIENT_TOKEN;
	if (!proofCapability) {
		throw new Error("Pass the live proof client capability");
	}
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({
			extraHTTPHeaders: { authorization: `Bearer ${proofCapability}` },
			viewport: { width: 1440, height: 1080 },
		});
		for (const file of ["token", "data/usage-history.db"]) {
			const privateResponse = await page.request.get(
				`http://127.0.0.1:5187/@fs/D:/Code/ryu/.tmp/usage-history-live/${file}`
			);
			assert(
				[403, 404].includes(privateResponse.status()),
				"Proof server must deny private filesystem files"
			);
			await privateResponse.dispose();
		}
		const errors = [];
		const evidence = { imports: [], checks: [] };
		let providerRequests = 0;
		page.on("request", (request) => {
			if (
				request.url().endsWith("/api/usage/history/account-sync") &&
				request.method() === "POST"
			) {
				providerRequests += 1;
			}
		});
		const stableRoots = JSON.parse(process.env.RYU_PROOF_HISTORY_ROOTS ?? "[]");
		evidence.stableNativeSources = stableRoots;
		page.on("pageerror", (error) => errors.push(error.message));
		await page.goto("http://127.0.0.1:5187/usage-history-proof.html", {
			waitUntil: "domcontentloaded",
			timeout: 180_000,
		});
		await page
			.getByRole("heading", { name: "Usage history", exact: true })
			.waitFor({ timeout: 180_000 });
		await page
			.getByRole("checkbox", { name: /^Codex/ })
			.waitFor({ timeout: 180_000 });
		const readSummary = async (scope = "session", startDate = undefined) => {
			const query = new URLSearchParams({ scope });
			if (startDate) {
				query.set("startDate", startDate);
			}
			const response = await page.request.get(
				`http://127.0.0.1:5187/api/usage/history?${query}`
			);
			assert.equal(response.status(), 200);
			return (await response.json()).summary;
		};
		const chooseRetainedSources = async () => {
			for (const checkbox of await page.getByRole("checkbox").all()) {
				await checkbox.uncheck();
			}
			for (const source of ["Codex", "Claude Code", "OpenCode"]) {
				await page
					.getByRole("checkbox", { name: new RegExp(`^${source}`) })
					.check();
			}
		};
		if (stableRoots.length === 0) {
			await chooseRetainedSources();
		} else {
			for (const checkbox of await page.getByRole("checkbox").all()) {
				await checkbox.uncheck();
			}
			await page
				.getByText("Custom location or provider metadata export", {
					exact: true,
				})
				.click();
		}
		const importPage = async () => {
			const responsePromise = page.waitForResponse(
				(response) =>
					response.url().endsWith("/api/usage/history/import") &&
					response.request().method() === "POST",
				{ timeout: 600_000 }
			);
			await page
				.getByRole("button", { name: /^(Import history|Continue import)$/ })
				.click();
			const response = await responsePromise;
			assert.equal(response.status(), 202);
			const started = await response.json();
			assert.equal(started.state, "running");
			await page
				.getByRole("button", { name: /^(Import history|Continue import)$/ })
				.waitFor({ timeout: 600_000 });
			const completedResponse = await page.request.get(
				`http://127.0.0.1:5187/api/usage/history/import/operations/${started.id}`
			);
			const completed = await completedResponse.json();
			assert.equal(completed.state, "completed");
			const report = completed.report;
			evidence.imports.push(report);
			await page.getByRole("status").waitFor();
			console.log(JSON.stringify({ import: report }));
			return report;
		};
		let report;
		if (stableRoots.length) {
			for (const root of stableRoots) {
				await page
					.getByLabel("History source", { exact: true })
					.selectOption(root.sourceId);
				await page
					.getByLabel("Explicit history path on selected node")
					.fill(root.path);
				report = await importPage();
				assert.equal(report.hasMore, false);
			}
			evidence.checks.push(
				"Explicit authentic historical Codex/Claude/OpenCode files imported through actual UI"
			);
		} else {
			report = await importPage();
			for (let index = 0; report.hasMore && index < 1000; index += 1) {
				report = await importPage();
			}
		}
		assert.equal(
			report.hasMore,
			false,
			"Import must reach its final checkpoint"
		);
		const initial = await readSummary();
		assert(
			initial.records > 0,
			"Retained machine history must populate the ledger"
		);
		if (stableRoots.length) {
			for (const root of stableRoots) {
				await page
					.getByLabel("History source", { exact: true })
					.selectOption(root.sourceId);
				await page
					.getByLabel("Explicit history path on selected node")
					.fill(root.path);
				report = await importPage();
				assert.equal(report.importedRecords, 0);
			}
			await page.getByLabel("Explicit history path on selected node").fill("");
			await page
				.getByText("Custom location or provider metadata export", {
					exact: true,
				})
				.click();
		} else {
			report = await importPage();
		}
		const repeated = await readSummary();
		assert.equal(repeated.records, initial.records);
		assert.equal(report.importedRecords, 0);
		evidence.checks.push("Repeated import keeps record count unchanged");
		for (const days of [7, 30]) {
			const next = page.waitForResponse(
				(response) =>
					response.url().includes("/api/usage/history?") &&
					response.url().includes("startDate=")
			);
			await page
				.getByRole("button", { name: `${days} days`, exact: true })
				.click();
			await next;
			const startDate = new Date(Date.now() - (days - 1) * 86_400_000)
				.toISOString()
				.slice(0, 10);
			const filtered = await readSummary("session", startDate);
			assert(filtered.records <= initial.records);
			evidence.checks.push(`${days} day period fetches filtered real API data`);
		}
		await page.getByRole("button", { name: "All time", exact: true }).click();
		for (const [scope, label] of [
			["account", "Account reports"],
			["organization", "Organization reports"],
			["unattributed", "Unattributed usage"],
		]) {
			const next = page.waitForResponse((response) =>
				response.url().includes(`scope=${scope}`)
			);
			await page.getByRole("button", { name: label, exact: true }).click();
			await next;
			if (scope === "unattributed") {
				await page
					.getByText(
						"This usage lacks reliable native session, model, or usage-date attribution and may overlap other reports. Totals stay separate. Snapshot dates show when metadata was observed. Conversation counts include only retained Ryu conversation IDs.",
						{ exact: true }
					)
					.waitFor();
				await page
					.getByRole("columnheader", { name: "Ryu conversations", exact: true })
					.waitFor();
			} else {
				assert.equal((await readSummary(scope)).records, 0);
			}
			evidence.checks.push(
				`${scope} scope stays separate from session history`
			);
		}
		await page
			.getByRole("button", { name: "Session history", exact: true })
			.click();
		if (stableRoots.length === 0) {
			await chooseRetainedSources();
		} else {
			for (const checkbox of await page.getByRole("checkbox").all()) {
				await checkbox.uncheck();
			}
		}
		await page.getByRole("button", { name: "By day", exact: true }).click();
		assert((await page.getByRole("table").locator("tbody tr").count()) > 0);
		await page.getByRole("button", { name: "By model", exact: true }).click();
		await page
			.getByRole("button", { name: "API estimate", exact: true })
			.click();
		await page
			.getByText("API-equivalent USD estimate. Unknown prices appear as gaps", {
				exact: false,
			})
			.waitFor();
		await page.getByRole("button", { name: "Tokens", exact: true }).click();
		const strokes = await page
			.locator(".recharts-line-curve")
			.evaluateAll((paths) =>
				paths.map((path) => getComputedStyle(path).stroke)
			);
		assert(
			strokes.length > 0 && strokes.every((stroke) => stroke !== "none"),
			"Actual chart series must be visible"
		);
		const tracking = page.getByRole("switch");
		const trackingBefore = await tracking.isChecked();
		await tracking.click();
		await page.getByRole("switch", { checked: !trackingBefore }).waitFor();
		assert.equal(await tracking.isChecked(), !trackingBefore);
		await tracking.click();
		await page.getByRole("switch", { checked: trackingBefore }).waitFor();
		assert.equal(await tracking.isChecked(), trackingBefore);
		evidence.checks.push(
			"Future tracking saves and restores through actual Core"
		);
		await page
			.getByText("Custom location or provider metadata export", { exact: true })
			.click();
		await page
			.getByLabel("History source", { exact: true })
			.selectOption("codex");
		await page
			.getByLabel("Explicit history path on selected node")
			.fill("D:/Code/ryu/.tmp/usage-history-live/does-not-exist");
		const failure = await importPage();
		assert(failure.errorCount > 0);
		await page.getByLabel("Explicit history path on selected node").fill("");
		await page
			.getByText("Custom location or provider metadata export", { exact: true })
			.click();
		if (stableRoots.length) {
			await page
				.getByText("Custom location or provider metadata export", {
					exact: true,
				})
				.click();
			await page
				.getByLabel("History source", { exact: true })
				.selectOption(stableRoots[0].sourceId);
			await page
				.getByLabel("Explicit history path on selected node")
				.fill(stableRoots[0].path);
			await importPage();
			await page.getByLabel("Explicit history path on selected node").fill("");
			await page
				.getByText("Custom location or provider metadata export", {
					exact: true,
				})
				.click();
			await chooseRetainedSources();
		} else {
			await importPage();
		}
		evidence.checks.push(
			"Unreadable custom location shows a recoverable import error"
		);
		await page.getByText("Connect a usage report", { exact: true }).click();
		const endDate = page.getByLabel("End date UTC, exclusive");
		const expectedEnd = new Date(Date.now() + 86_400_000)
			.toISOString()
			.slice(0, 10);
		assert.equal(await endDate.inputValue(), expectedEnd);
		await page
			.getByLabel("Account alias", { exact: true })
			.fill("local-validation-proof");
		await page
			.getByLabel("Organization admin API key", { exact: true })
			.fill("not-a-real-key");
		await page.getByLabel("Start date UTC", { exact: true }).fill(expectedEnd);
		await page
			.getByRole("button", { name: "Import provider report", exact: true })
			.click();
		await page
			.getByText("Enter an account alias, admin key, and valid date range.", {
				exact: true,
			})
			.waitFor();
		assert.equal(providerRequests, 0);
		await endDate.fill(new Date(Date.now()).toISOString().slice(0, 10));
		await page
			.getByRole("button", { name: "Import provider report", exact: true })
			.click();
		assert.equal(providerRequests, 0);
		await page
			.getByLabel("Organization admin API key", { exact: true })
			.fill("");
		await page.getByLabel("Account alias", { exact: true }).fill("");
		await page.getByText("Connect a usage report", { exact: true }).click();
		evidence.checks.push(
			"Provider reports default to tomorrow UTC and reject equal start/end before any provider request"
		);
		const refreshed = page.waitForResponse((response) =>
			response.url().includes("/api/usage/history?")
		);
		await page.getByRole("button", { name: "Refresh", exact: true }).click();
		await refreshed;
		await page.reload({ waitUntil: "domcontentloaded", timeout: 180_000 });
		await page
			.getByRole("checkbox", { name: /^Codex/ })
			.waitFor({ timeout: 180_000 });
		await chooseRetainedSources();
		const screenshotPath = (name) =>
			new URL(name, proofDir).pathname.replace(/^\/(\w:)/, "$1");
		await page.screenshot({
			path: screenshotPath("live-desktop.png"),
			fullPage: true,
		});
		await page.setViewportSize({ width: 390, height: 844 });
		await page.waitForTimeout(300);
		assert.equal(
			await page.evaluate(
				() => document.documentElement.scrollWidth > window.innerWidth
			),
			false,
			"Phone layout must not overflow the viewport"
		);
		await page.screenshot({
			path: screenshotPath("live-mobile.png"),
			fullPage: true,
		});
		evidence.summary = initial;
		evidence.checks.push(
			"Desktop and phone layouts captured with authentic imported data"
		);
		await writeFile(
			new URL("live-verification.json", proofDir),
			JSON.stringify(evidence, null, 2)
		);
		await writeFile(
			new URL("live-browser-errors.json", proofDir),
			JSON.stringify(errors)
		);
		assert.deepEqual(errors, []);
		console.log(
			JSON.stringify({
				records: initial.records,
				sessions: initial.sessions,
				sources: initial.sources.map((source) => source.sourceId),
				checks: evidence.checks,
			})
		);
	} finally {
		await browser.close();
	}
});
