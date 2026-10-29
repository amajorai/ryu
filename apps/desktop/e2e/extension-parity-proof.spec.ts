import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

const proofDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/extension-parity"
);
test("standard app context, stable PiP, filesystem save, rich form and completed product proof", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("https://proof.example/**", (route) =>
		route.fulfill({
			contentType: "image/svg+xml",
			body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 100"><rect width="160" height="100" fill="#e5edf5"/><path d="M55 30h50l15 20-15 20H55L40 50z" fill="#829bb0"/><circle cx="80" cy="50" r="12" fill="#e5edf5"/></svg>',
		})
	);
	await page.goto("/extension-parity-proof.html", {
		waitUntil: "domcontentloaded",
	});
	await expect(
		page.getByRole("heading", { name: "Extension host", exact: true })
	).toBeVisible();
	const frame = page.frameLocator("iframe");
	await expect(frame.getByText("Connected", { exact: true })).toBeVisible();
	await frame.getByRole("button", { name: "Share selection" }).click();
	await expect(page.getByTestId("model-context")).toContainText(
		"shared with model"
	);
	await frame.getByRole("button", { name: "Read file", exact: true }).click();
	await expect(frame.getByText("File loaded", { exact: true })).toBeVisible();
	await frame
		.getByRole("textbox", { name: "File contents" })
		.fill("Completed editor save: hex bolt\n");
	await frame.getByRole("button", { name: "Save file", exact: true }).click();
	await expect(frame.getByText("File saved", { exact: true })).toBeVisible();
	expect(
		await readFile(
			path.resolve(
				import.meta.dirname,
				"../../../target/extension-parity-proof/selected-file.txt"
			),
			"utf8"
		)
	).toBe("Completed editor save: hex bolt\n");
	await frame
		.getByRole("button", { name: "Picture in picture", exact: true })
		.click();
	await expect(page.getByTestId("app-widget")).toHaveAttribute(
		"data-display-mode",
		"pip"
	);
	// The textarea's unsaved state proves moving the widget did not reload its iframe.
	await expect(
		frame.getByRole("textbox", { name: "File contents" })
	).toHaveValue("Completed editor save: hex bolt\n");
	await mkdir(proofDir, { recursive: true });
	await page.screenshot({
		path: path.join(proofDir, "pip-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.getByRole("button", { name: "Back", exact: true }).click();
	await expect(page.getByTestId("app-widget")).toHaveAttribute(
		"data-display-mode",
		"inline"
	);
	await frame.getByRole("button", { name: "Fullscreen", exact: true }).click();
	await expect(page.getByTestId("app-widget")).toHaveAttribute(
		"data-display-mode",
		"fullscreen"
	);
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("app-widget")).toHaveAttribute(
		"data-display-mode",
		"inline"
	);
	await page.getByRole("button", { name: "Hex bolt", exact: true }).click();
	await page.getByRole("spinbutton", { name: /quantity/i }).fill("3");
	await page.getByRole("button", { name: "Submit", exact: true }).click();
	await expect(page.getByRole("status")).toContainText("Submitted:");
	const status = await page.getByRole("status").innerText();
	expect(JSON.parse(status.replace("Submitted: ", ""))).toEqual({
		part: "bolt",
		quantity: 3,
	});
	await page.screenshot({
		path: path.join(proofDir, "completed-light.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.getByRole("button", { name: "Dark mode", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Light mode", exact: true })
	).toBeVisible();
	await page.screenshot({
		path: path.join(proofDir, "completed-dark.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(
		frame.getByRole("heading", { name: "Parts editor", exact: true })
	).toBeVisible();
	await expect(
		frame.getByRole("textbox", { name: "File contents" })
	).toHaveValue("Completed editor save: hex bolt\n");
	await page.screenshot({
		path: path.join(proofDir, "completed-narrow.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.evaluate(() => {
		document.documentElement.dir = "rtl";
	});
	await expect(
		frame.getByRole("heading", { name: "Parts editor", exact: true })
	).toBeVisible();
	await page.screenshot({
		path: path.join(proofDir, "completed-rtl-reduced-motion.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(page.getByRole("status")).toContainText("Request canceled");
	await mkdir(path.join(proofDir, "logs"), { recursive: true });
	await test.info().attach("browser-errors", {
		body: JSON.stringify(errors),
		contentType: "application/json",
	});
	expect(errors).toEqual([]);
});
