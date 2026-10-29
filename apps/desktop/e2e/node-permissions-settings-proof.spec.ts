import path from "node:path";
import { expect, test } from "@playwright/test";

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
}

interface PermissionsProofSnapshot {
	overwrites: {
		allow: string[];
		deny: string[];
		target_id: string;
		target_type: string;
	}[];
	requests: CapturedRequest[];
}

// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
function evidencePath(name: string): string {
	const override = process.env.RYU_PROOF_EVIDENCE_DIR;
	if (override) {
		return path.join(override, `${name}.png`);
	}
	return path.resolve(
		import.meta.dirname,
		`../../../docs/proof/test-coverage-sweep-20260924/evidence/${name}.png`
	);
}

async function openExistingResource(
	page: import("@playwright/test").Page,
	query = ""
): Promise<void> {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) =>
		pageErrors.push(error.stack ?? error.message)
	);
	await page.goto(`/node-permissions-settings-proof.html${query}`);
	try {
		await expect(
			page.getByRole("heading", { name: "Node permissions" })
		).toBeVisible();
	} catch (error) {
		const body = await page
			.locator("body")
			.innerText()
			.catch(() => "<body unavailable>");
		throw new Error(
			`${String(error)}\nPage errors: ${pageErrors.join(" | ")}\nVisible body: ${body}`
		);
	}
	await expect(page.getByText("agent-07", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	if (query.includes("vocabularyFailure")) {
		await expect(page.getByRole("alert")).toContainText(
			"Could not load permissions"
		);
	} else {
		await expect(
			page.getByRole("heading", { name: "Permissions", exact: true })
		).toBeVisible();
	}
}

async function readProof(
	page: import("@playwright/test").Page
): Promise<PermissionsProofSnapshot> {
	return page.evaluate(() => {
		const proof =
			/* SAFETY: node-permissions-settings-proof.tsx installs __nodePermissionsProof before this proof page is evaluated. */ (
				window as Window & {
					__nodePermissionsProof: {
						snapshot: () => PermissionsProofSnapshot;
					};
				}
			).__nodePermissionsProof;
		return proof.snapshot();
	});
}

test("writes directory-backed ACL rules and reloads dynamic permissions", async ({
	page,
}) => {
	await openExistingResource(page, "?failWrite=true");

	const viewPermission = page
		.getByText("View items", { exact: true })
		.locator("xpath=../..");
	await viewPermission.getByRole("button", { name: "Allow" }).click();
	const editPermission = page
		.getByText("Edit items", { exact: true })
		.first()
		.locator("xpath=../..");
	await editPermission.getByRole("button", { name: "Deny" }).click();

	await page.getByRole("button", { name: "Add role" }).click();
	const addedRoleTarget = page.getByRole("combobox").nth(1);
	await addedRoleTarget.click();
	await page.getByRole("option", { name: "Auditors" }).click();

	await page.getByRole("button", { name: "Add team" }).click();
	const teamTarget = page.getByRole("combobox").nth(2);
	await teamTarget.click();
	await page.getByRole("option", { name: "Content writers" }).click();
	await expect(teamTarget).toContainText("Content writers");

	await page.getByRole("button", { name: "Add person" }).click();
	const memberTarget = page.getByRole("combobox").nth(3);
	await memberTarget.click();
	await page.getByPlaceholder("Search people…").fill("Kai");
	await page.getByRole("option", { name: /Kai/ }).click();
	await expect(memberTarget).toContainText("Kai");

	await page.getByRole("button", { name: "Add everyone in the org" }).click();
	await expect(
		page.getByText("Everyone in the org", { exact: true })
	).toBeVisible();

	await page
		.getByRole("button", { name: /Workflows/ })
		.nth(2)
		.click();
	const runPermission = page
		.getByText("Run workflows", { exact: true })
		.locator("xpath=../..");
	await runPermission.getByRole("button", { name: "Allow" }).click();
	await expect(
		page.getByText("Allowing this also allows: View items", { exact: true })
	).toBeVisible();
	const save = page.getByRole("button", { name: "Save", exact: true });
	await save.click();
	await expect(save).toBeEnabled();
	const failedWrite = await readProof(page);
	expect(failedWrite.overwrites).toEqual([
		{
			allow: ["space.edit"],
			deny: ["space.view"],
			target_id: "role-operators",
			target_type: "role",
		},
	]);
	await save.click();

	const saved = await readProof(page);
	const put = saved.requests.find(
		(request) =>
			request.method === "PUT" &&
			request.path.endsWith("/api/acl/resources/agent/agent-07")
	);
	expect(put?.body).toEqual({
		overwrites: [
			{
				allow: ["space.view"],
				deny: ["space.edit"],
				target_id: "role-operators",
				target_type: "role",
			},
			{
				allow: ["workflow.run"],
				deny: [],
				target_id: "team-content-writers",
				target_type: "team",
			},
		],
	});
	expect(saved.overwrites).toEqual([
		{
			allow: ["space.view"],
			deny: ["space.edit"],
			target_id: "role-operators",
			target_type: "role",
		},
		{
			allow: ["workflow.run"],
			deny: [],
			target_id: "team-content-writers",
			target_type: "team",
		},
	]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-permissions-agent-team-rule-saved"),
	});

	await page.reload();
	await expect(page.getByText("agent-07", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	const reloadedRunPermission = page
		.getByText("Run workflows", { exact: true })
		.locator("xpath=../..");
	await expect(
		reloadedRunPermission.getByRole("button", { name: "Allow" })
	).toBeVisible();
	await expect(page.getByRole("combobox").nth(1)).toContainText(
		"Content writers"
	);
	await expect(page.getByRole("combobox")).toHaveCount(2);
});

test("removing the last rule writes no empty exception and returns to the empty state", async ({
	page,
}) => {
	await openExistingResource(page);
	await page.getByRole("button", { name: /All resources/ }).click();
	await expect(
		page.getByRole("heading", { name: "Node permissions" })
	).toBeVisible();
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	await page.getByRole("button", { name: "Remove", exact: true }).click();
	await page.getByRole("button", { name: "Save", exact: true }).click();

	const saved = await readProof(page);
	const put = saved.requests.find(
		(request) =>
			request.method === "PUT" &&
			request.path.endsWith("/api/acl/resources/agent/agent-07")
	);
	expect(put?.body).toEqual({ overwrites: [] });

	await page.reload();
	await expect(
		page.getByText(
			"Nothing customised yet. Everyone follows their role everywhere."
		)
	).toBeVisible();
	await expect(page.getByText("agent-07", { exact: true })).toHaveCount(0);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-permissions-last-rule-removed"),
	});
});

test("Inherit clears explicit read and write overrides and restores role access", async ({
	page,
}) => {
	await openExistingResource(page);
	const viewPermission = page
		.getByText("View items", { exact: true })
		.locator("xpath=../..");
	const editPermission = page
		.getByText("Edit items", { exact: true })
		.locator("xpath=../..");
	await viewPermission.getByRole("button", { name: "Inherit" }).click();
	await editPermission.getByRole("button", { name: "Inherit" }).click();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByText("No exceptions. Everyone follows their usual role.")
	).toBeVisible();

	const saved = await readProof(page);
	expect(
		saved.requests
			.filter(
				(request) =>
					request.method === "PUT" &&
					request.path.endsWith("/api/acl/resources/agent/agent-07")
			)
			.map((request) => request.body)
	).toEqual([{ overwrites: [] }]);
	expect(saved.overwrites).toEqual([]);

	await page.getByRole("button", { name: /All resources/ }).click();
	await expect(
		page.getByText(
			"Nothing customised yet. Everyone follows their role everywhere."
		)
	).toBeVisible();
	await page.reload();
	await expect(
		page.getByText(
			"Nothing customised yet. Everyone follows their role everywhere."
		)
	).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-permissions-inherit-clears-exceptions"),
	});
});

test("opens a typed resource from the node-reported permission-kind list", async ({
	page,
}) => {
	await page.goto("/node-permissions-settings-proof.html");
	await expect(
		page.getByRole("heading", { name: "Node permissions" })
	).toBeVisible();
	await page.getByRole("combobox").click();
	await page.getByRole("option", { name: "Workflow" }).click();
	const identifier = page.getByLabel("Identifier");
	await expect(identifier).toHaveAttribute(
		"placeholder",
		"Workflow identifier"
	);
	await identifier.fill("weekly-review");
	await page.getByRole("button", { name: "Open", exact: true }).click();
	await expect(
		page.getByText("No exceptions. Everyone follows their usual role.")
	).toBeVisible();
	const opened = await readProof(page);
	expect(
		opened.requests.some(
			(request) =>
				request.method === "GET" &&
				request.path === "/api/acl/resources/workflow/weekly-review"
		)
	).toBe(true);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-permissions-open-resource"),
	});
});

test("saves member and organization scopes with exact stable identifiers", async ({
	page,
}) => {
	await openExistingResource(page);
	await page.getByRole("button", { name: "Add person", exact: true }).click();
	const memberTarget = page.getByRole("combobox").nth(1);
	await memberTarget.click();
	await page.getByPlaceholder("Search people…").fill("Kai");
	await page.getByRole("option", { name: /Kai/ }).click();
	await expect(memberTarget).toContainText("Kai");

	await page
		.getByRole("button", { name: "Add everyone in the org", exact: true })
		.click();
	const memberRow = page.locator("li").filter({ hasText: "Kai" });
	const memberWrite = memberRow
		.getByText("Edit items", { exact: true })
		.locator("xpath=../..");
	await memberWrite.getByRole("button", { name: "Allow" }).click();
	const organizationRow = page
		.locator("li")
		.filter({ hasText: "Everyone in the org" });
	const organizationRead = organizationRow
		.getByText("View items", { exact: true })
		.locator("xpath=../..");
	await organizationRead.getByRole("button", { name: "Allow" }).click();
	await page.getByRole("button", { name: "Save", exact: true }).click();

	const expected = {
		overwrites: [
			{
				allow: ["space.edit"],
				deny: ["space.view"],
				target_id: "role-operators",
				target_type: "role",
			},
			{
				allow: ["space.edit"],
				deny: [],
				target_id: "member-kai",
				target_type: "member",
			},
			{
				allow: ["space.view"],
				deny: [],
				target_id: "org-ryu",
				target_type: "org",
			},
		],
	};
	const snapshot = await readProof(page);
	expect(
		snapshot.requests
			.filter(
				(request) =>
					request.method === "PUT" &&
					request.path.endsWith("/api/acl/resources/agent/agent-07")
			)
			.map((request) => request.body)
	).toEqual([expected]);
	expect(snapshot.overwrites).toEqual(expected.overwrites);

	await page.reload();
	await expect(page.getByText("agent-07", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	await expect(page.getByRole("combobox").nth(1)).toContainText("Kai");
	await expect(
		page.getByText("Everyone in the org", { exact: true })
	).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-permissions-member-org-scope-saved"),
	});
});

test("unbound nodes block org-wide rules and prevent saving an untargeted grant", async ({
	page,
}) => {
	await openExistingResource(page, "?personalNode=true");
	const addOrganization = page.getByRole("button", {
		name: "Add everyone in the org",
		exact: true,
	});
	await expect(addOrganization).toBeDisabled();

	await page.getByRole("button", { name: "Add role", exact: true }).click();
	const unassignedRole = page.locator("li").filter({
		hasText: "Pick who this applies to. Until then these settings do nothing.",
	});
	const unassignedView = unassignedRole
		.getByText("View items", { exact: true })
		.locator("xpath=../..");
	await unassignedView.getByRole("button", { name: "Allow" }).click();
	const save = page.getByRole("button", { name: "Save", exact: true });
	await expect(save).toBeDisabled();
	const beforeTarget = await readProof(page);
	expect(
		beforeTarget.requests.some(
			(request) =>
				request.method === "PUT" &&
				request.path.endsWith("/api/acl/resources/agent/agent-07")
		)
	).toBe(false);

	const target = page.getByRole("combobox").nth(1);
	await target.click();
	await page.getByRole("option", { name: "Auditors", exact: true }).click();
	await expect(save).toBeEnabled();
	await save.click();
	const saved = await readProof(page);
	expect(
		saved.requests
			.filter(
				(request) =>
					request.method === "PUT" &&
					request.path.endsWith("/api/acl/resources/agent/agent-07")
			)
			.map((request) => request.body)
	).toEqual([
		{
			overwrites: [
				{
					allow: ["space.edit"],
					deny: ["space.view"],
					target_id: "role-operators",
					target_type: "role",
				},
				{
					allow: ["space.view"],
					deny: [],
					target_id: "role-auditors",
					target_type: "role",
				},
			],
		},
	]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-permissions-unbound-target-guard"),
	});
});

test("keeps ACL resources editable when the principal directory is unavailable", async ({
	page,
}) => {
	await openExistingResource(page, "?principalFailure=true");
	const roleId = page.getByLabel("Role identifier");
	await expect(roleId).toHaveValue("role-operators");
	await expect(
		page.getByText(/This node did not send anything to choose from/)
	).toBeVisible();
	await roleId.fill("role-auditors");

	const viewPermission = page
		.getByText("View items", { exact: true })
		.locator("xpath=../..");
	await viewPermission.getByRole("button", { name: "Allow" }).click();
	await page.getByRole("button", { name: "Save", exact: true }).click();

	const saved = await readProof(page);
	const put = saved.requests.find(
		(request) =>
			request.method === "PUT" &&
			request.path.endsWith("/api/acl/resources/agent/agent-07")
	);
	expect(put?.body).toEqual({
		overwrites: [
			{
				allow: ["space.edit", "space.view"],
				deny: [],
				target_id: "role-auditors",
				target_type: "role",
			},
		],
	});
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-permissions-directory-fallback"),
	});
});

test("shows and retries a failed resource-list read instead of a false empty state", async ({
	page,
}) => {
	await page.goto("/node-permissions-settings-proof.html?resourceFailure=true");
	await expect(
		page.getByRole("heading", { name: "Node permissions" })
	).toBeVisible();
	const error = page.getByRole("alert");
	await expect(error).toContainText("Could not list customised resources");
	await expect(
		page.getByText(
			"Nothing customised yet. Everyone follows their role everywhere."
		)
	).toHaveCount(0);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-permissions-resource-list-retry"),
	});
	await error.getByRole("button", { name: "Retry" }).click();
	await expect(page.getByText("agent-07", { exact: true })).toBeVisible();
	await expect(error).toHaveCount(0);
});

test("shows and retries a failed vocabulary read without replacing rules with an empty state", async ({
	page,
}) => {
	await openExistingResource(page, "?vocabularyFailure=true");
	const error = page.getByRole("alert");
	await expect(error).toContainText("Could not load permissions");
	await expect(
		page.getByText("No exceptions. Everyone follows their usual role.")
	).toHaveCount(0);
	await error.getByRole("button", { name: "Retry" }).click();
	await expect(
		page.getByRole("heading", { name: "Permissions", exact: true })
	).toBeVisible();
	await expect(page.getByText("Edit items", { exact: true })).toBeVisible();
	await expect(error).toHaveCount(0);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-permissions-vocabulary-retry"),
	});
});
