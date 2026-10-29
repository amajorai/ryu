import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import type { ReferenceProfile } from "../../../apps-store/video-studio/shared/reference.ts";

const evidenceDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

interface StudioRequest {
	body?: unknown;
	method: string;
	path: string;
}

interface VideoAsset {
	duration: number;
	hasAudio: boolean;
	height: number;
	id: string;
	kind: string;
	name: string;
	width: number;
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

async function seedVideoAsset(page: Page, name: string): Promise<VideoAsset> {
	const fixture = await page.request.get("/__proof/video");
	expect(fixture.ok()).toBe(true);
	const bytes = await fixture.body();
	const start = await page.request.post("/__studio/uploads", {
		data: { name, size: bytes.byteLength },
	});
	expect(start.status()).toBe(201);
	const upload = await start.json();
	for (let offset = 0; offset < bytes.byteLength; offset += upload.chunkSize) {
		const response = await page.request.put(`/__studio/uploads/${upload.id}`, {
			data: {
				offset,
				data: bytes
					.subarray(offset, offset + upload.chunkSize)
					.toString("base64"),
			},
		});
		expect(response.ok()).toBe(true);
	}
	const finish = await page.request.post(
		`/__studio/uploads/${upload.id}/finish`
	);
	expect(finish.status()).toBe(201);
	const asset = await finish.json();
	expect(asset).toMatchObject({ name, kind: "video", hasAudio: true });
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

async function openOverflowTab(page: Page, label: string, value: string) {
	await page.getByRole("button", { name: /Show \d+ more tabs/ }).click();
	await page.getByRole("combobox", { name: "Search tabs" }).fill(label);
	const tab = page.locator(`[data-tabs-menu-key="string:${value}"]`);
	await expect(tab).toBeVisible();
	await tab.click();
}

async function getProject(page: Page, projectId: string) {
	const response = await page.request.get(`/__studio/projects/${projectId}`);
	expect(response.ok()).toBe(true);
	// SAFETY: The successful local GET checked above is forwarded unchanged from store.project(), whose native projectSchema parser owns this Project and its declared fields before JSON serialization. Native brief is a string and referenceProfile uses the optional referenceProfileSchema.
	return (await response.json()) as {
		brief: string;
		referenceProfile?: ReferenceProfile;
	};
}

async function saveScreenshot(page: Page, filename: string) {
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, filename),
	});
}

test("ReferencePanel validates analysis, persists and clears profiles, and copies edited and concept briefs to Plan", async ({
	page,
}) => {
	const requests = recordStudioRequests(page);
	const asset = await seedVideoAsset(
		page,
		`${uniqueTitle("Coverage reference source")}.mp4`
	);
	const title = uniqueTitle("Coverage reference study");
	await createProject(page, title);
	const projectId = await page.getByLabel("Project").inputValue();
	await openOverflowTab(page, "Reference", "reference");

	const source = page.getByLabel("Reference video");
	const build = page.getByRole("button", {
		name: "Build reference profile",
		exact: true,
	});
	await expect(source).toHaveValue("");
	await expect(
		source.locator("option").filter({ hasText: asset.name })
	).toHaveCount(1);
	await expect(build).toBeDisabled();
	await expect(page.getByRole("button", { name: "Clear profile" })).toHaveCount(
		0
	);
	await source.selectOption(asset.id);
	await expect(build).toBeEnabled();
	await build.click();
	await expect(page.getByRole("status")).toContainText(
		"Analyze this source in the Media panel first."
	);
	await expect(build).toBeEnabled();
	await expect(page.getByRole("button", { name: "Clear profile" })).toHaveCount(
		0
	);
	await saveScreenshot(page, "video-studio-reference-analysis-needed.png");

	const analysisStarted = await page.request.post(
		`/__studio/assets/${asset.id}/analyze`
	);
	expect(analysisStarted.status()).toBe(202);
	await expect
		.poll(async () => {
			const response = await page.request.get(
				`/__studio/assets/${asset.id}/analysis`
			);
			const body = await response.json();
			return body.analysis?.status;
		})
		.toBe("completed");
	const analysisResponse = await page.request.get(
		`/__studio/assets/${asset.id}/analysis`
	);
	const analysisBody = await analysisResponse.json();
	expect(analysisBody.analysis.waveform.length).toBeGreaterThan(0);
	const scopeResponse = await page.request.get(
		`/__studio/assets/${asset.id}/scopes?time=0`
	);
	expect(scopeResponse.ok()).toBe(true);
	const scopes = await scopeResponse.json();

	await build.click();
	await expect(page.getByRole("status")).toContainText(
		"Reference profile saved to this project."
	);
	const profileCard = page
		.locator(".studio-scene")
		.filter({ hasText: asset.name });
	await expect(profileCard).toContainText(asset.name);
	await expect(profileCard).toContainText("1 shots");
	await expect(profileCard).toContainText("audio detected");
	const profileBrief = page.getByLabel("Reference brief");
	await expect(profileBrief).toHaveValue(new RegExp(`Use ${asset.name} as`));
	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	const profileSave = requests.find(
		(request) =>
			z
				.object({
					referenceProfile: z.object({ assetId: z.literal(asset.id) }),
				})
				.safeParse(request.body).success
	);
	expect(profileSave).toMatchObject({
		method: "PUT",
		path: `/projects/${projectId}`,
		body: {
			id: projectId,
			referenceProfile: expect.objectContaining({
				assetId: asset.id,
				assetName: asset.name,
			}),
		},
	});
	const clear = page.getByRole("button", {
		name: "Clear profile",
		exact: true,
	});
	await expect(clear).toBeVisible();
	const beforeEdit = await getProject(page, projectId);
	const profile = beforeEdit.referenceProfile;
	expect(profile).toMatchObject({
		assetId: asset.id,
		assetName: asset.name,
		captionCount: 0,
		concepts: expect.arrayContaining([
			expect.objectContaining({ title: "Keep the observed rhythm" }),
			expect.objectContaining({ title: "Build a slower reveal" }),
			expect.objectContaining({ title: "Lead with a fast hook" }),
		]),
		duration: asset.duration,
		shotCount: analysisBody.analysis.sceneCuts.length + 1,
		visualStyle: expect.objectContaining({
			luma: scopes.luma.average,
			saturation: scopes.saturation.average,
		}),
	});
	expect(profile?.audioPeak).toBeGreaterThan(0.01);
	expect(profile?.estimatedCostMicroUsd.total).toBeGreaterThan(0);
	await profileBrief.fill("Adapt the measured cadence to an original subject.");
	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	const editedProfileSave = requests
		.filter(
			(request) =>
				request.method === "PUT" && request.path === `/projects/${projectId}`
		)
		.at(-1);
	expect(editedProfileSave?.body).toMatchObject({
		referenceProfile: expect.objectContaining({
			assetId: asset.id,
			brief: "Adapt the measured cadence to an original subject.",
		}),
	});
	expect((await getProject(page, projectId)).referenceProfile?.brief).toBe(
		"Adapt the measured cadence to an original subject."
	);
	await page.locator(".studio-library").evaluate((element) => {
		element.scrollTop = 0;
	});
	await saveScreenshot(page, "video-studio-reference-profile-persisted.png");

	await page.reload();
	await expect(page.getByRole("status")).toContainText(
		"Project library connected."
	);
	await page.getByLabel("Project").selectOption({ label: title });
	await openOverflowTab(page, "Reference", "reference");
	await expect(page.getByLabel("Reference video")).toHaveValue(asset.id);
	await expect(page.getByLabel("Reference brief")).toHaveValue(
		"Adapt the measured cadence to an original subject."
	);
	await expect(
		page.locator(".studio-scene").filter({ hasText: asset.name })
	).toContainText("1 shots");

	await page.getByRole("button", { name: "Copy brief to Plan" }).click();
	await expect(page.getByRole("status")).toContainText(
		"Reference brief copied to Plan."
	);
	const planBrief = page.getByPlaceholder(
		"What are we making, and who is it for?"
	);
	await expect(planBrief).toHaveValue(
		"Adapt the measured cadence to an original subject."
	);
	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	expect((await getProject(page, projectId)).brief).toBe(
		"Adapt the measured cadence to an original subject."
	);

	await openOverflowTab(page, "Reference", "reference");
	const reloadedProfile = (await getProject(page, projectId)).referenceProfile;
	expect(reloadedProfile?.concepts).toHaveLength(3);
	const concept = reloadedProfile?.concepts.find(
		(item) => item.title === "Build a slower reveal"
	);
	expect(concept).toBeDefined();
	const conceptCard = page
		.locator(".studio-scene")
		.filter({ hasText: "Build a slower reveal" });
	await conceptCard
		.getByRole("button", { name: "Use concept in Plan" })
		.click();
	await expect(page.getByRole("status")).toContainText(
		"Reference brief copied to Plan."
	);
	await expect(planBrief).toHaveValue(concept?.brief ?? "");
	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	expect((await getProject(page, projectId)).brief).toBe(concept?.brief);

	await openOverflowTab(page, "Reference", "reference");
	await page
		.getByRole("button", { name: "Clear profile", exact: true })
		.click();
	await expect(page.getByRole("button", { name: "Clear profile" })).toHaveCount(
		0
	);
	await expect(page.getByLabel("Reference brief")).toHaveCount(0);
	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	const clearedProject = await getProject(page, projectId);
	expect(clearedProject.referenceProfile).toBeUndefined();
	expect(clearedProject.brief).toBe(concept?.brief);
	const clearProfileSave = requests
		.filter(
			(request) =>
				request.method === "PUT" && request.path === `/projects/${projectId}`
		)
		.at(-1);
	expect(
		z.record(z.string(), z.json()).safeParse(clearProfileSave?.body).success
	).toBe(true);
	expect(clearProfileSave?.body).not.toHaveProperty("referenceProfile");
	const assetsResponse = await page.request.get("/__studio/assets");
	const assets = z
		.object({ assets: z.array(z.object({ id: z.string() })) })
		.parse(await assetsResponse.json());
	expect(assets.assets.some((item) => item.id === asset.id)).toBe(true);

	await page.reload();
	await expect(page.getByRole("status")).toContainText(
		"Project library connected."
	);
	await page.getByLabel("Project").selectOption({ label: title });
	await openOverflowTab(page, "Reference", "reference");
	await expect(page.getByLabel("Reference video")).toHaveValue("");
	await expect(
		page.getByRole("button", { name: "Build reference profile" })
	).toBeDisabled();
	await page.getByLabel("Reference video").selectOption(asset.id);
	await expect(
		page.getByRole("button", { name: "Build reference profile" })
	).toBeEnabled();
	await page.locator(".studio-library").evaluate((element) => {
		element.scrollTop = 0;
	});
	await saveScreenshot(
		page,
		"video-studio-reference-profile-cleared-after-reload.png"
	);
});
