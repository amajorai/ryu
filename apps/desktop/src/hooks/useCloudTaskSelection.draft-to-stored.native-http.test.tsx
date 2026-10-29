import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";

// The real useCloudTaskSelection over real loopback HTTP. ChatPage opens a new
// chat as a draft (`existing` false), and the first send turns it into a stored
// conversation under the SAME id (`existing` true). The transport body reads this
// selection while that send starts, and refuses to send while it reads
// "loading". These cases pin what the hook reports across that change.
const nativeFetch = globalThis.fetch;
// Bun's native fetch rejects happy-dom's AbortSignal ("signal is not of type
// AbortSignal"), and every query passes one, so the native pair stays in place.
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
const NativeResponse = globalThis.Response;
const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
globalThis.fetch = nativeFetch;
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { useCloudTaskSelection } = await import("./useCloudTaskSelection.ts");
const { cloudTaskScope, useCloudTaskSelections } = await import(
	"@/src/lib/cloud-task-selection.ts"
);

const bindingRequests: string[] = [];
let boundEnvironment: string | null = null;
let bindingUnavailable = false;
const server = Bun.serve({
	fetch(request) {
		const url = new URL(request.url);
		if (
			request.method === "GET" &&
			url.pathname.startsWith("/api/cloud-environments/task-binding/")
		) {
			bindingRequests.push(
				decodeURIComponent(url.pathname.split("/").at(-1) ?? "")
			);
			if (bindingUnavailable) {
				return NativeResponse.json({ error: "binding down" }, { status: 503 });
			}
			return NativeResponse.json({ cloudEnvironmentId: boundEnvironment });
		}
		return new NativeResponse("unexpected", { status: 404 });
	},
	hostname: "127.0.0.1",
	port: 0,
});
const target: ApiTarget = {
	token: "cloud-selection-token",
	url: `http://127.0.0.1:${server.port}`,
	userJwt: null,
};

let root: Root | null = null;
let host: HTMLElement | null = null;
const modes: string[] = [];
const scopes: (string | null)[] = [];
let retryBinding: (() => void) | null = null;
function Probe({
	conversationId,
	existing,
	probeTarget,
}: {
	conversationId: string;
	existing: boolean;
	probeTarget: ApiTarget;
}) {
	const { retry, scope, selection } = useCloudTaskSelection(
		probeTarget,
		conversationId,
		existing
	);
	retryBinding = retry;
	modes.push(selection.mode);
	scopes.push(scope);
	return (
		<span
			data-message={selection.mode === "error" ? selection.message : ""}
			data-mode={selection.mode}
		/>
	);
}
const currentMode = () =>
	host?.querySelector("[data-mode]")?.getAttribute("data-mode") ?? null;
const currentMessage = () =>
	host?.querySelector("[data-mode]")?.getAttribute("data-message") ?? null;

async function render(
	conversationId: string,
	existing: boolean,
	probeTarget: ApiTarget = target
) {
	await act(async () => {
		root?.render(
			<Probe
				conversationId={conversationId}
				existing={existing}
				probeTarget={probeTarget}
			/>
		);
	});
}
// Lets the async scope hash and the binding read settle.
async function settle() {
	for (let step = 0; step < 20; step += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
	}
}

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	bindingRequests.length = 0;
	modes.length = 0;
	scopes.length = 0;
	boundEnvironment = null;
	bindingUnavailable = false;
	retryBinding = null;
	useCloudTaskSelections.setState({ selections: {} });
});
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
});
afterAll(async () => {
	server.stop(true);
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

test("a new chat reads loading, then local, without asking Core for a binding", async () => {
	await render("draft-new", false);
	await settle();
	// The first thing a new chat reports is "loading" (the scope is hashed
	// asynchronously), and it settles on the local choice.
	expect(modes[0]).toBe("loading");
	expect(currentMode()).toBe("local");
	expect(bindingRequests).toEqual([]);
});

test("a draft that becomes a stored conversation never reads loading again", async () => {
	await render("draft-first-send", false);
	await settle();
	expect(currentMode()).toBe("local");
	const modesBefore = modes.length;
	// The first send: same id, now stored. Every render from here on is one the
	// transport body can observe while the request starts.
	await render("draft-first-send", true);
	expect(currentMode()).toBe("local");
	expect(modes.slice(modesBefore)).not.toContain("loading");
	await settle();
	expect(currentMode()).toBe("local");
	expect(modes.slice(modesBefore)).not.toContain("loading");
	// The selection stays this chat's choice and is locked in once it is stored.
	const scope = await cloudTaskScope(target, "draft-first-send");
	expect(useCloudTaskSelections.getState().selections[scope]).toEqual({
		locked: true,
		mode: "local",
	});
	// Core had no stored binding to read: the draft's own selection was kept.
	expect(bindingRequests).toEqual([]);
});

test("another stored conversation loads its own binding before it can send", async () => {
	boundEnvironment = "env-published";
	await render("stored-elsewhere", true);
	await settle();
	expect(modes[0]).toBe("loading");
	expect(currentMessage()).toBe("");
	expect(currentMode()).toBe("cloud");
	expect(bindingRequests).toEqual(["stored-elsewhere"]);
});

test("switching to a different conversation reads loading until its binding arrives", async () => {
	await render("draft-a", false);
	await settle();
	expect(currentMode()).toBe("local");
	const modesBefore = modes.length;
	await render("draft-b", false);
	await settle();
	// A different conversation is a different scope: it is unresolved until its
	// own scope is hashed, so the selection of draft-a is never lent to it.
	expect(modes[modesBefore]).toBe("loading");
	expect(currentMode()).toBe("local");
});

test("Retry after a failed binding read asks Core again and resolves it", async () => {
	bindingUnavailable = true;
	await render("stored-retry", true);
	await settle();
	expect(currentMode()).toBe("error");
	expect(bindingRequests).toEqual(["stored-retry"]);
	bindingUnavailable = false;
	boundEnvironment = "env-after-retry";
	const modesBefore = modes.length;
	await act(async () => {
		retryBinding?.();
	});
	await settle();
	// Retry asks Core a second time and the chat ends up bound, not stuck on the
	// error it showed before.
	expect(bindingRequests).toEqual(["stored-retry", "stored-retry"]);
	expect(currentMode()).toBe("cloud");
	expect(modes.slice(modesBefore)).toContain("loading");
});

// The same chat id on another node or another signed-in user is a different
// scope. The hook never clears its scope itself, so these three render
// comparisons are the only thing that keeps the previous target's selection from
// being lent to the new one while the new scope is still being hashed.
const targetChanges: [string, ApiTarget][] = [
	["node URL", { ...target, url: "http://127.0.0.1:9" }],
	["node token", { ...target, token: "another-node-token" }],
	["user JWT", { ...target, userJwt: "another-user-jwt" }],
];
for (const [label, changed] of targetChanges) {
	test(`the same chat on another ${label} reads loading until its own scope resolves`, async () => {
		await render("draft-target", false);
		await settle();
		expect(currentMode()).toBe("local");
		const modesBefore = modes.length;
		await render("draft-target", false, changed);
		// Neither the selection nor the scope of the previous target is lent out.
		expect(modes[modesBefore]).toBe("loading");
		expect(scopes[modesBefore]).toBeNull();
		await settle();
		expect(currentMode()).toBe("local");
		expect(scopes.at(-1)).toBe(await cloudTaskScope(changed, "draft-target"));
	});
}
