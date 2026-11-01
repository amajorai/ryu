import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";

// The datacenter-IP plan warning: its copy and status role, the "Learn more"
// link to the public "Where your agent runs" page, and the managed-node lookup
// the cloud-task chooser feeds it. Only the native bridge is replaced; the node
// store is real and seeded per case.

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const realBridge = await import("@/lib/tauri-bridge.ts");
/** Links the warning opened in the browser. */
const opened: string[] = [];
mock.module("@/lib/tauri-bridge.ts", () => ({
	...realBridge,
	openExternal: (url: string) => {
		opened.push(url);
		return Promise.resolve();
	},
}));
const { createRoot } = await import("react-dom/client");
const { FRONTEND_URL } = await import("@/lib/auth-client.ts");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { DatacenterPlanWarning, useNodeManaged, WHERE_AGENTS_RUN_DOCS_PATH } =
	await import("./DatacenterPlanWarning.tsx");

const originalNodes = useNodeStore.getState().nodes;
const roots: Root[] = [];

beforeEach(() => {
	opened.length = 0;
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	useNodeStore.setState({ nodes: originalNodes });
});

async function render(element: ReactElement) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => root.render(element));
	return container;
}

function ManagedProbe({ url }: { url: string }) {
	return <output>{useNodeManaged(url) ? "managed" : "not-managed"}</output>;
}

async function managedText(url: string) {
	const container = await render(<ManagedProbe url={url} />);
	return container.querySelector("output")?.textContent;
}

test("renders the datacenter warning as a status with the plan advice", async () => {
	const container = await render(<DatacenterPlanWarning className="extra" />);
	const warning = container.querySelector(
		"[data-testid='datacenter-plan-warning']"
	);
	expect(warning?.getAttribute("role")).toBe("status");
	expect(warning?.className).toContain("extra");
	expect(warning?.textContent).toContain(
		"it runs from a cloud server's IP address, not your own"
	);
	expect(warning?.textContent).toContain("choose Agent on your computer");
});

test("Learn more opens the public where-agents-run page", async () => {
	const container = await render(<DatacenterPlanWarning />);
	const button = [...container.querySelectorAll("button")].find(
		(candidate) => candidate.textContent === "Learn more"
	);
	expect(button).toBeDefined();
	await act(async () => {
		button?.click();
	});
	expect(opened).toEqual([`${FRONTEND_URL}${WHERE_AGENTS_RUN_DOCS_PATH}`]);
	expect(WHERE_AGENTS_RUN_DOCS_PATH).toBe(
		"/docs/surfaces/desktop/user-guide/where-agents-run"
	);
});

test("useNodeManaged is true only for a managed node at the same url", async () => {
	useNodeStore.setState({
		nodes: [
			{
				managed: true,
				name: "cloud",
				token: "t",
				url: "https://cloud.fixture/",
			},
			{ name: "laptop", token: "t", url: "https://laptop.fixture" },
			{
				managed: false,
				name: "lan",
				token: "t",
				url: "https://lan.fixture",
			},
		],
	});
	expect(await managedText("https://cloud.fixture")).toBe("managed");
	expect(await managedText("https://cloud.fixture/")).toBe("managed");
	expect(await managedText("https://laptop.fixture")).toBe("not-managed");
	expect(await managedText("https://lan.fixture/")).toBe("not-managed");
	expect(await managedText("https://other.fixture")).toBe("not-managed");
});
