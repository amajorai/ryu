import path from "node:path";
import { expect, type Page, type Request, test } from "@playwright/test";

// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
function proofPath(relative: string): string {
	const override = process.env.RYU_PROOF_EVIDENCE_DIR;
	return override
		? path.join(override, relative)
		: `../../docs/proof/${relative}`;
}

interface TransactionNetworkReceipt {
	errors: string[];
	pending: Set<Request>;
	reads: { url: string; method: string; headers: Record<string, string> }[];
	unknown: string[];
}
const browserReceipts = new WeakMap<Page, TransactionNetworkReceipt>();
// The static build explicitly selects this tokenless local Core authority.
// The real useNodeStore fallback and API client still construct every request.
const coreOrigin = "http://127.0.0.1:7980";

test.afterEach(async ({ page }, testInfo) => {
	const receipt = browserReceipts.get(page);
	if (!receipt) {
		throw new Error("Missing transaction network receipt");
	}
	try {
		await expect.poll(() => receipt.pending.size).toBe(0);
		expect(receipt.errors).toEqual([]);
		expect(receipt.unknown).toEqual([]);
		expect(
			await page.evaluate(() => window.updateProofUnknownCommands)
		).toEqual([]);
	} finally {
		await testInfo.attach("app-update-transaction-network", {
			body: JSON.stringify({
				errors: receipt.errors,
				unknown: receipt.unknown,
				reads: receipt.reads,
				pending: [...receipt.pending].map((request) => ({
					url: request.url(),
					method: request.method(),
				})),
			}),
			contentType: "application/json",
		});
	}
});

test.beforeEach(async ({ page, baseURL }) => {
	if (!baseURL) {
		throw new Error("Missing transaction renderer origin");
	}
	const rendererOrigin = new URL(baseURL).origin;
	const receipt: TransactionNetworkReceipt = {
		errors: [],
		unknown: [],
		pending: new Set(),
		reads: [],
	};
	browserReceipts.set(page, receipt);
	page.on("pageerror", (error) => {
		receipt.errors.push(error.message);
	});
	page.on("request", (request) => receipt.pending.add(request));
	page.on("requestfinished", (request) => receipt.pending.delete(request));
	page.on("requestfailed", (request) => {
		receipt.pending.delete(request);
		receipt.errors.push(
			`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unknown failure"}`
		);
	});
	page.on("response", (response) => {
		if (response.status() >= 400) {
			receipt.errors.push(`${response.status()} ${response.url()}`);
		}
	});
	await page.route("**/*", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const headers = await request.allHeaders();
		const noBody = request.postData() === null;
		const noCredentials = !(headers.authorization || headers.cookie);
		const identityKeys = Object.keys(headers)
			.filter((key) => key.startsWith("x-ryu-"))
			.sort();
		const knownRead =
			url.origin === coreOrigin &&
			((url.pathname === "/api/version" && url.search === "") ||
				(url.pathname === "/api/update/check" &&
					url.search === "?channel=stable"));
		if (
			knownRead &&
			request.method() === "GET" &&
			noBody &&
			noCredentials &&
			headers["content-type"] === "application/json" &&
			headers["x-ryu-client-label"] === "Desktop" &&
			headers["x-ryu-surface"] === "desktop" &&
			JSON.stringify(identityKeys) ===
				JSON.stringify([
					"x-ryu-client-id",
					"x-ryu-client-label",
					"x-ryu-surface",
				]) &&
			headers["x-ryu-client-id"] ===
				(await page.evaluate(() => localStorage.getItem("ryu_client_id"))) &&
			headers["x-ryu-client-id"] &&
			headers.origin === rendererOrigin
		) {
			receipt.reads.push({
				url: request.url(),
				method: request.method(),
				headers,
			});
			await route.fulfill({
				headers: { "access-control-allow-origin": rendererOrigin },
				json:
					url.pathname === "/api/version"
						? {
								components: [{ name: "core", version: "0.4.0" }],
								platform: "linux",
								ryu_version: "0.4.0",
							}
						: {
								current: "0.4.0",
								latest: "9.9.9",
								channel: "stable",
								tag: "v9.9.9",
								update_available: true,
								asset: null,
								notes: null,
								html_url: null,
							},
			});
			return;
		}
		if (
			url.origin === rendererOrigin &&
			!url.pathname.startsWith("/api/") &&
			request.method() === "GET" &&
			noBody &&
			noCredentials &&
			identityKeys.length === 0 &&
			!["fetch", "xhr", "websocket"].includes(request.resourceType())
		) {
			await route.continue();
			return;
		}
		receipt.unknown.push(
			JSON.stringify({
				url: request.url(),
				method: request.method(),
				body: request.postData(),
				headers,
				resourceType: request.resourceType(),
			})
		);
		await route.abort("blockedbyclient");
	});
});

test("cancelling the native update keeps the verified update ready", async ({
	page,
}) => {
	await page.goto("/app-update-transaction-proof.html", {
		waitUntil: "domcontentloaded",
	});
	await expect(
		page.getByText(/App updates can restart the local runtime/)
	).toBeVisible({ timeout: 60_000 });
	await expect(
		page.getByRole("button", { name: "Install and restart" })
	).toBeEnabled();
	await page.getByRole("button", { name: "Install and restart" }).click();
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.updateProofCalls.includes("install_prepared_app_update")
			)
		)
		.toBe(true);
	await expect(
		page.getByRole("button", { name: "Install and restart" })
	).toBeEnabled();
	await expect(page.getByText("Update failed", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Update installed", { exact: true })).toHaveCount(
		0
	);
	expect(
		await page.evaluate(() =>
			window.updateProofCalls.some(
				(command) =>
					command.includes("relaunch") ||
					command === "clear_prepared_app_update"
			)
		)
	).toBe(false);
	await page.screenshot({
		path: proofPath("app-update-transactions/keep-working.png"),
		animations: "disabled",
		fullPage: true,
	});
});

test("failed preparation offers retry and leaves the update ready", async ({
	page,
}) => {
	await page.goto("/app-update-transaction-proof.html?failure=1", {
		waitUntil: "domcontentloaded",
	});
	await page.getByRole("button", { name: "Install and restart" }).click();
	await expect(page.getByText("Update failed", { exact: true })).toBeVisible();
	await page.getByText("Update failed", { exact: true }).hover();
	await expect(
		page.getByText(/The previous runtime remains available/)
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Install and restart" })
	).toBeEnabled();
	expect(
		await page.evaluate(() =>
			window.updateProofCalls.some((command) => command.includes("relaunch"))
		)
	).toBe(false);
	await page.screenshot({
		path: proofPath("app-update-transactions/preparation-failed.png"),
		animations: "disabled",
		fullPage: true,
	});
});

test("mounted renderer waits for runtime health before acknowledging startup", async ({
	page,
}) => {
	await page.goto("/app-update-transaction-proof.html?startup=1", {
		waitUntil: "domcontentloaded",
	});
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.updateProofCalls.filter(
						(command) => command === "get_update_startup_health"
					).length
			)
		)
		.toBeGreaterThan(1);
	expect(
		await page.evaluate(() =>
			window.updateProofCalls.includes("acknowledge_update_startup")
		)
	).toBe(false);
	await expect(page.getByText("Verifying your update")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Install and restart" })
	).toHaveCount(0);
	await page.evaluate(() => {
		window.updateProofRuntimeReady = true;
	});
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.updateProofCalls.includes("acknowledge_update_startup")
			)
		)
		.toBe(true);
	await expect(
		page.getByRole("button", { name: "Install and restart" })
	).toHaveCount(0);
	await page.screenshot({
		path: proofPath("app-update-transactions/startup-awaiting-commit.png"),
		animations: "disabled",
		fullPage: true,
	});
	await page.evaluate(() => {
		window.updateProofCommitted = true;
	});
	await expect(
		page.getByRole("button", { name: "Install and restart" })
	).toBeEnabled();
	await page.screenshot({
		path: proofPath("app-update-transactions/startup-ready.png"),
		animations: "disabled",
		fullPage: true,
	});
});

test("failed startup verification keeps work closed", async ({ page }) => {
	await page.goto(
		"/app-update-transaction-proof.html?startup=1&startupFailure=1"
	);
	await expect(page.getByText("Update verification stopped")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Install and restart" })
	).toHaveCount(0);
	expect(
		await page.evaluate(() =>
			window.updateProofCalls.includes("acknowledge_update_startup")
		)
	).toBe(false);
	await page.screenshot({
		path: proofPath("app-update-transactions/startup-verification-failed.png"),
		animations: "disabled",
		fullPage: true,
	});
});

test("ordinary launch opens work without an update acknowledgement", async ({
	page,
}) => {
	await page.goto("/app-update-transaction-proof.html?ordinary=1");
	await expect(
		page.getByRole("button", { name: "Install and restart" })
	).toBeEnabled();
	await expect(page.getByText("Verifying your update")).toHaveCount(0);
	const calls = await page.evaluate(() => window.updateProofCalls);
	expect(
		calls.filter((command) => command === "get_update_startup_health")
	).toHaveLength(1);
	expect(calls).not.toContain("acknowledge_update_startup");
});

test("unmounted startup renderer cannot acknowledge later runtime readiness", async ({
	page,
}) => {
	await page.goto("/app-update-transaction-proof.html?startup=1&unmount=1", {
		waitUntil: "domcontentloaded",
	});
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.updateProofCalls.includes("get_update_startup_health")
			)
		)
		.toBe(true);
	await page.getByRole("button", { name: "Close startup screen" }).click();
	await page.evaluate(() => {
		window.updateProofRuntimeReady = true;
	});
	await page.waitForTimeout(700);
	expect(
		await page.evaluate(() =>
			window.updateProofCalls.includes("acknowledge_update_startup")
		)
	).toBe(false);
});

test("failed schedule cancellation keeps the real pending action and supports retry", async ({
	page,
}) => {
	await page.goto(
		"/app-update-transaction-proof.html?pending=1&cancelFailure=1"
	);
	const cancel = page.getByRole("button", { name: "Cancel", exact: true });
	await expect(cancel).toBeVisible();
	await cancel.click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.updateProofCalls.filter(
						(command) => command === "clear_pending_app_update"
					).length
			)
		)
		.toBe(1);
	await expect(
		page.getByText("Couldn't cancel the scheduled update", { exact: true })
	).toBeVisible();
	await expect(cancel).toBeVisible();
	await expect(
		page.getByText("Scheduled update cancelled", { exact: true })
	).toHaveCount(0);
	await page.evaluate(() =>
		history.replaceState(
			null,
			"",
			"/app-update-transaction-proof.html?pending=1"
		)
	);
	await cancel.click();
	await expect(cancel).toBeHidden();
	await expect(
		page.getByText("Scheduled update cancelled", { exact: true })
	).toBeVisible();
	const calls = await page.evaluate(() => window.updateProofCalls);
	expect(
		calls.filter((command) => command === "clear_pending_app_update")
	).toHaveLength(2);
	expect(calls).not.toContain("install_prepared_app_update");
	expect(calls.some((command) => command.includes("relaunch"))).toBe(false);
	await expect(
		page.getByText("Couldn't cancel the scheduled update", { exact: true })
	).toBeHidden({ timeout: 15_000 });
	await expect(cancel).toBeHidden();
	await expect(
		page.getByRole("heading", { name: "App updates", exact: true })
	).toBeVisible();
	await page.evaluate(async () => {
		await document.fonts.ready;
		await Promise.all(
			document
				.getAnimations()
				.filter(
					(animation) =>
						animation.effect?.getTiming().iterations !==
						Number.POSITIVE_INFINITY
				)
				.map((animation) => animation.finished.catch(() => {}))
		);
	});
	await page.screenshot({
		path: proofPath(
			"updatevisual-v3/scheduled-cancellation-retry-completed.png"
		),
		animations: "disabled",
		fullPage: true,
	});
});

for (const retryAction of ["Settings", "notification"] as const) {
	test(`failed install then native cancellation can retry the same prepared artifact without clearing it via ${retryAction}`, async ({
		page,
	}) => {
		await page.goto("/app-update-transaction-proof.html?failure=1");
		const install = page.getByRole("button", { name: "Install and restart" });
		await expect(install).toBeEnabled();
		await install.click();
		await expect(
			page.getByText("Update failed", { exact: true })
		).toBeVisible();
		await expect(install).toBeEnabled();
		await page.evaluate(() => window.updateProofShowUnrelatedToast());
		await expect(
			page.getByText("Other pending action", { exact: true })
		).toBeVisible();
		const retry = async () => {
			if (retryAction === "Settings") {
				await install.click();
			} else {
				await page.getByText("Update failed", { exact: true }).hover();
				// Sileo renders the action as an anchor inside its toast button.
				const retryLink = page.getByRole("link", {
					name: "Retry",
					exact: true,
				});
				await expect(retryLink).toBeVisible();
				const bounds = await retryLink.boundingBox();
				expect(bounds).not.toBeNull();
				expect(bounds?.width).toBeGreaterThan(0);
				expect(bounds?.height).toBeGreaterThan(0);
				await retryLink.click();
			}
		};
		// A second immediate failure must outlive the first toast's exit cleanup.
		await retry();
		await expect(
			page.getByText(/Runtime preparation failed on attempt 1/)
		).toHaveCount(0);
		// A replacement notification starts collapsed; reveal its details as a user.
		await page.getByText("Update failed", { exact: true }).hover();
		await expect(
			page.getByText(/Runtime preparation failed on attempt 2/)
		).toBeVisible();
		await expect(
			page.getByText(/Runtime preparation failed on attempt 1/)
		).toHaveCount(0);
		await expect(page.getByText("Update failed", { exact: true })).toHaveCount(
			1
		);
		await expect(
			page.getByText("Update failed", { exact: true })
		).toBeVisible();
		await expect(install).toBeEnabled();
		await page.evaluate(() =>
			history.replaceState(null, "", "/app-update-transaction-proof.html")
		);
		await retry();
		await expect
			.poll(() =>
				page.evaluate(
					() =>
						window.updateProofCalls.filter(
							(command) => command === "install_prepared_app_update"
						).length
				)
			)
			.toBe(3);
		await expect(install).toBeEnabled();
		await expect(
			page.getByText("Update installer finished", { exact: true })
		).toHaveCount(0);
		const calls = await page.evaluate(() => window.updateProofCalls);
		expect(calls).not.toContain("prepare_app_update");
		expect(calls).not.toContain("clear_prepared_app_update");
		expect(calls.some((command) => command.includes("relaunch"))).toBe(false);
		await expect(page.getByText("Update failed", { exact: true })).toBeHidden({
			timeout: 15_000,
		});
		await expect(
			page.getByText("Other pending action", { exact: true })
		).toBeVisible();
		await expect(install).toBeEnabled();
		await expect(
			page.getByText(
				"v9.9.9 is downloaded and signature-verified. Install it when you're ready.",
				{ exact: true }
			)
		).toBeVisible();
		await page.screenshot({
			path: proofPath(
				`updatevisual-v3/failed-install-${retryAction.toLowerCase()}-retry-keeps-working.png`
			),
			animations: "disabled",
			fullPage: true,
		});
	});
}

// Shipping AppUpdatesSettings and native preparation coordinator run unchanged.
// Preference storage below is the isolated native IPC fixture, not an OS-disk claim.
async function preferenceOpen(page: import("@playwright/test").Page) {
	await page.goto("/app-update-transaction-proof.html?preference=1");
	await expect(
		page.getByRole("switch", { name: "Download app updates automatically" })
	).toBeChecked();
}
async function preferenceWrites(page: import("@playwright/test").Page) {
	return page.evaluate(() =>
		window.updateProofIpcRequests.filter(
			(call) => call.command === "set_app_update_download_preference"
		)
	);
}
test("automatic app downloads: exact Boolean native save survives a fresh renderer read", async ({
	page,
}) => {
	await preferenceOpen(page);
	const control = page.getByRole("switch", {
		name: "Download app updates automatically",
	});
	await control.click();
	await expect(control).not.toBeChecked();
	await expect
		.poll(() =>
			page.evaluate(() => window.updateProofDownloadPreference.persisted())
		)
		.toBe(false);
	expect(await preferenceWrites(page)).toEqual([
		{ command: "set_app_update_download_preference", args: { enabled: false } },
	]);
	expect(await page.evaluate(() => window.updateProofUnknownCommands)).toEqual(
		[]
	);
	await page.reload();
	await expect(control).not.toBeChecked();
	expect(await preferenceWrites(page)).toEqual([]);
	expect(await page.evaluate(() => window.updateProofCalls)).toContain(
		"get_app_update_download_preference"
	);
	await control.click();
	await expect
		.poll(() =>
			page.evaluate(() => window.updateProofDownloadPreference.persisted())
		)
		.toBe(true);
	expect(await preferenceWrites(page)).toEqual([
		{ command: "set_app_update_download_preference", args: { enabled: true } },
	]);
	expect(await page.evaluate(() => window.updateProofUnknownCommands)).toEqual(
		[]
	);
	await page.reload();
	await expect(control).toBeChecked();
});
test("automatic app downloads: refused write preserves saved preference and identical explicit retry", async ({
	page,
}) => {
	await preferenceOpen(page);
	const control = page.getByRole("switch", {
		name: "Download app updates automatically",
	});
	await page.evaluate(() => window.updateProofDownloadPreference.failNext());
	await control.click();
	await expect(
		page.getByText("Could not save the automatic-download setting", {
			exact: true,
		})
	).toBeVisible();
	await expect(control).toBeChecked();
	expect(
		await page.evaluate(() => window.updateProofDownloadPreference.persisted())
	).toBe(true);
	expect(
		await page.evaluate(() => window.updateProofDownloadPreference.accepted)
	).toEqual([]);
	await control.click();
	await expect(control).not.toBeChecked();
	await expect
		.poll(() =>
			page.evaluate(() => window.updateProofDownloadPreference.persisted())
		)
		.toBe(false);
	expect(await preferenceWrites(page)).toEqual([
		{ command: "set_app_update_download_preference", args: { enabled: false } },
		{ command: "set_app_update_download_preference", args: { enabled: false } },
	]);
	expect(
		await page.evaluate(() => window.updateProofDownloadPreference.accepted)
	).toEqual([false]);
	expect(await page.evaluate(() => window.updateProofUnknownCommands)).toEqual(
		[]
	);
	await page.reload();
	await expect(control).not.toBeChecked();
});
test("automatic app downloads: a held older write cannot leave displayed choice different from fresh saved read", async ({
	page,
}) => {
	await preferenceOpen(page);
	const control = page.getByRole("switch", {
		name: "Download app updates automatically",
	});
	await page.evaluate(() => window.updateProofDownloadPreference.holdNext());
	await control.click();
	await expect
		.poll(() =>
			page.evaluate(() => window.updateProofDownloadPreference.pending())
		)
		.toBe(1);
	await expect(control).not.toBeChecked();
	expect(
		await page.evaluate(() => window.updateProofDownloadPreference.persisted())
	).toBe(true);
	// A disabled switch should reject the second pointer activation; an enabled
	// switch must preserve the newer choice when the old native response settles.
	const disabled = await control.isDisabled();
	if (!disabled) {
		await control.click();
		await expect(control).toBeChecked();
	}
	await page.evaluate(() => window.updateProofDownloadPreference.release());
	if (!disabled) {
		await expect.poll(() => preferenceWrites(page)).toHaveLength(2);
	}
	await expect
		.poll(() =>
			page.evaluate(() => window.updateProofDownloadPreference.pending())
		)
		.toBe(0);
	const displayed = await control.isChecked();
	const saved = await page.evaluate(() =>
		window.updateProofDownloadPreference.persisted()
	);
	expect(saved).toBe(displayed);
	expect(await preferenceWrites(page)).toEqual(
		disabled
			? [
					{
						command: "set_app_update_download_preference",
						args: { enabled: false },
					},
				]
			: [
					{
						command: "set_app_update_download_preference",
						args: { enabled: false },
					},
					{
						command: "set_app_update_download_preference",
						args: { enabled: true },
					},
				]
	);
	expect(await page.evaluate(() => window.updateProofUnknownCommands)).toEqual(
		[]
	);
	await page.reload();
	await expect(control).toBeChecked({ checked: displayed });
});
test("automatic app downloads: queued refused writes leave the switch on the last saved choice", async ({
	page,
}) => {
	await preferenceOpen(page);
	const control = page.getByRole("switch", {
		name: "Download app updates automatically",
	});
	const pending = () =>
		page.evaluate(() => window.updateProofDownloadPreference.pending());
	const persisted = () =>
		page.evaluate(() => window.updateProofDownloadPreference.persisted());
	// Two quick changes that the native store both refuses. The older write is
	// held, so the newer one queues behind it and is refused after it.
	await page.evaluate(() => {
		window.updateProofDownloadPreference.holdNext();
		window.updateProofDownloadPreference.failNext(2);
	});
	await control.click();
	await expect.poll(pending).toBe(1);
	await expect(control).not.toBeChecked();
	await control.click();
	await expect(control).toBeChecked();
	await page.evaluate(() => window.updateProofDownloadPreference.release());
	await expect.poll(() => preferenceWrites(page)).toHaveLength(2);
	await expect.poll(pending).toBe(0);
	await expect(
		page.getByText("Could not save the automatic-download setting", {
			exact: true,
		})
	).toBeVisible();
	// Nothing was saved, so the switch must show the saved `true`, not the
	// stale optimistic value captured when the newer change was made.
	expect(await persisted()).toBe(true);
	await expect(control).toBeChecked();

	// Three quick changes: the first two are refused and the last is accepted.
	// The switch must end on the accepted choice, not on a rollback target.
	await page.evaluate(() => {
		window.updateProofDownloadPreference.holdNext();
		window.updateProofDownloadPreference.failNext(2);
	});
	await control.click();
	await expect.poll(pending).toBe(1);
	await control.click();
	await control.click();
	await expect(control).not.toBeChecked();
	await page.evaluate(() => window.updateProofDownloadPreference.release());
	await expect.poll(() => preferenceWrites(page)).toHaveLength(5);
	await expect.poll(pending).toBe(0);
	expect(await persisted()).toBe(false);
	await expect(control).not.toBeChecked();
	expect(await preferenceWrites(page)).toEqual(
		[false, true, false, true, false].map((enabled) => ({
			command: "set_app_update_download_preference",
			args: { enabled },
		}))
	);
	expect(
		await page.evaluate(() => window.updateProofDownloadPreference.accepted)
	).toEqual([false]);
	expect(await page.evaluate(() => window.updateProofUnknownCommands)).toEqual(
		[]
	);
	await page.reload();
	await expect(control).not.toBeChecked();
});
