import { expect, test } from "bun:test";
import vm from "node:vm";
import { dialogEscapeScript } from "./dialog-escape-script.ts";
import { dispatchRpc, type HostServices } from "./rpc.ts";

interface PolicyEvent {
	altKey: boolean;
	ctrlKey: boolean;
	defaultPrevented: boolean;
	isComposing: boolean;
	isTrusted: boolean;
	key: string;
	metaKey: boolean;
	preventDefault(): void;
	repeat: boolean;
	shiftKey: boolean;
}
function event(overrides: Partial<PolicyEvent> = {}): PolicyEvent {
	return {
		altKey: false,
		ctrlKey: false,
		defaultPrevented: false,
		isComposing: false,
		isTrusted: true,
		key: "Escape",
		metaKey: false,
		repeat: false,
		shiftKey: false,
		preventDefault() {
			this.defaultPrevented = true;
		},
		...overrides,
	};
}
function install(
	enabled: boolean,
	call: (method: string, args: []) => Promise<void>
) {
	const listeners = new Map<string, (event: PolicyEvent) => void>();
	vm.runInNewContext(dialogEscapeScript(enabled), {
		document: {
			addEventListener(name: string, callback: (event: PolicyEvent) => void) {
				listeners.set(name, callback);
			},
		},
		call,
	});
	return {
		listenedEvents: () => [...listeners.keys()],
		dispatch(input: PolicyEvent) {
			const handler = listeners.get("keydown");
			if (!handler) {
				throw new Error("No modal keyboard listener");
			}
			handler(input);
		},
	};
}
test("ordinary companions install no modal Escape listener", () => {
	const shim = install(false, async () => {
		throw new Error("ordinary app cannot close its host");
	});
	expect(shim.listenedEvents()).toEqual([]);
});
test("generated modal shim ignores untrusted, handled, composed, repeat, modified and non-Escape events", () => {
	const calls: string[] = [];
	const shim = install(true, async (method) => {
		calls.push(method);
	});
	expect(shim.listenedEvents()).toEqual(["keydown"]);
	for (const input of [
		event({ isTrusted: false }),
		event({ defaultPrevented: true }),
		event({ isComposing: true }),
		event({ repeat: true }),
		event({ altKey: true }),
		event({ ctrlKey: true }),
		event({ metaKey: true }),
		event({ shiftKey: true }),
		event({ key: "Enter" }),
	]) {
		shim.dispatch(input);
	}
	expect(calls).toEqual([]);
});
test("only accepted modal close marks the trusted Escape handled", async () => {
	let accept: () => void = () => {};
	const pending = new Promise<void>((resolve) => {
		accept = resolve;
	});
	const calls: Array<{ method: string; args: [] }> = [];
	const shim = install(true, async (method, args) => {
		calls.push({ method, args });
		await pending;
	});
	const input = event();
	shim.dispatch(input);
	expect(calls).toEqual([{ method: "ui.requestClose", args: [] }]);
	expect(input.defaultPrevented).toBe(false);
	accept();
	await pending;
	await Promise.resolve();
	await Promise.resolve();
	expect(input.defaultPrevented).toBe(true);
});
test("rejected or unavailable host close does not consume Escape", async () => {
	const shim = install(true, async () => {
		throw new Error("host dialog no longer available");
	});
	const input = event();
	shim.dispatch(input);
	await Promise.resolve();
	await Promise.resolve();
	expect(input.defaultPrevented).toBe(false);
});
test("existing RPC dispatch closes only a supplied host service without extending Gateway grants", async () => {
	const ordinary: HostServices = {
		listAgents: async () => [],
		registerRoute: async (claim) => claim,
	};
	await expect(
		dispatchRpc("ui.requestClose", [], new Set(), ordinary)
	).rejects.toThrow("ui.requestClose is not available");
	let closed = 0;
	await expect(
		dispatchRpc("ui.requestClose", [], new Set(), {
			...ordinary,
			requestClose: async () => {
				closed += 1;
			},
		})
	).resolves.toBeNull();
	expect(closed).toBe(1);
});
