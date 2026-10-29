import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ProofJsonRecord } from "./fixture-json.ts";

const evidenceDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

interface StudioRequest {
	body?: unknown;
	method: string;
	path: string;
}

interface SourceAsset {
	duration: number;
	id: string;
	kind: string;
	name: string;
}

interface SearchIndex {
	assetId: string;
	current: boolean;
	entries: Array<{
		docId: string | null;
		key: string;
		ready: boolean;
		source: string;
		title: string;
	}>;
	spaceId: string;
	spaceName: string;
}

interface SpaceProofState {
	calls: Array<{ action: string; input: ProofJsonRecord }>;
	documents: Array<{
		id: string;
		kind: string;
		source: string;
		spaceId: string;
		title: string;
	}>;
	spaces: Array<{ id: string; name: string }>;
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

async function seedVideoAsset(
	page: Page,
	name: string,
	cues: Array<{ end: number; start: number; text: string }>
): Promise<SourceAsset> {
	const fixture = await page.request.get("/__proof/video");
	expect(fixture.ok()).toBe(true);
	const bytes = await fixture.body();
	const start = await page.request.post("/__studio/uploads", {
		data: { name, size: bytes.byteLength },
	});
	expect(start.status()).toBe(201);
	const upload = await start.json();
	for (let offset = 0; offset < bytes.byteLength; offset += upload.chunkSize) {
		const chunk = bytes.subarray(offset, offset + upload.chunkSize);
		const response = await page.request.put(`/__studio/uploads/${upload.id}`, {
			data: {
				offset,
				data: chunk.toString("base64"),
			},
		});
		expect(response.ok()).toBe(true);
	}
	const finished = await page.request.post(
		`/__studio/uploads/${upload.id}/finish`
	);
	expect(finished.status()).toBe(201);
	const asset = await finished.json();
	expect(asset).toMatchObject({ name, kind: "video" });
	const transcript = await page.request.post(
		`/__studio/assets/${asset.id}/import-transcript`,
		{
			data: {
				revision: null,
				cues: cues.map((cue) => ({ ...cue, id: crypto.randomUUID() })),
			},
		}
	);
	expect(transcript.ok()).toBe(true);
	return asset;
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

async function openSearchPanel(page: Page) {
	await page.getByRole("button", { name: /Show \d+ more tabs/ }).click();
	await page
		.getByRole("combobox", { name: "Search tabs" })
		.fill("Find footage");
	const tab = page.locator('[data-tabs-menu-key="string:search"]');
	await expect(tab).toBeVisible();
	await tab.click();
	await expect(
		page.getByRole("heading", { name: "Find footage by meaning" })
	).toBeVisible();
}

async function spaceState(page: Page): Promise<SpaceProofState> {
	const response = await page.request.get("/__proof/state");
	expect(response.ok()).toBe(true);
	return await response.json();
}

async function sidecarIndexes(page: Page): Promise<SearchIndex[]> {
	const response = await page.request.get("/__studio/search-indexes");
	expect(response.ok()).toBe(true);
	const body = await response.json();
	return body.indexes;
}

async function expectIndexedSource(
	page: Page,
	assetId: string,
	spaceName: string
) {
	await expect
		.poll(async () => {
			const index = (await sidecarIndexes(page)).find(
				(value) => value.assetId === assetId
			);
			return Boolean(
				index?.current &&
					index.spaceName === spaceName &&
					index.entries.length > 0 &&
					index.entries.every((entry) => entry.ready && entry.docId)
			);
		})
		.toBe(true);
}

async function saveScreenshot(page: Page, filename: string) {
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, filename),
	});
}

test("Transcript indexing resumes after a failed Space write and rebuild removes the orphan", async ({
	page,
}) => {
	const requests = recordStudioRequests(page);
	const assetName = uniqueTitle("Coverage indexed interview");
	const asset = await seedVideoAsset(page, `${assetName}.mp4`, [
		{ start: 2, end: 5, text: "A cyclist crosses beneath the red bridge." },
		{ start: 40, end: 45, text: "The announcer calls the final lap." },
	]);
	const title = uniqueTitle("Coverage transcript recovery");
	await createProject(page, title);
	await openSearchPanel(page);

	const source = page.getByLabel("Source to index");
	const spaceName = page.getByLabel("Transcript index Space");
	const indexButton = page.getByRole("button", {
		name: "Index transcript",
		exact: true,
	});
	const rebuildButton = page.getByRole("button", {
		name: "Rebuild index",
		exact: true,
	});
	void rebuildButton;
	const searchButton = page.getByRole("button", {
		name: "Search footage",
		exact: true,
	});
	await expect(source).toHaveValue("");
	await expect(
		source.locator("option").filter({ hasText: asset.name })
	).toHaveCount(1);
	await expect(indexButton).toBeDisabled();
	await expect(rebuildButton).toBeDisabled();
	await expect(searchButton).toBeDisabled();
	await source.selectOption(asset.id);
	await expect(indexButton).toBeEnabled();
	await expect(rebuildButton).toBeEnabled();
	await spaceName.fill("   ");
	await expect(indexButton).toBeDisabled();
	await expect(rebuildButton).toBeDisabled();

	const requestedSpaceName = uniqueTitle("Editorial transcript index");
	await spaceName.fill(`  ${requestedSpaceName}  `);
	const failureMessage = "Fixture Space document update failed.";
	const armed = await page.request.post("/__proof/fail-next-update", {
		data: { message: failureMessage },
	});
	expect(armed.ok()).toBe(true);
	await indexButton.click();
	await expect(page.getByRole("status")).toContainText(failureMessage);

	let state = await spaceState(page);
	const pendingDoc = state.documents.find((document) => document.source === "");
	expect(pendingDoc).toMatchObject({
		title: expect.stringContaining(asset.name),
		kind: "app:@ryu/video-studio",
	});
	const failedIndex = (await sidecarIndexes(page)).find(
		(index) => index.assetId === asset.id
	);
	expect(failedIndex).toMatchObject({
		spaceName: requestedSpaceName,
		current: true,
	});
	expect(failedIndex?.entries).toHaveLength(2);
	expect(failedIndex?.entries[0]).toMatchObject({
		docId: pendingDoc?.id,
		ready: false,
	});
	await expect(searchButton).toBeDisabled();

	await rebuildButton.click();
	await expect(page.getByRole("status")).toContainText(
		"Transcript stored in your selected Space."
	);
	const rebuiltIndex = (await sidecarIndexes(page)).find(
		(index) => index.assetId === asset.id
	);
	expect(rebuiltIndex).toMatchObject({
		spaceName: requestedSpaceName,
		current: true,
	});
	expect(rebuiltIndex?.entries).toHaveLength(2);
	expect(
		rebuiltIndex?.entries.every((entry) => entry.ready && entry.docId)
	).toBe(true);
	state = await spaceState(page);
	expect(
		state.documents.some((document) => document.id === pendingDoc?.id)
	).toBe(false);
	expect(
		state.calls.some(
			(call) => call.action === "delete" && call.input.doc_id === pendingDoc?.id
		)
	).toBe(true);
	expect(
		state.documents
			.filter((document) => document.spaceId === rebuiltIndex?.spaceId)
			.map((document) => JSON.parse(document.source))
	).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				assetId: asset.id,
				start: 2,
				end: 5,
				text: "A cyclist crosses beneath the red bridge.",
			}),
			expect.objectContaining({
				assetId: asset.id,
				start: 40,
				end: 45,
				text: "The announcer calls the final lap.",
			}),
		])
	);
	expect(spaceName).toHaveValue(`  ${requestedSpaceName}  `);
	const ensure = state.calls.find(
		(call) => call.action === "ensure" && call.input.name === requestedSpaceName
	);
	expect(ensure?.input).toEqual({
		name: requestedSpaceName,
		description: "Video Studio source transcript index",
	});
	const indexCreates = requests.filter(
		(request) =>
			request.path === `/assets/${asset.id}/index` && request.method === "POST"
	);
	expect(indexCreates).toHaveLength(2);
	expect(indexCreates[0]?.body).toMatchObject({
		spaceName: requestedSpaceName,
		rebuild: false,
	});
	expect(indexCreates[1]?.body).toMatchObject({
		spaceName: requestedSpaceName,
		rebuild: true,
	});
	const searchSpace = page.getByLabel("Footage search Space");
	const completedSpaceId = rebuiltIndex?.spaceId ?? "";
	await expect(searchSpace).toHaveValue(completedSpaceId);
	await expect(searchButton).toBeDisabled();
	await page.locator(".studio-library").evaluate((element) => {
		element.scrollTop = 0;
	});
	await saveScreenshot(page, "video-studio-search-index-rebuild.png");
});

test("Meaning search filters by Space, handles no matches and retry, then adds a persistent source range", async ({
	page,
}) => {
	const requests = recordStudioRequests(page);
	const suffix = crypto.randomUUID().slice(0, 8);
	const firstAsset = await seedVideoAsset(
		page,
		`Coverage bridge rehearsal ${suffix}.mp4`,
		[
			{
				start: 2,
				end: 5,
				text: "Two performers rehearse beneath the red bridge.",
			},
			{ start: 40, end: 45, text: "The announcer calls the final lap." },
		]
	);
	const secondAsset = await seedVideoAsset(
		page,
		`Coverage lighthouse dawn ${suffix}.mp4`,
		[
			{
				start: 10,
				end: 14,
				text: "A keeper raises a lantern in the old lighthouse just before dawn.",
			},
			{
				start: 48,
				end: 52,
				text: "A boat follows a bright channel toward the harbor.",
			},
		]
	);
	const title = uniqueTitle("Coverage meaning search edit");
	await createProject(page, title);
	const projectId = await page.getByLabel("Project").inputValue();
	await openSearchPanel(page);
	const source = page.getByLabel("Source to index");
	const spaceName = page.getByLabel("Transcript index Space");
	const indexButton = page.getByRole("button", {
		name: "Index transcript",
		exact: true,
	});
	page.getByRole("button", {
		name: "Rebuild index",
		exact: true,
	});
	const firstSpaceName = `Bridge archive ${suffix}`;
	const secondSpaceName = `Lighthouse archive ${suffix}`;
	await source.selectOption(firstAsset.id);
	await spaceName.fill(firstSpaceName);
	await indexButton.click();
	await expect(page.getByRole("status")).toContainText(
		"Transcript stored in your selected Space."
	);
	await expectIndexedSource(page, firstAsset.id, firstSpaceName);
	await source.selectOption(secondAsset.id);
	await spaceName.fill(secondSpaceName);
	await indexButton.click();
	await expectIndexedSource(page, secondAsset.id, secondSpaceName);

	const indexes = await sidecarIndexes(page);
	const firstIndex = indexes.find((index) => index.assetId === firstAsset.id);
	const secondIndex = indexes.find((index) => index.assetId === secondAsset.id);
	expect(firstIndex).toBeDefined();
	expect(secondIndex).toBeDefined();
	expect(firstIndex?.entries.every((entry) => entry.ready)).toBe(true);
	expect(secondIndex?.entries.every((entry) => entry.ready)).toBe(true);
	expect(firstIndex?.spaceName).toBe(firstSpaceName);
	expect(secondIndex?.spaceName).toBe(secondSpaceName);

	const searchSpace = page.getByLabel("Footage search Space");
	const query = page.getByLabel("Footage meaning query");
	const searchButton = page.getByRole("button", {
		name: "Search footage",
		exact: true,
	});
	await searchSpace.selectOption(firstIndex?.spaceId ?? "");
	await expect(searchSpace).toHaveValue(firstIndex?.spaceId ?? "");
	await searchSpace.selectOption(secondIndex?.spaceId ?? "");
	await query.fill("  lighthouse dawn  ");
	await expect(searchButton).toBeEnabled();
	await searchButton.click();
	await expect(page.getByRole("status")).toHaveText("1 source range found.");
	let result = page
		.locator(".studio-scene")
		.filter({ hasText: secondAsset.name });
	await expect(result).toContainText("10.0–14.0s");
	await expect(result).toContainText(
		"A keeper raises a lantern in the old lighthouse just before dawn."
	);
	const state = await spaceState(page);
	const searchCalls = state.calls.filter((call) => call.action === "search");
	expect(searchCalls.at(-1)?.input).toEqual({
		space_id: secondIndex?.spaceId,
		query: "lighthouse dawn",
		limit: 30,
	});

	await searchSpace.selectOption(firstIndex?.spaceId ?? "");
	await searchButton.click();
	await expect(page.getByRole("status")).toContainText(
		"No current indexed ranges matched."
	);
	await expect(
		page.locator(".studio-scene").filter({ hasText: secondAsset.name })
	).toHaveCount(0);
	await searchSpace.selectOption(secondIndex?.spaceId ?? "");
	await query.fill("purple elephants");
	await searchButton.click();
	await expect(page.getByRole("status")).toContainText(
		"No current indexed ranges matched."
	);
	await expect(
		page.locator(".studio-scene").filter({ hasText: secondAsset.name })
	).toHaveCount(0);

	await query.fill("lighthouse dawn");
	const searchFailure = "Fixture semantic search is temporarily unavailable.";
	const armed = await page.request.post("/__proof/fail-next-search", {
		data: { message: searchFailure },
	});
	expect(armed.ok()).toBe(true);
	await searchButton.click();
	await expect(page.getByRole("status")).toContainText(searchFailure);
	await expect(query).toHaveValue("lighthouse dawn");
	await expect(
		page.locator(".studio-scene").filter({ hasText: secondAsset.name })
	).toHaveCount(0);
	await expect(searchButton).toBeEnabled();
	await searchButton.click();
	await expect(page.getByRole("status")).toHaveText("1 source range found.");
	await expect(query).toHaveValue("lighthouse dawn");
	result = page.locator(".studio-scene").filter({ hasText: secondAsset.name });
	await expect(result).toContainText("10.0–14.0s");
	await saveScreenshot(page, "video-studio-search-meaning-result.png");

	await result.getByRole("button", { name: "Add source range" }).click();
	const clipName = `Select ${secondAsset.name} at 0.00 seconds`;
	await expect(page.getByRole("button", { name: clipName })).toBeVisible();
	const saveButton = page.getByRole("button", {
		name: "Save changes",
		exact: true,
	});
	await expect(saveButton).toBeEnabled();
	await saveButton.click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	const saved = [...requests]
		.reverse()
		.find(
			(request) =>
				request.path === `/projects/${projectId}` && request.method === "PUT"
		);
	expect(saved?.body).toMatchObject({
		id: projectId,
		segments: [
			expect.objectContaining({
				assetId: secondAsset.id,
				start: 0,
				sourceIn: 10,
				sourceOut: 14,
			}),
		],
	});
	await page.reload();
	await expect(page.getByRole("status")).toContainText(
		"Project library connected."
	);
	await page.getByLabel("Project").selectOption({ label: title });
	await expect(page.getByRole("button", { name: clipName })).toBeVisible();
	const reloaded = await page.request.get(`/__studio/projects/${projectId}`);
	expect(reloaded.ok()).toBe(true);
	const project = await reloaded.json();
	expect(project.segments).toEqual([
		expect.objectContaining({
			assetId: secondAsset.id,
			sourceIn: 10,
			sourceOut: 14,
		}),
	]);
	await saveScreenshot(page, "video-studio-search-range-after-reload.png");
	await openSearchPanel(page);
	await page
		.getByLabel("Footage search Space")
		.selectOption(secondIndex?.spaceId ?? "");
	await page.getByLabel("Footage meaning query").fill("lighthouse dawn");
	await page
		.getByRole("button", { name: "Search footage", exact: true })
		.click();
	await expect(page.getByRole("status")).toHaveText("1 source range found.");
	await expect(
		page.locator(".studio-scene").filter({ hasText: secondAsset.name })
	).toContainText("10.0–14.0s");
});
