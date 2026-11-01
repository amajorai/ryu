import { expect, test } from "@playwright/test";
import type { SetVaultSecretInput } from "@/src/lib/api/vault.ts";
import {
	capture,
	expectedSetBody,
	installVaultApi,
	NODE_TOKEN,
	openVault,
	requestsFor,
	type SaveCase,
	selectScope,
	UPDATED_AT,
	VAULT_PATH,
	type VaultFixtureSecret,
} from "./vault-secrets-interactions-fixture.ts";

// Vault errors show Core's own message (vaultErrorMessage prefers the server
// message over the "<path> failed: <status>" fallback, already so at
// 07d403e33, before Ryu Quiet), so the proofs assert the fixture's messages.
// The row action is "Delete" with a "Delete this secret?" confirmation (a soft
// delete, restorable from Show deleted), also already so at 07d403e33.
test.describe.configure({ timeout: 120_000 });

test("shows a failed metadata read and Refresh vault recovers the production page", async ({
	page,
}) => {
	const fixture = await installVaultApi(page);
	fixture.failNext(
		"GET",
		VAULT_PATH,
		503,
		"Vault list temporarily unavailable"
	);
	await openVault(page);

	await expect(
		page.getByText("Vault list temporarily unavailable")
	).toBeVisible();
	expect(
		requestsFor(fixture, "GET", VAULT_PATH).map((request) => request.status)
	).toEqual([503]);
	await capture(page, "desktop-vault-metadata-read-error");

	await page.getByRole("button", { name: "Refresh vault" }).click();
	await expect(
		page.getByText("No secrets here", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Vault list temporarily unavailable")
	).toHaveCount(0);
	expect(
		requestsFor(fixture, "GET", VAULT_PATH).map((request) => request.status)
	).toEqual([503, 200]);
	for (const request of requestsFor(fixture, "GET", VAULT_PATH)) {
		expect(request.authorization).toBe(`Bearer ${NODE_TOKEN}`);
	}
	await capture(page, "desktop-vault-metadata-refresh-recovered");
});

test("writes exact user/node/team/org payloads, retains a failed Team draft, and keeps values out of metadata", async ({
	page,
}) => {
	const fixture = await installVaultApi(page);
	await openVault(page);

	const nameInput = page.getByLabel("Name");
	const valueInput = page.getByLabel("Value");
	const bindingInput = page.getByLabel(/MCP binding/);
	const saveButton = page.getByRole("button", {
		name: "Save secret",
		exact: true,
	});
	await expect(valueInput).toHaveAttribute("type", "password");

	await nameInput.fill("bad-token");
	await valueInput.fill("not-yet-stored-value");
	await saveButton.click();
	await expect(
		page.getByText(
			"Use a letter or underscore followed by letters, numbers, or underscores."
		)
	).toBeVisible();
	expect(
		fixture.requests.filter((request) => request.method === "PUT")
	).toHaveLength(0);

	const cases: [SaveCase, SaveCase, SaveCase, SaveCase] = [
		{
			name: "USER_TOKEN",
			scope: "user",
			value: "secret-user-123",
		},
		{
			bindingId: "github",
			name: "NODE_TOKEN",
			scope: "node",
			value: "secret-node-456",
		},
		{
			bindingId: "io.example/github",
			name: "TEAM_TOKEN",
			scope: "team",
			scopeId: "team-sales",
			value: "secret-team-789",
		},
		{
			name: "ORG_TOKEN",
			scope: "org",
			value: "secret-org-012",
		},
	];
	const expectedRequests: {
		body: SetVaultSecretInput;
		path: string;
		status: number;
	}[] = [];
	void expectedRequests;

	for (const entry of cases) {
		await selectScope(page, entry.scope);
		await nameInput.fill(
			entry.name === "USER_TOKEN" ? "  USER_TOKEN  " : entry.name
		);
		await valueInput.fill(entry.value);
		await bindingInput.fill(entry.bindingId ?? "");
		if (entry.scope === "team") {
			await page.getByLabel("Team id").fill(entry.scopeId ?? "");
			fixture.failNext(
				"PUT",
				`${VAULT_PATH}/${entry.name}`,
				503,
				"Vault write temporarily unavailable"
			);
		}

		await saveButton.click();
		const expectedBody = expectedSetBody(entry);
		const requestPath = `${VAULT_PATH}/${encodeURIComponent(entry.name)}`;
		if (entry.scope === "team") {
			await expect(
				page.getByText("Vault write temporarily unavailable")
			).toBeVisible();
			await expect(nameInput).toHaveValue(entry.name);
			await expect(valueInput).toHaveValue(entry.value);
			await expect(page.getByLabel("Team id")).toHaveValue(entry.scopeId ?? "");
			await expect(bindingInput).toHaveValue(entry.bindingId ?? "");
			expect(requestsFor(fixture, "PUT", requestPath).at(-1)).toMatchObject({
				body: expectedBody,
				status: 503,
			});
			await capture(page, "desktop-vault-team-save-error-draft-retained");
			await saveButton.click();
		}

		await expect(page.getByText(entry.name, { exact: true })).toBeVisible();
		await expect(valueInput).toHaveValue("");
		await expect(
			page.getByText("Vault write temporarily unavailable")
		).toHaveCount(0);
		const writes = requestsFor(fixture, "PUT", requestPath);
		const isRetriedTeam = entry.scope === "team";
		const lastWrite = writes.at(-1);
		expect(lastWrite).toMatchObject({ body: expectedBody, status: 200 });
		expect(writes).toHaveLength(isRetriedTeam ? 2 : 1);
		expect(lastWrite?.authorization).toBe(`Bearer ${NODE_TOKEN}`);
		expect(
			fixture.readState().secrets.some((secret) => secret.name === entry.name)
		).toBe(true);
		expect(JSON.stringify(fixture.readState())).not.toContain(entry.value);

		const scopeId =
			entry.scopeId ??
			(entry.scope === "user"
				? "user-alex"
				: entry.scope === "node"
					? "node-local"
					: "org-acme");
		expect(
			fixture.readStoredValue(entry.scope, entry.name, scopeId, entry.bindingId)
		).toBe(entry.value);
		for (const request of requestsFor(fixture, "GET", VAULT_PATH)) {
			expect(request.authorization).toBe(`Bearer ${NODE_TOKEN}`);
		}
	}

	const writes = fixture.requests.filter((request) => request.method === "PUT");
	expect(
		writes.map(({ body, path: requestPath, status }) => ({
			body,
			path: requestPath,
			status,
		}))
	).toEqual([
		{
			body: expectedSetBody(cases[0]),
			path: `${VAULT_PATH}/USER_TOKEN`,
			status: 200,
		},
		{
			body: expectedSetBody(cases[1]),
			path: `${VAULT_PATH}/NODE_TOKEN`,
			status: 200,
		},
		{
			body: expectedSetBody(cases[2]),
			path: `${VAULT_PATH}/TEAM_TOKEN`,
			status: 503,
		},
		{
			body: expectedSetBody(cases[2]),
			path: `${VAULT_PATH}/TEAM_TOKEN`,
			status: 200,
		},
		{
			body: expectedSetBody(cases[3]),
			path: `${VAULT_PATH}/ORG_TOKEN`,
			status: 200,
		},
	]);
	expect(requestsFor(fixture, "GET", VAULT_PATH)).toHaveLength(
		cases.length + 1
	);
	const bodyText = await page.locator("body").innerText();
	for (const entry of cases) {
		expect(bodyText).not.toContain(entry.value);
	}
	await capture(page, "desktop-vault-scoped-secrets-persisted");
});

test("hides shared scopes from a member who cannot manage them", async ({
	page,
}) => {
	const fixture = await installVaultApi(page, {
		canManageShared: false,
		role: "member",
	});
	await openVault(page);
	await page.getByRole("combobox", { name: "Scope" }).click();

	await expect(page.getByRole("option", { name: /^User\b/u })).toBeEnabled();
	await expect(page.getByRole("option", { name: /^Node\b/u })).toBeEnabled();
	await expect(page.getByRole("option", { name: /^Team\b/u })).toBeDisabled();
	await expect(
		page.getByRole("option", { name: /^Organization\b/u })
	).toBeDisabled();
	expect(
		fixture.requests.filter((request) => request.method !== "GET")
	).toEqual([]);
	await capture(page, "desktop-vault-shared-scopes-permission-gated");
});

test("refreshes metadata and makes clear cancellation, failure, and retry explicit", async ({
	page,
}) => {
	const existingSecret: VaultFixtureSecret = {
		binding: { kind: "mcp", id: "io.example/github" },
		name: "ORGANIZATION_TOKEN",
		scope: "org",
		scopeId: "org-acme",
		updatedAt: UPDATED_AT,
	};
	const refreshedSecret: VaultFixtureSecret = {
		name: "NODE_ROTATION_TOKEN",
		scope: "node",
		scopeId: "node-local",
		updatedAt: UPDATED_AT,
	};
	const fixture = await installVaultApi(page, {
		initialSecrets: [existingSecret],
		initialValues: [
			{
				bindingId: "io.example/github",
				name: existingSecret.name,
				scope: "org",
				scopeId: "org-acme",
				value: "initial-secret-never-returned",
			},
		],
	});
	await openVault(page);
	fixture.addSecretMetadata(refreshedSecret);
	await page.getByRole("button", { name: "Refresh vault" }).click();
	await expect(
		page.getByText("NODE_ROTATION_TOKEN", { exact: true })
	).toBeVisible();
	expect(requestsFor(fixture, "GET", VAULT_PATH)).toHaveLength(2);

	await page.getByRole("button", { name: "Delete ORGANIZATION_TOKEN" }).click();
	await expect(
		page.getByRole("heading", { name: "Delete this secret?" })
	).toBeVisible();
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Delete this secret?" })
	).toHaveCount(0);
	expect(
		fixture.requests.filter((request) => request.method === "DELETE")
	).toHaveLength(0);
	await expect(
		page.getByText("ORGANIZATION_TOKEN", { exact: true })
	).toBeVisible();

	await page.getByRole("button", { name: "Delete ORGANIZATION_TOKEN" }).click();
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("heading", { name: "Delete this secret?" })
	).toHaveCount(0);
	expect(
		fixture.requests.filter((request) => request.method === "DELETE")
	).toHaveLength(0);

	fixture.failNext(
		"DELETE",
		`${VAULT_PATH}/ORGANIZATION_TOKEN`,
		503,
		"Vault delete temporarily unavailable"
	);
	await page.getByRole("button", { name: "Delete ORGANIZATION_TOKEN" }).click();
	await page
		.getByRole("button", { name: "Delete secret", exact: true })
		.click();
	await expect(page.getByRole("alert")).toHaveText(
		"Vault delete temporarily unavailable"
	);
	await expect(
		page.getByRole("heading", { name: "Delete this secret?" })
	).toBeVisible();
	await expect(
		page.getByText("ORGANIZATION_TOKEN", { exact: true })
	).toBeVisible();
	expect(
		fixture.readStoredValue(
			"org",
			"ORGANIZATION_TOKEN",
			"org-acme",
			"io.example/github"
		)
	).toBe("initial-secret-never-returned");
	expect(
		requestsFor(fixture, "DELETE", `${VAULT_PATH}/ORGANIZATION_TOKEN`).at(-1)
	).toMatchObject({
		body: {
			binding: { kind: "mcp", id: "io.example/github" },
			scope: "org",
		},
		status: 503,
	});
	await capture(page, "desktop-vault-clear-error-retry");

	await page
		.getByRole("button", { name: "Delete secret", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Delete this secret?" })
	).toHaveCount(0);
	await expect(
		page.getByText("ORGANIZATION_TOKEN", { exact: true })
	).toHaveCount(0);
	await expect(
		page.getByText("NODE_ROTATION_TOKEN", { exact: true })
	).toBeVisible();
	expect(fixture.readState().secrets.map((secret) => secret.name)).toEqual([
		"NODE_ROTATION_TOKEN",
	]);
	expect(
		fixture.readStoredValue(
			"org",
			"ORGANIZATION_TOKEN",
			"org-acme",
			"io.example/github"
		)
	).toBeUndefined();
	expect(
		requestsFor(fixture, "DELETE", `${VAULT_PATH}/ORGANIZATION_TOKEN`).map(
			(request) => request.status
		)
	).toEqual([503, 200]);
	expect(requestsFor(fixture, "GET", VAULT_PATH)).toHaveLength(3);
	await capture(page, "desktop-vault-secret-clear-readback");
});
