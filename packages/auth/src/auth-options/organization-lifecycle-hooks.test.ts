import {
	afterAll,
	afterEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";

/**
 * The organization name and slug are the publisher line on every Marketplace
 * card. These pin the Better Auth hooks that keep them off protected vendor and
 * Ryu names: creation is refused unless a platform admin creates it, and a
 * rename is refused unless the organization holds a current official or
 * partner staff verdict whose approved legal name is that brand. Only the Mongo
 * client, `Organization.findById` and `OrgVerificationRequest.findOne` are
 * stubbed.
 */
Object.assign(process.env, {
	ADMIN_EMAILS: "",
	BETTER_AUTH_SECRET: "organization-lifecycle-hooks-".repeat(3),
	BETTER_AUTH_URL: "http://localhost:3000",
	DATABASE_URL: "mongodb://127.0.0.1:1/unused-organization-lifecycle-fixture",
	NODE_ENV: "test",
	POLAR_ACCESS_TOKEN: "local-test",
	POLAR_BILLING_AUTHORITY: "local",
	POLAR_SERVER: "sandbox",
	POLAR_SUCCESS_URL: "http://localhost:3001/success",
	RYU_DB_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
	RYU_DIR: "/tmp/ryu-dev-headless",
	RYU_KEYCHAIN: "off",
	RYU_PROFILE: "dev",
});
mock.module("@ryu/db", () => ({ client: {}, mongoClient: {} }));

const { Organization } = await import("@ryu/db/models/control-plane.model");
const { OrgVerificationRequest } = await import(
	"@ryu/db/models/org-verification.model"
);
const { organizationIdentityRevision } = await import(
	"@ryu/db/organization-identity"
);
const { ReservedOrganizationIdentityError } = await import(
	"@ryu/db/organization-reserved-identity"
);
const { organizationLifecycleHooks } = await import(
	"./organization-lifecycle-hooks.ts"
);

afterEach(() => {
	mock.restore();
});
afterAll(() => {
	mock.restore();
});

type CreateInput = Parameters<
	NonNullable<typeof organizationLifecycleHooks.beforeCreateOrganization>
>[0];
type UpdateInput = Parameters<
	NonNullable<typeof organizationLifecycleHooks.beforeUpdateOrganization>
>[0];

const NOW = new Date("2026-01-01T00:00:00.000Z");
const person = {
	createdAt: NOW,
	email: "person@gmail.com",
	emailVerified: true,
	id: "user-1",
	name: "Person",
	role: "approved",
	updatedAt: NOW,
};

async function create(
	organization: { name: string; slug: string },
	user: Partial<typeof person> = {}
) {
	return await organizationLifecycleHooks.beforeCreateOrganization?.({
		organization: { ...organization, createdAt: NOW },
		user: { ...person, ...user },
	} as unknown as CreateInput);
}

async function refusalOf(run: () => Promise<unknown>): Promise<unknown> {
	try {
		await run();
	} catch (error) {
		return error;
	}
	return null;
}

describe("creating an organization under a protected brand", () => {
	it("refuses a vendor or Ryu name or slug as a 422 reserved_identity", async () => {
		for (const organization of [
			{ name: "OpenAI", slug: "acme-labs" },
			{ name: "Anthrоpic", slug: "acme-labs" },
			{ name: "Acme Labs", slug: "openai" },
			// The personal-workspace path is no way around it.
			{ name: "Ryu Team", slug: "personal-1234" },
		]) {
			const refusal = await refusalOf(() => create(organization));
			expect(refusal).toBeInstanceOf(ReservedOrganizationIdentityError);
			expect((refusal as { statusCode?: number }).statusCode).toBe(422);
		}
	});

	it("creates ordinary organizations, and protected ones for platform admins", async () => {
		const personal = await create({ name: "Personal", slug: "personal-1" });
		expect(personal?.data.name).toBe("Personal");
		const staff = await create(
			{ name: "Ryu Team", slug: "personal-2" },
			{ role: "admin" }
		);
		expect(staff?.data.name).toBe("Ryu Team");
	});
});

describe("renaming an organization into a protected brand", () => {
	const identity = { logo: null, name: "Acme", slug: "acme" };

	/** The approved requests on record; the stub applies the hook's filter. */
	let requests: Record<string, unknown>[] = [];
	const requestFilters: Record<string, unknown>[] = [];

	function storedRequests(rows: Record<string, unknown>[]) {
		requests = rows;
		spyOn(OrgVerificationRequest, "findOne").mockImplementation(((
			filter: Record<string, unknown>
		) => {
			requestFilters.push(filter);
			const row = requests.find((request) =>
				Object.entries(filter).every(([key, value]) => request[key] === value)
			);
			return {
				select: () => ({ lean: async () => row ?? null }),
			};
		}) as unknown as typeof OrgVerificationRequest.findOne);
	}

	const approved = (legalName: string, overrides = {}) => ({
		_id: "request-1",
		legalName,
		organizationId: "org-1",
		status: "approved",
		...overrides,
	});

	/** Serves only the fields the hook selects, like Mongo's projection. */
	function storedOrganization(stored: Record<string, unknown>) {
		spyOn(Organization, "findById").mockImplementation((() => ({
			select: (fields: string) => ({
				lean: async () =>
					Object.fromEntries(
						fields
							.split(" ")
							.filter((field) => field in stored)
							.map((field) => [field, stored[field]])
					),
			}),
		})) as unknown as typeof Organization.findById);
	}

	async function rename(name: string, slug?: string) {
		return await organizationLifecycleHooks.beforeUpdateOrganization?.({
			member: { organizationId: "org-1" },
			organization: slug === undefined ? { name } : { name, slug },
			user: person,
		} as unknown as UpdateInput);
	}

	const verdict = (tier: string) => ({
		...identity,
		verificationRequestId: "request-1",
		verificationTier: tier,
		verified: true,
		verifiedIdentityRevision: organizationIdentityRevision(identity),
	});

	it("lets the vendor's own official or partner organization take its brand", async () => {
		for (const tier of ["official", "partner"]) {
			storedOrganization(verdict(tier));
			storedRequests([approved("OpenAI, L.L.C.")]);
			const updated = await rename("OpenAI");
			expect(updated?.data.name).toBe("OpenAI");
			// Any rename still drops the staff verdict for the old identity.
			expect(updated?.data).toMatchObject({ verified: false });
			mock.restore();
		}
		// Only this organization's approved request vets a brand.
		expect(requestFilters.at(-1)).toEqual({
			_id: "request-1",
			organizationId: "org-1",
			status: "approved",
		});
	});

	it("refuses everyone else", async () => {
		for (const stored of [
			identity,
			verdict("community"),
			{ ...verdict("official"), verified: false },
			{ ...verdict("partner"), revokedVerificationRequestIds: ["request-1"] },
		]) {
			storedOrganization(stored);
			storedRequests([approved("OpenAI, L.L.C.")]);
			expect(await refusalOf(() => rename("OpenAI"))).toBeInstanceOf(
				ReservedOrganizationIdentityError
			);
			mock.restore();
		}
	});

	it("refuses a verified partner a brand its approved legal name is not", async () => {
		for (const [rows, name, slug] of [
			// An ordinary company's partner verdict vets no brand.
			[[approved("Acme Corp")], "OpenAI", undefined],
			// The vendor's verdict covers its own brand, not a rival's.
			[[approved("Anthropic, PBC")], "OpenAI", undefined],
			[[approved("Anthropic, PBC")], "Anthropic", "gemini"],
			// A request that is not this organization's approved one vets nothing.
			[
				[approved("OpenAI, L.L.C.", { status: "revoked" })],
				"OpenAI",
				undefined,
			],
			[
				[approved("OpenAI, L.L.C.", { organizationId: "org-2" })],
				"OpenAI",
				undefined,
			],
			[[approved("OpenAI, L.L.C.", { _id: "request-2" })], "OpenAI", undefined],
		] as const) {
			storedOrganization(verdict("partner"));
			storedRequests([...rows]);
			expect(await refusalOf(() => rename(name, slug))).toBeInstanceOf(
				ReservedOrganizationIdentityError
			);
			mock.restore();
		}
	});
});
