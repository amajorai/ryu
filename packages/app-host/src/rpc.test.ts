import { describe, expect, it } from "bun:test";
import {
	asModelCompleteArg,
	asRpcRequest,
	asSafeActionsRequestArg,
	assertGranted,
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
		catalogSnapshot: () =>
			Promise.resolve({
				agents: [],
				apiTypes: [],
				current: {
					provider: "gateway",
					providerRouting: {},
					routing: "gateway",
				},
				hookEvents: [],
				hooks: [],
				plugins: [],
				providers: [],
				thinkingLevels: [],
				version: 1,
			}),
		catalogModels: (input) =>
			Promise.resolve({
				models: [{ id: `${input.providerId}/model` }],
				providerId: input.providerId,
				source: "test",
			}),
		chatListConversations: () =>
			Promise.resolve([
				{
					agent_id: "agent-1",
					created_at: 1,
					id: "conversation-1",
					message_count: 2,
					run_status: "running",
					title: "Build",
					updated_at: 2,
				},
			]),
		chatSend: ({ conversationId, text }) =>
			Promise.resolve({
				conversation_id: `${conversationId}:${text}`,
				status: "accepted" as const,
			}),
		registerRoute: () => Promise.resolve(null),
	};
}

const GRANTED = new Set<Capability>(["core.listAgents"]);
const NONE = new Set<Capability>();

function errorContract(value: unknown): {
	code: unknown;
	message: string;
	name: string;
} | null {
	if (!(value instanceof Error)) {
		return null;
	}
	return {
		code: "code" in value ? value.code : null,
		message: value.message,
		name: value.name,
	};
}

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

	it("dispatches the shared catalog through the existing read-only grant", async () => {
		await expect(
			dispatchRpc("catalog.snapshot", [], GRANTED, services())
		).resolves.toMatchObject({ version: 1, providers: [], agents: [] });
	});

	it("discovers provider models through the shared catalog bridge", async () => {
		await expect(
			dispatchRpc(
				"catalog.models",
				[{ providerId: "openai" }],
				GRANTED,
				services()
			)
		).resolves.toEqual({
			models: [{ id: "openai/model" }],
			providerId: "openai",
			source: "test",
		});
	});

	it("dispatches the scoped NotifyUser recipient roster through the catalog grant", async () => {
		const catalogGrant = new Set<Capability>(["workflows.catalogs"]);
		const svc: HostServices = {
			...services(),
			workflowsNotifyTargets: () =>
				Promise.resolve([{ id: "user-ada", name: "Ada Lovelace" }]),
		};
		await expect(
			dispatchRpc("workflows.notifyTargets", [], catalogGrant, svc)
		).resolves.toEqual([{ id: "user-ada", name: "Ada Lovelace" }]);
	});

	it("dispatches Chat Broadcast list and send through the explicit grant", async () => {
		const chatGrant = new Set<Capability>(["chat.broadcast"]);
		await expect(
			dispatchRpc("chat.list", [], chatGrant, services())
		).resolves.toMatchObject([{ id: "conversation-1", run_status: "running" }]);
		await expect(
			dispatchRpc(
				"chat.send",
				[{ conversationId: "conversation-1", text: "Stop linting." }],
				chatGrant,
				services()
			)
		).resolves.toEqual({
			conversation_id: "conversation-1:Stop linting.",
			status: "accepted",
		});
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

	it("keeps unary dispatch denials identical to the shared streaming gate", async () => {
		for (const [method, capability] of Object.entries(METHOD_CAPABILITY)) {
			if (capability === "host.capabilities") {
				continue;
			}
			let assertedError: unknown;
			try {
				assertGranted(method, NONE);
			} catch (error) {
				assertedError = error;
			}
			let dispatchedError: unknown;
			try {
				await dispatchRpc(method, [], NONE, services());
			} catch (error) {
				dispatchedError = error;
			}
			expect(errorContract(dispatchedError), method).toEqual(
				errorContract(assertedError)
			);
		}
	});
});

describe("model completion argument validation", () => {
	it("preserves an explicit provider lane without accepting non-string input", () => {
		expect(
			asModelCompleteArg({
				model: "gpt-5",
				prompt: "hello",
				provider: "openai",
			})
		).toEqual({ model: "gpt-5", prompt: "hello", provider: "openai" });
		expect(
			asModelCompleteArg({ prompt: "hello", provider: { id: "openai" } })
		).toBeNull();
	});

	it("trims and validates shared catalog discovery arguments", async () => {
		await expect(
			dispatchRpc(
				"catalog.models",
				[{ providerId: "  openai " }],
				GRANTED,
				services()
			)
		).resolves.toMatchObject({ providerId: "openai" });
		await expect(
			dispatchRpc("catalog.models", [{ providerId: "" }], GRANTED, services())
		).rejects.toMatchObject({ code: "invalid_args" });
	});
});

describe("Safe Actions fixed-mount bridge", () => {
	const SAFE_ACTIONS = new Set<Capability>(["safe-actions.manage"]);

	it("dispatches only a validated relative request when granted", async () => {
		let received: unknown;
		const svc: HostServices = {
			listAgents: () => Promise.resolve([]),
			registerRoute: () => Promise.resolve(null),
			safeActionsRequest: async (input) => {
				received = input;
				return { ok: true };
			},
		};
		expect(
			await dispatchRpc(
				"safeActions.request",
				[{ path: "/reviews/r-1/approve", method: "POST", body: {} }],
				SAFE_ACTIONS,
				svc
			)
		).toEqual({ ok: true });
		expect(received).toEqual({
			path: "/reviews/r-1/approve",
			method: "POST",
			body: {},
		});
	});

	it("rejects traversal, absolute, query, and unsupported methods", () => {
		for (const input of [
			{ path: "/../mcp/tools" },
			{ path: "/%2e%2e/mcp/tools" },
			{ path: "//evil.example/x" },
			{ path: "https://evil.example/x" },
			{ path: "/receipts?all=1" },
			{ path: "/policies", method: "PATCH" },
		]) {
			expect(asSafeActionsRequestArg(input)).toBeNull();
		}
	});

	it("never calls the service without the capability", async () => {
		let called = false;
		await expect(
			dispatchRpc("safeActions.request", [{ path: "/policies" }], NONE, {
				listAgents: () => Promise.resolve([]),
				registerRoute: () => Promise.resolve(null),
				safeActionsRequest: async () => {
					called = true;
				},
			})
		).rejects.toMatchObject({ code: "denied" });
		expect(called).toBe(false);
	});
});

describe("grant-mapping completeness invariant", () => {
	// `widget.state`, `ui.displayMode`, and `host.capabilities` are LOCAL host caps
	// added directly by the
	// widget host on mount (never Gateway-sourced), so they intentionally have no
	// grant-string mapping. Every OTHER capability a method gates MUST be unlockable
	// via some grant string in GRANT_CAPABILITY — otherwise the whole method family
	// is functionally dead: the Gateway-approved grant maps to nothing, the granted
	// set is empty, and every call is denied (the `timeline.read` regression).
	const LOCAL_HOST_CAPS = new Set<Capability>([
		"host.capabilities",
		"widget.state",
		"ui.displayMode",
	]);

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

describe("assistant bridge dispatch", () => {
	const ASSISTANT = new Set<Capability>(["assistant.context"]);

	it("routes each assistant method to its service when granted", async () => {
		const calls: string[] = [];
		const svc: HostServices = {
			listAgents: () => Promise.resolve([]),
			registerRoute: () => Promise.resolve(null),
			assistantPublishContext: async ({ items }) => {
				calls.push(`publish:${items.length}`);
			},
			assistantClearContext: async () => {
				calls.push("clear");
			},
			assistantRegisterSurface: async ({ label }) => {
				calls.push(`surface:${label}`);
			},
			assistantClearSurface: async () => {
				calls.push("clearSurface");
			},
			assistantOpen: async ({ prompt }) => {
				calls.push(`open:${prompt ?? ""}`);
			},
		};
		await dispatchRpc(
			"assistant.publishContext",
			[{ items: [{ id: "a", title: "T", text: "x" }] }],
			ASSISTANT,
			svc
		);
		await dispatchRpc("assistant.clearContext", [], ASSISTANT, svc);
		await dispatchRpc(
			"assistant.registerSurface",
			[{ label: "Board" }],
			ASSISTANT,
			svc
		);
		await dispatchRpc("assistant.clearSurface", [], ASSISTANT, svc);
		await dispatchRpc("assistant.open", [{ prompt: "why?" }], ASSISTANT, svc);
		expect(calls).toEqual([
			"publish:1",
			"clear",
			"surface:Board",
			"clearSurface",
			"open:why?",
		]);
	});

	it("REFUSES every assistant method without the grant, service untouched", async () => {
		let touched = false;
		const svc: HostServices = {
			listAgents: () => Promise.resolve([]),
			registerRoute: () => Promise.resolve(null),
			assistantPublishContext: async () => {
				touched = true;
			},
			assistantOpen: async () => {
				touched = true;
			},
		};
		for (const method of ["assistant.publishContext", "assistant.open"]) {
			await expect(
				dispatchRpc(method, [{ items: [] }], new Set<Capability>(), svc)
			).rejects.toBeInstanceOf(CapabilityError);
		}
		expect(touched).toBe(false);
	});
});
