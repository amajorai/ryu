import { describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

interface Snapshot {
	canConfigure?: boolean;
	completed?: boolean;
}
let nextRead: () => Promise<Snapshot> = () =>
	Promise.reject(new Error("no endpoint"));
const reads: string[] = [];

mock.module("@/src/lib/api/onboarding-profile.ts", () => ({
	fetchNodeOnboardingState: ({ url }: { url: string }) => {
		reads.push(url);
		return nextRead();
	},
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useNodeOnboardingState } = await import(
	"./use-node-onboarding-state.ts"
);

type Node = Parameters<
	typeof useNodeOnboardingState
>[0]["activeNodeForOnboarding"];

const statuses: string[] = [];

function Probe({ node }: { node: Node }) {
	const { nodeOnboardingStateStatus } = useNodeOnboardingState({
		activeNodeForOnboarding: node,
		authed: true,
		botProduct: false,
		nodesReady: true,
		startupSelectionStatus: "ready",
		vaultReady: true,
	});
	statuses.push(nodeOnboardingStateStatus);
	return null;
}

function node(url: string, userJwt: string): Node {
	return { name: "local", url, userJwt } as Node;
}

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

describe("useNodeOnboardingState", () => {
	test("re-reads for the same node never fall back to loading", async () => {
		const root = createRoot(document.createElement("div"));
		await act(async () => {
			root.render(<Probe node={node("http://127.0.0.1:7980", "jwt-1")} />);
		});
		await flush();
		expect(statuses.at(-1)).toBe("ready");

		// A rebuilt node object with a refreshed bearer (the window-focus token
		// refresh) re-reads quietly: the shell must not swap to the boot splash,
		// which would remount and restart onboarding.
		statuses.length = 0;
		await act(async () => {
			root.render(<Probe node={node("http://127.0.0.1:7980", "jwt-2")} />);
		});
		await flush();
		expect(reads).toHaveLength(2);
		expect(statuses).not.toContain("loading");

		// A rebuilt object with identical fields does not read again at all.
		await act(async () => {
			root.render(<Probe node={node("http://127.0.0.1:7980", "jwt-2")} />);
		});
		await flush();
		expect(reads).toHaveLength(2);

		// Switching to a different node is a real gate again.
		statuses.length = 0;
		nextRead = () => Promise.resolve({ completed: true });
		await act(async () => {
			root.render(<Probe node={node("https://other.example", "jwt-2")} />);
		});
		await flush();
		expect(statuses).toContain("loading");
		expect(statuses.at(-1)).toBe("ready");

		await act(async () => {
			root.unmount();
		});
	});
});
