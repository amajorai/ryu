import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

async function measureAction(
	page: Page,
	name: string,
	selector = "button",
	heading = name
) {
	return await page.evaluate(
		async ({ name, selector, heading }) => {
			const button = Array.from(document.querySelectorAll(selector)).find(
				(item) => item.textContent === name
			);
			if (!(button instanceof HTMLButtonElement)) {
				throw new Error(`Missing button: ${name}`);
			}
			const start = performance.now();
			await new Promise<void>((resolve, reject) => {
				const visible = () =>
					Array.from(document.querySelectorAll("h1,h2,h3")).some(
						(item) =>
							item.textContent === heading && item.getClientRects().length > 0
					);
				const observer = new MutationObserver(() => {
					if (visible()) {
						observer.disconnect();
						clearTimeout(timer);
						resolve();
					}
				});
				const timer = setTimeout(() => {
					observer.disconnect();
					reject(new Error(`View did not appear: ${heading}`));
				}, 10_000);
				observer.observe(document.body, {
					attributes: true,
					childList: true,
					subtree: true,
				});
				button.click();
				if (visible()) {
					observer.disconnect();
					clearTimeout(timer);
					resolve();
				}
			});
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			);
			return performance.now() - start;
		},
		{ name, selector, heading }
	);
}

const baseline = Boolean(process.env.RYU_NAV_BASELINE);
test("warm switching avoids unrelated route renders and preserves working state", async ({
	page,
	browserName,
}, testInfo) => {
	// Ordinary runs write the ledger and screenshot to this test's Playwright
	// output directory so the committed proof is never rewritten as a side
	// effect. Set RYU_REFRESH_NAV_PROOF=1 to deliberately regenerate it.
	const proofDir =
		process.env.RYU_REFRESH_NAV_PROOF === "1"
			? path.resolve(
					import.meta.dirname,
					"../../../docs/proof/navigation-performance",
					process.env.RYU_NAV_PROOF_RUN ?? "",
					browserName === "chromium" ? "" : browserName,
					testInfo.repeatEachIndex === 0
						? ""
						: `run-${testInfo.repeatEachIndex}`
				)
			: testInfo.outputPath("navigation-performance");
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			errors.push(message.text());
		}
	});
	// The installed full Chromium build (PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)
	// requests /favicon.ico, which the harness does not serve; the headless
	// shell does not. Answer it so the console-error check covers the app only.
	await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
	await page.goto("/navigation-performance-proof.html");
	await expect(page.locator("[data-workspace]")).toHaveCount(12);
	const draft = page.getByRole("textbox", { name: "Working draft" });
	await draft.fill("Keep this draft across tab switches");
	await page
		.locator("[data-scroll]")
		.first()
		.evaluate((element) => {
			element.scrollTop = 480;
		});
	const before = await page
		.locator("[data-workspace]")
		.evaluateAll((elements) =>
			elements.map((element) => Number(element.getAttribute("data-renders")))
		);
	const timings: number[] = [];
	for (let index = 0; index < 24; index++) {
		const title = index % 2 === 0 ? "Workspace 2" : "Workspace 1";
		// Measure the visible target through two animation-frame callbacks, excluding
		// Playwright locator/IPC overhead. This is not an optical paint measurement.
		const elapsed = await measureAction(page, title, "nav button");
		timings.push(elapsed);
		await expect(
			page.getByRole("heading", { name: title, exact: true })
		).toBeVisible();
	}
	const after = await page
		.locator("[data-workspace]")
		.evaluateAll((elements) =>
			elements.map((element) => Number(element.getAttribute("data-renders")))
		);
	const unrelatedRenders = after
		.slice(2)
		.reduce((sum, count, index) => sum + count - (before[index + 2] ?? 0), 0);
	if (!baseline) {
		expect(unrelatedRenders).toBe(0);
	}
	await expect(draft).toHaveValue("Keep this draft across tab switches");
	expect(
		await page
			.locator("[data-scroll]")
			.first()
			.evaluate((element) => element.scrollTop)
	).toBe(480);
	await page.getByRole("button", { name: "Find message", exact: true }).click();
	await expect(page.locator("[data-request]").first()).toHaveText("message-42");
	await page.getByRole("button", { name: "Mark busy", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Workspace 1", exact: true })
	).toBeVisible();
	const openPageMs = await measureAction(
		page,
		"Open page",
		"button",
		"New workspace"
	);
	await expect(
		page.getByRole("heading", { name: "New workspace", exact: true })
	).toBeVisible();
	await expect(page.locator("[data-workspace]")).toHaveCount(13);
	await page.getByRole("button", { name: "Workspace 1", exact: true }).click();
	await page
		.getByRole("button", { name: "Unload last tab", exact: true })
		.click();
	await expect(page.locator("[data-workspace]")).toHaveCount(12);
	const remountPageMs = await measureAction(
		page,
		"New workspace",
		"nav button"
	);
	await expect(page.locator("[data-workspace]")).toHaveCount(13);
	await expect(
		page.getByRole("heading", { name: "New workspace", exact: true })
	).toBeVisible();
	await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
	const saved = await page.evaluate(() =>
		JSON.parse(localStorage.getItem("ryu_session_tabs") ?? "{}")
	);
	expect(saved.tabs[saved.activeIndex].title).toBe("New workspace");
	expect(errors).toEqual([]);
	await mkdir(proofDir, { recursive: true });
	const sorted = [...timings].sort((a, b) => a - b);
	await writeFile(
		path.join(proofDir, baseline ? "baseline.json" : "after.json"),
		JSON.stringify(
			{
				scenario:
					"12 mounted routes, 160 rows per route, 24 switches including first activation; component harness; click to visible target plus two animation-frame callbacks",
				measurementVersion: 2,
				openPageMs,
				remountPageMs,
				firstSwitchMs: timings[0],
				maxMs: sorted.at(-1),
				unrelatedRenders,
				timings,
				medianMs: sorted[12],
				p95Ms: sorted[22],
				errors,
			},
			null,
			2
		)
	);
	if (!baseline) {
		await page.screenshot({
			path: path.join(proofDir, "navigation-completed.png"),
			fullPage: true,
		});
	}
});
