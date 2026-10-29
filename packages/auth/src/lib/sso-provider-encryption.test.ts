import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
	type BetterAuthAdapter,
	openSsoProviderRecord,
	sealSsoProviderRecord,
	wrapSsoProviderAdapter,
} from "./sso-provider-encryption.ts";

const oidcConfigSchema = z.object({
	clientId: z.string(),
	clientSecret: z.string(),
});

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

describe("SSO provider field encryption", () => {
	it("aborts direct and transactional writes when encryption fails", async () => {
		const originalKey = process.env.RYU_DB_MASTER_KEY;
		const originalOverride = process.env.RYU_DB_ALLOW_PLAINTEXT_SECRETS;
		process.env.RYU_DB_MASTER_KEY = Buffer.from("too-short").toString("base64");
		delete process.env.RYU_DB_ALLOW_PLAINTEXT_SECRETS;
		const writes: string[] = [];
		const passthrough = async () => null;
		const transactionAdapter = {
			id: "fixture",
			create: async (input: Parameters<BetterAuthAdapter["create"]>[0]) => {
				writes.push(`create:${input.model}`);
				return input.data;
			},
			findOne: passthrough,
			findMany: async () => [],
			count: async () => 0,
			update: async (input: Parameters<BetterAuthAdapter["update"]>[0]) => {
				writes.push(`update:${input.model}`);
				return input.update;
			},
			updateMany: async (
				input: Parameters<BetterAuthAdapter["updateMany"]>[0]
			) => {
				writes.push(`updateMany:${input.model}`);
				return 1;
			},
			delete: passthrough,
			deleteMany: async () => 0,
			consumeOne: passthrough,
			incrementOne: passthrough,
		} as unknown as Omit<BetterAuthAdapter, "transaction">;
		const adapter: BetterAuthAdapter = {
			...transactionAdapter,
			transaction: async (callback) => callback(transactionAdapter),
		};
		const wrapped = wrapSsoProviderAdapter(adapter);
		const secretRecord = {
			oidcConfig: JSON.stringify({
				clientId: "client",
				clientSecret: "secret",
			}),
		};
		try {
			await expect(
				wrapped.create({ model: "ssoProvider", data: secretRecord })
			).rejects.toThrow("RYU_DB_MASTER_KEY");
			await expect(
				wrapped.update({
					model: "ssoProvider",
					update: secretRecord,
					where: [],
				})
			).rejects.toThrow("RYU_DB_MASTER_KEY");
			await expect(
				wrapped.transaction((transaction) =>
					transaction.updateMany({
						model: "ssoProvider",
						update: secretRecord,
						where: [],
					})
				)
			).rejects.toThrow("RYU_DB_MASTER_KEY");
			expect(writes).toEqual([]);
		} finally {
			if (originalKey === undefined) {
				delete process.env.RYU_DB_MASTER_KEY;
			} else {
				process.env.RYU_DB_MASTER_KEY = originalKey;
			}
			if (originalOverride === undefined) {
				delete process.env.RYU_DB_ALLOW_PLAINTEXT_SECRETS;
			} else {
				process.env.RYU_DB_ALLOW_PLAINTEXT_SECRETS = originalOverride;
			}
		}
	});

	it("reads a provider row whose organization reference is an ObjectId", () => {
		const originalKey = process.env.RYU_DB_MASTER_KEY;
		process.env.RYU_DB_MASTER_KEY = TEST_KEY;
		try {
			const organizationId = {
				toHexString: () => "64c000000000000000000077",
			};
			const sealed = sealSsoProviderRecord({
				oidcConfig: JSON.stringify({
					clientId: "client",
					clientSecret: "secret",
				}),
				organizationId,
			});
			const opened = openSsoProviderRecord(sealed);
			expect(opened.organizationId).toBe(organizationId);
			expect(oidcConfigSchema.parse(JSON.parse(opened.oidcConfig))).toEqual({
				clientId: "client",
				clientSecret: "secret",
			});
		} finally {
			if (originalKey === undefined) {
				delete process.env.RYU_DB_MASTER_KEY;
			} else {
				process.env.RYU_DB_MASTER_KEY = originalKey;
			}
		}
	});

	it("preserves adapter writes and encrypts transaction writes with date fields", async () => {
		const originalKey = process.env.RYU_DB_MASTER_KEY;
		process.env.RYU_DB_MASTER_KEY = TEST_KEY;
		const writes: Parameters<BetterAuthAdapter["updateMany"]>[0][] = [];
		const unused = async () => {
			throw new Error("Unexpected adapter operation");
		};
		const transactionAdapter: Omit<BetterAuthAdapter, "transaction"> = {
			id: "fixture",
			create: unused,
			findOne: unused,
			findMany: unused,
			count: unused,
			update: unused,
			updateMany: async (input) => {
				writes.push(input);
				return 1;
			},
			delete: unused,
			deleteMany: unused,
			consumeOne: unused,
			incrementOne: unused,
		};
		const adapter: BetterAuthAdapter = {
			...transactionAdapter,
			transaction: async (callback) => callback(transactionAdapter),
		};
		const wrapped = wrapSsoProviderAdapter(adapter);
		try {
			const unrelatedUpdate = { name: "Visible user" };
			expect(
				await wrapped.updateMany({
					model: "user",
					update: unrelatedUpdate,
					where: [],
				})
			).toBe(1);
			expect(writes.at(0)?.update).toBe(unrelatedUpdate);
			const createdAt = new Date("2026-01-01T00:00:00Z");
			expect(
				await wrapped.transaction((transaction) =>
					transaction.updateMany({
						model: "ssoProvider",
						update: {
							createdAt,
							oidcConfig: { clientId: "client", clientSecret: "secret" },
						},
						where: [],
					})
				)
			).toBe(1);
			const stored = z
				.object({ createdAt: z.date(), oidcConfig: oidcConfigSchema })
				.parse(writes.at(1)?.update);
			expect(stored.createdAt).toEqual(createdAt);
			expect(stored.oidcConfig.clientId).toBe("client");
			expect(stored.oidcConfig.clientSecret).not.toBe("secret");
			expect(openSsoProviderRecord(stored).oidcConfig.clientSecret).toBe(
				"secret"
			);
		} finally {
			if (originalKey === undefined) {
				delete process.env.RYU_DB_MASTER_KEY;
			} else {
				process.env.RYU_DB_MASTER_KEY = originalKey;
			}
		}
	});

	it("seals OIDC, SAML, and domain-verification secrets at rest", () => {
		const originalKey = process.env.RYU_DB_MASTER_KEY;
		const originalOverride = process.env.RYU_DB_ALLOW_PLAINTEXT_SECRETS;
		process.env.RYU_DB_MASTER_KEY = TEST_KEY;
		delete process.env.RYU_DB_ALLOW_PLAINTEXT_SECRETS;

		try {
			const sealed = sealSsoProviderRecord({
				domainVerificationToken: "dns-secret",
				oidcConfig: JSON.stringify({
					clientId: "client-id",
					clientSecret: "oidc-secret",
				}),
				samlConfig: {
					cert: "saml-cert",
					entryPoint: "https://idp.example/sso",
					idpMetadata: {
						cert: "idp-cert",
						metadata: "saml-metadata",
						privateKey: "idp-key",
						privateKeyPass: "idp-key-pass",
					},
					privateKey: "saml-key",
					spMetadata: {
						privateKey: "sp-key",
						privateKeyPass: "sp-key-pass",
					},
				},
			});
			const sealedRecord = sealed;
			const sealedOidc = oidcConfigSchema.parse(
				JSON.parse(sealedRecord.oidcConfig)
			);
			const sealedSaml = sealedRecord.samlConfig;

			expect(sealedRecord.domainVerificationToken).not.toBe("dns-secret");
			expect(sealedOidc.clientSecret).not.toBe("oidc-secret");
			expect(sealedSaml.cert).not.toBe("saml-cert");
			expect(sealedSaml.idpMetadata.metadata).not.toBe("saml-metadata");
			expect(sealedSaml.idpMetadata.privateKey).not.toBe("idp-key");
			expect(sealedSaml.privateKey).not.toBe("saml-key");
			expect(sealedSaml.spMetadata.privateKey).not.toBe("sp-key");

			const opened = openSsoProviderRecord(sealed);
			expect({
				...opened,
				oidcConfig: oidcConfigSchema.parse(JSON.parse(opened.oidcConfig)),
			}).toEqual({
				domainVerificationToken: "dns-secret",
				oidcConfig: {
					clientId: "client-id",
					clientSecret: "oidc-secret",
				},
				samlConfig: {
					cert: "saml-cert",
					entryPoint: "https://idp.example/sso",
					idpMetadata: {
						cert: "idp-cert",
						metadata: "saml-metadata",
						privateKey: "idp-key",
						privateKeyPass: "idp-key-pass",
					},
					privateKey: "saml-key",
					spMetadata: {
						privateKey: "sp-key",
						privateKeyPass: "sp-key-pass",
					},
				},
			});
		} finally {
			if (originalKey === undefined) {
				delete process.env.RYU_DB_MASTER_KEY;
			} else {
				process.env.RYU_DB_MASTER_KEY = originalKey;
			}
			if (originalOverride === undefined) {
				delete process.env.RYU_DB_ALLOW_PLAINTEXT_SECRETS;
			} else {
				process.env.RYU_DB_ALLOW_PLAINTEXT_SECRETS = originalOverride;
			}
		}
	});
});
