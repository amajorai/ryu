import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
	type AcpSelectionStore,
	type AcpSessionConfig,
	useAcpSections,
} from "./composer-acp-sections.ts";

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

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

const SESSION_CONFIG: AcpSessionConfig = {
	configOptions: null,
	models: null,
	modes: {
		currentModeId: "default",
		availableModes: [
			{ id: "default", name: "Default" },
			{ id: "plan", name: "Plan" },
			{ id: "bypassPermissions", name: "Bypass permissions" },
		],
	},
};

const NO_OP = () => undefined;

interface ProbeProps {
	agentId: string;
	onResult: (acpMode: string | null) => void;
	store: AcpSelectionStore;
	streamedMode: string | null;
}

function Probe({ agentId, onResult, store, streamedMode }: ProbeProps) {
	const { acpMode } = useAcpSections({
		acpSessionConfig: SESSION_CONFIG,
		agentId,
		agents: [],
		engineModel: null,
		modelOptions: [],
		onEngineModelChange: NO_OP,
		store,
		streamedMode,
	});
	onResult(acpMode);
	return null;
}

test("an agent switch does not carry the previous agent's streamed mode over", async () => {
	const store = fakeStore();
	store.setAcpMode("agent-b", "plan");
	const seen: { acpMode: string | null } = { acpMode: null };
	const onResult = (value: string | null) => {
		seen.acpMode = value;
	};
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () =>
			root.render(
				<Probe
					agentId="agent-a"
					onResult={onResult}
					store={store}
					streamedMode="bypassPermissions"
				/>
			)
		);
		expect(store.mode["agent-a"]).toBe("bypassPermissions");
		expect(seen.acpMode).toBe("bypassPermissions");

		// Same conversation, the caller still holds agent A's last streamed mode.
		await act(async () =>
			root.render(
				<Probe
					agentId="agent-b"
					onResult={onResult}
					store={store}
					streamedMode="bypassPermissions"
				/>
			)
		);
		expect(store.mode["agent-b"]).toBe("plan");
		expect(seen.acpMode).toBe("plan");
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
});
