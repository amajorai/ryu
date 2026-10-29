import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import type {
	SetVaultSecretInput,
	VaultCallerContext,
	VaultScope,
	VaultSecret,
	VaultState,
} from "@/src/lib/api/vault.ts";

const vaultWriteSchema = z.object({
	scope: z.enum(["user", "node", "team", "org"]),
	scopeId: z.string().optional(),
	binding: z.object({ id: z.string(), kind: z.literal("mcp") }).optional(),
	environment: z.string().optional(),
	path: z.string().optional(),
	expectedVersion: z.number().optional(),
	value: z.string().optional(),
	metadata: z
		.object({
			description: z.string().optional(),
			expandReferences: z.boolean().optional(),
			expiresAt: z.string().nullable().optional(),
			generator: z
				.object({
					charset: z.string(),
					kind: z.literal("random"),
					length: z.number(),
				})
				.nullable()
				.optional(),
			maxVersions: z.number().optional(),
			rotationPeriodSecs: z.number().nullable().optional(),
			tags: z.array(z.string()).optional(),
		})
		.optional(),
}) satisfies z.ZodType<SetVaultSecretInput>;
type VaultFixtureSecret = Pick<
	VaultSecret,
	"binding" | "name" | "scope" | "scopeId" | "updatedAt"
>;
interface VaultFixtureState
	extends Pick<VaultState, "caller" | "canManageShared" | "node"> {
	secrets: VaultFixtureSecret[];
}

const PROOF_PAGE = "/vault-proof.html";
const VAULT_PATH = "/api/vault/secrets";
const NODE_TOKEN = "vault-proof-token";
const UPDATED_AT = "2026-10-01T12:00:00.000Z";

interface CapturedRequest {
	authorization: string | null;
	body: unknown;
	method: string;
	path: string;
	status: number;
}

interface StoredValueSeed {
	bindingId?: string;
	name: string;
	scope: VaultScope;
	scopeId: string;
	value: string;
}

interface VaultFixtureOptions {
	canManageShared?: boolean;
	initialSecrets?: VaultFixtureSecret[];
	initialValues?: StoredValueSeed[];
	role?: VaultCallerContext["role"];
}

interface VaultProofFixture {
	addSecretMetadata: (secret: VaultFixtureSecret) => void;
	failNext: (
		method: string,
		path: string,
		status?: number,
		message?: string
	) => void;
	readState: () => VaultFixtureState;
	readStoredValue: (
		scope: VaultScope,
		name: string,
		scopeId: string,
		bindingId?: string
	) => string | undefined;
	requests: CapturedRequest[];
}

interface PendingFailure {
	message: string;
	status: number;
}

interface SaveCase {
	bindingId?: string;
	name: string;
	scope: VaultScope;
	scopeId?: string;
	value: string;
}

function evidencePath(name: string): string {
	return path.resolve(
		import.meta.dirname,
		`../../../docs/proof/test-coverage-sweep-20260924/evidence/${name}.png`
	);
}

function storageKey(
	scope: VaultScope,
	name: string,
	scopeId: string,
	bindingId = ""
): string {
	return [scope, scopeId, bindingId, name].join(":");
}

function resolvedScopeId(
	state: VaultFixtureState,
	scope: VaultScope,
	scopeId?: string
): string {
	switch (scope) {
		case "user":
			return state.caller?.userId ?? "local-user";
		case "node":
			return state.node.id;
		case "team":
			return scopeId ?? "";
		case "org":
			return state.node.orgId ?? "";
	}
}

function seedValueKey(state: VaultFixtureState, seed: StoredValueSeed): string {
	return storageKey(
		seed.scope,
		seed.name,
		seed.scopeId || resolvedScopeId(state, seed.scope),
		seed.bindingId
	);
}

async function installVaultApi(
	page: Page,
	options: VaultFixtureOptions = {}
): Promise<VaultProofFixture> {
	const role =
		options.role ?? (options.canManageShared === false ? "member" : "owner");
	const state: VaultFixtureState = {
		caller: {
			orgId: "org-acme",
			role,
			teamIds: ["team-sales"],
			userId: "user-alex",
		},
		canManageShared: options.canManageShared ?? true,
		node: {
			id: "node-local",
			orgId: "org-acme",
			ownerUserId: "user-alex",
			scope: "org",
			teamId: null,
		},
		secrets: structuredClone(options.initialSecrets ?? []),
	};
	const requests: CapturedRequest[] = [];
	const storedValues = new Map<string, string | undefined>();
	for (const seed of options.initialValues ?? []) {
		storedValues.set(seedValueKey(state, seed), seed.value);
	}
	const failures = new Map<string, PendingFailure[]>();
	let writeSequence = 0;

	const failNext = (
		method: string,
		requestPath: string,
		status = 503,
		message = "Vault request is temporarily unavailable"
	) => {
		const key = `${method} ${requestPath}`;
		failures.set(key, [...(failures.get(key) ?? []), { message, status }]);
	};

	await page.route("**/api/vault/secrets**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const method = request.method();
		const requestPath = `${url.pathname}${url.search}`;
		const rawBody = request.postData();
		const requestBody: unknown = rawBody ? JSON.parse(rawBody) : null;
		const captured: CapturedRequest = {
			authorization: request.headers().authorization ?? null,
			body: requestBody,
			method,
			path: requestPath,
			status: 0,
		};
		requests.push(captured);

		const failureKey = `${method} ${requestPath}`;
		const pendingFailures = failures.get(failureKey);
		if (pendingFailures?.length) {
			const failure = pendingFailures.shift();
			if (pendingFailures.length === 0) {
				failures.delete(failureKey);
			}
			if (!failure) {
				throw new Error("Vault proof failure queue lost its first item");
			}
			captured.status = failure.status;
			await route.fulfill({
				body: JSON.stringify({ error: failure.message }),
				contentType: "application/json",
				status: failure.status,
			});
			return;
		}

		const respondJson = async <FixturePayload>(
			status: number,
			payload: FixturePayload
		) => {
			captured.status = status;
			await route.fulfill({
				body: JSON.stringify(payload),
				contentType: "application/json",
				status,
			});
		};
		const respondEmpty = async () => {
			captured.status = 204;
			await route.fulfill({ status: 204 });
		};

		if (method === "GET" && url.pathname === VAULT_PATH) {
			await respondJson(200, state);
			return;
		}

		const secretPrefix = `${VAULT_PATH}/`;
		if (
			method === "PUT" &&
			url.pathname.startsWith(secretPrefix) &&
			url.pathname.length > secretPrefix.length
		) {
			const name = decodeURIComponent(url.pathname.slice(secretPrefix.length));
			const input = vaultWriteSchema.parse(requestBody);
			const scopeId = resolvedScopeId(state, input.scope, input.scopeId);
			const bindingId = input.binding?.id ?? "";
			const nextSecret: VaultFixtureSecret = {
				...(input.binding
					? { binding: structuredClone(input.binding) }
					: undefined),
				name,
				scope: input.scope,
				scopeId,
				updatedAt: new Date(
					Date.parse(UPDATED_AT) + writeSequence * 60_000
				).toISOString(),
			};
			writeSequence += 1;
			state.secrets = state.secrets.filter(
				(secret) =>
					storageKey(
						secret.scope,
						secret.name,
						secret.scopeId,
						secret.binding?.id ?? ""
					) !== storageKey(input.scope, name, scopeId, bindingId)
			);
			state.secrets.unshift(nextSecret);
			storedValues.set(
				storageKey(input.scope, name, scopeId, bindingId),
				input.value
			);
			await respondEmpty();
			return;
		}

		if (
			method === "DELETE" &&
			url.pathname.startsWith(secretPrefix) &&
			url.pathname.length > secretPrefix.length
		) {
			const name = decodeURIComponent(url.pathname.slice(secretPrefix.length));
			const input = vaultWriteSchema.omit({ value: true }).parse(requestBody);
			const scopeId = resolvedScopeId(state, input.scope, input.scopeId);
			const bindingId = input.binding?.id ?? "";
			state.secrets = state.secrets.filter(
				(secret) =>
					storageKey(
						secret.scope,
						secret.name,
						secret.scopeId,
						secret.binding?.id ?? ""
					) !== storageKey(input.scope, name, scopeId, bindingId)
			);
			storedValues.delete(storageKey(input.scope, name, scopeId, bindingId));
			await respondEmpty();
			return;
		}

		await respondJson(404, {
			error: `Unexpected Vault proof request: ${method} ${requestPath}`,
		});
	});

	return {
		addSecretMetadata: (secret) => {
			state.secrets.push(structuredClone(secret));
		},
		failNext,
		readState: () => structuredClone(state),
		readStoredValue: (scope, name, scopeId, bindingId) =>
			storedValues.get(storageKey(scope, name, scopeId, bindingId)),
		requests,
	};
}

async function openVault(page: Page): Promise<void> {
	await page.goto(PROOF_PAGE);
	await expect(
		page.getByRole("heading", { name: "Vault", exact: true })
	).toBeVisible();
}

async function selectScope(page: Page, scope: VaultScope): Promise<void> {
	const trigger = page.getByRole("combobox", { name: "Scope" });
	await trigger.click();
	const label =
		scope === "org"
			? "Organization"
			: `${scope[0]?.toUpperCase()}${scope.slice(1)}`;
	const option = page.getByRole("option", { name: new RegExp(`^${label}\\b`) });
	await expect(option).toBeVisible();
	await option.click();
	await expect(trigger).toContainText(label);
}

async function capture(page: Page, name: string): Promise<void> {
	const target = evidencePath(name);
	await mkdir(path.dirname(target), { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: target,
	});
}

function requestsFor(
	fixture: VaultProofFixture,
	method: string,
	requestPath: string
): CapturedRequest[] {
	return fixture.requests.filter(
		(request) => request.method === method && request.path === requestPath
	);
}

function expectedSetBody(entry: SaveCase): SetVaultSecretInput {
	return {
		...(entry.scope === "team" && entry.scopeId
			? { scopeId: entry.scopeId }
			: undefined),
		...(entry.bindingId
			? { binding: { kind: "mcp", id: entry.bindingId } }
			: undefined),
		scope: entry.scope,
		value: entry.value,
	};
}

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

	await expect(page.getByText(`${VAULT_PATH} failed: 503`)).toBeVisible();
	expect(
		requestsFor(fixture, "GET", VAULT_PATH).map((request) => request.status)
	).toEqual([503]);
	await capture(page, "desktop-vault-metadata-read-error");

	await page.getByRole("button", { name: "Refresh vault" }).click();
	await expect(
		page.getByText("No secrets stored", { exact: true })
	).toBeVisible();
	await expect(page.getByText(`${VAULT_PATH} failed: 503`)).toHaveCount(0);
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
				page.getByText(`${VAULT_PATH}/${entry.name} failed: 503`)
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
			page.getByText(`${VAULT_PATH}/${entry.name} failed: 503`)
		).toHaveCount(0);
		const writes = requestsFor(fixture, "PUT", requestPath);
		const isRetriedTeam = entry.scope === "team";
		const lastWrite = writes.at(-1);
		expect(lastWrite).toMatchObject({ body: expectedBody, status: 204 });
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
			status: 204,
		},
		{
			body: expectedSetBody(cases[1]),
			path: `${VAULT_PATH}/NODE_TOKEN`,
			status: 204,
		},
		{
			body: expectedSetBody(cases[2]),
			path: `${VAULT_PATH}/TEAM_TOKEN`,
			status: 503,
		},
		{
			body: expectedSetBody(cases[2]),
			path: `${VAULT_PATH}/TEAM_TOKEN`,
			status: 204,
		},
		{
			body: expectedSetBody(cases[3]),
			path: `${VAULT_PATH}/ORG_TOKEN`,
			status: 204,
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

	await page.getByRole("button", { name: "Clear ORGANIZATION_TOKEN" }).click();
	await expect(
		page.getByRole("heading", { name: "Clear this secret?" })
	).toBeVisible();
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Clear this secret?" })
	).toHaveCount(0);
	expect(
		fixture.requests.filter((request) => request.method === "DELETE")
	).toHaveLength(0);
	await expect(
		page.getByText("ORGANIZATION_TOKEN", { exact: true })
	).toBeVisible();

	await page.getByRole("button", { name: "Clear ORGANIZATION_TOKEN" }).click();
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("heading", { name: "Clear this secret?" })
	).toHaveCount(0);
	expect(
		fixture.requests.filter((request) => request.method === "DELETE")
	).toHaveLength(0);

	fixture.failNext(
		"DELETE",
		`${VAULT_PATH}/ORGANIZATION_TOKEN`,
		503,
		"Vault clear temporarily unavailable"
	);
	await page.getByRole("button", { name: "Clear ORGANIZATION_TOKEN" }).click();
	await page.getByRole("button", { name: "Clear secret", exact: true }).click();
	await expect(page.getByRole("alert")).toHaveText(
		`${VAULT_PATH}/ORGANIZATION_TOKEN failed: 503`
	);
	await expect(
		page.getByRole("heading", { name: "Clear this secret?" })
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

	await page.getByRole("button", { name: "Clear secret", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Clear this secret?" })
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
	).toEqual([503, 204]);
	expect(requestsFor(fixture, "GET", VAULT_PATH)).toHaveLength(3);
	await capture(page, "desktop-vault-secret-clear-readback");
});
