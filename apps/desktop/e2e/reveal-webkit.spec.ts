import path from "node:path";
import { expect, test } from "@playwright/test";

declare global {
	interface Window {
		__revealTransitions: number;
	}
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
	test(`reveal modes finish correctly with motion preference ${reducedMotion}`, async ({
		page,
	}) => {
		await page.emulateMedia({ reducedMotion });
		await page.addInitScript(() => {
			window.__revealTransitions = 0;
			document.addEventListener("transitionrun", (event) => {
				if (
					event.target instanceof Element &&
					event.target.parentElement?.matches('[data-testid="reveal-grid"]') &&
					["opacity", "filter", "transform", "translate"].includes(
						event.propertyName
					)
				) {
					window.__revealTransitions = Number(window.__revealTransitions) + 1;
				}
			});
		});
		for (const clone of [false, true]) {
			await page.goto(
				`/button-label-overflow-proof.html?many&reveal${clone ? "&clone" : ""}`
			);
			await expect(page.getByRole("button")).toHaveCount(200);
			await expect
				.poll(() =>
					page.evaluate(() =>
						Array.from(
							document.querySelectorAll('[data-testid="reveal-grid"] > *')
						).every((element) => getComputedStyle(element).opacity === "1")
					)
				)
				.toBe(true);
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
			const transitions = await page.evaluate(() =>
				Number(window.__revealTransitions)
			);
			if (reducedMotion === "reduce") {
				expect(transitions).toBe(0);
			} else {
				expect(transitions).toBeGreaterThan(0);
			}
		}
		await page.screenshot({
			path: path.resolve(
				import.meta.dirname,
				`../../../docs/proof/performance-sweep/reveal-webkit-${reducedMotion}-completed.png`
			),
			fullPage: true,
			animations: "disabled",
		});
	});
}
