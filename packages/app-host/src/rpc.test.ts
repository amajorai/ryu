import { describe, expect, it } from "bun:test";
import {
	asRpcRequest,
	type Capability,
	CapabilityError,
	dispatchRpc,
	GRANT_CAPABILITY,
	type HostServices,
	METHOD_CAPABILITY,
} from "./rpc.ts";

const AGENTS = [{ id: "ryu", name: "Ryu" }];

function services(): HostServices {
	return {
		listAgents: () => Promise.resolve(AGENTS),
		registerRoute: () => Promise.resolve(null),
	};
}

const GRANTED = new Set<Capability>(["core.listAgents"]);
const NONE = new Set<Capability>();

describe("dispatchRpc capability gate", () => {
	it("dispatches a granted method to its service", async () => {
		const result = await dispatchRpc(
			"core.listAgents",
			[],
			GRANTED,
			services()
		);
		expect(result).toEqual(AGENTS);
	});

	it("REJECTS a known method whose capability was not granted", async () => {
		await expect(
			dispatchRpc("core.listAgents", [], NONE, services())
		).rejects.toBeInstanceOf(CapabilityError);
	});

	it("REJECTS an unknown method even when all capabilities are granted", async () => {
		await expect(
			dispatchRpc("core.deleteEverything", [], GRANTED, services())
		).rejects.toBeInstanceOf(CapabilityError);
	});

	it("never invokes the service for an ungranted call", async () => {
		let called = false;
		const spy: HostServices = {
			listAgents: () => {
				called = true;
				return Promise.resolve(AGENTS);
			},
			registerRoute: () => Promise.resolve(null),
		};
		await expect(
			dispatchRpc("core.listAgents", [], NONE, spy)
		).rejects.toBeInstanceOf(CapabilityError);
		expect(called).toBe(false);
	});
});

describe("grant-mapping completeness invariant", () => {
	// `widget.state` and `ui.displayMode` are LOCAL host caps added directly by the
	// widget host on mount (never Gateway-sourced), so they intentionally have no
	// grant-string mapping. Every OTHER capability a method gates MUST be unlockable
	// via some grant string in GRANT_CAPABILITY — otherwise the whole method family
	// is functionally dead: the Gateway-approved grant maps to nothing, the granted
	// set is empty, and every call is denied (the `timeline.read` regression).
	const LOCAL_HOST_CAPS = new Set<Capability>(["widget.state", "ui.displayMode"]);

	it("every capability reachable from METHOD_CAPABILITY has a grant mapping", () => {
		const grantable = new Set<Capability>(Object.values(GRANT_CAPABILITY));
		const unmapped: Array<{ capability: Capability; methods: string[] }> = [];
		for (const capability of new Set(Object.values(METHOD_CAPABILITY))) {
			if (LOCAL_HOST_CAPS.has(capability) || grantable.has(capability)) {
				continue;
			}
			unmapped.push({
				capability,
				methods: Object.entries(METHOD_CAPABILITY)
					.filter(([, cap]) => cap === capability)
					.map(([method]) => method),
			});
		}
		expect(unmapped).toEqual([]);
	});
});

describe("asRpcRequest envelope validation", () => {
	it("accepts a well-formed request", () => {
		expect(
			asRpcRequest({
				kind: "ryu-plugin-rpc",
				id: 1,
				method: "core.listAgents",
				args: [],
			})
		).toEqual({
			kind: "ryu-plugin-rpc",
			id: 1,
			method: "core.listAgents",
			args: [],
		});
	});

	it("rejects payloads with the wrong kind", () => {
		expect(
			asRpcRequest({ kind: "other", id: 1, method: "x", args: [] })
		).toBeNull();
	});

	it("rejects payloads missing required fields", () => {
		expect(asRpcRequest({ kind: "ryu-plugin-rpc", id: 1 })).toBeNull();
		expect(asRpcRequest(null)).toBeNull();
		expect(asRpcRequest("nope")).toBeNull();
	});
});
