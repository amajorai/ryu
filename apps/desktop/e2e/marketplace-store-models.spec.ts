import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
	chooseSelectOption,
	installModelFixture,
	latestSearch,
	modelSearchCalls,
	openFilters,
} from "./marketplace-store-models.data.ts";
import {
	FILTER_PROOF_DIR,
	STORY_URL,
	TOKEN_TAGS,
} from "./marketplace-store-models.helpers.ts";

test.describe.configure({ timeout: 90_000 });

test("model source, every task/format/sort option, and exact Core queries stay in sync", async ({
	page,
}) => {
	const fixture = await installModelFixture(page);
	await page.goto(`${STORY_URL}?section=models`);
	await expect(page.getByRole("tab", { name: "Models" })).toHaveAttribute(
		"aria-selected",
		"true"
	);
	await openFilters(page);

	await chooseSelectOption(page, 0, "Local mirror");
	await expect.poll(() => fixture.activeSource).toBe("local-mirror");
	expect(
		fixture.calls
			.filter((call) => call.path === "/api/catalog/sources/select")
			.map((call) => call.body)
	).toEqual([{ kind: "model", id: "local-mirror" }]);
	await expect(page.getByRole("button", { name: /Falcon/ })).toBeVisible();
	await chooseSelectOption(page, 0, "Hugging Face");
	await expect.poll(() => fixture.activeSource).toBe("huggingface");

	const categories = [
		["Chat / text", "text-generation", "google"],
		["Vision", "image-text-to-text", "meta"],
		["Image to text", "image-to-text", "salesforce"],
		["Image generation", "text-to-image", "stability"],
		["Image editing", "image-to-image", "black-forest-labs"],
		["Image classification", "image-classification", "microsoft"],
		["Object detection", "object-detection", "facebook"],
		["Image segmentation", "image-segmentation", "sam"],
		["Text to video", "text-to-video", "kling"],
		["Image to video", "image-to-video", "luma"],
		["Video understanding", "video-classification", "microsoft"],
		["Embedding / similarity", "sentence-similarity", "acme"],
		["Embeddings / features", "feature-extraction", "nomic"],
		["Reranker", "text-ranking", "cohere"],
		["Speech to text", "automatic-speech-recognition", "openai"],
		["Text to speech", "text-to-speech", "audio"],
		["Audio generation", "text-to-audio", "audio"],
		["Audio to audio", "audio-to-audio", "coqui"],
		["Audio understanding", "audio-classification", "speechbrain"],
		["Voice activity detection", "voice-activity-detection", "silero"],
		["Text classification", "text-classification", "distilbert"],
		["Question answering", "question-answering", "deepset"],
		["Translation", "translation", "facebook"],
		["Summarization", "summarization", "pegasus"],
	] as const;
	for (const [label, task, author] of categories) {
		await chooseSelectOption(page, 1, label);
		await expect.poll(() => latestSearch(fixture).get("task")).toBe(task);
		await expect(
			page.getByRole("button", { name: new RegExp(author) }).first()
		).toBeVisible();
	}
	await chooseSelectOption(page, 1, "All categories");
	await expect.poll(() => latestSearch(fixture).get("task")).toBeNull();
	await chooseSelectOption(page, 1, "Text to video");
	await expect
		.poll(() => latestSearch(fixture).get("task"))
		.toBe("text-to-video");
	await expect(page.getByRole("button", { name: /kling/ })).toBeVisible();
	await mkdir(FILTER_PROOF_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(FILTER_PROOF_DIR, "marketplace-video-filter.png"),
		fullPage: true,
	});
	await chooseSelectOption(page, 1, "All categories");

	const formats = [
		["Runs anywhere (GGUF)", "gguf", "google"],
		["Full quality (Safetensors)", "safetensors", "acme"],
		["Apple Silicon (MLX)", "mlx", "apple"],
	] as const;
	for (const [label, format, author] of formats) {
		await chooseSelectOption(page, 2, label);
		await expect.poll(() => latestSearch(fixture).get("format")).toBe(format);
		await expect(
			page.getByRole("button", { name: new RegExp(author) }).first()
		).toBeVisible();
	}
	await chooseSelectOption(page, 2, "Runs anywhere (GGUF)");

	const sorts = [
		["Trending", "trending"],
		["Popular", "downloads"],
		["Most liked", "likes"],
		["Newest", "recent"],
	] as const;
	for (const [label, sort] of sorts) {
		await chooseSelectOption(page, 3, label);
		await expect.poll(() => latestSearch(fixture).get("sort")).toBe(sort);
	}
});

test("the tag picker exposes and applies all 21 tokens with removable filter chips", async ({
	page,
}) => {
	const fixture = await installModelFixture(page);
	await page.goto(`${STORY_URL}?section=models`);
	await openFilters(page);
	await page.getByRole("button", { name: "Tags", exact: false }).click();
	const choices = page.getByRole("menuitemcheckbox");
	await expect(choices).toHaveCount(21);
	for (const label of TOKEN_TAGS) {
		const choice = page.getByRole("menuitemcheckbox", {
			name: label,
			exact: true,
		});
		await expect(choice).toBeVisible();
		await choice.click();
		await expect(choice).toHaveAttribute("aria-checked", "true");
	}
	await expect(
		page.getByRole("button", { name: /Token Catalog/ })
	).toBeVisible();
	await expect(page.getByRole("button", { name: /Gemma/ })).toHaveCount(0);
	const chips = page.getByRole("button", { name: /^Remove filter / });
	await expect(chips).toHaveCount(21);
	await page.getByRole("button", { name: /^Tags/ }).click();

	for (const label of [...TOKEN_TAGS].reverse()) {
		await page.getByRole("button", { name: `Remove filter ${label}` }).click();
		await page.getByRole("button", { name: /^Tags/ }).click();
		await expect(
			page.getByRole("menuitemcheckbox", { name: label, exact: true })
		).toHaveAttribute("aria-checked", "false");
		await page.getByRole("button", { name: /^Tags/ }).click();
	}
	await expect(chips).toHaveCount(0);
	await expect(page.getByRole("button", { name: /Gemma/ })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("menuitemcheckbox").first()).toHaveCount(0);
	expect(modelSearchCalls(fixture).length).toBeGreaterThan(0);
});

test("search, Added only, friendly labels, raw tags, and clear filters preserve their intended state", async ({
	page,
}) => {
	const fixture = await installModelFixture(page);
	await page.goto(`${STORY_URL}?section=models`);
	const search = page.getByPlaceholder(
		"Search by name, org, tag, or type (e.g. llama, google, coder, uncensored)…"
	);
	await expect(
		page.getByText("Chat-ready", { exact: true }).first()
	).toBeVisible();

	await openFilters(page);
	const friendly = page.getByRole("switch", {
		name: "Friendly names",
	});
	await expect(friendly).toHaveAttribute("aria-checked", "true");
	await friendly.click();
	await expect(
		page.getByText("Instruct", { exact: true }).first()
	).toBeVisible();
	await friendly.click();
	await expect(
		page.getByText("Chat-ready", { exact: true }).first()
	).toBeVisible();

	const showTags = page.getByRole("switch", { name: "Show tags" });
	await expect(showTags).toHaveAttribute("aria-checked", "false");
	await showTags.click();
	await expect(
		page.getByText("text-generation", { exact: true }).first()
	).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu.catalog.showTags"))
		)
		.toBe("true");

	await chooseSelectOption(page, 1, "Vision");
	await chooseSelectOption(page, 3, "Newest");
	const addedOnly = page.getByRole("switch", { name: "Added only" });
	await addedOnly.click();
	await expect(addedOnly).toHaveAttribute("aria-checked", "true");
	await expect(page.getByRole("combobox").nth(1)).toBeDisabled();
	await expect
		.poll(() => latestSearch(fixture).get("installed_only"))
		.toBe("true");

	await search.fill("no-such-model-in-local-fixture");
	await expect(
		page.getByText("No models added yet", { exact: true })
	).toBeVisible();
	await expect
		.poll(() => latestSearch(fixture).get("query"))
		.toBe("no-such-model-in-local-fixture");
	await page
		.getByRole("button", { name: "Clear filters", exact: true })
		.click();
	await expect(search).toHaveValue("");
	await expect(page.getByRole("button", { name: /Gemma/ })).toBeVisible();
	await expect.poll(() => latestSearch(fixture).get("format")).toBe("gguf");
	await expect.poll(() => latestSearch(fixture).get("sort")).toBe("trending");
	await expect(latestSearch(fixture).get("installed_only")).toBeNull();
	await expect(latestSearch(fixture).get("task")).toBeNull();

	await page.reload();
	await expect(
		page.getByText("text-generation", { exact: true }).first()
	).toBeVisible();
	await openFilters(page);
	await expect(page.getByRole("switch", { name: "Show tags" })).toHaveAttribute(
		"aria-checked",
		"true"
	);
	await expect(
		page.getByRole("switch", { name: "Friendly names" })
	).toHaveAttribute("aria-checked", "true");
});

test("the Store Installed toolbar button filters Models and restores the full catalog", async ({
	page,
}) => {
	const fixture = await installModelFixture(page);
	await page.goto(`${STORY_URL}?section=models`);
	const installed = page.getByRole("button", {
		name: "Installed",
		exact: true,
	});
	await expect(installed).toHaveAttribute("aria-pressed", "false");
	await expect(page.getByRole("button", { name: /Gated/ })).toBeVisible();
	await installed.click();
	await expect(installed).toHaveAttribute("aria-pressed", "true");
	await expect
		.poll(() => latestSearch(fixture).get("installed_only"))
		.toBe("true");
	await expect(page.getByRole("button", { name: /Gemma/ })).toBeVisible();
	await expect(page.getByRole("button", { name: /Gated/ })).toHaveCount(0);
	await installed.click();
	await expect(installed).toHaveAttribute("aria-pressed", "false");
	await expect
		.poll(() => latestSearch(fixture).get("installed_only"))
		.toBeNull();
	await expect(page.getByRole("button", { name: /Gated/ })).toBeVisible();
});

test("list loading retries, selection works by keyboard, infinite paging and split resize persist", async ({
	page,
}, testInfo) => {
	const fixture = await installModelFixture(page);
	fixture.modelListFailures = 1;
	await page.goto(`${STORY_URL}?section=models`);
	await expect(
		page.getByText("Couldn't load models", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText(/\/api\/models\/catalog\?.*failed: 503/)
	).toBeVisible();
	await page.getByRole("button", { name: "Try again", exact: true }).click();
	await expect(page.getByRole("button", { name: /Gemma/ })).toBeVisible();
	await expect(modelSearchCalls(fixture)).toHaveLength(2);

	const gemma = page.getByRole("button", { name: /Gemma/ });
	await gemma.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("heading", { name: /Gemma/ })).toBeVisible();
	await expect
		.poll(() =>
			fixture.calls.some(
				(call) =>
					call.path === "/api/models/catalog/detail" &&
					new URLSearchParams(call.search).get("id") ===
						"google/gemma-4b-instruct"
			)
		)
		.toBe(true);
	await page.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("models-gemma-detail-rendered.png"),
	});

	const splitter = page.getByRole("separator");
	await expect(splitter).toBeVisible();
	await splitter.focus();
	await page.keyboard.press("ArrowRight");
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu.store.models.split"))
		)
		.toMatch(/"list":\d/);

	fixture.paginationEnabled = true;
	await page.reload();
	const list = page.locator("nav.scroll-fade").last();
	await list.evaluate((element) => element.scrollTo(0, element.scrollHeight));
	await expect
		.poll(() =>
			modelSearchCalls(fixture).some(
				(call) => new URLSearchParams(call.search).get("cursor") === "page-two"
			)
		)
		.toBe(true);
	await expect(
		page.getByRole("button", { name: /Token Catalog/ })
	).toBeVisible();
});

test("model-card and detail tooltips explain context, dates, size, token and addon badges", async ({
	page,
}, testInfo) => {
	// Pin "now" so the fixture's 2026-08-01 last_modified always reads as
	// "2 months ago" instead of drifting with the wall clock.
	await page.clock.setFixedTime(new Date("2026-10-01T00:00:00.000Z"));
	await installModelFixture(page);
	await page.goto(`${STORY_URL}?section=models`);
	const contextBadge = page
		.getByText("32,768 context", { exact: true })
		.first();
	await contextBadge.hover();
	await expect(
		page.getByText("Context window (tokens the model can read + write at once)")
	).toBeVisible();
	const updatedDate = page.getByText("(updated 2 months ago)").first();
	await updatedDate.hover();
	await expect(page.getByText("Updated Aug 1, 2026")).toBeVisible();

	await page.getByRole("button", { name: /Gemma/ }).click();
	await expect(page.getByRole("heading", { name: /Gemma/ })).toBeVisible();
	const sizeBadge = page.getByText("Medium", { exact: true }).last();
	await sizeBadge.hover();
	await expect(page.getByText("4 billion parameters")).toBeVisible();
	const tokenBadge = page.getByRole("button", {
		name: "Chat-ready",
		exact: true,
	});
	await tokenBadge.hover();
	await expect(
		page.getByText("Instruction-tuned — follows chat-style prompts")
	).toBeVisible();
	await page.getByText("Vision adapter", { exact: true }).hover();
	await expect(
		page.getByText(/An image-understanding add-on \(mmproj\)/)
	).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("models-detail-tooltip-content.png"),
	});
});
