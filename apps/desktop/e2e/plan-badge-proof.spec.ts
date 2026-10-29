import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 900, height: 800 }, video: "on" });
test.describe.configure({ timeout: 90_000 });

test("every plan badge has a moving gradient background and respects reduced motion", async ({
	page,
}, testInfo) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			errors.push(message.text());
		}
	});
	await page.goto("/plan-badge-proof.html");
	await expect(page.getByTestId("plan-badge-proof")).toBeVisible();
	await expect(page.locator("[data-plan]")).toHaveCount(9);
	await testInfo.attach("default-motion.json", {
		body: JSON.stringify(
			await page.evaluate(() => ({
				reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
				animations: document.getAnimations().map((animation) => ({
					playState: animation.playState,
					currentTime: animation.currentTime,
				})),
			})),
			null,
			2
		),
		contentType: "application/json",
	});
	await page.emulateMedia({ reducedMotion: "no-preference" });
	const backgrounds = page.locator(
		"[data-plan] [title] > span > .t-plan-badge-gradient"
	);
	await expect(backgrounds).toHaveCount(18);
	const backgroundFrames = await backgrounds.evaluateAll(async (faces) => {
		const read = () =>
			faces.map((face) => {
				const style = getComputedStyle(face);
				return {
					plan: face.closest("[data-plan]")?.getAttribute("data-plan"),
					animation: style.animationName,
					position: style.backgroundPosition,
					size: style.backgroundSize,
				};
			});
		const before = read();
		await new Promise((resolve) => setTimeout(resolve, 1200));
		return { before, after: read() };
	});
	await testInfo.attach("background-motion.json", {
		body: JSON.stringify(backgroundFrames, null, 2),
		contentType: "application/json",
	});
	for (const [index, before] of backgroundFrames.before.entries()) {
		const expectedSize =
			before.plan === "business"
				? "500% 100%"
				: before.plan === "plus"
					? "180% 100%"
					: "300% 100%";
		const gradientCount = before.plan === "plus" ? 4 : 1;
		expect
			.soft(before.animation, `${before.plan} background animation`)
			.not.toBe("none");
		expect
			.soft(before.size.split(/,\s*/), `${before.plan} enlarged gradient`)
			.toEqual(Array.from({ length: gradientCount }, () => expectedSize));
		expect
			.soft(
				backgroundFrames.after[index]?.position,
				`${before.plan} background changes position`
			)
			.not.toBe(before.position);
	}
	const frames = await page.locator("[data-plan]").evaluateAll(async (rows) => {
		const read = () =>
			rows.flatMap((row) =>
				[
					...row.querySelectorAll(".t-plan-badge-sheen, .t-plan-badge-border"),
				].map((layer) => {
					const style = getComputedStyle(layer);
					return {
						plan: row.getAttribute("data-plan"),
						layer: layer.className,
						animation: style.animationName,
						position: style.backgroundPosition,
						size: style.backgroundSize,
					};
				})
			);
		const before = read();
		await new Promise((resolve) => setTimeout(resolve, 450));
		return { before, after: read() };
	});
	await testInfo.attach("gradient-motion.json", {
		body: JSON.stringify(frames, null, 2),
		contentType: "application/json",
	});
	await page.screenshot({
		path: testInfo.outputPath("plan-badges-animated.png"),
		fullPage: true,
	});
	expect(frames.before).toHaveLength(36);
	for (const [index, before] of frames.before.entries()) {
		expect
			.soft(before.animation, `${before.plan} sheen animation`)
			.not.toBe("none");
		expect
			.soft(
				frames.after[index]?.position,
				`${before.plan} sheen changes position`
			)
			.not.toBe(before.position);
	}
	await page.emulateMedia({ reducedMotion: "reduce" });
	const reduced = await page
		.locator("[data-plan] [title] > span")
		.evaluateAll((faces) =>
			faces.map((face) => ({
				face: getComputedStyle(face).animationName,
				background: getComputedStyle(
					face.querySelector(".t-plan-badge-gradient")
				).animationName,
				layers: [
					...face.querySelectorAll(".t-plan-badge-sheen, .t-plan-badge-border"),
				].map((layer) => getComputedStyle(layer).animationName),
			}))
		);
	for (const badge of reduced) {
		expect(badge.face).toBe("none");
		expect(badge.background).toBe("none");
		expect(badge.layers).toEqual(["none", "none"]);
	}
	expect(errors).toEqual([]);
});
