import { describe, expect, it } from "bun:test";
import { scim } from "@better-auth/scim";
import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { z } from "zod";
import { scimAdminEmailGuardPlugin } from "./scim-admin-email-guard.ts";
import { createScimIdentity } from "./scim-deprovisioning.ts";
import { SCIM_EMAIL_DOMAIN_DETAIL } from "./scim-email-domain-guard.ts";

/**
 * The verified-domain binding driven through the installed `@better-auth/scim`
 * managed connections, wired the way `index.ts` wires them (Ryu's identity
 * resolver plus the SCIM email guard plugin). A directory can only create, or
 * rename an account to, an address on a DNS-verified SSO domain of its own
 * organization.
 */

const SECRET = "scim-email-domain-guard-test-secret-long-enough";
const BASE_URL = "http://localhost:3000";
const ORGANIZATION_ID = "64c000000000000000000077";
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const issuedSchema = z.object({ token: z.string() });
const createdSchema = z.object({ id: z.string() });

function createAuth(tables: Record<string, Record<string, unknown>[]>) {
	return betterAuth({
		baseURL: BASE_URL,
		database: memoryAdapter(tables),
		plugins: [
			sso({ domainVerification: { enabled: true } }),
			scim({
				connections: [],
				identity: createScimIdentity(),
				managedConnections: {
					credentialHashSecret: SECRET,
					maxActiveCredentials: 5,
				},
			}),
			scimAdminEmailGuardPlugin(),
		],
		secret: SECRET,
	});
}

async function harness(
	providers: { domain: string; domainVerified: boolean }[]
) {
	const tables: Record<string, Record<string, unknown>[]> = {};
	const auth = createAuth(tables);
	for (const table of Object.values((await auth.$context).tables)) {
		tables[table.modelName] ??= [];
	}
	tables.ssoProvider = providers.map((provider, index) => ({
		id: `sso-${index}`,
		issuer: `https://idp.${provider.domain}`,
		organizationId: ORGANIZATION_ID,
		providerId: `provider-${index}`,
		userId: "owner",
		...provider,
	}));
	const issued = issuedSchema.parse(
		await auth.api.createSCIMManagedConnection({
			body: {
				actorId: "admin",
				creationRequestId: "ryu-scim-domain-guard-request",
				expiresAt: new Date(Date.now() + YEAR_MS),
				provisioningDomainId: ORGANIZATION_ID,
				scopes: ["scim.users.read", "scim.users.write"],
			},
		})
	);
	const send = (path: string, method: string, body: unknown) =>
		auth.handler(
			new Request(`${BASE_URL}/api/auth/scim/v2/Users${path}`, {
				body: JSON.stringify(body),
				headers: {
					authorization: `Bearer ${issued.token}`,
					"content-type": "application/scim+json",
				},
				method,
			})
		);
	return { send, tables };
}

function userResource(email: string) {
	return {
		emails: [{ primary: true, value: email }],
		schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
		userName: email,
	};
}

function renameTo(email: string) {
	return {
		Operations: [
			{
				op: "replace",
				path: "emails",
				value: [{ primary: true, value: email }],
			},
		],
		schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
	};
}

function userEmails(tables: Record<string, Record<string, unknown>[]>) {
	return (tables.user ?? []).map((user) => user.email);
}

describe("SCIM email domain binding", () => {
	it("refuses to create an account for an address off every verified domain", async () => {
		const { send, tables } = await harness([]);
		const response = await send(
			"",
			"POST",
			userResource("victim@unrelated.test")
		);
		expect(response.status).toBe(403);
		// The SCIM plugin reshapes the refusal into a SCIM Error resource.
		expect(await response.json()).toMatchObject({
			detail: SCIM_EMAIL_DOMAIN_DETAIL,
			status: "403",
		});
		expect(userEmails(tables)).toEqual([]);
	});

	it("refuses a domain the organization registered but never verified", async () => {
		const { send, tables } = await harness([
			{ domain: "acme.test", domainVerified: false },
		]);
		const response = await send("", "POST", userResource("ada@acme.test"));
		expect(response.status).toBe(403);
		expect(userEmails(tables)).toEqual([]);
	});

	it("creates accounts on the organization's verified domain and its subdomains", async () => {
		const { send, tables } = await harness([
			{ domain: "acme.test", domainVerified: true },
		]);
		expect((await send("", "POST", userResource("ada@acme.test"))).status).toBe(
			201
		);
		expect(
			(await send("", "POST", userResource("bob@eu.acme.test"))).status
		).toBe(201);
		expect(userEmails(tables)).toEqual(["ada@acme.test", "bob@eu.acme.test"]);
	});

	it("refuses to rename an adopted account to an address the directory controls", async () => {
		const { send, tables } = await harness([
			{ domain: "acme.test", domainVerified: true },
		]);
		const created = await send("", "POST", userResource("a@acme.test"));
		expect(created.status).toBe(201);
		const scimUserId = createdSchema.parse(await created.json()).id;
		// The real owner proves the mailbox (email code or magic link).
		const stored = tables.user?.find((user) => user.email === "a@acme.test");
		if (!stored) {
			throw new Error("SCIM user was not created");
		}
		stored.emailVerified = true;

		const renamed = await send(
			`/${scimUserId}`,
			"PATCH",
			renameTo("b@evil.test")
		);
		expect(renamed.status).toBe(403);
		const replaced = await send(
			`/${scimUserId}`,
			"PUT",
			userResource("b@evil.test")
		);
		expect(replaced.status).toBe(403);
		expect(stored.email).toBe("a@acme.test");
		expect(stored.emailVerified).toBe(true);
	});

	it("still renames within the organization's verified domains", async () => {
		const { send, tables } = await harness([
			{ domain: "acme.test", domainVerified: true },
		]);
		const created = await send("", "POST", userResource("a@acme.test"));
		const scimUserId = createdSchema.parse(await created.json()).id;
		const renamed = await send(
			`/${scimUserId}`,
			"PATCH",
			renameTo("ada@eu.acme.test")
		);
		expect(renamed.status).toBe(200);
		expect(userEmails(tables)).toEqual(["ada@eu.acme.test"]);
	});
});
