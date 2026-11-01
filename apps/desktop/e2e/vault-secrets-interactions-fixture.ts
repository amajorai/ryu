// Fixture and helpers for the Vault secrets interactions proof (split from
// vault-secrets-interactions-proof.spec.ts to stay under the file size limit).
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
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
export type VaultFixtureSecret = Pick<
	VaultSecret,
	"binding" | "name" | "scope" | "scopeId" | "updatedAt"
>;
interface VaultFixtureState
	extends Pick<VaultState, "caller" | "canManageShared" | "node"> {
	secrets: VaultFixtureSecret[];
}

const PROOF_PAGE = "/vault-proof.html";
export const VAULT_PATH = "/api/vault/secrets";
export const NODE_TOKEN = "vault-proof-token";
export const UPDATED_AT = "2026-10-01T12:00:00.000Z";

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

export interface SaveCase {
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

export async function installVaultApi(
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
		// Core answers a vault write or delete with 200 and a JSON body
		// (`{ ok: true, ... }` in apps/core/src/server/vault_api.rs, already so at
		// 07d403e33, before Ryu Quiet), and the client's write contract rejects an
		// empty body, so the fixture does not answer 204.
		const respondOk = async () => {
			await respondJson(200, { ok: true });
		};

		if (method === "GET" && url.pathname === VAULT_PATH) {
			// Core lists each secret with the caller's capabilities, and a row
			// offers Delete only with "delete" (already so at 07d403e33).
			await respondJson(200, {
				...state,
				secrets: state.secrets.map((secret) => ({
					...secret,
					capabilities: ["list", "read", "write", "delete"],
				})),
			});
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
			await respondOk();
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
			await respondOk();
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

export async function openVault(page: Page): Promise<void> {
	await page.goto(PROOF_PAGE);
	await expect(
		page.getByRole("heading", { name: "Vault", exact: true })
	).toBeVisible();
}

export async function selectScope(
	page: Page,
	scope: VaultScope
): Promise<void> {
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

export async function capture(page: Page, name: string): Promise<void> {
	const target = evidencePath(name);
	await mkdir(path.dirname(target), { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: target,
	});
}

export function requestsFor(
	fixture: VaultProofFixture,
	method: string,
	requestPath: string
): CapturedRequest[] {
	return fixture.requests.filter(
		(request) => request.method === method && request.path === requestPath
	);
}

export function expectedSetBody(entry: SaveCase): SetVaultSecretInput {
	return {
		...(entry.scope === "team" && entry.scopeId
			? { scopeId: entry.scopeId }
			: undefined),
		...(entry.bindingId
			? { binding: { kind: "mcp", id: entry.bindingId } }
			: undefined),
		// The page writes into the active environment's current folder (already
		// so at 07d403e33, before Ryu Quiet): "default" and "/" here.
		environment: "default",
		path: "/",
		scope: entry.scope,
		value: entry.value,
	};
}
