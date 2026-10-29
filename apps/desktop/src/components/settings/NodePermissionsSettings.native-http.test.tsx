// biome-ignore-all lint/suspicious/noMisplacedAssertion: the shared teardown asserts every case left no undeclared Core request.
// The node-wide resource permissions index against a loopback Core peer: the
// customised-resource list, its failure and retry, the kind picker fed by the
// node's own kinds, and the drill-in to one resource's permissions and back.
import {
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import {
	button,
	type CorePeer,
	click,
	fill,
	installAnimationApis,
	type PeerCall,
	registerDomWithNativeNetworking,
	startCorePeer,
	text,
	until,
} from "./models-plugins-settings.test-support.ts";

registerDomWithNativeNetworking();
installAnimationApis();
setDefaultTimeout(30_000);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { NodePermissionsSettings } = await import(
	"./NodePermissionsSettings.tsx"
);

const TOKEN = "node-permissions-token";
const initialNodeState = useNodeStore.getState();

interface CoreState {
	kinds: string[] | null;
	principalsStatus: number;
	resources: { id: string; kind: string }[];
	resourcesStatus: number;
}

let core: CoreState;
let peer: CorePeer;
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement;

function route(call: PeerCall) {
	if (call.authorization !== `Bearer ${TOKEN}`) {
		return { status: 401, body: { error: "unauthorized" } };
	}
	if (call.method !== "GET") {
		return;
	}
	if (call.path === "/api/acl/resources") {
		return core.resourcesStatus === 200
			? { body: { resources: core.resources } }
			: { status: core.resourcesStatus, body: { error: "acl store down" } };
	}
	if (call.path === "/api/acl/principals") {
		return core.principalsStatus === 200
			? {
					body: {
						org_id: "org-acme",
						...(core.kinds ? { kinds: core.kinds } : {}),
						roles: [],
						teams: [],
						members: [],
					},
				}
			: { status: core.principalsStatus, body: { error: "no directory" } };
	}
	if (call.path === "/api/acl/vocabulary") {
		return { body: { kernel: [], declared: [], collisions: [] } };
	}
	if (call.path.startsWith("/api/acl/resources/")) {
		return { body: { overwrites: [] } };
	}
	return;
}

function listReads(): number {
	return peer.calls.filter((call) => call.path === "/api/acl/resources").length;
}

function identifierInput(): HTMLInputElement {
	const input = container.querySelector<HTMLInputElement>("#acl-id");
	if (!input) {
		throw new Error(`Missing identifier input: ${text()}`);
	}
	return input;
}

async function mount() {
	root = createRoot(container);
	await act(async () => root?.render(<NodePermissionsSettings />));
	await until(
		() => !text().includes("Checking customised resources…"),
		"resource list settled"
	);
}

beforeEach(() => {
	core = {
		kinds: ["space", "agent", "workflow"],
		principalsStatus: 200,
		resources: [],
		resourcesStatus: 200,
	};
	peer = startCorePeer(route);
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: "node-permissions",
		nodes: [
			{
				name: "node-permissions",
				token: TOKEN,
				url: peer.url,
				userJwt: "node-permissions-user",
			},
		],
		tabOverrides: {},
	});
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	container.remove();
	document.body.replaceChildren();
	useNodeStore.setState(initialNodeState, true);
	peer.stop();
	expect(peer.unexpected).toEqual([]);
});

test("a failed resource list shows the error with a working Retry, never the empty state", async () => {
	core.resourcesStatus = 500;
	await mount();
	await until(
		() => text().includes("Could not list customised resources"),
		"error"
	);
	const alert = container.querySelector('[role="alert"]');
	expect(alert?.textContent).toContain("Could not list customised resources");
	expect(text()).not.toContain("Nothing customised yet");

	core.resourcesStatus = 200;
	core.resources = [{ id: "space-design", kind: "space" }];
	const before = listReads();
	await click(button("Retry"));
	await until(() => text().includes("space-design"), "retried list");
	expect(listReads()).toBe(before + 1);
	expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("an empty list from a healthy node shows the empty state", async () => {
	await mount();
	expect(text()).toContain("Nothing customised yet");
	expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("a failing principal directory keeps the list usable on the space fallback", async () => {
	core.principalsStatus = 500;
	core.resources = [{ id: "agent-writer", kind: "agent" }];
	await mount();
	expect(text()).toContain("agent-writer");
	expect(container.querySelector('[role="alert"]')).toBeNull();
	expect(identifierInput().placeholder).toBe("Space identifier");
});

test("the kind picker switches to the node's first kind when space is not offered", async () => {
	core.kinds = ["workflow", "agent"];
	await mount();
	await until(
		() => identifierInput().placeholder === "Workflow identifier",
		"kind switched"
	);
	await fill(identifierInput(), "wf-nightly");
	await click(button("Open"));
	await until(
		() =>
			peer.calls.some(
				(call) => call.path === "/api/acl/resources/workflow/wf-nightly"
			),
		"opened workflow resource"
	);
});

test("the kind picker keeps the current kind while the node still offers it", async () => {
	core.kinds = ["agent", "space"];
	await mount();
	expect(identifierInput().placeholder).toBe("Space identifier");
});

test("Edit opens the resource's permissions and All resources re-reads the list", async () => {
	core.resources = [{ id: "space-design", kind: "space" }];
	await mount();
	await click(button("Edit"));
	await until(
		() =>
			peer.calls.some(
				(call) => call.path === "/api/acl/resources/space/space-design"
			),
		"resource permissions loaded"
	);
	const before = listReads();
	core.resources = [
		{ id: "space-design", kind: "space" },
		{ id: "agent-writer", kind: "agent" },
	];
	await click(button("All resources"));
	await until(() => text().includes("agent-writer"), "list re-read");
	expect(listReads()).toBe(before + 1);
});
