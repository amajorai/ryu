import { afterAll, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type {
	AcpSectionsResult,
	AcpSelectionStore,
} from "./composer-acp-sections.ts";

// Suites share one process: release the DOM so later files see their own globals.
const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { useAcpSections } = await import("./composer-acp-sections.ts");

function fakeStore(): AcpSelectionStore & { mode: Record<string, string> } {
	const mode: Record<string, string> = {};
	return {
		mode,
		getAcpMode: (agentId) => (agentId ? (mode[agentId] ?? null) : null),
		getAcpModel: () => null,
		getAcpConfig: () => ({}),
		setAcpMode: (agentId, modeId) => {
			mode[agentId] = modeId;
		},
		setAcpModel: () => undefined,
		setAcpConfigValue: () => undefined,
	};
}

const NOOP = () => undefined;

function mountHarness(store: AcpSelectionStore) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	let latest: AcpSectionsResult | null = null;

	function Harness({
		agentId,
		streamedMode,
		streamedModeKey,
	}: {
		agentId: string | null;
		streamedMode: string | null;
		streamedModeKey?: string | null;
	}) {
		latest = useAcpSections({
			acpSessionConfig: null,
			agentId,
			agents: [],
			engineModel: null,
			modelOptions: [],
			onEngineModelChange: NOOP,
			store,
			streamedMode,
			streamedModeKey,
		});
		return null;
	}

	return {
		render: async (
			agentId: string | null,
			streamedMode: string | null,
			streamedModeKey?: string | null
		) => {
			await act(async () => {
				root.render(
					<Harness
						agentId={agentId}
						streamedMode={streamedMode}
						streamedModeKey={streamedModeKey}
					/>
				);
			});
		},
		result: () => latest,
		unmount: async () => {
			await act(async () => {
				root.unmount();
			});
			container.remove();
		},
	};
}

describe("useAcpSections streamed mode", () => {
	it("adopts an agent-initiated mode for the agent that emitted it", async () => {
		const store = fakeStore();
		const harness = mountHarness(store);
		await harness.render("claude", null);
		await harness.render("claude", "acceptEdits");
		expect(store.mode.claude).toBe("acceptEdits");
		await harness.unmount();
	});

	it("does not copy the previous agent's streamed mode onto a newly selected agent", async () => {
		const store = fakeStore();
		store.setAcpMode("codex", "read-only");
		const harness = mountHarness(store);
		await harness.render("claude", null);
		await harness.render("claude", "acceptEdits");

		// The caller keeps the last streamed mode around after the user switches.
		await harness.render("codex", "acceptEdits");
		expect(store.mode.codex).toBe("read-only");
		expect(store.mode.claude).toBe("acceptEdits");

		// Switching back must not re-apply it over a pick made in the meantime.
		store.setAcpMode("claude", "default");
		await harness.render("claude", "acceptEdits");
		expect(store.mode.claude).toBe("default");
		await harness.unmount();
	});

	it("adopts a newly selected agent's own switch to the mode the previous agent streamed", async () => {
		const store = fakeStore();
		store.setAcpMode("codex", "read-only");
		const harness = mountHarness(store);
		await harness.render("claude", null);
		await harness.render("claude", "plan", "m1:0");
		expect(store.mode.claude).toBe("plan");

		// Switching keeps the caller's last emission around: not codex's.
		await harness.render("codex", "plan", "m1:0");
		expect(store.mode.codex).toBe("read-only");

		// Codex then switches itself to `plan` in a new part.
		await harness.render("codex", "plan", "m2:0");
		expect(store.mode.codex).toBe("plan");
		expect(harness.result()?.acpMode).toBe("plan");

		// A re-render over the same part does not re-adopt over a manual pick.
		store.setAcpMode("codex", "default");
		await harness.render("codex", "plan", "m2:0");
		expect(store.mode.codex).toBe("default");
		await harness.unmount();
	});

	it("keys the value guard by agent when the caller has no emission key", async () => {
		const store = fakeStore();
		store.setAcpMode("codex", "read-only");
		const harness = mountHarness(store);
		await harness.render("claude", "plan");
		expect(store.mode.claude).toBe("plan");

		// A new conversation with codex starts with no streamed mode, then codex
		// switches itself to the same `plan` the previous agent last streamed.
		await harness.render("codex", null);
		expect(store.mode.codex).toBe("read-only");
		await harness.render("codex", "plan");
		expect(store.mode.codex).toBe("plan");
		await harness.unmount();
	});
});
