import { expect, test } from "@playwright/test";
import {
	createWorkspace,
	draftRow,
	listDrafts,
	listMedia,
	listTemplates,
	mediaRow,
	openLibrary,
	recordSocialRequests,
	saveScreenshot,
	seedDraft,
	selectLibraryTab,
	templateRow,
	uniqueName,
} from "./social-library-proof.helpers.ts";

test("draft rows reopen saved content, confirm deletion, and expose blank compose", async ({
	page,
}) => {
	const workspace = await createWorkspace(page, uniqueName("Library drafts"));
	const reusableText =
		"The harbor light is on. A saved draft must reopen intact.";
	const removableText =
		"A second draft is only here to verify delete confirmation.";
	const savedDraft = await seedDraft(page, workspace.id, reusableText);
	const removableDraft = await seedDraft(page, workspace.id, removableText);
	const requests = recordSocialRequests(page);
	await openLibrary(page, workspace.id);

	await selectLibraryTab(page, "Templates", "templates");
	await expect(
		page.getByRole("button", { name: "New template" })
	).toBeVisible();
	await selectLibraryTab(page, "Media", "media");
	await expect(page.getByLabel("File path")).toBeVisible();
	await selectLibraryTab(page, "Drafts", "drafts");
	await expect(draftRow(page, reusableText)).toBeVisible();
	await expect(draftRow(page, removableText)).toBeVisible();

	const beforeRefresh = {
		drafts: requests.filter(
			(request) => request.method === "GET" && request.path === "/drafts"
		).length,
		media: requests.filter(
			(request) => request.method === "GET" && request.path === "/media"
		).length,
		templates: requests.filter(
			(request) => request.method === "GET" && request.path === "/templates"
		).length,
	};
	const refresh = page.getByRole("button", { name: "Refresh", exact: true });
	await expect(refresh).toBeEnabled();
	await refresh.click();
	await expect
		.poll(
			() =>
				requests.filter(
					(request) => request.method === "GET" && request.path === "/drafts"
				).length
		)
		.toBe(beforeRefresh.drafts + 1);
	await expect
		.poll(
			() =>
				requests.filter(
					(request) => request.method === "GET" && request.path === "/templates"
				).length
		)
		.toBe(beforeRefresh.templates + 1);
	await expect
		.poll(
			() =>
				requests.filter(
					(request) => request.method === "GET" && request.path === "/media"
				).length
		)
		.toBe(beforeRefresh.media + 1);

	await draftRow(page, reusableText)
		.getByRole("button", { name: "Compose", exact: true })
		.click();
	await expect(page.getByRole("heading", { name: "Compose" })).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Post text" })).toHaveValue(
		reusableText
	);
	expect(
		requests.some(
			(request) =>
				request.method === "GET" && request.path === `/drafts/${savedDraft.id}`
		)
	).toBe(true);
	await saveScreenshot(page, "social-library-reopened-draft.png");

	await openLibrary(page, workspace.id);
	await selectLibraryTab(page, "Drafts", "drafts");
	const toDelete = draftRow(page, removableText);
	await toDelete.getByRole("button", { name: "Delete draft" }).click();
	const confirmation = page.getByRole("alertdialog");
	await expect(confirmation).toContainText(removableText);
	const deletesBeforeCancel = requests.filter(
		(request) =>
			request.method === "DELETE" &&
			request.path === `/drafts/${removableDraft.id}`
	).length;
	await confirmation.getByRole("button", { name: "Cancel" }).click();
	await expect(draftRow(page, removableText)).toBeVisible();
	expect(
		requests.filter(
			(request) =>
				request.method === "DELETE" &&
				request.path === `/drafts/${removableDraft.id}`
		).length
	).toBe(deletesBeforeCancel);
	await draftRow(page, removableText)
		.getByRole("button", { name: "Delete draft" })
		.click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Delete", exact: true })
		.click();
	await expect
		.poll(async () =>
			(await listDrafts(page, workspace.id)).some(
				(draft) => draft.id === removableDraft.id
			)
		)
		.toBe(false);

	await draftRow(page, reusableText)
		.getByRole("button", { name: "Delete draft" })
		.click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Delete", exact: true })
		.click();
	await expect(page.getByText("No drafts yet", { exact: true })).toBeVisible();
	await saveScreenshot(page, "social-library-empty-drafts.png");
	await page
		.getByRole("button", { name: "Compose a post", exact: true })
		.click();
	await expect(page.getByRole("heading", { name: "Compose" })).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Post text" })).toHaveValue(
		""
	);
	await expect(page.getByText("Draft saved", { exact: true })).toHaveCount(0);
});

test("media registration rejects paths outside the approved root, retries, and removes only the library reference", async ({
	page,
}) => {
	const workspace = await createWorkspace(page, uniqueName("Library media"));
	const requests = recordSocialRequests(page);
	await openLibrary(page, workspace.id);
	await selectLibraryTab(page, "Media", "media");
	const pathField = page.getByLabel("File path");
	const nameField = page.locator("#social-media-name");
	const mimeField = page.locator("#social-media-mime");
	const addButton = page.locator("form").getByRole("button", {
		name: "Add",
		exact: true,
	});
	await expect(addButton).toBeDisabled();
	const pathsResponse = await page.request.get("/__proof/media-path");
	// SAFETY: The controlled social-library host creates both local fixture files before serving; this /__proof/media-path route JSON-serializes the native realpath string results as path/outsidePath, with no foreign response publisher in this proof.
	const paths = (await pathsResponse.json()) as {
		outsidePath: string;
		path: string;
	};
	await pathField.fill(paths.outsidePath);
	await nameField.fill("Outside path attempt");
	await mimeField.fill("image/png");
	await expect(addButton).toBeEnabled();
	await addButton.click();
	await expect(page.getByRole("alert")).toContainText(
		"Could not add that file"
	);
	await expect(page.getByRole("alert")).toContainText(
		"media must be beneath the configured Social media root"
	);
	expect(await listMedia(page, workspace.id)).toEqual([]);
	await expect(pathField).toHaveValue(paths.outsidePath);
	await saveScreenshot(page, "social-library-media-validation-error.png");

	const name = "Harbor launch card";
	await pathField.fill(paths.path);
	await nameField.fill(`  ${name}  `);
	await mimeField.fill(" image/png ");
	await addButton.click();
	await expect(page.getByRole("status")).toContainText("Added to the library");
	const media = (await listMedia(page, workspace.id)).find(
		(asset) => asset.path === paths.path
	);
	expect(media).toMatchObject({
		kind: "image",
		mime_type: "image/png",
		name,
		path: paths.path,
		workspace_id: workspace.id,
	});
	const createRequests = requests.filter(
		(request) => request.method === "POST" && request.path === "/media"
	);
	expect(createRequests.map((request) => request.body)).toEqual([
		{
			mime_type: "image/png",
			name: "Outside path attempt",
			path: paths.outsidePath,
			workspace_id: workspace.id,
		},
		{
			mime_type: "image/png",
			name,
			path: paths.path,
			workspace_id: workspace.id,
		},
	]);
	await expect(mediaRow(page, name)).toBeVisible();
	await expect(
		page.getByText("Could not add that file", { exact: true })
	).toBeHidden();
	await saveScreenshot(page, "social-library-media-reference.png");

	await page.reload();
	await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
	await page.getByLabel("Workspace").selectOption(workspace.id);
	await selectLibraryTab(page, "Media", "media");
	await expect(mediaRow(page, name)).toBeVisible();
	const row = mediaRow(page, name);
	await row
		.getByRole("button", { name: `Remove ${name} from the library` })
		.click();
	const removeDialog = page.getByRole("alertdialog");
	await expect(removeDialog).toContainText("The file at");
	await expect(removeDialog).toContainText(paths.path);
	await removeDialog.getByRole("button", { name: "Cancel" }).click();
	expect(
		(await listMedia(page, workspace.id)).some(
			(asset) => asset.id === media?.id
		)
	).toBe(true);
	await mediaRow(page, name)
		.getByRole("button", { name: `Remove ${name} from the library` })
		.click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Remove", exact: true })
		.click();
	await expect
		.poll(async () =>
			(await listMedia(page, workspace.id)).some(
				(asset) => asset.id === media?.id
			)
		)
		.toBe(false);
	const fileState = await page.request.get("/__proof/media-exists");
	expect(await fileState.json()).toEqual({ inside: true, outside: true });
});

test("template editor saves platform variants, reopens them in Compose, and keeps deleted starters deleted", async ({
	page,
}) => {
	const workspace = await createWorkspace(
		page,
		uniqueName("Library templates")
	);
	const requests = recordSocialRequests(page);
	await openLibrary(page, workspace.id);
	await selectLibraryTab(page, "Templates", "templates");
	const starters = await listTemplates(page, workspace.id);
	expect(starters).toHaveLength(7);

	const newTemplate = page.getByRole("button", {
		name: "New template",
		exact: true,
	});
	await newTemplate.click();
	let editor = page.getByRole("dialog");
	await expect(editor).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(editor).toHaveCount(0);
	await newTemplate.click();
	editor = page.getByRole("dialog");
	await editor.locator("#template-name").fill("   ");
	const templateCreatesBeforeBlankName = requests.filter(
		(request) => request.method === "POST" && request.path === "/templates"
	).length;
	await editor.getByRole("button", { name: "Create", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText(
		"A template needs a name"
	);
	await expect(editor).toBeVisible();
	expect(
		requests.filter(
			(request) => request.method === "POST" && request.path === "/templates"
		).length
	).toBe(templateCreatesBeforeBlankName);
	const originalName = "Coverage launch template";
	const originalText = "[Product] is live. [Problem solved]. [link]";
	const originalLinkedIn =
		"[Product] launches. Here is what changed: [detail].";
	const originalX = "[Product] is live: [link]";
	await editor.locator("#template-name").fill(originalName);
	await editor.locator("#template-text").fill(originalText);
	await editor.getByLabel("Add a platform variant").selectOption("linkedin");
	await editor.getByRole("button", { name: "Add", exact: true }).click();
	await editor.locator("#template-variant-linkedin").fill(originalLinkedIn);
	await editor.getByRole("button", { name: "Remove variant" }).click();
	await expect(editor.locator("#template-variant-linkedin")).toHaveCount(0);
	await editor.getByLabel("Add a platform variant").selectOption("x");
	await editor.getByRole("button", { name: "Add", exact: true }).click();
	await editor.locator("#template-variant-x").fill(originalX);
	await editor.getByRole("button", { name: "Create", exact: true }).click();
	await expect(editor).toHaveCount(0);
	await expect(templateRow(page, originalName)).toBeVisible();
	let templates = await listTemplates(page, workspace.id);
	let savedTemplate = templates.find(
		(template) => template.name === originalName
	);
	expect(savedTemplate?.body).toEqual({
		platform_defaults: { x: originalX },
		schema_version: 1,
		text: originalText,
	});
	const createRequest = requests.find(
		(request) => request.method === "POST" && request.path === "/templates"
	);
	expect(createRequest?.body).toEqual({
		body: {
			platform_defaults: { x: originalX },
			schema_version: 1,
			text: originalText,
		},
		name: originalName,
		workspace_id: workspace.id,
	});
	await saveScreenshot(page, "social-library-template-created.png");

	await templateRow(page, originalName)
		.getByRole("button", { name: "Edit template" })
		.click();
	editor = page.getByRole("dialog");
	const editedName = "Coverage launch template edited";
	const editedText = "[Product] now ships. [What changed]. [link]";
	const editedX = "[Product] ships today: [link]";
	const linkedInText = "[Product] now ships. [Detail] [link]";
	await editor.locator("#template-name").fill(editedName);
	await editor.locator("#template-text").fill(editedText);
	await editor.locator("#template-variant-x").fill(editedX);
	await editor.getByLabel("Add a platform variant").selectOption("linkedin");
	await editor.getByRole("button", { name: "Add", exact: true }).click();
	await editor.locator("#template-variant-linkedin").fill(linkedInText);
	await editor.getByRole("button", { name: "Save", exact: true }).click();
	await expect(templateRow(page, editedName)).toBeVisible();
	templates = await listTemplates(page, workspace.id);
	savedTemplate = templates.find((template) => template.name === editedName);
	expect(savedTemplate?.body).toEqual({
		platform_defaults: { linkedin: linkedInText, x: editedX },
		schema_version: 1,
		text: editedText,
	});
	const updateRequest = requests.find(
		(request) =>
			request.method === "PATCH" &&
			request.path === `/templates/${savedTemplate?.id}`
	);
	expect(updateRequest?.body).toEqual({
		body: {
			platform_defaults: { linkedin: linkedInText, x: editedX },
			schema_version: 1,
			text: editedText,
		},
		name: editedName,
	});

	if (!savedTemplate) {
		throw new Error("The edited template must still exist in the sidecar.");
	}
	await templateRow(page, editedName)
		.getByRole("button", { name: "Compose", exact: true })
		.click();
	await expect(page.getByRole("heading", { name: "Compose" })).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Post text" })).toHaveValue(
		editedText
	);
	const createdDraft = (await listDrafts(page, workspace.id)).find(
		(draft) => draft.body.text === editedText
	);
	expect(createdDraft?.body).toMatchObject({
		account_ids: [],
		segments: [{ media: [], text: editedText }],
		text: editedText,
	});
	expect(
		requests.some(
			(request) =>
				request.method === "POST" &&
				request.path === `/templates/${savedTemplate.id}/use`
		)
	).toBe(true);
	if (!createdDraft) {
		throw new Error("Using a template must create an editable draft.");
	}
	await expect
		.poll(async () =>
			requests.some(
				(request) =>
					request.method === "GET" &&
					request.path === `/drafts/${createdDraft.id}`
			)
		)
		.toBe(true);
	await saveScreenshot(page, "social-library-template-composed.png");

	await openLibrary(page, workspace.id);
	await selectLibraryTab(page, "Templates", "templates");
	await templateRow(page, editedName)
		.getByRole("button", { name: "Delete template" })
		.click();
	let confirmation = page.getByRole("alertdialog");
	await expect(confirmation).toContainText("permanently deleted");
	await confirmation.getByRole("button", { name: "Cancel" }).click();
	await expect(templateRow(page, editedName)).toBeVisible();
	await templateRow(page, editedName)
		.getByRole("button", { name: "Delete template" })
		.click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Delete", exact: true })
		.click();
	await expect
		.poll(async () =>
			(await listTemplates(page, workspace.id)).some(
				(template) => template.id === savedTemplate?.id
			)
		)
		.toBe(false);

	let cancelledStarter = false;
	for (const starter of starters) {
		const row = templateRow(page, starter.name);
		await row.getByRole("button", { name: "Delete template" }).click();
		confirmation = page.getByRole("alertdialog");
		await expect(confirmation).toContainText("stays deleted");
		if (!cancelledStarter) {
			await confirmation.getByRole("button", { name: "Cancel" }).click();
			await expect(templateRow(page, starter.name)).toBeVisible();
			await row.getByRole("button", { name: "Delete template" }).click();
			confirmation = page.getByRole("alertdialog");
			cancelledStarter = true;
		}
		await confirmation
			.getByRole("button", { name: "Delete", exact: true })
			.click();
		await expect
			.poll(async () =>
				(await listTemplates(page, workspace.id)).some(
					(template) => template.id === starter.id
				)
			)
			.toBe(false);
	}
	await expect(page.getByText("No templates", { exact: true })).toBeVisible();
	await page
		.getByRole("button", { name: "New template", exact: true })
		.last()
		.click();
	editor = page.getByRole("dialog");
	await expect(editor).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(editor).toHaveCount(0);
	await saveScreenshot(page, "social-library-empty-templates.png");
	await page.reload();
	await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
	await page.getByLabel("Workspace").selectOption(workspace.id);
	await selectLibraryTab(page, "Templates", "templates");
	await expect(page.getByText("No templates", { exact: true })).toBeVisible();
	expect(await listTemplates(page, workspace.id)).toEqual([]);
});
