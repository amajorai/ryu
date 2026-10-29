import { describe, expect, test } from "bun:test";
import type { RouteClaim } from "./rpc.ts";
import {
	type Capability,
	dispatchRpc,
	finetuneJobSpecSchema,
	type HostServices,
	widgetRpcErrorCodeSchema,
} from "./rpc.ts";

const capabilities: Set<Capability> = new Set(["finetune.runs"]);

describe("worker-owned finetune transport", () => {
	test("keeps future worker fields and original nested JSON references", async () => {
		const input = {
			base_model_id: "future/model",
			dataset: { format: "future", samples: [{ custom: [null, true] }] },
			future_option: { enabled: true },
		};
		const reply = {
			future_reply: [{ state: "worker-defined" }],
			job_id: "job",
		};
		expect(finetuneJobSpecSchema.parse(input)).toBe(input);
		const services: HostServices = {
			listAgents: async () => [],
			registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
			finetuneStart: async (spec) => {
				expect(spec).toBe(input);
				return reply;
			},
			finetuneMerge: async (spec) => {
				expect(spec).toBe(input);
				return reply;
			},
		};
		for (const method of ["finetune.start", "finetune.merge"]) {
			expect(await dispatchRpc(method, [input], capabilities, services)).toBe(
				reply
			);
		}
	});
	test("retains worker fallback values and empty responses on every unary route", async () => {
		const reply = { malformed_job: null, future: ["worker-owned"] };
		const services: HostServices = {
			listAgents: async () => [],
			registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
			finetuneCapability: async () => reply,
			finetuneList: async () => reply,
			finetuneAdapters: async () => reply,
			finetuneGet: async () => reply,
			finetuneCancel: async () => undefined,
		};
		for (const method of [
			"finetune.capability",
			"finetune.list",
			"finetune.adapters",
			"finetune.get",
		]) {
			expect(
				await dispatchRpc(method, [{ id: "job" }], capabilities, services)
			).toBe(reply);
		}
		expect(
			await dispatchRpc(
				"finetune.cancel",
				[{ id: "job" }],
				capabilities,
				services
			)
		).toBeUndefined();
	});
	test("rejects non-JSON requests without calling the privileged service", async () => {
		let calls = 0;
		const services: HostServices = {
			listAgents: async () => [],
			registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
			finetuneStart: async () => {
				calls += 1;
				return null;
			},
		};
		for (const input of [
			null,
			[],
			"invalid",
			{ nested: { callback: () => null } },
		]) {
			await expect(
				dispatchRpc("finetune.start", [input], capabilities, services)
			).rejects.toThrow();
		}
		expect(calls).toBe(0);
		expect(widgetRpcErrorCodeSchema.safeParse("invalid_args").success).toBe(
			true
		);
		expect(widgetRpcErrorCodeSchema.safeParse("future_code").success).toBe(
			false
		);
	});
});
