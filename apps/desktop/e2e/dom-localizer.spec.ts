import path from "node:path";
import { expect, test } from "@playwright/test";
import type {} from "./harness/dom-localizer-proof.tsx";

test("localized mutations avoid translating stable siblings and retain language behavior", async ({
	page,
	browserName,
}) => {
	await page.goto("/dom-localizer-proof.html");
	await expect(page.locator("#primary")).toHaveText("Translated alpha");
	await page.evaluate(() => window.localizerProof.reset());
	await page
		.getByRole("button", { name: "Change literal", exact: true })
		.click();
	await expect(page.locator("#primary")).toHaveText("Translated beta");
	expect(await page.evaluate(() => window.localizerProof.calls())).toBe(1);
	expect(await page.evaluate(() => window.localizerProof.stableVisits())).toBe(
		0
	);
	await page.evaluate(() => window.localizerProof.reset());
	await page
		.getByRole("button", { name: "Change attribute", exact: true })
		.click();
	await expect(page.locator("#attribute")).toHaveAttribute(
		"title",
		"Translated beta"
	);
	expect(await page.evaluate(() => window.localizerProof.calls())).toBe(1);
	await page.getByRole("button", { name: "Add subtree", exact: true }).click();
	await expect(page.locator("#dynamic button")).toHaveText("Translated alpha");
	await expect(page.locator("#dynamic button")).toHaveAttribute(
		"title",
		"Translated beta"
	);
	await expect(page.locator("#excluded")).toHaveText("Alpha label");
	await expect(page.locator('[contenteditable="true"]')).toHaveText(
		"Beta label"
	);
	await page
		.getByRole("button", { name: "Remove opt out", exact: true })
		.click();
	await expect(page.locator("#excluded")).toHaveText("Translated alpha");
	await page.getByRole("button", { name: "Update pack", exact: true }).click();
	await expect(page.locator("#attribute")).toHaveText("Updated alpha");
	await page
		.getByRole("button", { name: "Use source language", exact: true })
		.click();
	await expect(page.locator("#attribute")).toHaveText("Alpha label");
	await page.evaluate(() => window.localizerProof.reset());
	await page
		.getByRole("button", { name: "Remove temporary node", exact: true })
		.click();
	await expect(page.getByText("Temporary label", { exact: true })).toHaveCount(
		0
	);
	expect(await page.evaluate(() => window.localizerProof.calls())).toBe(0);
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			`../../../docs/proof/performance-sweep/dom-localizer-${browserName}-completed.png`
		),
		animations: "disabled",
	});
});
test("remote pack changes reject obsolete replies and refresh the same pack", async ({
	page,
}) => {
	await page.goto("/dom-localizer-proof.html?host");
	await expect
		.poll(() => page.evaluate(() => window.localizerProof.remoteCount()))
		.toBe(1);
	await page.evaluate(() => window.localizerProof.changeHost("remote-b"));
	await expect
		.poll(() => page.evaluate(() => window.localizerProof.remoteCount()))
		.toBe(2);
	await page.evaluate(() =>
		window.localizerProof.resolveRemote(1, "Fresh label")
	);
	await expect(page.locator("#primary")).toHaveText("Fresh label");
	await page.evaluate(() =>
		window.localizerProof.resolveRemote(0, "Stale label")
	);
	await expect(page.locator("#primary")).toHaveText("Fresh label");
	await page.evaluate(() => window.localizerProof.changeHost("remote-b"));
	expect(await page.evaluate(() => window.localizerProof.remoteCount())).toBe(
		2
	);
	await page.evaluate(() => window.localizerProof.changeHost("remote-b", "2"));
	await expect
		.poll(() => page.evaluate(() => window.localizerProof.remoteCount()))
		.toBe(3);
	await page.evaluate(() =>
		window.localizerProof.resolveRemote(2, "Updated label")
	);
	await expect(page.locator("#primary")).toHaveText("Updated label");
});
