// Continues marketplace-store-models.spec.ts (split under the file token limit); helpers live in marketplace-store-models.helpers.ts.

import { expect, test } from "@playwright/test";
import {
	chooseSelectOption,
	closeFilters,
	installModelFixture,
	latestSearch,
	openFilters,
} from "./marketplace-store-models.data.ts";
import { STORY_URL } from "./marketplace-store-models.helpers.ts";

test.describe.configure({ timeout: 90_000 });

test("GGUF quant install failure recovers, readback enables activation, fine-tune and removal paths", async ({
	page,
}, testInfo) => {
	const fixture = await installModelFixture(page);
	fixture.installFailures = 1;
	fixture.uninstallFailures = 1;
	fixture.activeFailures = 1;
	fixture.llmfitFailures = 1;
	fixture.engineInstallState = "not_installed";
	fixture.installGate = new Promise<void>((resolve) => {
		fixture.releaseInstall = resolve;
	});
	await page.goto(`${STORY_URL}?section=models`);
	const gemma = page.getByRole("button", { name: /Gemma/ });
	await gemma.click();
	const detail = page.getByRole("heading", { name: /Gemma/ });
	await expect(detail).toBeVisible();
	const hfLink = page.getByRole("link", { name: "View on Hugging Face" });
	await expect(hfLink).toHaveAttribute(
		"href",
		"https://huggingface.co/google/gemma-4b-instruct"
	);
	await expect(hfLink).toHaveAttribute("target", "_blank");
	await expect(hfLink).toHaveAttribute("rel", "noopener noreferrer");
	const readmeLink = page.getByRole("link", { name: "the local usage guide" });
	await expect(readmeLink).toHaveAttribute(
		"href",
		"https://docs.example.test/model-usage"
	);
	await expect(readmeLink).toHaveAttribute("rel", "noopener noreferrer");

	const speed = page.getByRole("button", {
		name: "Estimate speed on your device",
		exact: true,
	});
	await speed.click();
	await expect(page.getByText(/llmfit-estimate.*failed: 503/)).toBeVisible();
	await page
		.getByRole("button", {
			name: "Estimate speed on your device",
			exact: true,
		})
		.click();
	await expect(
		page.getByRole("button", { name: "Enable speed estimates" })
	).toBeVisible();
	expect(
		fixture.calls
			.filter((call) => call.path === "/api/models/llmfit-estimate")
			.map((call) => new URLSearchParams(call.search).toString())
	).toEqual([
		"repo=google%2Fgemma-4b-instruct&context=32768&quant=Q8_0",
		"repo=google%2Fgemma-4b-instruct&context=32768&quant=Q8_0",
	]);

	fixture.sidecarFailures = 1;
	await page.getByRole("button", { name: "Enable speed estimates" }).click();
	await expect(
		page.getByText("Fixture speed estimator install failed")
	).toBeVisible();
	await page.getByRole("button", { name: "Enable speed estimates" }).click();
	await expect(
		fixture.calls.filter((call) => call.path === "/api/setup/llmfit/install")
	).toHaveLength(2);
	await page
		.getByRole("button", { name: "Estimate speed on your device" })
		.click();
	await expect(page.getByText("≈42 tokens/sec", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Re-estimate", exact: true }).click();
	await expect
		.poll(
			() =>
				fixture.calls.filter(
					(call) => call.path === "/api/models/llmfit-estimate"
				).length
		)
		.toBe(4);

	await openFilters(page);
	const tokenBadge = page.getByRole("button", {
		name: "Chat-ready",
		exact: true,
	});
	await tokenBadge.click();
	await expect(tokenBadge).toHaveAttribute("aria-pressed", "true");
	await openFilters(page);
	await expect(
		page.getByRole("button", { name: "Remove filter Instruct" })
	).toBeVisible();
	await page.keyboard.press("Escape");

	const author = page.getByRole("button", { name: "google", exact: true });
	await author.click();
	await expect.poll(() => latestSearch(fixture).get("author")).toBe("google");
	await openFilters(page);
	await expect(
		page.getByRole("button", { name: "Remove filter Org: google" })
	).toBeVisible();
	await closeFilters(page);

	const quant = page.getByRole("combobox").filter({ hasText: "Q8_0" });
	await quant.click();
	await page.getByRole("option", { name: /Q8_0/ }).click();
	const addQuant = page
		.getByRole("button", { name: "Add", exact: true })
		.first();
	await addQuant.click();
	await expect(
		page.getByRole("button", { name: "Adding…", exact: true })
	).toBeDisabled();
	await page.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("models-q8-pending-remains-selected.png"),
	});
	// SAFETY: Only records for the native model install path enter this predicate; installModelFile/previewModelInstall serialize the selected fixture filename string when present, and snapshot installs omit it.
	await expect
		.poll(
			() =>
				fixture.calls.filter(
					(call) =>
						call.path === "/api/models/catalog/install" &&
						(call.body as { file?: string })?.file ===
							"gemma-4b-instruct-Q8_0.gguf"
				).length
		)
		.toBe(1);
	fixture.releaseInstall?.();
	await expect(
		page.getByRole("button", { name: "Add", exact: true }).first()
	).toBeVisible();
	await expect(
		fixture.installedFiles.has(
			"google/gemma-4b-instruct:gemma-4b-instruct-Q8_0.gguf"
		)
	).toBe(false);
	await page.getByRole("button", { name: "Add", exact: true }).first().click();
	await expect
		.poll(() =>
			fixture.installedFiles.has(
				"google/gemma-4b-instruct:gemma-4b-instruct-Q8_0.gguf"
			)
		)
		.toBe(true);
	const q8row = page.getByRole("listitem").filter({ hasText: "5.0 GB" });
	await page.mouse.move(100, 980);
	await expect(
		q8row.getByRole("button", { name: "Added", exact: true })
	).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("models-q8-installed-readback.png"),
	});
	const installRequests = fixture.calls.filter(
		(call) => call.path === "/api/models/catalog/install"
	);
	expect(installRequests.map((call) => call.body)).toEqual([
		{
			id: "google/gemma-4b-instruct",
			file: "gemma-4b-instruct-Q8_0.gguf",
			format: "gguf",
		},
		{
			id: "google/gemma-4b-instruct",
			file: "gemma-4b-instruct-Q8_0.gguf",
			format: "gguf",
		},
	]);
	const activate = page.getByRole("button", {
		name: "Set up & chat",
		exact: true,
	});
	await activate.click();
	await expect
		.poll(
			() =>
				fixture.calls.filter(
					(call) =>
						call.path === "/api/setup/llamacpp/install" &&
						call.method === "POST"
				).length
		)
		.toBe(1);
	await expect.poll(() => fixture.engineInstallReads).toBe(1);
	await expect
		.poll(
			() =>
				fixture.calls.filter(
					(call) => call.path === "/api/models/active" && call.method === "POST"
				).length
		)
		.toBe(1);
	await expect(
		page.getByRole("button", { name: "Use & chat", exact: true })
	).toBeEnabled();
	await page.getByRole("button", { name: "Use & chat", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Chat with this model", exact: true })
	).toBeEnabled();
	await expect
		.poll(() => page.evaluate(() => window.__modelsStoreEffects?.openedTabs))
		.toEqual(["/chat"]);
	const modelChatOptions = await page.evaluate(
		() => window.__modelsStoreEffects?.openedTabOptions?.[0]
	);
	expect(modelChatOptions).toMatchObject({
		forceNew: true,
		initialAgent: "ryu",
		initialModel: "google/gemma-4b-instruct",
		title: "Chat · Gemma",
	});
	await expect(
		page.getByRole("button", { name: /Could not start this model/ })
	).toBeHidden({ timeout: 10_000 });
	expect(
		fixture.calls
			.filter(
				(call) => call.path === "/api/models/active" && call.method === "POST"
			)
			.map((call) => call.body)
	).toEqual([
		{ engine: "llamacpp", id: "google/gemma-4b-instruct" },
		{ engine: "llamacpp", id: "google/gemma-4b-instruct" },
	]);
	expect(
		fixture.calls.filter(
			(call) =>
				call.path === "/api/setup/llamacpp/install" && call.method === "POST"
		)
	).toHaveLength(1);
	expect(fixture.engineInstallReads).toBe(1);
	await page.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("models-active-model-chat-ready.png"),
	});
	await page.getByRole("button", { name: "Fine-tune", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => window.__modelsStoreEffects?.openedTabs))
		.toEqual([
			"/chat",
			"/plugin/@ryu/finetune?base_model_id=google%2Fgemma-4b-instruct",
		]);
	await page.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("models-active-model-and-finetune.png"),
	});

	const remove = q8row.getByRole("button");
	await remove.focus();
	await expect(
		q8row.getByRole("button", { name: "Remove", exact: true })
	).toBeVisible();
	await q8row.getByRole("button", { name: "Remove", exact: true }).click();
	await expect
		.poll(
			() =>
				fixture.calls.filter(
					(call) => call.path === "/api/models/catalog/uninstall"
				).length
		)
		.toBe(1);
	await expect(
		fixture.installedFiles.has(
			"google/gemma-4b-instruct:gemma-4b-instruct-Q8_0.gguf"
		)
	).toBe(true);
	await q8row.getByRole("button", { name: "Remove", exact: true }).click();
	await expect
		.poll(() =>
			fixture.installedFiles.has(
				"google/gemma-4b-instruct:gemma-4b-instruct-Q8_0.gguf"
			)
		)
		.toBe(false);
	expect(
		fixture.calls
			.filter((call) => call.path === "/api/models/catalog/uninstall")
			.map((call) => call.body)
	).toEqual([
		{ id: "google/gemma-4b-instruct", file: "gemma-4b-instruct-Q8_0.gguf" },
		{ id: "google/gemma-4b-instruct", file: "gemma-4b-instruct-Q8_0.gguf" },
	]);

	const addon = page
		.getByRole("listitem")
		.filter({ hasText: "Vision adapter" });
	await addon.getByRole("button", { name: "Add", exact: true }).click();
	await expect
		.poll(() =>
			fixture.installedFiles.has(
				"google/gemma-4b-instruct:mmproj-model-f16.gguf"
			)
		)
		.toBe(true);
	await expect(
		addon.getByRole("button", { name: "Added", exact: true })
	).toBeVisible();
	expect(
		fixture.calls
			.filter((call) => call.path === "/api/models/catalog/install")
			.map((call) => call.body)
	).toEqual([
		{
			id: "google/gemma-4b-instruct",
			file: "gemma-4b-instruct-Q8_0.gguf",
			format: "gguf",
		},
		{
			id: "google/gemma-4b-instruct",
			file: "gemma-4b-instruct-Q8_0.gguf",
			format: "gguf",
		},
		{
			id: "google/gemma-4b-instruct",
			file: "mmproj-model-f16.gguf",
			format: "gguf",
		},
	]);
	await page.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("models-installed-quant-and-addon.png"),
	});
});

test("snapshot models retry locally and incompatible MLX remains disabled", async ({
	page,
}, testInfo) => {
	const fixture = await installModelFixture(page);
	fixture.snapshotFailures = 1;
	await page.goto(`${STORY_URL}?section=models`);
	await openFilters(page);
	await chooseSelectOption(page, 2, "Full quality (Safetensors)");
	await closeFilters(page);
	const embed = page.getByRole("button", { name: /acme/ });
	await expect(embed).toBeVisible();
	await embed.click();
	await expect(page.getByRole("heading", { name: /Embed/ })).toBeVisible();
	const addRepository = page.getByRole("button", {
		name: "Add repository",
		exact: true,
	});
	await expect(page.getByText("7.2 GB", { exact: true })).toBeVisible();
	await addRepository.click();
	await expect(addRepository).toBeVisible();
	await addRepository.click();
	await expect
		.poll(() => fixture.installedSnapshots.has("acme/embed-2b"))
		.toBe(true);
	await expect(page.getByText("Added", { exact: true }).last()).toBeVisible();
	expect(
		fixture.calls
			.filter((call) => call.path === "/api/models/catalog/install")
			.map((call) => call.body)
	).toEqual([
		{ id: "acme/embed-2b", format: "safetensors" },
		{ id: "acme/embed-2b", format: "safetensors" },
	]);

	await openFilters(page);
	await chooseSelectOption(page, 2, "Apple Silicon (MLX)");
	await closeFilters(page);
	const mlx = page.getByRole("button", { name: /apple/ });
	await expect(mlx).toBeVisible();
	await mlx.click();
	await expect(page.getByRole("heading", { name: /Llama/ })).toBeVisible();
	await expect(page.getByText(/Requires MLX \(Apple Silicon\)/)).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Add repository" })
	).toBeDisabled();
	await page.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("models-incompatible-mlx-action-disabled.png"),
	});
	// SAFETY: Only records for the native model install path enter this predicate; native install and preview writers JSON-serialize the selected fixture string repository ID.
	await expect
		.poll(
			() =>
				fixture.calls.filter(
					(call) =>
						call.path === "/api/models/catalog/install" &&
						(call.body as { id?: string })?.id === "apple/mlx-llama-8b"
				).length
		)
		.toBe(0);
});

test("gated model details keep their terms link on the exact safe Hugging Face destination", async ({
	page,
}) => {
	await installModelFixture(page);
	await page.goto(`${STORY_URL}?section=models`);
	await page.getByRole("button", { name: /restricted/ }).click();
	await expect(page.getByRole("heading", { name: /Gated/ })).toBeVisible();
	const link = page.getByRole("link", { name: "Hugging Face page" });
	await expect(link).toHaveAttribute(
		"href",
		"https://huggingface.co/restricted/gated-4b"
	);
	await expect(link).toHaveAttribute("target", "_blank");
	await expect(link).toHaveAttribute("rel", "noopener noreferrer");
});
