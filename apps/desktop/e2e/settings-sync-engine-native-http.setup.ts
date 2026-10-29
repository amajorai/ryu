import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect, type FullConfig } from "@playwright/test";
export default async function setup(config: FullConfig) {
	const browser = await chromium.launch({ headless: true });
	const context = await browser.newContext({
		userAgent: config.projects[0].use.userAgent,
		viewport: config.projects[0].use.viewport,
	});
	const page = await context.newPage();
	const errors: string[] = [];
	const failedResponses: { url: string; status: number }[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("requestfailed", (request) =>
		errors.push(`${request.url()} ${request.failure()?.errorText}`)
	);
	page.on("response", (response) => {
		if (
			response.status() >= 400 &&
			new URL(response.url()).pathname !== "/favicon.ico"
		) {
			failedResponses.push({ url: response.url(), status: response.status() });
		}
	});
	let browserIdentity: { userAgent: string; shortcutKey: string } | null = null;
	const control = String(config.metadata.proofControl ?? "");
	try {
		await page.addInitScript(() => {
			localStorage.clear();
			localStorage.setItem("ryu_session_token", "account-A");
			// Sync requests act only for a bearer the vault verifies as its account.
			localStorage.setItem(
				"ryu_accounts",
				JSON.stringify([
					{
						userId: "owned-account-A",
						token: "account-A",
						email: "A@example.invalid",
						name: "A",
						image: null,
					},
				])
			);
			localStorage.setItem("ryu_active_user_id", "owned-account-A");
			localStorage.setItem("ryu:settings-sync-enabled", "false");
		});
		await page.goto("http://127.0.0.1:5606/settings-sync-engine-proof.html", {
			waitUntil: "networkidle",
			timeout: 30_000,
		});
		await expect(
			page.getByRole("heading", { name: "Settings Sync", exact: true })
		).toBeVisible({ timeout: 10_000 });
		browserIdentity = await page.evaluate(() => ({
			userAgent: navigator.userAgent,
			shortcutKey: Reflect.get(window, "__syncProof").shortcutKey(),
		}));
		expect(browserIdentity.shortcutKey).toBe(
			`keybindings:${browserIdentity.userAgent.includes("Mac") ? "darwin" : browserIdentity.userAgent.includes("Windows") ? "win32" : "linux"}`
		);
		// Readiness requires real transport, not correctness of the original engine.
		// Actual engine behavior and opt-in switch belong to the thirteen cases.
		await expect(page.getByRole("switch")).toHaveAttribute(
			"aria-checked",
			"false"
		);
		expect(
			await page.evaluate(() => Reflect.get(window, "__syncProof").readCloud())
		).toEqual({ entries: [], updatedAt: 0, revision: 0 });
		expect(
			await page.evaluate(() =>
				Reflect.get(window, "__syncProof").readShortcuts()
			)
		).toEqual({});
		const stateResponse = await page.request.get(
			"http://127.0.0.1:5607/proof/state",
			{ headers: { Authorization: "Bearer owned-proof-control" } }
		);
		expect(stateResponse.status()).toBe(200);
		const state = await stateResponse.json();
		expect(state.pending).toEqual([]);
		expect(state.unexpected).toEqual([]);
		expect(
			state.calls.every((call: { settled: boolean }) => call.settled)
		).toBe(true);
		await expect(page.getByRole("switch")).toHaveAttribute(
			"aria-checked",
			"false"
		);
		expect(errors).toEqual([]);
		expect(failedResponses).toEqual([]);
		if (control) {
			await writeFile(
				path.join(control, "actual-browser-readiness.json"),
				JSON.stringify(
					{
						ready: true,
						featureAcceptance: false,
						browserIdentity,
						errors,
						failedResponses,
						shippingUI: true,
						nativeAccountPull: true,
						nativeCoreShortcutRead: true,
					},
					null,
					2
				)
			);
		}
	} catch (error) {
		if (control) {
			await writeFile(
				path.join(control, "actual-browser-readiness.json"),
				JSON.stringify(
					{
						ready: false,
						featureAcceptance: false,
						browserIdentity,
						error: String(error),
						errors,
						failedResponses,
					},
					null,
					2
				)
			);
		}
		throw error;
	} finally {
		if (
			!page.isClosed() &&
			(await page.getByRole("switch").count()) &&
			(await page.getByRole("switch").getAttribute("aria-checked")) === "true"
		) {
			await page.getByRole("switch").click();
			await expect(page.getByRole("switch")).toHaveAttribute(
				"aria-checked",
				"false"
			);
		}
		await context.close();
		await browser.close();
	}
}
