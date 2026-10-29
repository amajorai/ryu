import { describe, expect, test } from "bun:test";
import type { RouteClaim } from "./rpc.ts";
import { type Capability, dispatchRpc, type HostServices } from "./rpc.ts";
import {
	type WebhookEndpointRecord,
	webhookIngressStatusRecordSchema,
	webhookRegistryRecordSchema,
	webhookSecretReadSchema,
	webhookSecretWriteSchema,
} from "./webhook-records.ts";

const endpoint = {
	hasSecret: false,
	id: "workflow",
	kind: "workflow",
	label: "Webhook",
	lastDelivery: null,
	path: "/hook",
	publicUrl: null,
	subscriptionCount: null,
	workflowId: "workflow",
	workflowName: "Workflow",
	future: { enabled: true },
} satisfies WebhookEndpointRecord & { future: { enabled: boolean } };
const registry = {
	endpoints: [endpoint],
	ingressKind: "future-backend",
	publicBaseUrl: null,
	up: false,
	future: [null, true],
};
const ingress = { kind: "future-backend", publicUrl: null, up: false };

describe("normalized webhook host records", () => {
	test("retains published secret envelopes without unwrapping metadata", () => {
		const read = { secret: null, future: { rotated: true } };
		const written = { secret: "secret", future: { rotated: true } };
		expect(webhookSecretReadSchema.parse(read)).toBe(read);
		expect(webhookSecretWriteSchema.parse(written)).toBe(written);
		expect(webhookSecretReadSchema.safeParse(null).success).toBe(false);
		expect(webhookSecretWriteSchema.safeParse({ secret: null }).success).toBe(
			false
		);
	});
	test("retains future ingress names, unavailable URLs, nested references, and metadata", () => {
		expect(webhookRegistryRecordSchema.parse(registry)).toBe(registry);
		expect(webhookRegistryRecordSchema.parse(registry).endpoints[0]).toBe(
			endpoint
		);
		expect(webhookIngressStatusRecordSchema.parse(ingress)).toBe(ingress);
	});
	test("rejects malformed normalized fields and non-JSON metadata", () => {
		expect(
			webhookRegistryRecordSchema.safeParse({
				...registry,
				endpoints: [{ ...endpoint, hasSecret: "false" }],
			}).success
		).toBe(false);
		expect(
			webhookRegistryRecordSchema.safeParse({
				...registry,
				endpoints: [{ ...endpoint, publicUrl: 1 }],
			}).success
		).toBe(false);
		expect(
			webhookRegistryRecordSchema.safeParse({
				...registry,
				future: { callback: () => null },
			}).success
		).toBe(false);
		expect(
			webhookIngressStatusRecordSchema.safeParse({ ...ingress, up: "true" })
				.success
		).toBe(false);
	});
	test("registry read remains metadata-only and secrets stay on protected operations", async () => {
		const capabilities: Set<Capability> = new Set(["webhooks.crud"]);
		const services: HostServices = {
			listAgents: async () => [],
			registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
			webhooksList: async () => registry,
			webhooksIngressStatus: async () => ingress,
			webhooksSecretGet: async () => ({ secret: null }),
			webhooksSecretSet: async () => ({ secret: "secret" }),
		};
		expect(await dispatchRpc("webhooks.list", [], capabilities, services)).toBe(
			registry
		);
		expect(
			await dispatchRpc("webhooks.ingressStatus", [], capabilities, services)
		).toBe(ingress);
		expect(
			await dispatchRpc(
				"webhooks.secretGet",
				[{ id: "workflow" }],
				capabilities,
				services
			)
		).toEqual({ secret: null });
		expect(
			await dispatchRpc(
				"webhooks.secretSet",
				[{ id: "workflow" }],
				capabilities,
				services
			)
		).toEqual({ secret: "secret" });
		await expect(
			dispatchRpc(
				"webhooks.secretGet",
				[{ id: "workflow" }],
				new Set(),
				services
			)
		).rejects.toThrow();
	});
});
