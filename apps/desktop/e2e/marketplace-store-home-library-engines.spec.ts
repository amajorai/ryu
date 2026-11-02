// Marketplace Store home proof. Library engines configured in place.

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { EVIDENCE_DIR } from "./marketplace-store-home.fixture.ts";
import { engineCatalogItems } from "./marketplace-store-home.fixture-cards.ts";
import {
	callsFor,
	prepareEvidenceCapture,
	registerStoreHomeEvidenceHooks,
} from "./marketplace-store-home.helpers.ts";
import { installLocalFixture } from "./marketplace-store-home.routes.ts";

registerStoreHomeEvidenceHooks();

test("Library engines configure chat and embeddings in place and share Store defaults", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page, "http://127.0.0.1:5192");
	await page.goto("/library-engine-settings.html");
	await expect(page.getByRole("tab", { selected: true })).toContainText(
		"Engines"
	);
	await page.getByText("llama.cpp", { exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Advanced configuration" })
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Embedding engine" })
	).toBeVisible();
	await page
		.getByRole("button", { name: "Sampling defaults", exact: true })
		.click();
	await page.getByRole("spinbutton", { name: "Temperature" }).fill("0.55");
	await page.getByRole("button", { name: "Save sampling defaults" }).click();
	await expect(page.getByText("Saved for this engine")).toBeVisible();
	expect(
		callsFor(fixture, "PUT", "/api/preferences/inference.engine.llamacpp").map(
			(call) => call.body
		)
	).toEqual([{ value: JSON.stringify({ temperature: 0.55 }) }]);
	await page
		.getByRole("heading", { name: "Advanced configuration" })
		.scrollIntoViewIfNeeded();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "library-engine-advanced-settings.png"),
	});
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await expect(page.getByRole("tab", { selected: true })).toContainText(
		"Engines"
	);
	await expect(page.getByPlaceholder("Search your library…")).toBeVisible();
	await expect(page).toHaveURL(/library-engine-settings\.html$/);
	await prepareEvidenceCapture(page);
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "library-engine-settings-cards.png"),
	});
	await page.goto("/library-engine-settings.html?surface=store");
	await page.getByRole("button", { name: "llama.cpp" }).click();
	await page
		.getByRole("button", { name: "Sampling defaults", exact: true })
		.click();
	await expect(
		page.getByRole("spinbutton", { name: "Temperature" })
	).toHaveValue("0.55");
});

test("Library engines expose speech runtime and text-to-speech settings without leaving Library", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page, "http://127.0.0.1:5192");
	await page.goto("/library-engine-settings.html");
	await page.getByText("Audio.cpp Fixture", { exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Audio runtime settings" })
	).toBeVisible();
	await page.getByRole("spinbutton", { name: "Threads" }).fill("7");
	await page.getByRole("button", { name: "Save audio.cpp settings" }).click();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();
	expect(
		callsFor(fixture, "PUT", "/api/preferences/engine.audiocpp.runtime").map(
			(call) => call.body
		)
	).toEqual([{ value: JSON.stringify({ threads: 7 }) }]);
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await page.getByText("Ryu Audio Fixture", { exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Text-to-speech defaults" })
	).toBeVisible();
	await expect(
		page.getByRole("combobox", { name: "Audio engine" })
	).toBeVisible();
	await expect(page).toHaveURL(/library-engine-settings\.html$/);
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "library-engine-tts-settings.png"),
	});
});

test("Library engines open every chat engine and fit a compact window", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page, "http://127.0.0.1:5192");
	await page.goto("/library-engine-settings.html");
	const chatEngines = engineCatalogItems(fixture).filter(
		(engine) => engine.category === "provider"
	);
	expect(chatEngines).toHaveLength(15);
	for (const engine of chatEngines) {
		await page.getByText(engine.display_name, { exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "Advanced configuration" })
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Sampling defaults", exact: true })
		).toBeVisible();
		await expect(
			page
				.getByRole("button", { name: "Engine launch settings", exact: true })
				.first()
		).toBeVisible();
		await page.getByRole("button", { name: "Close", exact: true }).click();
	}
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByText("llama.cpp", { exact: true }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth
			)
		)
		.toBe(true);
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "library-engine-settings-compact.png"),
	});
});
