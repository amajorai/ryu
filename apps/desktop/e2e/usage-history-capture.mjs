import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const proofDir = new URL("../../../docs/proof/usage-history/", import.meta.url);
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
	await page.goto("http://127.0.0.1:5187/usage-history-proof.html", {
		waitUntil: "domcontentloaded",
		timeout: 180_000,
	});
	await page
		.getByTestId("history-estimated-cost")
		.waitFor({ timeout: 180_000 });
	await page.getByRole("button", { name: "All time", exact: true }).click();
	await page.waitForTimeout(1000);
	console.log(await page.locator("body").innerText());
	console.log(
		await page.locator(".recharts-line-curve").evaluateAll((paths) =>
			paths.map((path) => ({
				d: path.getAttribute("d"),
				stroke: getComputedStyle(path).stroke,
				attribute: path.getAttribute("stroke"),
			}))
		)
	);
	await page.screenshot({
		path: fileURLToPath(new URL("live-desktop.png", proofDir)),
		fullPage: true,
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({
		path: fileURLToPath(new URL("live-mobile.png", proofDir)),
		fullPage: true,
	});
} finally {
	await browser.close();
}
