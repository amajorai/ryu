import { expect, test } from "bun:test";
import { listVaultSecrets, type VaultListResponse } from "../vault.ts";
import { VAULT_VALUE_TYPES, vaultValueType } from "./value-types.ts";

test("vaultValueType applies Core's defaults", () => {
	expect(vaultValueType({ valueType: "config" })).toBe("config");
	expect(vaultValueType({ valueType: "secret" })).toBe("secret");
	expect(vaultValueType({ valueType: "sealed" })).toBe("sealed");
	// Written before types existed.
	expect(vaultValueType({})).toBe("secret");
	expect(vaultValueType({ valueType: null })).toBe("secret");
	expect(vaultValueType(undefined)).toBe("secret");
	// A type this client does not know is never less protected than sealed.
	expect(vaultValueType({ valueType: "public" })).toBe("sealed");
	expect(VAULT_VALUE_TYPES).toEqual(["config", "secret", "sealed"]);
});

function secret(name: string, valueType?: string) {
	return {
		scope: "user",
		scopeId: "u1",
		environment: "dev",
		path: "/",
		name,
		version: 1,
		status: "active",
		metadata: {
			description: "",
			tags: [],
			expiresAt: null,
			rotationPeriodSecs: null,
			generator: null,
			expandReferences: false,
			maxVersions: 10,
			...(valueType === undefined ? {} : { valueType }),
		},
		capabilities: ["list", "read"],
		createdAt: null,
		createdBy: null,
		updatedAt: null,
		updatedBy: null,
		rotatedAt: null,
	};
}

test("listings carry metadata.valueType, and an unknown type still parses", async () => {
	const body = {
		activeEnvironment: "dev",
		caller: null,
		canManageShared: false,
		node: {
			id: "n1",
			orgId: null,
			ownerUserId: null,
			scope: "local",
			teamId: null,
		},
		seal: {
			activeKeyVersion: 1,
			keyVersions: [1],
			mode: "auto",
			progress: 0,
			sealed: false,
			shares: 1,
			threshold: 1,
		},
		secrets: [
			secret("LOG_LEVEL", "config"),
			secret("API_KEY"),
			secret("SIGNING_KEY", "sealed"),
			secret("FUTURE", "public"),
		],
		sharedError: null,
		sharedRemote: false,
	};
	const fetchImpl = () => Promise.resolve(Response.json(body));
	const result: VaultListResponse = await listVaultSecrets({
		url: "http://core.test",
		token: null,
		fetch: fetchImpl,
	});
	expect(
		result.secrets.map((value) => [value.name, vaultValueType(value.metadata)])
	).toEqual([
		["LOG_LEVEL", "config"],
		["API_KEY", "secret"],
		["SIGNING_KEY", "sealed"],
		["FUTURE", "sealed"],
	]);
});
