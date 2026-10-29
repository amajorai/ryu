import { afterAll, describe, expect, test } from "bun:test";
import {
	editGatewayWebAccount,
	GatewayWebAccountSavedError,
	getGatewayWebAccounts,
	parseGatewayWebAccounts,
} from "./web-service-accounts.ts";

const revision = "a".repeat(64);
const accountId = "b".repeat(64);
const view = {
	webServiceSchema: 1,
	configRevision: revision,
	providers: [
		{
			provider: "tavily",
			anonymous: false,
			accounts: [
				{
					accountId,
					context: { kind: "default", future: true },
					policy: { enabled: false, name: "Primary", priority: 0 },
					future: true,
				},
			],
			future: true,
		},
	],
	future: true,
};
let applicationStatus = "applied";
const server = Bun.serve({
	port: 0,
	fetch(request) {
		if (request.method === "GET") {
			return Response.json(view);
		}
		return Response.json({
			success: true,
			persisted: true,
			configRevision: revision,
			gateway_application: {
				status: applicationStatus,
				requestedRevision: revision,
				appliedRevision: revision,
				epoch: { boot: "boot", sequence: 0 },
			},
		});
	},
});
const target = { token: null, url: server.url.origin };
afterAll(() => server.stop(true));
describe("Web account owner boundaries", () => {
	test("projects full account fields and normalizes omitted diagnostics over HTTP", async () => {
		const parsed = await getGatewayWebAccounts(target);
		expect(parsed.providers[0]?.accounts[0]).toEqual({
			accountId,
			context: { kind: "default" },
			diagnostic: null,
			policy: { name: "Primary", enabled: false, priority: 0 },
		});
		expect(Object.hasOwn(parsed, "future")).toBe(false);
	});
	test("rejects duplicate providers, duplicate accounts, wrong contexts and anonymous credentials", () => {
		const connection = view.providers[0];
		expect(() =>
			parseGatewayWebAccounts({ ...view, providers: [connection, connection] })
		).toThrow("invalid web account view");
		expect(() =>
			parseGatewayWebAccounts({
				...view,
				providers: [
					{
						...connection,
						accounts: [...connection.accounts, ...connection.accounts],
					},
				],
			})
		).toThrow("invalid web account view");
		expect(() =>
			parseGatewayWebAccounts({
				...view,
				providers: [{ ...connection, provider: "google-pse" }],
			})
		).toThrow("invalid web account view");
		expect(() =>
			parseGatewayWebAccounts({
				...view,
				providers: [{ ...connection, anonymous: true }],
			})
		).toThrow("invalid web account view");
		expect(() =>
			parseGatewayWebAccounts({ ...view, configRevision: "invalid" })
		).toThrow("invalid web account view");
	});
	test("requires confirmed live application and preserves saved-edit error ownership", async () => {
		const result = await editGatewayWebAccount(target, revision, {
			action: "configure",
			provider: "tavily",
			accountId,
			accountPolicy: { name: "Primary", enabled: false, priority: 0 },
		});
		expect(result.gateway_application).toEqual({
			status: "applied",
			requestedRevision: revision,
			appliedRevision: revision,
			epoch: { boot: "boot", sequence: 0 },
		});
		try {
			applicationStatus = "future";
			await expect(
				editGatewayWebAccount(target, revision, {
					action: "clear",
					provider: "tavily",
				})
			).rejects.toBeInstanceOf(GatewayWebAccountSavedError);
		} finally {
			applicationStatus = "applied";
		}
	});
});
