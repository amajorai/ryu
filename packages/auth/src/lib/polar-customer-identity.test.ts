import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

let externalCustomer: { id: string; externalId: string } | null = null;
let externalFailure: Error | null = null;
let knownContract: { polarCustomerId: string } | null = null;
const createdCustomer = {
	id: "created-org",
	externalId: "ryu:organization:B",
	metadata: { scope: "org", orgId: "B" },
};
const createCustomer = mock(async (input: { externalId?: string | null }) =>
	input.externalId?.startsWith("ryu:organization:")
		? createdCustomer
		: { id: "created-personal", externalId: input.externalId, metadata: {} }
);
let personalCustomers: {
	id: string;
	externalId: string | null;
	metadata: Record<string, string>;
}[] = [];
const externalLookup = mock(async (_input: { externalId: string }) => {
	if (externalFailure) {
		throw externalFailure;
	}
	if (!externalCustomer) {
		throw Object.assign(new Error("customer missing"), { statusCode: 404 });
	}
	return { ...externalCustomer, metadata: {} };
});
const emailLookup = mock(() =>
	Promise.resolve({
		async *[Symbol.asyncIterator]() {
			yield { result: { items: personalCustomers } };
		},
	})
);
mock.module("./payments.ts", () => ({
	polarClient: {
		customers: {
			create: createCustomer,
			getExternal: externalLookup,
			list: emailLookup,
		},
	},
}));
mock.module("@ryu/db/models/organization-seat-entitlement.model", () => ({
	OrganizationSeatEntitlement: {
		findOne: () => ({ select: () => ({ lean: async () => knownContract }) }),
	},
}));
mock.module("@ryu/db/models/polar-billing-projection.model", () => ({
	PolarBillingProjection: {
		findOne: () => ({ select: () => ({ lean: async () => null }) }),
	},
}));
const {
	ensurePersonalPolarCustomer,
	resolveOrganizationPolarCustomerId,
	resolvePersonalPolarCustomerId,
} = await import("./polar-customer-identity.ts");

beforeEach(() => {
	externalCustomer = null;
	externalFailure = null;
	knownContract = null;
	personalCustomers = [];
	externalLookup.mockClear();
	emailLookup.mockClear();
	createCustomer.mockClear();
});
afterAll(() => mock.restore());

describe("Polar customer ownership", () => {
	it("recognizes numeric SDK status fallbacks without coercing invalid statuses", async () => {
		externalFailure = Object.assign(new Error("missing"), { status: 404 });
		expect(await resolveOrganizationPolarCustomerId("B")).toBeNull();
		externalFailure = Object.assign(new Error("invalid status"), {
			statusCode: "404",
			status: 404,
		});
		await expect(resolveOrganizationPolarCustomerId("B")).rejects.toBe(
			externalFailure
		);
	});

	it("does not adopt A's customer by shared payer email when B is missing", async () => {
		personalCustomers = [
			{ id: "customer-A", externalId: "ryu:organization:A", metadata: {} },
		];
		expect(await resolveOrganizationPolarCustomerId("B")).toBeNull();
		expect(externalLookup).toHaveBeenCalledWith({
			externalId: "ryu:organization:B",
		});
		expect(emailLookup).not.toHaveBeenCalled();
	});
	it("accepts an exact organization identity", async () => {
		externalCustomer = { id: "customer-B", externalId: "ryu:organization:B" };
		expect(await resolveOrganizationPolarCustomerId("B")).toBe("customer-B");
	});
	it("rejects mismatched provider identity", async () => {
		externalCustomer = { id: "customer-A", externalId: "ryu:organization:A" };
		await expect(resolveOrganizationPolarCustomerId("B")).rejects.toThrow(
			"different billing identity"
		);
	});
	it("blocks duplicate checkout for a known unverified legacy binding", async () => {
		knownContract = { polarCustomerId: "legacy-payer" };
		await expect(resolveOrganizationPolarCustomerId("B")).rejects.toThrow(
			"reconciliation"
		);
		expect(emailLookup).not.toHaveBeenCalled();
	});
	it("creates a team customer when the organization identity is new", async () => {
		const { ensureOrganizationPolarCustomer } = await import(
			"./polar-customer-identity.ts"
		);
		expect(
			await ensureOrganizationPolarCustomer({
				email: "owner@example.com",
				organizationId: "B",
				ownerUserId: "user-B",
			})
		).toBe("created-org");
		expect(createCustomer).toHaveBeenCalledWith(
			expect.objectContaining({
				email: "owner@example.com",
				externalId: "ryu:organization:B",
				type: "team",
			})
		);
	});
	it("turns a provider email collision into an explicit reconciliation error", async () => {
		createCustomer.mockRejectedValueOnce(
			Object.assign(new Error("email already exists"), { statusCode: 422 })
		);
		const { ensureOrganizationPolarCustomer } = await import(
			"./polar-customer-identity.ts"
		);
		await expect(
			ensureOrganizationPolarCustomer({
				email: "owner@example.com",
				organizationId: "B",
			})
		).rejects.toMatchObject({
			code: "polar_customer_identity_reconciliation_required",
		});
		// The conflict was re-resolved once (still 404) before being surfaced.
		expect(externalLookup).toHaveBeenCalledTimes(2);
	});
	it("adopts the concurrent winner when organization create loses the race", async () => {
		createCustomer.mockImplementationOnce(() => {
			// A double-clicked checkout committed the same identity first.
			externalCustomer = { id: "raced-org", externalId: "ryu:organization:B" };
			return Promise.reject(
				Object.assign(new Error("external id exists"), { statusCode: 409 })
			);
		});
		const { ensureOrganizationPolarCustomer } = await import(
			"./polar-customer-identity.ts"
		);
		expect(
			await ensureOrganizationPolarCustomer({
				email: "owner@example.com",
				organizationId: "B",
			})
		).toBe("raced-org");
		expect(externalLookup).toHaveBeenCalledTimes(2);
	});
	it("adopts the concurrent winner when personal create loses the race", async () => {
		createCustomer.mockImplementationOnce(() => {
			externalCustomer = { id: "raced-personal", externalId: "user-B" };
			return Promise.reject(
				Object.assign(new Error("external id exists"), { statusCode: 422 })
			);
		});
		expect(
			await ensurePersonalPolarCustomer({
				email: "owner@example.com",
				userId: "user-B",
			})
		).toBe("raced-personal");
		expect(externalLookup).toHaveBeenCalledTimes(2);
	});
	it("still requires reconciliation for an unexplained personal collision", async () => {
		createCustomer.mockRejectedValueOnce(
			Object.assign(new Error("email already exists"), { statusCode: 422 })
		);
		await expect(
			ensurePersonalPolarCustomer({
				email: "owner@example.com",
				userId: "user-B",
			})
		).rejects.toMatchObject({
			code: "polar_customer_identity_reconciliation_required",
		});
		expect(externalLookup).toHaveBeenCalledTimes(2);
	});
	it("never adopts a different identity found after a conflict", async () => {
		createCustomer.mockImplementationOnce(() => {
			externalCustomer = { id: "other-payer", externalId: "user-2" };
			return Promise.reject(
				Object.assign(new Error("email already exists"), { statusCode: 409 })
			);
		});
		await expect(
			ensurePersonalPolarCustomer({
				email: "owner@example.com",
				userId: "user-B",
			})
		).rejects.toThrow("different billing identity");
	});
	it("creates an individual customer when a personal checkout is new", async () => {
		expect(
			await ensurePersonalPolarCustomer({
				email: "owner@example.com",
				userId: "user-B",
			})
		).toBe("created-personal");
		expect(createCustomer).toHaveBeenCalledWith(
			expect.objectContaining({
				email: "owner@example.com",
				externalId: "user-B",
				type: "individual",
			})
		);
	});
	it("propagates provider outages without an email fallback", async () => {
		externalFailure = new Error("provider unavailable");
		await expect(resolveOrganizationPolarCustomerId("B")).rejects.toThrow(
			"provider unavailable"
		);
		expect(emailLookup).not.toHaveBeenCalled();
	});
	it("uses exact personal identity without querying shared payer email", async () => {
		externalCustomer = { id: "personal", externalId: "user-1" };
		expect(await resolvePersonalPolarCustomerId("user-1")).toBe("personal");
		expect(externalLookup).toHaveBeenCalledWith({ externalId: "user-1" });
		expect(emailLookup).not.toHaveBeenCalled();
	});
	it("returns no personal account when only a shared email matches", async () => {
		personalCustomers = [
			{ id: "customer-A", externalId: "ryu:organization:A", metadata: {} },
		];
		expect(await resolvePersonalPolarCustomerId("user-1")).toBeNull();
		expect(emailLookup).not.toHaveBeenCalled();
	});
	for (const externalId of ["ryu:organization:A", "user-2"]) {
		it(`rejects ${externalId} for a personal user identity`, async () => {
			externalCustomer = { id: "other-payer", externalId };
			await expect(resolvePersonalPolarCustomerId("user-1")).rejects.toThrow(
				"different billing identity"
			);
		});
	}
});
