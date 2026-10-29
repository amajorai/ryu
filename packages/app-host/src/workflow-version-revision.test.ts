import { expect, test } from "bun:test";
import type { RouteClaim } from "./rpc.ts";
import {
	asWorkflowVersionCreateArg,
	dispatchRpc,
	type HostServices,
} from "./rpc.ts";

test("workflow checkpoint converter and dispatcher preserve the opaque save revision", async () => {
	const calls: unknown[] = [];
	const host: HostServices = {
		listAgents: async () => [],
		registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
		workflowsVersionCreate: async (input) => {
			calls.push(input);
		},
	};
	const guarded = {
		id: "workflow",
		label: "Reviewed",
		expectedRevision: "opaque/revision:2",
	};
	expect(asWorkflowVersionCreateArg(guarded)).toEqual(guarded);
	await dispatchRpc(
		"workflows.versionCreate",
		[guarded],
		new Set(["workflows.crud"]),
		host
	);
	await dispatchRpc(
		"workflows.versionCreate",
		[{ id: "workflow" }],
		new Set(["workflows.crud"]),
		host
	);
	expect(calls).toEqual([guarded, { id: "workflow" }]);
	for (const expectedRevision of [42, null, {}, []]) {
		expect(
			asWorkflowVersionCreateArg({ id: "workflow", expectedRevision })
		).toBeNull();
		await expect(
			dispatchRpc(
				"workflows.versionCreate",
				[{ id: "workflow", expectedRevision }],
				new Set(["workflows.crud"]),
				host
			)
		).rejects.toMatchObject({ code: "invalid_args" });
	}
	expect(calls).toHaveLength(2);
});

test("checkpoint dispatcher propagates conflicts without reporting success", async () => {
	const conflict = new Error(
		"workflow revision conflict: it was changed since it was saved"
	);
	const host: HostServices = {
		listAgents: async () => [],
		registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
		workflowsVersionCreate: async () => {
			throw conflict;
		},
	};
	await expect(
		dispatchRpc(
			"workflows.versionCreate",
			[{ id: "workflow", expectedRevision: "revision-1" }],
			new Set(["workflows.crud"]),
			host
		)
	).rejects.toBe(conflict);
});
