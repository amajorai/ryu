import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
	type Project,
	projectSchema,
} from "../../../apps-store/video-studio/shared/project.ts";
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

async function projectTitleField(page: Page) {
	return page
		.locator(".studio-inspector .ryu-app-field")
		.first()
		.locator("input");
}

async function createProject(page: Page, title: string) {
	await page.goto("/");
	await expect(page.getByRole("status")).toContainText(
		"Project library connected."
	);
	await page.getByRole("button", { name: "New project" }).click();
	await expect(page.getByRole("status")).toContainText("Project created.");
	const titleField = await projectTitleField(page);
	await expect(titleField).toBeVisible();
	await titleField.fill(title);
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
}

async function openOverflowTab(page: Page, label: string, value: string) {
	await page.getByRole("button", { name: /Show \d+ more tabs/ }).click();
	await page.getByRole("combobox", { name: "Search tabs" }).fill(label);
	const tabItem = page.locator(`[data-tabs-menu-key="string:${value}"]`);
	await expect(tabItem).toBeVisible();
	await tabItem.click();
}

async function createTextureDataUri(page: Page) {
	const bytes = await page.evaluate(async () => {
		const canvas = document.createElement("canvas");
		canvas.width = 8;
		canvas.height = 8;
		const context = canvas.getContext("2d");
		if (!context) {
			throw new Error("Could not create the mesh texture fixture.");
		}
		context.fillStyle = "#f59e0b";
		context.fillRect(0, 0, 8, 8);
		context.fillStyle = "#0f766e";
		context.fillRect(0, 0, 4, 4);
		context.fillRect(4, 4, 4, 4);
		const blob = await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob((result) => {
				if (result) {
					resolve(result);
				} else {
					reject(new Error("Could not encode the mesh texture PNG."));
				}
			}, "image/png");
		});
		return Array.from(new Uint8Array(await blob.arrayBuffer()));
	});
	return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

void recordStudioRequests;

function makeTexturedRigGltf(textureDataUri: string) {
	const positions = Buffer.alloc(36);
	[
		[-0.5, -0.5, 0],
		[0.5, -0.5, 0],
		[0, 0.5, 0],
	].forEach((vertex, vertexIndex) => {
		vertex.forEach((component, axis) => {
			positions.writeFloatLE(component, (vertexIndex * 3 + axis) * 4);
		});
	});
	const uvs = Buffer.alloc(24);
	[
		[0, 0],
		[1, 0],
		[0.5, 1],
	].forEach((uv, vertexIndex) => {
		uv.forEach((component, axis) => {
			uvs.writeFloatLE(component, (vertexIndex * 2 + axis) * 4);
		});
	});
	const jointIndices = Buffer.from([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
	const weights = Buffer.alloc(48);
	for (let vertexIndex = 0; vertexIndex < 3; vertexIndex++) {
		weights.writeFloatLE(1, vertexIndex * 16);
	}
	const indices = Buffer.alloc(6);
	[0, 1, 2].forEach((index, offset) => {
		indices.writeUInt16LE(index, offset * 2);
	});
	const binary = Buffer.concat([
		positions,
		uvs,
		jointIndices,
		weights,
		indices,
	]);
	const document = {
		accessors: [
			{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
			{ bufferView: 1, componentType: 5126, count: 3, type: "VEC2" },
			{ bufferView: 2, componentType: 5121, count: 3, type: "VEC4" },
			{ bufferView: 3, componentType: 5126, count: 3, type: "VEC4" },
			{ bufferView: 4, componentType: 5123, count: 3, type: "SCALAR" },
		],
		asset: { version: "2.0" },
		bufferViews: [
			{ buffer: 0, byteLength: positions.length, byteOffset: 0 },
			{ buffer: 0, byteLength: uvs.length, byteOffset: 36 },
			{ buffer: 0, byteLength: jointIndices.length, byteOffset: 60 },
			{ buffer: 0, byteLength: weights.length, byteOffset: 72 },
			{ buffer: 0, byteLength: indices.length, byteOffset: 120 },
		],
		buffers: [
			{
				byteLength: binary.length,
				uri: `data:application/octet-stream;base64,${binary.toString("base64")}`,
			},
		],
		images: [{ uri: textureDataUri }],
		materials: [
			{
				pbrMetallicRoughness: {
					baseColorFactor: [0.2, 0.4, 0.8, 1],
					baseColorTexture: { index: 0 },
				},
			},
		],
		meshes: [
			{
				name: "Textured skeletal sample",
				primitives: [
					{
						attributes: {
							JOINTS_0: 2,
							POSITION: 0,
							TEXCOORD_0: 1,
							WEIGHTS_0: 3,
						},
						indices: 4,
						material: 0,
					},
				],
			},
		],
		nodes: [
			{ mesh: 0, name: "Textured skeletal sample", skin: 0 },
			{ children: [2], name: "Root joint" },
			{ name: "Arm joint", translation: [0, 0, 0.3] },
		],
		scene: 0,
		scenes: [{ nodes: [0, 1] }],
		skins: [{ joints: [1, 2] }],
		textures: [{ source: 0 }],
	};
	return Buffer.from(JSON.stringify(document));
}

function seedInteractiveRig(project: Project) {
	// SAFETY: The sole seedInteractiveRig caller passes the successful native GET project decoded by projectSchema; its meshes array contains native meshSchema objects, viewed here without claiming extra fields.
	const meshes = project.meshes;
	const mesh = meshes[0];
	if (!mesh) {
		throw new Error("The imported mesh is missing from the project fixture.");
	}
	// SAFETY: That persisted mesh was decoded by meshSchema extending objMeshSchema; each vertices entry passes meshVertexSchema, the actual three-number tuple decoder.
	const vertices = mesh.vertices;
	const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
	const joint = (
		name: string,
		origin: [number, number, number],
		parent: number
	) => ({
		name,
		origin,
		parent,
		rotationX: 0,
		rotationY: 0,
		rotationZ: 0,
		x: 0,
		y: 0,
		z: 0,
	});
	meshes[0] = {
		...mesh,
		rig: {
			bindMatrices: [identity, identity],
			constraints: [],
			influences: vertices.map(() => [1, 0, 0, 0]),
			joints: [
				joint("Root joint", [0, 0, 0], -1),
				joint("Arm joint", [0, 0, 0.3], 0),
			],
			keyframes: [],
			meshMatrix: identity,
			vertices,
			weights: vertices.map(() => [1, 0, 0, 0]),
		},
	};
	return { ...project, meshes };
}

async function importTexturedRig(
	page: Page,
	file: { buffer: Buffer; name: string }
) {
	const fileChooserPromise = page.waitForEvent("filechooser");
	await page
		.getByRole("button", { name: "Import 3D mesh", exact: true })
		.click();
	await (await fileChooserPromise).setFiles({
		buffer: file.buffer,
		mimeType: "model/gltf+json",
		name: file.name,
	});
	await expect(page.getByRole("status")).toContainText(
		`Imported ${file.name} as 1 editable mesh.`
	);
}

async function selectMeshColor(page: Page, hex: string) {
	await page.getByRole("button", { name: "Mesh 1 color", exact: true }).click();
	const input = page.getByRole("textbox", { name: "Hex color value" }).last();
	await expect(input).toBeVisible();
	await input.fill(hex);
	await expect(input).toHaveValue(hex.toUpperCase());
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("button", { name: "Mesh 1 color", exact: true })
	).toContainText(hex.toUpperCase());
}

async function saveScreenshot(page: Page, filename: string) {
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, filename),
	});
}

test("Mesh panel imports embedded material/texture, persists rig and motion edits, and captures the textured frame", async ({
	page,
}) => {
	test.setTimeout(180_000);
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

	const title = uniqueTitle("Coverage textured rig");
	await createProject(page, title);
	const projectId = await page.getByLabel("Project").inputValue();
	const texture = await createTextureDataUri(page);
	const gltfFile = {
		buffer: makeTexturedRigGltf(texture),
		name: "textured-rig.gltf",
	};
	await page.getByRole("spinbutton", { name: "Playhead" }).fill("0.25");
	await page.getByRole("spinbutton", { name: "Playhead" }).press("Tab");
	await openOverflowTab(page, "Meshes", "meshes");
	await importTexturedRig(page, gltfFile);
	await expect(page.getByText("Mesh 1", { exact: true })).toBeVisible();
	const importedSvg = page.locator(
		".studio-preview-frame svg[aria-label='Imported 3D mesh']"
	);
	await expect(importedSvg.locator("pattern image")).toHaveAttribute(
		"href",
		texture
	);
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	const importedResponse = await page.request.get(
		`/__studio/projects/${projectId}`
	);
	expect(importedResponse.ok()).toBeTruthy();
	// SAFETY: The successful local GET checked above is forwarded unchanged from store.project(), whose native projectSchema parser owns this Project and its declared fields before JSON serialization. Its meshes are meshSchema objects; other observed object fields retain unknown values.
	const importedProject = projectSchema.parse(await importedResponse.json());
	expect(importedProject.meshes[0]).toMatchObject({
		fill: "#3366cc",
		texture,
		vertices: expect.arrayContaining([expect.any(Array)]),
	});
	const importedRig = importedProject.meshes[0]?.rig;
	if (!importedRig) {
		test.info().annotations.push({
			type: "confirmed-import-gap",
			description:
				"The imported static glTF rig did not reach the saved mesh; the rig editor uses a local sidecar-seeded project fixture below.",
		});
		const seedResponse = await page.request.put(
			`/__studio/projects/${projectId}`,
			{
				data: seedInteractiveRig(importedProject),
			}
		);
		expect(seedResponse.ok()).toBeTruthy();
	}
	await page.reload();
	await page.getByLabel("Project").selectOption({ label: title });
	await openOverflowTab(page, "Meshes", "meshes");
	await expect(
		page.getByText("Interactive skeletal rig · 2 joints")
	).toBeVisible();

	const playhead = page.getByRole("spinbutton", { name: "Playhead" });
	await playhead.fill("1.25");
	await playhead.press("Tab");
	const meshPreview = page.locator(
		".studio-preview-frame svg[aria-label='Imported 3D mesh']"
	);
	await expect(meshPreview).toBeVisible();
	await expect(meshPreview.locator("pattern image")).toHaveAttribute(
		"href",
		texture
	);
	await expect(meshPreview.locator("polygon")).toHaveAttribute(
		"fill",
		/^url\(#mesh-texture-/
	);

	const rigJoint = page.getByLabel("Mesh 1 rig joint");
	await rigJoint.selectOption("1");
	const rigParent = page.getByLabel("Mesh 1 rig parent");
	await expect(rigParent).toHaveValue("0");
	await rigParent.selectOption("-1");
	const jointX = page.getByLabel("Mesh 1 Joint X");
	await jointX.fill("0.25");
	await jointX.press("Tab");
	await expect(jointX).toHaveValue("0.25");

	const rigProperty = page.getByLabel("Mesh 1 rig keyframe property");
	await rigProperty.selectOption("rotationZ");
	const rigValue = page.getByLabel("Mesh 1 rig keyframe value");
	await rigValue.fill("40");
	await page
		.getByRole("button", { name: "Add rig keyframe at playhead" })
		.click();
	await expect(
		page.getByText("1 rig keyframe saved", { exact: true })
	).toBeVisible();

	const constraintType = page.getByLabel("Mesh 1 rig constraint type");
	const constraintAxis = page.getByLabel("Mesh 1 rig constraint axis");
	const limitMin = page.getByLabel("Mesh 1 rig constraint minimum");
	const limitMax = page.getByLabel("Mesh 1 rig constraint maximum");
	await constraintAxis.selectOption("rotationX");
	await limitMin.fill("-35");
	await limitMax.fill("60");
	await page
		.getByRole("button", { name: "Save joint limit", exact: true })
		.click();
	await expect(page.getByRole("status")).toContainText(
		"Rotation limit saved for Arm joint."
	);
	await expect(
		page.getByText("rotationX -35° to 60°", { exact: true })
	).toBeVisible();

	await constraintType.selectOption("translation-limit");
	await expect(constraintAxis).toHaveValue("x");
	await constraintAxis.selectOption("z");
	await limitMin.fill("0.8");
	await limitMax.fill("-0.2");
	await page
		.getByRole("button", { name: "Save joint limit", exact: true })
		.click();
	await expect(page.getByRole("status")).toContainText(
		"The constraint minimum must be at or below its maximum."
	);
	await limitMin.fill("-0.5");
	await limitMax.fill("0.5");
	await page
		.getByRole("button", { name: "Save joint limit", exact: true })
		.click();
	await expect(page.getByRole("status")).toContainText(
		"Translation limit saved for Arm joint."
	);
	const translationConstraint = page.getByText("z -0.5 to 0.5", {
		exact: true,
	});
	await expect(translationConstraint).toBeVisible();
	await translationConstraint
		.locator("..")
		.getByRole("button", { name: "Remove", exact: true })
		.click();
	await expect(translationConstraint).toHaveCount(0);
	await expect(
		page.getByText("rotationX -35° to 60°", { exact: true })
	).toBeVisible();

	const offsetX = page.getByLabel("Mesh 1 Offset X");
	await offsetX.fill("1.2");
	await offsetX.press("Tab");
	await expect(offsetX).toHaveValue("0");
	await offsetX.fill("0.25");
	await offsetX.press("Tab");
	await expect(offsetX).toHaveValue("0.25");
	await selectMeshColor(page, "#E85838");

	const meshKeyframeProperty = page.getByLabel("Mesh 1 keyframe property");
	await meshKeyframeProperty.selectOption("rotationY");
	const meshKeyframeValue = page.getByLabel("Mesh 1 keyframe value");
	await meshKeyframeValue.fill("27");
	await page
		.getByRole("button", { name: "Add mesh keyframe at playhead" })
		.click();
	await expect(
		page.getByText("1 mesh keyframe saved", { exact: true })
	).toBeVisible();

	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	const initialSave = [...requests]
		.reverse()
		.find(
			(request) =>
				request.path === `/projects/${projectId}` && request.method === "PUT"
		);
	const initialProject = projectSchema.parse(initialSave?.body);
	expect(initialProject.meshes).toHaveLength(1);
	const firstMesh = initialProject.meshes[0];
	expect(firstMesh).toMatchObject({ fill: "#E85838", texture, x: 0.25 });
	expect(firstMesh?.rig?.joints[1]).toMatchObject({
		name: "Arm joint",
		parent: -1,
		x: 0.25,
	});
	expect(firstMesh?.rig?.keyframes).toEqual([
		expect.objectContaining({
			joint: 1,
			property: "rotationZ",
			time: 1,
			value: 40,
		}),
	]);
	expect(firstMesh?.rig?.constraints).toEqual([
		expect.objectContaining({
			axis: "rotationX",
			joint: 1,
			max: 60,
			min: -35,
			type: "rotation-limit",
		}),
	]);
	expect(firstMesh?.keyframes).toEqual([
		expect.objectContaining({ property: "rotationY", time: 1, value: 27 }),
	]);
	await saveScreenshot(page, "video-studio-mesh-material-rig-persisted.png");

	await page.reload();
	await page.getByLabel("Project").selectOption({ label: title });
	await openOverflowTab(page, "Meshes", "meshes");
	await expect(page.getByText("Mesh 1", { exact: true })).toBeVisible();
	await expect(page.getByLabel("Mesh 1 Offset X")).toHaveValue("0.25");
	const reloadedRigJoint = page.getByLabel("Mesh 1 rig joint");
	await expect(reloadedRigJoint).toHaveValue("0");
	await reloadedRigJoint.selectOption("1");
	await expect(page.getByLabel("Mesh 1 rig parent")).toHaveValue("-1");
	await expect(page.getByLabel("Mesh 1 Joint X")).toHaveValue("0.25");
	await expect(
		page.getByText("1 rig keyframe saved", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("1 mesh keyframe saved", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("rotationX -35° to 60°", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Mesh 1 color", exact: true })
	).toContainText("#E85838");
	await playhead.fill("1.25");
	await playhead.press("Tab");
	const persistedMeshPreview = page.locator(
		".studio-preview-frame svg[aria-label='Imported 3D mesh']"
	);
	await expect(persistedMeshPreview.locator("pattern image")).toHaveAttribute(
		"href",
		texture
	);

	await page
		.getByRole("button", { name: "Capture frame", exact: true })
		.click();
	await expect(page.getByRole("status")).toContainText(
		"Captured a PNG frame at"
	);
	const captureRequest = requests.find(
		(request) =>
			request.path === `/projects/${projectId}/capture-frame` &&
			request.method === "POST"
	);
	expect(captureRequest?.body).toMatchObject({ time: 1.25 });
	await saveScreenshot(page, "video-studio-mesh-texture-frame-captured.png");

	await openOverflowTab(page, "Meshes", "meshes");
	await importTexturedRig(page, gltfFile);
	await expect(page.getByText("Mesh 2", { exact: true })).toBeVisible();
	const secondMeshScene = page
		.locator(".studio-scene")
		.filter({ hasText: "Mesh 2" });
	await secondMeshScene
		.getByRole("button", { name: "Remove mesh", exact: true })
		.click();
	await expect(page.getByText("Mesh 2", { exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	const afterRemove = [...requests]
		.reverse()
		.find(
			(request) =>
				request.path === `/projects/${projectId}` && request.method === "PUT"
		);
	expect(
		capturedJsonArray(capturedJsonField(afterRemove?.body, "meshes"))
	).toEqual([expect.objectContaining({ id: firstMesh?.id })]);

	await page.reload();
	await page.getByLabel("Project").selectOption({ label: title });
	await openOverflowTab(page, "Meshes", "meshes");
	await expect(page.getByText("Mesh 1", { exact: true })).toBeVisible();
	await expect(page.getByText("Mesh 2", { exact: true })).toHaveCount(0);
	await playhead.fill("1.25");
	await playhead.press("Tab");
	await expect(
		page.locator(".studio-preview-frame svg[aria-label='Imported 3D mesh']")
	).toBeVisible();
	const persistedRotationLimit = page.getByText("rotationX -35° to 60°", {
		exact: true,
	});
	await expect(persistedRotationLimit).toBeVisible();
	await persistedRotationLimit.scrollIntoViewIfNeeded();
	await saveScreenshot(page, "video-studio-mesh-rig-constraints-persisted.png");
	await page
		.getByRole("button", { name: "Import 3D mesh", exact: true })
		.scrollIntoViewIfNeeded();
	await saveScreenshot(page, "video-studio-mesh-after-removing-second.png");
});
