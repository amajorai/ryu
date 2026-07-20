// Tests for the app host-bridge methods (model.complete / agent.run / storage.*)
// added to the capability-gated RPC dispatch. These are the full-page Companion
// app capabilities that reach the Core `PluginHookBridge` over one governed fetch.
//
// The security shape under test: an ungranted call is rejected with a STRUCTURED
// `denied` code (not the legacy string error) BEFORE any service runs, and every
// arg is narrowed — a bad shape rejects with `invalid_args`, notably a non-string
// storage value (which the Rust bridge would silently drop = data loss).

import { describe, expect, it } from "bun:test";
import {
	asAgentRunArg,
	asFinetuneIdArg,
	asModelCompleteArg,
	asRecordArg,
	asStorageKeyArg,
	asStorageSetArg,
	assertGranted,
	type Capability,
	CodedRpcError,
	capabilitiesFromGrants,
	dispatchRpc,
	type HostServices,
	STREAMING_METHODS,
} from "./rpc.ts";

const ALL = new Set<Capability>(["model.complete", "agent.run", "storage.kv"]);
const NONE = new Set<Capability>();

describe("spaces documents capability", () => {
	const SP = new Set<Capability>(["spaces.docs"]);
	function spacesServices(): HostServices {
		return {
			listAgents: () => Promise.resolve([]),
			registerRoute: () => Promise.resolve(null),
			spacesCreateDoc: () => Promise.resolve("doc-1"),
			spacesGetDoc: () =>
				Promise.resolve({
					id: "doc-1",
					title: "t",
					source: "{}",
					kind: "app:x",
				}),
			spacesUpdateDoc: () => Promise.resolve(),
			spacesListDocs: () => Promise.resolve([]),
			spacesDeleteDoc: () => Promise.resolve(),
		};
	}

	it("dispatches spaces.* when granted", async () => {
		expect(
			await dispatchRpc(
				"spaces.createDoc",
				[{ space_id: "s", title: "T" }],
				SP,
				spacesServices()
			)
		).toBe("doc-1");
		expect(
			await dispatchRpc(
				"spaces.updateDoc",
				[{ doc_id: "doc-1", source: "{}" }],
				SP,
				spacesServices()
			)
		).toBeUndefined();
	});

	it("REJECTS spaces.* with coded denied when ungranted", async () => {
		const err = await dispatchRpc(
			"spaces.getDoc",
			[{ doc_id: "d" }],
			NONE,
			spacesServices()
		).catch((e) => e);
		expect(err).toBeInstanceOf(CodedRpcError);
		expect((err as CodedRpcError).code).toBe("denied");
	});

	it("REJECTS bad spaces args with invalid_args (missing source / space_id / doc_id)", async () => {
		for (const [method, args] of [
			["spaces.createDoc", [{ space_id: "s" }]],
			["spaces.updateDoc", [{ doc_id: "d" }]],
			["spaces.getDoc", [{}]],
		] as const) {
			const err = await dispatchRpc(
				method,
				args as unknown as unknown[],
				SP,
				spacesServices()
			).catch((e) => e);
			expect(err).toBeInstanceOf(CodedRpcError);
			expect((err as CodedRpcError).code).toBe("invalid_args");
		}
	});
});

describe("streaming agent.run grant gate", () => {
	it("agent.run.stream is a streaming method sharing the agent.run grant", () => {
		expect(STREAMING_METHODS.has("agent.run.stream")).toBe(true);
		// Granted when the app holds agent.run; the streaming path enforces the same
		// gate as the unary path via assertGranted.
		expect(() =>
			assertGranted("agent.run.stream", new Set<Capability>(["agent.run"]))
		).not.toThrow();
		expect(() =>
			assertGranted("agent.cancel", new Set<Capability>(["agent.run"]))
		).not.toThrow();
	});

	it("REJECTS agent.run.stream / agent.cancel with coded `denied` when ungranted", () => {
		for (const method of ["agent.run.stream", "agent.cancel"]) {
			let thrown: unknown;
			try {
				assertGranted(method, NONE);
			} catch (e) {
				thrown = e;
			}
			expect(thrown).toBeInstanceOf(CodedRpcError);
			expect((thrown as CodedRpcError).code).toBe("denied");
		}
	});
});

function services(overrides: Partial<HostServices> = {}): HostServices {
	return {
		listAgents: () => Promise.resolve([]),
		registerRoute: () => Promise.resolve(null),
		modelComplete: () => Promise.resolve("draft"),
		runAgent: () => Promise.resolve("agent-result"),
		storageGet: () => Promise.resolve("stored"),
		storageSet: () => Promise.resolve(),
		storageDelete: () => Promise.resolve(),
		storageKeys: () => Promise.resolve(["a", "b"]),
		...overrides,
	};
}

describe("app host-bridge dispatch", () => {
	it("dispatches model.complete to its service when granted", async () => {
		const out = await dispatchRpc(
			"model.complete",
			[{ prompt: "hi" }],
			ALL,
			services()
		);
		expect(out).toBe("draft");
	});

	it("dispatches agent.run and storage.* to their services when granted", async () => {
		expect(
			await dispatchRpc("agent.run", [{ task: "do" }], ALL, services())
		).toBe("agent-result");
		expect(
			await dispatchRpc("storage.get", [{ key: "k" }], ALL, services())
		).toBe("stored");
		expect(await dispatchRpc("storage.keys", [{}], ALL, services())).toEqual([
			"a",
			"b",
		]);
	});

	it("REJECTS an ungranted app method with a coded `denied` error, never running the service", async () => {
		let called = false;
		const spy = services({
			modelComplete: () => {
				called = true;
				return Promise.resolve("x");
			},
		});
		const err = await dispatchRpc(
			"model.complete",
			[{ prompt: "hi" }],
			NONE,
			spy
		).catch((e) => e);
		expect(err).toBeInstanceOf(CodedRpcError);
		expect((err as CodedRpcError).code).toBe("denied");
		expect(called).toBe(false);
	});

	it("REJECTS a bad arg shape with invalid_args (empty prompt / missing task / missing key)", async () => {
		for (const [method, args] of [
			["model.complete", [{ prompt: "" }]],
			["agent.run", [{}]],
			["storage.get", [{ key: "" }]],
		] as const) {
			const err = await dispatchRpc(
				method,
				args as unknown as unknown[],
				ALL,
				services()
			).catch((e) => e);
			expect(err).toBeInstanceOf(CodedRpcError);
			expect((err as CodedRpcError).code).toBe("invalid_args");
		}
	});

	it("REJECTS storage.set with a non-string value (bridge would silently drop it)", async () => {
		const err = await dispatchRpc(
			"storage.set",
			[{ key: "k", value: 42 }],
			ALL,
			services()
		).catch((e) => e);
		expect(err).toBeInstanceOf(CodedRpcError);
		expect((err as CodedRpcError).code).toBe("invalid_args");
	});
});

describe("app host-bridge arg validators", () => {
	it("asModelCompleteArg requires a non-empty prompt, passes optional strings", () => {
		expect(asModelCompleteArg({ prompt: "x", system: "s" })).toEqual({
			prompt: "x",
			system: "s",
		});
		expect(asModelCompleteArg({ prompt: "" })).toBeNull();
		expect(asModelCompleteArg({ prompt: "x", model: 5 })).toBeNull();
		expect(asModelCompleteArg(null)).toBeNull();
	});

	it("asAgentRunArg requires a task, validates numeric bounds", () => {
		expect(asAgentRunArg({ task: "t", wall_time_secs: 30 })).toEqual({
			task: "t",
			wall_time_secs: 30,
		});
		expect(asAgentRunArg({ task: "" })).toBeNull();
		expect(asAgentRunArg({ task: "t", wall_time_secs: -1 })).toBeNull();
		expect(asAgentRunArg({ task: "t", agent_id: 3 })).toBeNull();
	});

	it("asStorageKeyArg / asStorageSetArg enforce key + string value", () => {
		expect(asStorageKeyArg({ key: "k", namespace: "n" })).toEqual({
			key: "k",
			namespace: "n",
		});
		expect(asStorageKeyArg({ key: "" })).toBeNull();
		expect(asStorageSetArg({ key: "k", value: "v" })).toEqual({
			key: "k",
			value: "v",
		});
		expect(asStorageSetArg({ key: "k", value: 1 })).toBeNull();
		expect(asStorageSetArg({ key: "k" })).toBeNull();
	});
});

describe("fine-tune runs capability", () => {
	const FT = new Set<Capability>(["finetune.runs"]);
	function ftServices(): HostServices {
		return {
			listAgents: () => Promise.resolve([]),
			registerRoute: () => Promise.resolve({}),
			finetuneCapability: () => Promise.resolve({ can_train_local: true }),
			finetuneList: () => Promise.resolve({ jobs: [] }),
			finetuneAdapters: () => Promise.resolve({ adapters: [] }),
			finetuneGet: (i) => Promise.resolve({ id: i.id, state: "running" }),
			finetuneCancel: (i) => Promise.resolve({ id: i.id, cancelling: true }),
			finetuneStart: (i) => Promise.resolve({ job_id: "j1", spec: i }),
			finetuneMerge: (i) => Promise.resolve({ stem: "s", merged: i }),
		};
	}

	it("maps the finetune:runs grant to the finetune.runs capability", () => {
		expect(capabilitiesFromGrants(["finetune:runs"]).has("finetune.runs")).toBe(
			true
		);
		expect(capabilitiesFromGrants([]).has("finetune.runs")).toBe(false);
	});

	it("dispatches finetune.* when granted", async () => {
		const s = ftServices();
		expect(await dispatchRpc("finetune.capability", [], FT, s)).toEqual({
			can_train_local: true,
		});
		expect(await dispatchRpc("finetune.list", [], FT, s)).toEqual({ jobs: [] });
		expect(await dispatchRpc("finetune.get", [{ id: "j1" }], FT, s)).toEqual({
			id: "j1",
			state: "running",
		});
		expect(
			await dispatchRpc("finetune.start", [{ base_model_id: "m" }], FT, s)
		).toEqual({
			job_id: "j1",
			spec: { base_model_id: "m" },
		});
	});

	it("REJECTS finetune.* with coded `denied` when ungranted", async () => {
		let thrown: unknown;
		try {
			await dispatchRpc("finetune.list", [], NONE, ftServices());
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeInstanceOf(CodedRpcError);
		expect((thrown as CodedRpcError).code).toBe("denied");
	});

	it("finetune.stream is a streaming method sharing the finetune.runs grant", () => {
		expect(STREAMING_METHODS.has("finetune.stream")).toBe(true);
		expect(() => assertGranted("finetune.stream", FT)).not.toThrow();
	});

	it("finetune.get / .cancel require a { id }, .start / .merge require an object", () => {
		expect(asFinetuneIdArg({ id: "j1" })).toEqual({ id: "j1" });
		expect(asFinetuneIdArg({ id: "" })).toBeNull();
		expect(asFinetuneIdArg({})).toBeNull();
		expect(asRecordArg({ base_model_id: "m" })).toEqual({ base_model_id: "m" });
		expect(asRecordArg([])).toBeNull();
		expect(asRecordArg("x")).toBeNull();
	});
});
