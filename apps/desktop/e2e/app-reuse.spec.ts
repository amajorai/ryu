import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

for (const app of [
	"slides",
	"pull-requests",
	"feedback-board",
	"teams",
	"canvas",
]) {
	test(`${app}: shared modal traps focus and restores it on Escape`, async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.goto(`/app-reuse-proof.html?app=${app}`);
		await page
			.getByRole("button", { name: "Open dialog", exact: true })
			.click();
		const dialog = page.getByRole(app === "teams" ? "alertdialog" : "dialog");
		await expect(dialog).toBeVisible();
		for (let index = 0; index < 12; index++) {
			await page.keyboard.press("Tab");
			await expect
				.poll(() =>
					dialog.evaluate((element) => element.contains(document.activeElement))
				)
				.toBe(true);
		}
		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();
		await expect(
			page.getByRole("button", { name: "Open dialog", exact: true })
		).toBeFocused();
		await expect(page.getByLabel("Mutation result")).toHaveText("No mutation");
		expect(errors).toEqual([]);
	});
}

test("Slides: export failure stays recoverable, successful MIME selection reaches callback", async ({
	page,
}) => {
	await page.goto("/app-reuse-proof.html?app=slides");
	await page.getByLabel("Simulate failure").check();
	await page.getByRole("button", { name: "Open dialog" }).click();
	await page.getByRole("button", { name: "Export", exact: true }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"Fixture request failed. Try again."
	);
	await expect(
		page.getByRole("button", { name: "Export", exact: true })
	).toBeEnabled();
	await page.keyboard.press("Escape");
	await page.getByLabel("Simulate failure").uncheck();
	await page.getByRole("button", { name: "Open dialog" }).click();
	await page.getByRole("radio", { name: /JPEG/ }).check();
	await page.getByRole("button", { name: "Export", exact: true }).click();
	await expect(page.getByRole("dialog")).toBeHidden();
	await expect(page.getByLabel("Mutation result")).toHaveText('"image/jpeg"');
});

test("Stack validation rejects duplicates and submits ordered PRs", async ({
	page,
}) => {
	await page.goto("/app-reuse-proof.html?app=pull-requests");
	await page.getByRole("button", { name: "Open dialog" }).click();
	await page.getByLabel("Pull request numbers").fill("101, 101");
	await page
		.getByRole("button", { name: "Create a stack", exact: true })
		.click();
	await expect(
		page.getByText(
			"Enter at least two unique PR numbers, ordered from bottom to top."
		)
	).toBeVisible();
	await page.getByLabel("Pull request numbers").fill("101, 102");
	await page
		.getByRole("button", { name: "Create a stack", exact: true })
		.click();
	await expect(page.getByLabel("Mutation result")).toHaveText("[101,102]");
});

test("Rooms: cancel is inert and unavailable host keeps confirmation open with error", async ({
	page,
}) => {
	await page.goto("/app-reuse-proof.html?app=rooms");
	await page.getByRole("button", { name: "Open dialog" }).click();
	await page.getByRole("button", { name: "Close room", exact: true }).click();
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(page.getByRole("alertdialog")).toBeHidden();
	await page.getByRole("button", { name: "Revoke", exact: true }).click();
	await page
		.getByRole("button", { name: "Revoke access", exact: true })
		.click();
	await expect(page.getByRole("alertdialog")).toContainText(
		"The Rooms host bridge is unavailable."
	);
	await expect(
		page.getByRole("button", { name: "Revoke access", exact: true })
	).toBeEnabled();
});

for (const theme of ["light", "dark"]) {
	test(`Slides ${theme}: narrow dialog fits and shared styles are emitted`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(`/app-reuse-proof.html?app=slides&theme=${theme}`);
		await page.getByRole("button", { name: "Open dialog" }).click();
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		const box = await dialog.boundingBox();
		expect(box).not.toBeNull();
		expect(box!.x).toBeGreaterThanOrEqual(0);
		expect(box!.x + box!.width).toBeLessThanOrEqual(391);
		expect(box!.y + box!.height).toBeLessThanOrEqual(845);
		await expect
			.poll(() =>
				dialog.evaluate((element) => getComputedStyle(element).position)
			)
			.toBe("fixed");
		await page.screenshot({
			path: `test-results/app-reuse/slides-${theme}-narrow.png`,
		});
	});
}

test("packed Slides runs in an opaque iframe and exports a real frame", async ({
	page,
}) => {
	const html = await readFile(
		path.resolve(
			import.meta.dirname,
			"../../../apps-store/slides/ui/dist/index.html"
		),
		"utf8"
	);
	expect(html).not.toMatch(
		/<(?:script|link)[^>]+(?:src|href)=["'][^"']+\.(?:js|css)["']/
	);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.setContent(
		'<iframe title="Slides" sandbox="allow-scripts allow-downloads" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>'
	);
	await page.locator("iframe").evaluate((frame, source) => {
		if (!(frame instanceof HTMLIFrameElement)) {
			throw new Error("Expected proof element to be an HTMLIFrameElement.");
		}

		frame.srcdoc = source;
	}, html);
	const frame = page.frameLocator("iframe");
	await frame.getByRole("button", { name: "Open First frame" }).click();
	await frame.getByRole("button", { name: "Export", exact: true }).click();
	await expect(frame.getByRole("dialog")).toBeVisible();
	await expect
		.poll(() =>
			frame
				.locator('[data-slot="dialog-overlay"]')
				.evaluate((element) => getComputedStyle(element).backgroundColor)
		)
		.not.toBe("rgba(0, 0, 0, 0)");
	await page.screenshot({
		path: "test-results/app-reuse/slides-packed-dialog.png",
	});
	const downloadPromise = page.waitForEvent("download");
	await frame
		.getByRole("dialog")
		.getByRole("button", { name: "Export", exact: true })
		.click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toMatch(/\.png$/);
	await expect(frame.getByRole("dialog")).toBeHidden();
	await download.saveAs("test-results/app-reuse/exported-frame.png");
	expect(errors).toEqual([]);
});

for (const app of ["finetune", "workflows"]) {
	test(`packed ${app}: shared toolbar renders in the Companion`, async ({
		page,
	}) => {
		const html = await readFile(
			path.resolve(
				import.meta.dirname,
				`../../../apps-store/${app}/ui/dist/index.html`
			),
			"utf8"
		);
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.setContent(
			'<iframe title="App" sandbox="allow-scripts" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>'
		);
		await page.locator("iframe").evaluate((frame, source) => {
			if (!(frame instanceof HTMLIFrameElement)) {
				throw new Error("Expected proof element to be an HTMLIFrameElement.");
			}

			frame.srcdoc = source;
		}, html);
		const frame = page.frameLocator("iframe");
		await expect(frame.locator(".ryu-app-toolbar")).toBeVisible();
		await expect(frame.locator(".ryu-app-toolbar")).toContainText(
			app === "finetune" ? "Fine-tuning Studio" : "New workflow"
		);
		await page.screenshot({
			path: `test-results/app-reuse/${app}-packed-toolbar.png`,
		});
		expect(errors).toEqual([]);
	});
}
