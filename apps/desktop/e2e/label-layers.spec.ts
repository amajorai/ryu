import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

declare global {
	interface Window {
		__revealTransitions: number;
	}
}

for (const reveal of [false, true, "clone"]) {
	const prefix =
		reveal === "clone" ? "reveal-clone" : reveal ? "reveal" : "label";
	test(`${prefix}: settled controls do not request idle transform layers`, async ({
		page,
	}) => {
		const cdp = await page.context().newCDPSession(page);
		let layers: { layerId: string }[] = [];
		cdp.on(
			"LayerTree.layerTreeDidChange",
			(event: { layers?: { layerId: string }[] }) => {
				layers = event.layers ?? [];
			}
		);
		await cdp.send("LayerTree.enable");
		await page.emulateMedia({ reducedMotion: "no-preference" });
		await page.addInitScript(() => {
			window.__revealTransitions = 0;
			document.addEventListener("transitionrun", (event) => {
				if (
					event.target instanceof Element &&
					event.target.closest("[data-testid=reveal-grid]")
				) {
					window.__revealTransitions = Number(window.__revealTransitions) + 1;
				}
			});
		});
		await page.goto(
			`/button-label-overflow-proof.html?many${reveal ? "&reveal" : ""}${reveal === "clone" ? "&clone" : ""}`
		);
		await page.waitForLoadState("networkidle");
		await expect(page.getByRole("button")).toHaveCount(200);
		await expect
			.poll(() =>
				page.evaluate(
					() =>
						document
							.getAnimations()
							.filter((animation) => animation.playState === "running").length
				)
			)
			.toBe(0);
		if (reveal) {
			expect(
				await page.evaluate(() => Number(window.__revealTransitions))
			).toBeGreaterThan(0);
		}
		await expect.poll(() => layers.length).toBeGreaterThan(0);
		const reasons = await Promise.all(
			layers.map((layer) =>
				cdp.send("LayerTree.compositingReasons", {
					layerId: layer.layerId,
				})
			)
		);
		const idleTransformHintLayers = reasons.filter((row) =>
			row.compositingReasons.some((reason) =>
				/will-change.*transform/i.test(reason)
			)
		).length;
		const directory = path.resolve(
			import.meta.dirname,
			"../../../docs/proof/performance-sweep"
		);
		await writeFile(
			path.join(directory, `${prefix}-layers-current.json`),
			`${JSON.stringify({ scope: "Chromium compositor tree for 200 actual shared Buttons with fitting labels", labels: 200, reveal, layers: layers.length, idleTransformHintLayers }, null, 2)}\n`
		);
		expect(idleTransformHintLayers).toBe(0);
		await page.screenshot({
			path: path.join(directory, `${prefix}-layers-completed.png`),
			fullPage: true,
			animations: "disabled",
		});
	});
}
