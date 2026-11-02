import { expect, test } from "@playwright/test";
import {
	browserReceipts,
	coreOrigin,
	preferenceOpen,
	preferenceWrites,
	type TransactionNetworkReceipt,
} from "./app-update-transaction-proof.helpers.ts";

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
