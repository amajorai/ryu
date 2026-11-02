// Marketplace Store home proof. Engine detail and per-runtime settings.

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { EVIDENCE_DIR } from "./marketplace-store-home.fixture.ts";
import { engineCatalogItems } from "./marketplace-store-home.fixture-cards.ts";
import {
	callsFor,
	openStoreSection,
	prepareEvidenceCapture,
	registerStoreHomeEvidenceHooks,
} from "./marketplace-store-home.helpers.ts";

registerStoreHomeEvidenceHooks();

test("engine detail saves shared sampling and launch defaults", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	await page.getByRole("button", { name: "llama.cpp" }).click();
	await expect(
		page.getByRole("heading", { name: "Advanced configuration" })
	).toBeVisible();

	await page
		.getByRole("button", { name: "Sampling defaults", exact: true })
		.click({ force: true });
	await page.getByRole("spinbutton", { name: "Temperature" }).fill("0.4");
	await page.getByRole("button", { name: "Save sampling defaults" }).click();
	await expect(page.getByText("Saved for this engine")).toBeVisible();

	const launchSections = page.getByRole("region", {
		name: "Engine launch defaults",
	});
	// llama.cpp serves five launch-default scopes, in this order: chat (under
	// Advanced configuration), the embedding engine, Speech Processing, and the
	// reranker and classifier servers (4f7563c79d). This proof saves the chat
	// and embedding scopes, each to its own preference.
	await expect(launchSections).toHaveCount(5);
	const chatLaunchSection = launchSections.nth(0);
	await chatLaunchSection
		.getByRole("button", { name: "Engine launch settings" })
		.click();
	await chatLaunchSection
		.getByRole("spinbutton", { name: "Context size" })
		.fill("4096");
	await chatLaunchSection
		.getByRole("spinbutton", { name: "Unload after idle (seconds)" })
		.fill("120");
	await chatLaunchSection
		.getByRole("button", { name: "Save engine launch settings" })
		.click();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();

	const embeddingLaunchSection = launchSections.nth(1);
	await embeddingLaunchSection
		.getByRole("button", { name: "Engine launch settings" })
		.click();
	await embeddingLaunchSection
		.getByRole("spinbutton", { name: "Context size" })
		.fill("6144");
	await embeddingLaunchSection
		.getByRole("button", { name: "Save engine launch settings" })
		.click();
	await expect(page.getByText("Saved", { exact: true }).last()).toBeVisible();

	expect(
		callsFor(fixture, "PUT", "/api/preferences/inference.engine.llamacpp").map(
			(call) => call.body
		)
	).toEqual([{ value: JSON.stringify({ temperature: 0.4 }) }]);
	expect(
		callsFor(
			fixture,
			"PUT",
			"/api/preferences/model.launch.engine.llamacpp"
		).map((call) => call.body)
	).toEqual([
		{
			value: JSON.stringify({ ctx_size: 4096, sleep_idle_secs: 120 }),
		},
	]);
	expect(
		callsFor(
			fixture,
			"PUT",
			"/api/preferences/model.launch.engine.llamacpp-embed"
		).map((call) => call.body)
	).toEqual([{ value: JSON.stringify({ ctx_size: 6144 }) }]);

	await page
		.getByRole("heading", { name: "Advanced configuration" })
		.scrollIntoViewIfNeeded();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-engine-advanced-settings.png"
		),
	});
	await embeddingLaunchSection
		.getByRole("button", {
			name: "Engine launch settings",
			exact: true,
		})
		.scrollIntoViewIfNeeded();
	await prepareEvidenceCapture(page);
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-engine-embedding-launch-settings.png"
		),
	});
});

test("every chat runtime has its own engine-wide settings", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	const chatEngineIds = new Set([
		"llamacpp",
		"ollama",
		"koboldcpp",
		"vllm",
		"sglang",
		"mlx",
		"mlx-vlm",
		"mlx-serve",
		"omlx",
		"lemonade",
		"llama-swap",
		"freetoken",
		"docker-model-runner",
		"apfel",
		"mesh-llm",
	]);
	const manualLaunchProfileIds = new Set([
		"koboldcpp",
		"lemonade",
		"llama-swap",
		"freetoken",
		"docker-model-runner",
	]);
	const chatEngines = engineCatalogItems(fixture).filter((engine) =>
		chatEngineIds.has(engine.name)
	);
	expect(chatEngines.map((engine) => engine.name).sort()).toEqual(
		[...chatEngineIds].sort()
	);

	for (const engine of chatEngines) {
		await page.getByRole("button", { name: engine.display_name }).click();
		await expect(
			page.getByRole("heading", { name: "Advanced configuration" })
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Engine launch settings" }).first()
		).toBeVisible();
		await page
			.getByRole("button", { name: "Sampling defaults", exact: true })
			.click({ force: true });
		await page.getByRole("spinbutton", { name: "Temperature" }).fill("0.35");
		await page.getByRole("button", { name: "Save sampling defaults" }).click();
		await expect(page.getByText("Saved for this engine")).toBeVisible();
		expect(
			callsFor(
				fixture,
				"PUT",
				`/api/preferences/inference.engine.${engine.name}`
			).map((call) => call.body)
		).toEqual([{ value: JSON.stringify({ temperature: 0.35 }) }]);
		if (engine.name === "lemonade") {
			await page
				.getByRole("textbox", { name: "Extra body fields (JSON)" })
				.fill('{"top_k": 23}');
			await page
				.getByRole("button", { name: "Save sampling defaults" })
				.click();
			await expect(page.getByText("Saved for this engine")).toBeVisible();
			expect(
				callsFor(
					fixture,
					"PUT",
					"/api/preferences/inference.engine.lemonade"
				).map((call) => call.body)
			).toEqual([
				{ value: JSON.stringify({ temperature: 0.35 }) },
				{
					value: JSON.stringify({ temperature: 0.35, extra: { top_k: 23 } }),
				},
			]);
		}
		if (manualLaunchProfileIds.has(engine.name)) {
			await page
				.getByRole("button", { name: "Engine launch settings" })
				.first()
				.click();
			await expect(page.getByText(/saved copy only/i)).toBeVisible();
			await page
				.getByRole("textbox", { name: "Runtime args" })
				.fill(`--engine-id, ${engine.name}`);
			await page
				.getByRole("button", { name: "Save engine launch settings" })
				.click();
			await expect(page.getByText("Saved", { exact: true })).toBeVisible();
			expect(
				callsFor(
					fixture,
					"PUT",
					`/api/preferences/model.launch.engine.${engine.name}`
				).map((call) => call.body)
			).toEqual([
				{
					value: JSON.stringify({
						extra_args: ["--engine-id", engine.name],
					}),
				},
			]);
			await expect(
				page.getByRole("textbox", { name: "Runtime args" })
			).toBeVisible();
		} else {
			await page
				.getByRole("button", { name: "Engine launch settings" })
				.first()
				.click();
			if (["llamacpp", "ollama", "vllm", "sglang"].includes(engine.name)) {
				await expect(
					page.getByRole("spinbutton", { name: "Context size" })
				).toBeVisible();
			} else {
				await expect(
					page.getByRole("textbox", { name: "Extra args" })
				).toBeVisible();
			}
		}
		await page.getByRole("button", { name: "Close", exact: true }).click();
	}
});

test("Ollama exposes a copyable per-engine Modelfile profile", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	await page.getByRole("button", { name: "Ollama Fixture" }).click();
	await page
		.getByRole("button", { name: "Sampling defaults", exact: true })
		.click();
	await page.getByRole("spinbutton", { name: "Top K" }).fill("40");
	await page.getByRole("button", { name: "Save sampling defaults" }).click();
	await expect(page.getByText("Saved for this engine")).toBeVisible();
	await page.getByRole("button", { name: "Engine launch settings" }).click();
	await expect(
		page.getByText(/does not create a derived Ollama model/i)
	).toBeVisible();
	await page.getByRole("spinbutton", { name: "Context size" }).fill("8192");
	await page.getByRole("spinbutton", { name: "Batch size" }).fill("256");
	await expect(page.getByLabel("Generated Ollama Modelfile")).toContainText(
		"PARAMETER num_ctx 8192"
	);
	await expect(page.getByLabel("Generated Ollama Modelfile")).toContainText(
		"PARAMETER num_batch 256"
	);
	await expect(page.getByLabel("Generated Ollama Modelfile")).toContainText(
		"PARAMETER top_k 40"
	);
	await page
		.getByRole("button", { name: "Save engine launch settings" })
		.click();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();
	expect(
		callsFor(fixture, "PUT", "/api/preferences/inference.engine.ollama").map(
			(call) => call.body
		)
	).toEqual([{ value: JSON.stringify({ top_k: 40 }) }]);
	expect(
		callsFor(fixture, "PUT", "/api/preferences/model.launch.engine.ollama").map(
			(call) => call.body
		)
	).toEqual([
		{
			value: JSON.stringify({
				ctx_size: 8192,
				batch_size: 256,
			}),
		},
	]);

	await page.getByLabel("Generated Ollama Modelfile").scrollIntoViewIfNeeded();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-ollama-modelfile-settings.png"
		),
	});
});

test("chat engines without a launch adapter expose a saved runtime profile", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	await page.getByRole("button", { name: "KoboldCPP Fixture" }).click();
	await page.getByRole("button", { name: "Engine launch settings" }).click();
	await expect(page.getByText(/saved copy only/i)).toBeVisible();
	await page
		.getByRole("textbox", { name: "Runtime args" })
		.fill("--ctx-size, 8192");
	await page
		.getByRole("button", { name: "Save engine launch settings" })
		.click();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();
	expect(
		callsFor(
			fixture,
			"PUT",
			"/api/preferences/model.launch.engine.koboldcpp"
		).map((call) => call.body)
	).toEqual([
		{ value: JSON.stringify({ extra_args: ["--ctx-size", "8192"] }) },
	]);

	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-engine-manual-runtime-profile.png"
		),
	});
});
