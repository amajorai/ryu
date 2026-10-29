import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { POLAR_API_VERSION } from "./polar-api.ts";

let customers: {
	id: string;
	externalId: string | null;
	metadata: Record<string, string>;
}[] = [];
const create = mock(async () => ({}));
let updateFailure: Error | null = null;
const update = mock(async () => {
	if (updateFailure) {
		throw updateFailure;
	}
	return {};
});
type BeforeRequestHook = (
	request: Request
) => Request | undefined | Promise<Request | undefined>;
let polarHttpClient: { beforeRequest?: BeforeRequestHook } | undefined;
let polarTimeoutMs: number | undefined;

class MockHTTPClient {
	beforeRequest: BeforeRequestHook | undefined;

	addHook(_hook: string, fn: BeforeRequestHook): this {
		this.beforeRequest = fn;
		return this;
	}
}

mock.module("@ryu/env/server", () => ({ env: {} }));
mock.module("@polar-sh/sdk", () => ({
	HTTPClient: MockHTTPClient,
	Polar: class {
		constructor(options: { httpClient?: MockHTTPClient; timeoutMs?: number }) {
			polarHttpClient = options.httpClient;
			polarTimeoutMs = options.timeoutMs;
		}

		customers = {
			list: async () => ({ result: { items: customers } }),
			create,
			update,
			updateExternal: update,
		};
	},
}));
const { ensurePolarCustomer, syncPolarCustomer } = await import(
	"./payments.ts"
);
beforeEach(() => {
	customers = [];
	create.mockClear();
	update.mockClear();
	updateFailure = null;
});
afterAll(() => mock.restore());

describe("personal customer provisioning", () => {
	it("creates a customer when the email has no existing payer", async () => {
		expect(
			await ensurePolarCustomer({ id: "user-B", email: "person@example.com" })
		).toBe(true);
		expect(create).toHaveBeenCalledWith({
			email: "person@example.com",
			externalId: "user-B",
			name: undefined,
		});
	});
	it("recognizes an already verified personal identity", async () => {
		customers = [{ id: "payer-B", externalId: "user-B", metadata: {} }];
		expect(
			await ensurePolarCustomer({ id: "user-B", email: "person@example.com" })
		).toBe(true);
		expect(create).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});
	it("pins every SDK request to the stable Polar API contract", async () => {
		const request = new Request("https://api.polar.sh/v1/customers");
		await polarHttpClient?.beforeRequest?.(request);
		expect(request.headers.get("Polar-Version")).toBe(POLAR_API_VERSION);
	});
	it("bounds every SDK request with a client timeout", () => {
		expect(polarTimeoutMs).toBe(15_000);
	});
	it("treats a missing personal customer as an expected lazy-sync state", async () => {
		updateFailure = Object.assign(new Error("customer missing"), {
			statusCode: 404,
		});
		expect(
			await syncPolarCustomer({ id: "user-B", email: "person@example.com" })
		).toBe(false);
	});
	const otherCustomers: typeof customers = [
		{ id: "payer-A", externalId: "ryu:organization:A", metadata: {} },
		{ id: "legacy-org", externalId: null, metadata: { scope: "org" } },
		{ id: "legacy-personal", externalId: null, metadata: {} },
		{ id: "other-personal", externalId: "user-A", metadata: {} },
	];
	for (const customer of otherCustomers) {
		it(`does not claim ${customer.id} merely because its email matches`, async () => {
			customers = [customer];
			expect(
				await ensurePolarCustomer({ id: "user-B", email: "person@example.com" })
			).toBe(false);
			expect(create).not.toHaveBeenCalled();
			expect(update).not.toHaveBeenCalled();
		});
	}
});
