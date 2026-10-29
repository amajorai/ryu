import path from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";

const projectPath = "/Users/proof/projects/ryu-app";
// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
function evidencePath(ledgerPath: string): string {
	const override = process.env.RYU_PROOF_EVIDENCE_DIR;
	if (override) {
		return path.join(override, path.basename(ledgerPath));
	}
	return path.resolve(import.meta.dirname, "../../..", ledgerPath);
}
const environmentsKey = "ryu_workspace_environments_v1";

type ProofWindow = Window & {
	__PROJECT_ENVIRONMENT_PATH__?: string;
	__READ_PROJECT_ENVIRONMENT_STATE__?: () => {
		activeId: string | null;
		environments: unknown[];
	};
	__PROJECT_ENVIRONMENT_PROOF__?: {
		apiCalls: Array<{
			query?: string;
			body?: unknown;
			headers: Record<string, string>;
			method: string;
			path: string;
		}>;
		fileReads: string[];
		fileWrites: Array<{ content: string; path: string }>;
	};
};

async function openProjectEnvironmentEditor(
	page: import("@playwright/test").Page
) {
	await page.goto("/gateway-project-environments-proof.html");
	await expect(
		page.getByRole("heading", { name: "Environments", exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: /ryu-app/ }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Local environments" })
	).toBeVisible();
	const instructionsEditor = page.locator("#project-settings-instructions");
	await expect(instructionsEditor).toBeVisible();
	await expect(
		instructionsEditor.locator('[data-slate-editor="true"]')
	).toBeVisible();
	const minimumEditorHeight = await instructionsEditor.evaluate((element) =>
		Number.parseFloat(getComputedStyle(element).minHeight)
	);
	expect(minimumEditorHeight).toBeGreaterThan(160);
	const editorBox = await instructionsEditor.boundingBox();
	const mappingHeading = page.getByRole("heading", {
		name: "Managed project mapping",
	});
	const mappingBox = await mappingHeading.boundingBox();
	expect(mappingBox?.y ?? 0).toBeGreaterThan(
		(editorBox?.y ?? 0) + (editorBox?.height ?? 0)
	);
}

async function readProofState(page: import("@playwright/test").Page) {
	return await page.evaluate(() => {
		const win =
			/* SAFETY: This fixture initialization defines __PROJECT_ENVIRONMENT_PATH__ on its own browser window. */ window as ProofWindow;
		return {
			apiCalls: win.__PROJECT_ENVIRONMENT_PROOF__?.apiCalls ?? [],
			fileReads: win.__PROJECT_ENVIRONMENT_PROOF__?.fileReads ?? [],
			fileWrites: win.__PROJECT_ENVIRONMENT_PROOF__?.fileWrites ?? [],
			projectPath: win.__PROJECT_ENVIRONMENT_PATH__ ?? null,
		};
	});
}

test.describe.configure({ timeout: 120_000 });

test("Gateway Add project browses the selected node, cancels without writes and reads back the selected folder", async ({
	page,
}) => {
	await page.goto("/gateway-project-environments-proof.html");
	await expect(
		page.getByRole("tab", { name: "Effective", exact: true })
	).toHaveAttribute("aria-selected", "true");
	await expect(
		page.getByRole("tab", { name: "Organization", exact: true })
	).toBeDisabled();
	await page.getByRole("tab", { name: "Node", exact: true }).click();
	await expect(
		page.getByText("Changes at this level override broader defaults.", {
			exact: true,
		})
	).toBeVisible();
	await page.getByRole("button", { name: "Add project", exact: true }).click();
	await expect(
		page.getByRole("dialog", { name: "Add a project folder to Ryu" })
	).toBeVisible();
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: /new-project.*Edit/ })
	).toHaveCount(0);
	await page.getByRole("button", { name: "Add project", exact: true }).click();
	const pathInput = page.getByPlaceholder(
		"Type a folder path, or pick one below…"
	);
	await pathInput.fill("/Users/proof/projects/new-project");
	await pathInput.press("Enter");
	await expect(
		page.getByRole("button", { name: "Add folder to Ryu", exact: true })
	).toBeEnabled();
	await pathInput.fill("/denied");
	await expect(
		page.getByRole("button", { name: "Add folder to Ryu", exact: true })
	).toBeDisabled();
	await pathInput.press("Enter");
	await expect(pathInput).toHaveAttribute("aria-invalid", "true");
	await expect(
		page.getByRole("button", { name: "Add folder to Ryu", exact: true })
	).toBeDisabled();
	await pathInput.fill("/Users/proof/projects/new-project");
	await pathInput.press("Enter");
	await expect(pathInput).not.toHaveAttribute("aria-invalid", "true");
	await page
		.getByRole("button", { name: "Add folder to Ryu", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Local environments", exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await expect(
		page.getByRole("button", { name: /new-project.*Edit/ })
	).toBeVisible();
	const state = await readProofState(page);
	const folderReads = state.apiCalls.filter(
		(call) => call.path === "/api/workspace/list"
	);
	expect(folderReads.length).toBeGreaterThanOrEqual(4);
	expect(
		folderReads.map((call) => new URLSearchParams(call.query).get("path"))
	).toContain("/denied");
	expect(
		folderReads.map((call) => new URLSearchParams(call.query).get("path"))
	).toContain("/Users/proof/projects/new-project");
	expect(
		state.apiCalls
			.filter((call) => call.path === "/api/workspace/list")
			.every(
				(call) =>
					call.method === "GET" &&
					call.headers.authorization ===
						"Bearer project-environment-proof-token"
			)
	).toBe(true);
	expect(state.fileWrites).toHaveLength(0);
	expect(state.apiCalls.filter((call) => call.method !== "GET")).toHaveLength(
		0
	);
	await page.reload();
	await expect(
		page.getByRole("button", { name: /new-project.*Edit/ })
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: evidencePath(
			"docs/proof/test-coverage-sweep-20260924/parallel/desktop-gateway/environment-project-added.png"
		),
	});
});

test("saves the project environment contract and reloads the active profile", async ({
	page,
}) => {
	await openProjectEnvironmentEditor(page);
	await page.getByRole("button", { name: "Add environment" }).click();
	const name = page.getByLabel("Name", { exact: true }).last();
	await name.fill("Linux development");
	await page.getByRole("button", { name: "Add variable" }).click();
	await page.getByLabel("Variable name").fill("DATABASE_URL");
	await page.getByLabel("Variable value").fill("postgres://localhost/ryu");
	await page.getByRole("button", { name: "Add action" }).click();
	await page.getByLabel("Action name").fill("Run integration tests");
	await page.getByRole("button", { name: "linux", exact: true }).click();
	await page
		.getByPlaceholder("Overrides Default on linux")
		.fill("bun run test:integration");
	await page.getByRole("button", { name: "Add environment" }).click();
	await page.getByLabel("Name", { exact: true }).last().fill("Preview");
	await page.getByRole("button", { name: "Make active" }).last().click();
	await page.getByRole("button", { name: "Linux development" }).click();
	await expect(page.getByLabel("Variable name")).toHaveValue("DATABASE_URL");
	await page.getByRole("button", { name: "linux", exact: true }).click();
	await page
		.getByPlaceholder("Overrides Default on linux")
		.scrollIntoViewIfNeeded();
	await expect(page.getByPlaceholder("Overrides Default on linux")).toHaveValue(
		"bun run test:integration"
	);
	await page.screenshot({
		fullPage: true,
		path: evidencePath(
			"docs/proof/test-coverage-sweep-20260924/evidence/gateway-project-environments-saved.png"
		),
	});
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByRole("dialog")).not.toBeVisible();

	const persisted = await page.evaluate(() => ({
		environments: JSON.parse(
			localStorage.getItem("ryu_workspace_environments_v1") ?? "{}"
		),
		active: JSON.parse(
			localStorage.getItem("ryu_workspace_active_environments_v1") ?? "{}"
		),
	}));
	// Strict objects keep the whole stored contract, including the generated
	// action and variable ids, so the reload comparison below covers every field.
	const projectEnvironments = z
		.array(
			z.strictObject({
				actions: z.array(
					z.strictObject({
						id: z.uuid(),
						name: z.string(),
						scripts: z.record(z.string(), z.string()),
					})
				),
				cleanup: z.record(z.string(), z.string()),
				id: z.uuid(),
				name: z.string(),
				setup: z.record(z.string(), z.string()),
				variables: z.array(
					z.strictObject({ id: z.uuid(), key: z.string(), value: z.string() })
				),
			})
		)
		.parse(persisted.environments[projectPath]);
	expect(projectEnvironments).toHaveLength(2);
	const generatedIds = projectEnvironments.flatMap((environment) => [
		environment.id,
		...environment.actions.map((action) => action.id),
		...environment.variables.map((variable) => variable.id),
	]);
	expect(generatedIds).toHaveLength(4);
	expect(new Set(generatedIds).size).toBe(generatedIds.length);
	expect(projectEnvironments[0]).toMatchObject({
		name: "Linux development",
		setup: { default: "", linux: "", macos: "", windows: "" },
		cleanup: { default: "", linux: "", macos: "", windows: "" },
		variables: [{ key: "DATABASE_URL", value: "postgres://localhost/ryu" }],
		actions: [
			{
				name: "Run integration tests",
				scripts: {
					default: "",
					linux: "bun run test:integration",
					macos: "",
					windows: "",
				},
			},
		],
	});
	expect(projectEnvironments[1].name).toBe("Preview");
	expect(persisted.active[projectPath]).toBe(projectEnvironments[1].id);
	const proof = await readProofState(page);
	expect(proof.projectPath).toBe(projectPath);
	expect(proof.fileWrites).toEqual([
		{
			content: "Keep local environment settings with this project.\n",
			path: `${projectPath}/AGENTS.md`,
		},
	]);

	await page.reload();
	await page.getByRole("button", { name: /ryu-app/ }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Preview · Active" })
	).toBeVisible();
	const reloadedState = await page.evaluate(
		() =>
			/* SAFETY: gateway-project-environments-proof.tsx installs __READ_PROJECT_ENVIRONMENT_STATE__ before this proof page is evaluated. */ (
				window as ProofWindow
			).__READ_PROJECT_ENVIRONMENT_STATE__?.() ?? null
	);
	expect(reloadedState?.activeId).toBe(projectEnvironments[1].id);
	expect(reloadedState?.environments).toEqual(projectEnvironments);
});

test("rejects invalid environment input before any disk or project write", async ({
	page,
}) => {
	await openProjectEnvironmentEditor(page);
	await page
		.getByRole("button", { name: "Add a local environment setup" })
		.click();
	await page.getByRole("button", { name: "Add variable" }).click();
	await page.getByLabel("Variable name").fill("9INVALID");
	await page.getByLabel("Variable value").fill("must-not-save");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByText("Invalid variable name in Local")).toBeVisible();
	await expect(page.getByRole("dialog")).toBeVisible();
	const proof = await readProofState(page);
	expect(proof.fileWrites).toHaveLength(0);
	expect(
		await page.evaluate((key) => localStorage.getItem(key), environmentsKey)
	).toBeNull();

	await page.getByLabel("Variable name").fill("VALID_NAME");
	await page.getByRole("button", { name: "Add variable" }).click();
	await page.getByLabel("Variable name").nth(1).fill("VALID_NAME");
	await page.getByLabel("Variable value").nth(1).fill("duplicate");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByText("Duplicate variable name in Local")
	).toBeVisible();
	const duplicateProof = await readProofState(page);
	expect(duplicateProof.fileWrites).toHaveLength(0);
	const mappingCalls = duplicateProof.apiCalls.filter(
		(call) => call.path === "/api/org-project-mappings" && call.method !== "GET"
	);
	expect(mappingCalls).toHaveLength(0);

	await page.getByLabel("Variable name").nth(1).fill("FEATURE_FLAG");
	await page.getByLabel("Organization ID").fill("org-without-project");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByText(
			"Organization ID and project ID are both required for a mapping"
		)
	).toBeVisible();
	const incompleteMappingProof = await readProofState(page);
	expect(incompleteMappingProof.fileWrites).toHaveLength(0);
	expect(
		incompleteMappingProof.apiCalls.filter(
			(call) =>
				call.path === "/api/org-project-mappings" && call.method !== "GET"
		)
	).toHaveLength(0);
});

test("keeps a denied save editable and retries successfully after access returns", async ({
	page,
}) => {
	await page.goto("/gateway-project-environments-proof.html?denyMappingOnce=1");
	await expect(
		page.getByRole("heading", { name: "Environments", exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: /ryu-app/ }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await page
		.getByRole("button", { name: "Add a local environment setup" })
		.click();
	await page.getByLabel("Name", { exact: true }).last().fill("Canary");
	await page.getByLabel("Organization ID").fill("org-canary");
	await page.getByLabel("Project ID").fill("project-canary");

	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await expect(
		page.getByText("Couldn't save project settings", { exact: true })
	).toBeVisible();
	await expect(
		page
			.getByRole("alert")
			.getByText(
				"Couldn't save project settings. Check that the project folder and node are writable, then try again."
			)
	).toBeVisible();
	await expect(page.getByLabel("Name", { exact: true }).last()).toHaveValue(
		"Canary"
	);
	await page.screenshot({
		fullPage: true,
		path: evidencePath(
			"docs/proof/test-coverage-sweep-20260924/evidence/gateway-project-environments-access-denied.png"
		),
	});
	const failedProof = await readProofState(page);
	expect(
		failedProof.apiCalls.filter(
			(call) =>
				call.path === "/api/org-project-mappings" && call.method === "PUT"
		)
	).toHaveLength(1);
	expect(failedProof.fileWrites).toHaveLength(1);

	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByRole("dialog")).not.toBeVisible();
	const succeeded = await readProofState(page);
	const writes = succeeded.apiCalls.filter(
		(call) => call.path === "/api/org-project-mappings" && call.method === "PUT"
	);
	expect(writes).toHaveLength(2);
	expect(writes[1]?.body).toEqual({
		organizationId: "org-canary",
		projectId: "project-canary",
		root: projectPath,
	});
	expect(writes[1]?.headers.authorization).toBe(
		"Bearer project-environment-proof-token"
	);
	expect(
		await page.evaluate(() =>
			JSON.parse(localStorage.getItem("ryu_workspace_environments_v1") ?? "{}")
		)
	).toMatchObject({
		[projectPath]: [{ name: "Canary" }],
	});

	await page.reload();
	await page.getByRole("button", { name: /ryu-app/ }).click();
	await expect(
		page.getByRole("button", { name: "Canary · Active" })
	).toBeVisible();
	await expect(page.getByLabel("Organization ID")).toHaveValue("org-canary");
	await expect(page.getByLabel("Project ID")).toHaveValue("project-canary");
});

test("recovers from a denied project instruction write without losing the draft", async ({
	page,
}) => {
	await page.goto(
		"/gateway-project-environments-proof.html?denyFileWriteOnce=1"
	);
	await expect(
		page.getByRole("heading", { name: "Environments", exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: /ryu-app/ }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await page
		.getByRole("button", { name: "Add a local environment setup" })
		.click();
	await page.getByLabel("Name", { exact: true }).last().fill("Recovered");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await expect(
		page.getByText("Couldn't save project settings", { exact: true })
	).toBeVisible();
	await expect(page.getByLabel("Name", { exact: true }).last()).toHaveValue(
		"Recovered"
	);
	await expect(
		page.getByRole("button", { name: "Save", exact: true })
	).toBeEnabled();
	const failed = await readProofState(page);
	expect(failed.fileWrites).toHaveLength(1);
	expect(
		failed.apiCalls.filter(
			(call) =>
				call.path === "/api/org-project-mappings" && call.method === "PUT"
		)
	).toHaveLength(0);

	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByRole("dialog")).not.toBeVisible();
	const success = await readProofState(page);
	expect(success.fileWrites).toHaveLength(2);
	expect(
		await page.evaluate(() =>
			JSON.parse(localStorage.getItem("ryu_workspace_environments_v1") ?? "{}")
		)
	).toMatchObject({
		[projectPath]: [{ name: "Recovered" }],
	});
});
