import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { Node } from "@/src/store/useNodeStore.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { sileo } = await import("sileo");
const { getEditorAiConfig, setEditorAiConfig } = await import(
	"@ryu/ui/lib/editor-ai.ts"
);
const { queryClient } = await import("@/src/lib/query-client.ts");
const { agentListOptions } = await import("@/src/lib/agent-list-query.ts");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { deriveGatewayBase, EDITOR_AI_PREF_KEY } = await import(
	"@/src/hooks/useRegisterEditorAi.ts"
);
const { QueryClientProvider } = await import("@tanstack/react-query");
const { MemoryRouter } = await import("react-router-dom");
const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
const { EditorEmbeddingSettings } = await import(
	"./EditorEmbeddingSettings.tsx"
);

const node: Node = {
	name: "editor-ai-proof",
	url: "https://editor.fixture:7980",
	token: "editor-token",
	userJwt: "editor-user",
};
const writer = {
	id: "writer",
	name: "Writer",
	model: "llama-3-8b",
} as unknown as AgentSummary;

interface Call {
	body: { value: string } | null;
	method: string;
	path: string;
	token: string | null;
}
const originalFetch = globalThis.fetch;
const originalNodes = useNodeStore.getState();
const roots: Root[] = [];
let calls: Call[] = [];
/** The node's stored preference value, written by PUT and served by GET. */
let stored: string | null = null;
let preferenceStatus = 200;
let saveStatus = 200;
let errorToast: ReturnType<typeof spyOn<typeof sileo, "error">>;
let successToast: ReturnType<typeof spyOn<typeof sileo, "success">>;
let warningToast: ReturnType<typeof spyOn<typeof sileo, "warning">>;

function respond(call: Call): Response {
	if (call.path === `/api/preferences/${EDITOR_AI_PREF_KEY}`) {
		if (call.method === "PUT") {
			if (saveStatus !== 200) {
				return Response.json({ error: "denied" }, { status: saveStatus });
			}
			stored = call.body?.value ?? null;
			return Response.json({ ok: true });
		}
		if (preferenceStatus !== 200) {
			return Response.json({ error: "down" }, { status: preferenceStatus });
		}
		return stored === null
			? Response.json({ error: "missing" }, { status: 404 })
			: Response.json({ value: stored });
	}
	if (call.path === "/api/embeddings/model") {
		return Response.json({ model_id: "nomic-embed-text", dims: 768 });
	}
	if (call.path === "/api/embeddings/reindex/status") {
		return Response.json({
			current_model: "nomic-embed-text",
			current_dims: 768,
			total_chunks: 0,
			pending_chunks: 0,
			running: false,
		});
	}
	return Response.json({ error: "undeclared" }, { status: 404 });
}

beforeEach(() => {
	calls = [];
	stored = null;
	preferenceStatus = 200;
	saveStatus = 200;
	setEditorAiConfig({
		enabled: false,
		model: "",
		baseUrl: null,
		agentId: undefined,
		apiKey: undefined,
	});
	queryClient.clear();
	queryClient.setQueryData(agentListOptions(node).queryKey, [writer]);
	useNodeStore.setState({
		nodes: [node],
		defaultNode: node.name,
		autoSelect: false,
	});
	errorToast = spyOn(sileo, "error");
	successToast = spyOn(sileo, "success");
	warningToast = spyOn(sileo, "warning");
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			const call: Call = {
				path: url.pathname,
				method: init?.method ?? "GET",
				token: new Headers(init?.headers).get("authorization"),
				body: init?.body ? JSON.parse(String(init.body)) : null,
			};
			calls.push(call);
			return await Promise.resolve(respond(call));
		},
		{ preconnect: originalFetch.preconnect }
	);
});

afterEach(async () => {
	await unmountAll();
	errorToast.mockRestore();
	successToast.mockRestore();
	warningToast.mockRestore();
	globalThis.fetch = originalFetch;
	queryClient.clear();
	useNodeStore.setState(originalNodes);
});

async function unmountAll() {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
}

async function settle() {
	await act(async () => {
		await Bun.sleep(5);
	});
}

async function mount() {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () =>
		root.render(
			<QueryClientProvider client={queryClient}>
				<MemoryRouter>
					<EntitlementProvider>
						<EditorEmbeddingSettings />
					</EntitlementProvider>
				</MemoryRouter>
			</QueryClientProvider>
		)
	);
	await settle();
}

function editorRegion(): HTMLElement {
	const region = document.querySelector<HTMLElement>(
		'[aria-labelledby="editor-ai-settings-title"], [aria-label="Inline AI editing"]'
	);
	if (!region) {
		throw new Error("Missing editor AI region");
	}
	return region;
}

function editorSwitch(): HTMLElement {
	const element = document.querySelector<HTMLElement>(
		'[role="switch"][aria-label="Enable editor AI"]'
	);
	if (!element) {
		throw new Error("Missing editor AI switch");
	}
	return element;
}

function modelInput(): HTMLInputElement | null {
	return document.querySelector<HTMLInputElement>("#editor-ai-model");
}

async function type(element: HTMLInputElement, value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function buttonIn(scope: HTMLElement, name: string): HTMLButtonElement {
	const match = Array.from(scope.querySelectorAll("button")).find(
		(candidate) => candidate.textContent?.trim() === name
	);
	if (!match) {
		throw new Error(`Missing button ${name}`);
	}
	return match;
}

async function click(element: HTMLElement) {
	await act(async () => {
		element.click();
	});
	await settle();
}

async function chooseAgent(name: string) {
	const trigger = document.querySelector<HTMLElement>("#editor-ai-agent");
	if (!trigger) {
		throw new Error("Missing agent picker");
	}
	await click(trigger);
	const option = Array.from(
		document.querySelectorAll<HTMLElement>('[role="option"]')
	).find((candidate) => candidate.textContent?.trim() === name);
	if (!option) {
		throw new Error(`Missing agent option ${name}`);
	}
	await click(option);
}

/** Writes of the editor AI preference (the entitlement provider publishes its own key). */
function puts(): Call[] {
	return calls.filter(
		(call) =>
			call.method === "PUT" &&
			call.path === `/api/preferences/${EDITOR_AI_PREF_KEY}`
	);
}

function toastTitle(spy: { mock: { calls: unknown[][] } }): unknown[] {
	return spy.mock.calls.map((args) =>
		typeof args[0] === "object" && args[0] !== null
			? Reflect.get(args[0], "title")
			: args[0]
	);
}

test("a custom-model save persists the preference, applies it to the editor, and reads back after a remount", async () => {
	await mount();
	expect(editorSwitch().getAttribute("aria-checked")).toBe("false");

	await click(editorSwitch());
	const field = modelInput();
	if (!field) {
		throw new Error("Missing model field");
	}
	await type(field, "  qwen-2.5  ");
	await click(buttonIn(editorRegion(), "Save"));

	expect(puts()).toHaveLength(1);
	expect(puts()[0]?.token).toBe(`Bearer ${node.token}`);
	expect(JSON.parse(puts()[0]?.body?.value ?? "null")).toEqual({
		enabled: true,
		model: "qwen-2.5",
		baseUrl: "",
	});
	expect(getEditorAiConfig()).toMatchObject({
		enabled: true,
		model: "qwen-2.5",
		baseUrl: deriveGatewayBase(node.url),
		apiKey: node.token,
	});
	expect(toastTitle(successToast)).toEqual(["Editor AI settings saved"]);

	await unmountAll();
	await mount();
	expect(editorSwitch().getAttribute("aria-checked")).toBe("true");
	expect(modelInput()?.value).toBe("qwen-2.5");
});

test("choosing an agent saves its id and model instead of the manual field, and Custom model brings the field back", async () => {
	stored = JSON.stringify({ enabled: true, model: "old-model", baseUrl: "" });
	await mount();
	expect(modelInput()?.value).toBe("old-model");

	await chooseAgent("Writer");
	expect(modelInput()).toBeNull();
	expect(editorRegion().textContent).toContain("Uses Writer's model:");

	await click(buttonIn(editorRegion(), "Save"));
	expect(JSON.parse(puts()[0]?.body?.value ?? "null")).toEqual({
		enabled: true,
		model: "llama-3-8b",
		baseUrl: "",
		agentId: "writer",
	});
	expect(getEditorAiConfig()).toMatchObject({
		enabled: true,
		model: "llama-3-8b",
		agentId: "writer",
	});

	await chooseAgent("Custom model");
	expect(modelInput()?.value).toBe("old-model");
});

test("a rejected save shows the failure toast and leaves the live editor config untouched", async () => {
	saveStatus = 403;
	await mount();
	await click(editorSwitch());
	const field = modelInput();
	if (!field) {
		throw new Error("Missing model field");
	}
	await type(field, "qwen-2.5");
	await click(buttonIn(editorRegion(), "Save"));

	expect(puts()).toHaveLength(1);
	expect(toastTitle(errorToast)).toEqual(["Couldn't save editor AI settings"]);
	expect(successToast).not.toHaveBeenCalled();
	expect(getEditorAiConfig()).toMatchObject({ enabled: false, model: "" });
	expect(stored).toBeNull();
});

test("enabling without a model saves but warns and keeps inline AI inactive", async () => {
	await mount();
	await click(editorSwitch());
	await click(buttonIn(editorRegion(), "Save"));

	expect(JSON.parse(stored ?? "null")).toEqual({
		enabled: true,
		model: "",
		baseUrl: "",
	});
	expect(toastTitle(warningToast)).toEqual([
		"Saved, but inline AI isn't active yet",
	]);
	expect(getEditorAiConfig().enabled).toBe(false);
});

test("a failed preference read shows a retry that recovers the stored value", async () => {
	stored = JSON.stringify({ enabled: true, model: "gemma", baseUrl: "" });
	preferenceStatus = 500;
	await mount();
	expect(editorRegion().textContent).toContain(
		"Couldn't load editor AI settings."
	);
	expect(document.querySelector("#editor-ai-model")).toBeNull();

	preferenceStatus = 200;
	await click(buttonIn(editorRegion(), "Retry"));
	expect(modelInput()?.value).toBe("gemma");
	expect(editorSwitch().getAttribute("aria-checked")).toBe("true");
});
