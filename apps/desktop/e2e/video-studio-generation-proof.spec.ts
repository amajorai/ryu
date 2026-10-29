import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import {
	capturedJsonArray,
	capturedJsonField,
} from "./captured-json-observations.ts";

const evidenceDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

interface StudioRequest {
	body?: unknown;
	method: string;
	path: string;
}

interface MediaCall {
	input: {
		prompt?: string;
		provider?: string;
		model?: string;
		count?: number;
		request_id: string;
		project_id: string;
		text?: string;
		speed?: number;
		voice?: string;
		language?: string;
	};
	kind: string;
}

function uniqueTitle(prefix: string) {
	return `${prefix} ${new Date().toISOString().replaceAll(":", "-")} ${crypto.randomUUID().slice(0, 8)}`;
}

function recordStudioRequests(page: Page) {
	const requests: StudioRequest[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (!url.pathname.startsWith("/__studio/")) {
			return;
		}
		const body = request.postData();
		let parsedBody: unknown;
		if (body) {
			try {
				parsedBody = JSON.parse(body);
			} catch {
				parsedBody = body;
			}
		}
		requests.push({
			...(parsedBody === undefined ? undefined : { body: parsedBody }),
			method: request.method(),
			path: url.pathname.slice("/__studio".length),
		});
	});
	return requests;
}

async function createProject(page: Page, title: string) {
	await page.goto("/");
	await expect(page.getByRole("status")).toContainText(
		"Project library connected."
	);
	await page.getByRole("button", { name: "New project" }).click();
	await expect(page.getByRole("status")).toContainText("Project created.");
	const titleField = page
		.locator(".studio-inspector .ryu-app-field")
		.first()
		.locator("input");
	await titleField.fill(title);
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
}

async function openGenerationPanel(page: Page) {
	await page.getByRole("button", { name: /Show \d+ more tabs/ }).click();
	await page.getByRole("combobox", { name: "Search tabs" }).fill("Generate");
	const tab = page.locator('[data-tabs-menu-key="string:generate"]');
	await expect(tab).toBeVisible();
	await tab.click();
	await expect(
		page.getByRole("heading", { name: "Generate with Ryu" })
	).toBeVisible();
}

function appField(page: Page, label: string) {
	return page
		.locator(".ryu-app-field")
		.filter({ hasText: label })
		.locator("input, textarea")
		.first();
}

async function saveScreenshot(page: Page, filename: string) {
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, filename),
	});
}

async function generationCalls(page: Page): Promise<MediaCall[]> {
	const response = await page.request.get("/__proof/state");
	expect(response.ok()).toBe(true);
	const state = z
		.object({
			calls: z.array(
				z.object({
					kind: z.string(),
					input: z.object({
						prompt: z.string().optional(),
						provider: z.string().optional(),
						model: z.string().optional(),
						count: z.number().optional(),
						request_id: z.string(),
						project_id: z.string(),
						text: z.string().optional(),
						speed: z.number().optional(),
						voice: z.string().optional(),
						language: z.string().optional(),
					}),
				})
			),
		})
		.parse(await response.json());
	return state.calls;
}

async function resetMediaFixture(page: Page) {
	const response = await page.request.post("/__proof/reset");
	expect(response.ok()).toBe(true);
}

test("Generation saves exact image settings and its sidecar asset survives reload", async ({
	page,
}) => {
	await resetMediaFixture(page);
	const requests = recordStudioRequests(page);
	const title = uniqueTitle("Coverage generated image");
	await createProject(page, title);
	const projectId = await page.getByLabel("Project").inputValue();
	await openGenerationPanel(page);

	const generate = page.getByRole("button", {
		name: "Generate media",
		exact: true,
	});
	await expect(generate).toBeDisabled();
	await page
		.getByPlaceholder("Describe the scene, subject, and motion…")
		.fill("  Frosted glass greenhouse at sunrise  ");
	await appField(page, "Provider (optional)").fill(
		"  fixture-image-provider  "
	);
	await appField(page, "Model (optional)").fill("  fixture-image-model  ");
	await page.getByLabel("Generation execution route").selectOption("byok");
	await page
		.getByLabel("Generation decision note")
		.fill("  Approved campaign hero for the opening scene.  ");
	await expect(generate).toBeEnabled();
	await page.locator(".studio-library").evaluate((element) => {
		element.scrollTop = 0;
	});
	await saveScreenshot(page, "video-studio-generation-image-settings.png");
	await generate.click();
	await expect(page.getByRole("status")).toContainText(
		"Generated media saved to your library."
	);

	const post = requests.find(
		(request) => request.path === "/generations" && request.method === "POST"
	);
	expect(post?.body).toMatchObject({
		projectId,
		kind: "image",
		prompt: "Frosted glass greenhouse at sunrise",
		provider: "fixture-image-provider",
		model: "fixture-image-model",
		voice: "",
		language: "",
		speed: 1,
		route: "byok",
		rationale: "Approved campaign hero for the opening scene.",
	});
	const jobId = capturedJsonField(post?.body, "id");
	expect(jobId).toMatch(/^[0-9a-f-]{36}$/i);
	const imageCalls = await generationCalls(page);
	expect(imageCalls).toHaveLength(1);
	expect(imageCalls[0]).toEqual({
		kind: "image",
		input: {
			prompt: "Frosted glass greenhouse at sunrise",
			provider: "fixture-image-provider",
			model: "fixture-image-model",
			count: 1,
			request_id: jobId,
			project_id: projectId,
		},
	});
	const completed = requests.find(
		(request) =>
			request.path === `/generations/${jobId}` && request.method === "PUT"
	);
	expect(completed?.body).toMatchObject({
		status: "completed",
		message: "",
	});
	const assetId = capturedJsonArray(
		capturedJsonField(completed?.body, "assetIds")
	)[0];
	expect(assetId).toMatch(/^[0-9a-f-]{36}$/i);
	const initialEntry = page
		.locator("details.studio-scene")
		.filter({ hasText: "Frosted glass greenhouse at sunrise" });
	await expect(initialEntry).toContainText("Image · Saved");
	await initialEntry.locator("summary").click();
	await expect(initialEntry).toContainText(
		"Requested provider: fixture-image-provider. Model: fixture-image-model."
	);
	await expect(initialEntry).toContainText("Requested route: byok.");
	await expect(initialEntry).toContainText(
		"Decision note: Approved campaign hero for the opening scene."
	);
	await expect(initialEntry).toContainText(
		"Saved media: Generated image — Frosted glass greenhouse at sunrise.png"
	);
	const defaultPrompt = "Quiet harbor under a pale dawn";
	await page
		.getByLabel("Generation execution route")
		.selectOption("node-default");
	await page
		.getByPlaceholder("Describe the scene, subject, and motion…")
		.fill(defaultPrompt);
	await generate.click();
	await expect(page.getByRole("status")).toContainText(
		"Generated media saved to your library."
	);
	// SAFETY: GenerationPanel publishes the native string route in every controlled /generations POST; the actual bridge JSON.stringify and local request recorder preserve that field after this path/method filter.
	const defaultPost = requests.find(
		(request) =>
			request.path === "/generations" &&
			request.method === "POST" &&
			(request.body as { route?: string }).route === "node-default"
	);
	expect(defaultPost?.body).toMatchObject({
		projectId,
		kind: "image",
		prompt: defaultPrompt,
		provider: "fixture-image-provider",
		model: "fixture-image-model",
		route: "node-default",
	});
	const defaultId = capturedJsonField(defaultPost?.body, "id");
	expect((await generationCalls(page))[1]).toEqual({
		kind: "image",
		input: {
			prompt: defaultPrompt,
			provider: "fixture-image-provider",
			model: "fixture-image-model",
			count: 1,
			request_id: defaultId,
			project_id: projectId,
		},
	});
	const defaultEntry = page
		.locator("details.studio-scene")
		.filter({ hasText: defaultPrompt });
	await expect(defaultEntry).toContainText("Image · Saved");
	await defaultEntry.locator("summary").click();
	await expect(defaultEntry).toContainText("Requested route: node-default.");
	await expect(defaultEntry).toContainText(
		`Saved media: Generated image — ${defaultPrompt}.png`
	);
	await page.locator(".studio-library").evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	await saveScreenshot(page, "video-studio-generation-image-persisted.png");

	await page.reload();
	await expect(page.getByRole("status")).toContainText(
		"Project library connected."
	);
	await page.getByLabel("Project").selectOption({ label: title });
	await openGenerationPanel(page);
	const reloadedEntry = page
		.locator("details.studio-scene")
		.filter({ hasText: "Frosted glass greenhouse at sunrise" });
	await expect(reloadedEntry).toContainText("Image · Saved");
	await reloadedEntry.locator("summary").click();
	await expect(reloadedEntry).toContainText(
		"Saved media: Generated image — Frosted glass greenhouse at sunrise.png"
	);
	await expect(reloadedEntry).toContainText("Requested route: byok.");
	const defaultReloaded = page
		.locator("details.studio-scene")
		.filter({ hasText: defaultPrompt });
	await expect(defaultReloaded).toContainText("Image · Saved");
	await defaultReloaded.locator("summary").click();
	await expect(defaultReloaded).toContainText("Requested route: node-default.");
	await page.locator(".studio-library").evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	await saveScreenshot(page, "video-studio-generation-image-after-reload.png");
});

test("Narration settings are recorded, fixture failure stays reviewable, and retry saves WAV output", async ({
	page,
}) => {
	await resetMediaFixture(page);
	const requests = recordStudioRequests(page);
	const title = uniqueTitle("Coverage narration retry");
	await createProject(page, title);
	const projectId = await page.getByLabel("Project").inputValue();
	await openGenerationPanel(page);
	await page.getByLabel("Generation type").selectOption("audio");
	await expect(page.getByPlaceholder("Words for your narrator…")).toBeVisible();
	await page
		.getByPlaceholder("Words for your narrator…")
		.fill("  The morning train is now boarding at platform four.  ");
	await page.getByLabel("Narration voice").fill("  AveryTest  ");
	await page.getByLabel("Narration language").fill("  fr-CA  ");
	await page.getByLabel("Narration speaking rate").fill("1.25");
	await page.getByLabel("Generation execution route").selectOption("managed");
	await page
		.getByLabel("Generation decision note")
		.fill("Platform announcement, neutral delivery.");
	const generate = page.getByRole("button", {
		name: "Generate media",
		exact: true,
	});
	const speakingRate = page.getByLabel("Narration speaking rate");
	await expect(speakingRate).toHaveAttribute("min", "0.5");
	await expect(speakingRate).toHaveAttribute("max", "2");
	await page.locator(".studio-library").evaluate((element) => {
		element.scrollTop = 0;
	});
	await saveScreenshot(page, "video-studio-generation-narration-settings.png");

	for (const invalidRate of ["0.4", "2.5"]) {
		await speakingRate.fill(invalidRate);
		await generate.click();
		await expect(page.getByRole("status")).toContainText(
			"The request does not match the Video Studio contract."
		);
		// SAFETY: These controlled audio submissions use authored finite rates 0.4/2.5 through GenerationPanel Number(input.value); its real request serializer publishes numeric speed even when the server rejects the range.
		const rejectedRate = requests.find(
			(request) =>
				request.path === "/generations" &&
				request.method === "POST" &&
				(request.body as { speed?: number }).speed === Number(invalidRate)
		);
		expect(rejectedRate?.body).toMatchObject({
			kind: "audio",
			speed: Number(invalidRate),
		});
		expect(await generationCalls(page)).toHaveLength(0);
		await expect(
			page.getByText("No generation requests recorded for this project.")
		).toBeVisible();
		await expect(generate).toBeEnabled();
	}

	await speakingRate.fill("1.25");
	const failureMessage = "Fixture narration generation failed.";
	const armed = await page.request.post("/__proof/fail-next", {
		data: { kind: "audio", message: failureMessage },
	});
	expect(armed.ok()).toBe(true);
	await generate.click();
	await expect(page.getByRole("status")).toContainText(failureMessage);
	// SAFETY: This controlled audio submission publishes the authored finite rate 1.25 from GenerationPanel through the actual bridge JSON serializer and request recorder; the preceding filter selects that POST.
	const failedPost = requests.find(
		(request) =>
			request.path === "/generations" &&
			request.method === "POST" &&
			(request.body as { speed?: number }).speed === 1.25
	);
	expect(failedPost?.body).toMatchObject({
		projectId,
		kind: "audio",
		prompt: "The morning train is now boarding at platform four.",
		provider: "",
		model: "",
		voice: "AveryTest",
		language: "fr-CA",
		speed: 1.25,
		route: "managed",
		rationale: "Platform announcement, neutral delivery.",
	});
	const failedId = capturedJsonField(failedPost?.body, "id");
	const failedOutcome = requests.find(
		(request) =>
			request.path === `/generations/${failedId}` && request.method === "PUT"
	);
	expect(failedOutcome?.body).toEqual({
		status: "incomplete",
		assetIds: [],
		message: failureMessage,
	});
	const failedEntry = page
		.locator("details.studio-scene")
		.filter({ hasText: failureMessage });
	await expect(failedEntry).toContainText("Narration · Needs review");
	await failedEntry.locator("summary").click();
	await expect(failedEntry).toContainText(
		"Voice: AveryTest · Language: fr-CA · Rate: 1.25×"
	);
	await expect(generate).toBeEnabled();

	await generate.click();
	await expect(page.getByRole("status")).toContainText(
		"Generated media saved to your library."
	);
	// SAFETY: The controlled retry republishes GenerationPanel numeric speed 1.25 through the unchanged native JSON request path; this filter observes only those authored /generations POST bodies.
	const generationPosts = requests.filter(
		(request) =>
			request.path === "/generations" &&
			request.method === "POST" &&
			(request.body as { speed?: number }).speed === 1.25
	);
	expect(generationPosts).toHaveLength(2);
	const retriedId = capturedJsonField(generationPosts[1]?.body, "id");
	expect(retriedId).not.toBe(failedId);
	expect(generationPosts[1]?.body).toMatchObject({
		projectId,
		kind: "audio",
		prompt: "The morning train is now boarding at platform four.",
		voice: "AveryTest",
		language: "fr-CA",
		speed: 1.25,
		route: "managed",
		rationale: "Platform announcement, neutral delivery.",
	});
	const mediaCalls = await generationCalls(page);
	expect(mediaCalls).toEqual([
		{
			kind: "audio",
			input: {
				text: "The morning train is now boarding at platform four.",
				request_id: failedId,
				project_id: projectId,
				speed: 1.25,
				voice: "AveryTest",
				language: "fr-CA",
			},
		},
		{
			kind: "audio",
			input: {
				text: "The morning train is now boarding at platform four.",
				request_id: retriedId,
				project_id: projectId,
				speed: 1.25,
				voice: "AveryTest",
				language: "fr-CA",
			},
		},
	]);
	const completedOutcome = requests.find(
		(request) =>
			request.path === `/generations/${retriedId}` && request.method === "PUT"
	);
	expect(completedOutcome?.body).toMatchObject({ status: "completed" });
	const narrationEntries = page
		.locator("details.studio-scene")
		.filter({ hasText: "The morning train is now boarding at platform four." });
	await expect(narrationEntries).toHaveCount(2);
	const savedEntry = narrationEntries.filter({ hasText: "Narration · Saved" });
	await expect(savedEntry).toContainText(
		"Saved media: Generated audio — The morning train is now boarding at platform four..wav"
	);
	await page.locator(".studio-library").evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	await saveScreenshot(page, "video-studio-generation-narration-retry.png");

	await page.reload();
	await expect(page.getByRole("status")).toContainText(
		"Project library connected."
	);
	await page.getByLabel("Project").selectOption({ label: title });
	await openGenerationPanel(page);
	const reloadedFailed = page
		.locator("details.studio-scene")
		.filter({ hasText: failureMessage });
	const reloadedSaved = page.locator("details.studio-scene").filter({
		hasText: "The morning train is now boarding at platform four..wav",
	});
	await expect(reloadedFailed).toContainText("Narration · Needs review");
	await expect(reloadedSaved).toContainText("Narration · Saved");
	await reloadedFailed.locator("summary").click();
	await expect(reloadedFailed).toContainText(failureMessage);
	await reloadedSaved.locator("summary").click();
	await expect(reloadedSaved).toContainText("Rate: 1.25×");
	await page.locator(".studio-library").evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	await saveScreenshot(
		page,
		"video-studio-generation-narration-after-reload.png"
	);
});

test("Video generation sends selected settings and persists the imported MP4 fixture", async ({
	page,
}) => {
	await resetMediaFixture(page);
	const requests = recordStudioRequests(page);
	const title = uniqueTitle("Coverage generated video");
	await createProject(page, title);
	const projectId = await page.getByLabel("Project").inputValue();
	await openGenerationPanel(page);
	await page.getByLabel("Generation type").selectOption("video");
	await page
		.getByPlaceholder("Describe the scene, subject, and motion…")
		.fill("Rain moves over a harbor at blue hour");
	await appField(page, "Provider (optional)").fill("fixture-video-provider");
	await appField(page, "Model (optional)").fill("fixture-video-model");
	await page.getByLabel("Generation execution route").selectOption("local");
	await page
		.getByLabel("Generation decision note")
		.fill("One-second local fixture, no provider invocation.");
	await page.locator(".studio-library").evaluate((element) => {
		element.scrollTop = 0;
	});
	await saveScreenshot(page, "video-studio-generation-video-settings.png");
	await page
		.getByRole("button", { name: "Generate media", exact: true })
		.click();
	await expect(page.getByRole("status")).toContainText(
		"Generated media saved to your library."
	);

	const created = requests.find(
		(request) => request.path === "/generations" && request.method === "POST"
	);
	expect(created?.body).toMatchObject({
		projectId,
		kind: "video",
		prompt: "Rain moves over a harbor at blue hour",
		provider: "fixture-video-provider",
		model: "fixture-video-model",
		route: "local",
		rationale: "One-second local fixture, no provider invocation.",
	});
	const jobId = capturedJsonField(created?.body, "id");
	expect(await generationCalls(page)).toEqual([
		{
			kind: "video",
			input: {
				prompt: "Rain moves over a harbor at blue hour",
				provider: "fixture-video-provider",
				model: "fixture-video-model",
				request_id: jobId,
				project_id: projectId,
			},
		},
	]);
	const completed = requests.find(
		(request) =>
			request.path === `/generations/${jobId}` && request.method === "PUT"
	);
	expect(completed?.body).toMatchObject({ status: "completed" });
	expect(
		capturedJsonArray(capturedJsonField(completed?.body, "assetIds"))
	).toHaveLength(1);
	const savedEntry = page
		.locator("details.studio-scene")
		.filter({ hasText: "Rain moves over a harbor at blue hour" });
	await expect(savedEntry).toContainText("Video · Saved");
	await savedEntry.locator("summary").click();
	await expect(savedEntry).toContainText(
		"Saved media: Generated video — Rain moves over a harbor at blue hour.mp4"
	);
	await page.reload();
	await expect(page.getByRole("status")).toContainText(
		"Project library connected."
	);
	await page.getByLabel("Project").selectOption({ label: title });
	await openGenerationPanel(page);
	const reloaded = page
		.locator("details.studio-scene")
		.filter({ hasText: "Rain moves over a harbor at blue hour" });
	await expect(reloaded).toContainText("Video · Saved");
	await reloaded.locator("summary").click();
	await expect(reloaded).toContainText(
		"Saved media: Generated video — Rain moves over a harbor at blue hour.mp4"
	);
	await page.locator(".studio-library").evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	await saveScreenshot(page, "video-studio-generation-video-after-reload.png");
});
