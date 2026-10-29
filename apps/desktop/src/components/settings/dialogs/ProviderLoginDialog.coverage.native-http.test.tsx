// biome-ignore-all lint/suspicious/noMisplacedAssertion: the shared teardown asserts every case left no undeclared Core request.
// ProviderLoginDialog against a loopback Core peer that serves the real login
// start, SSE event stream, answer and cancel routes. The dialog, its stream
// reader, the active-node store and the Tauri bridge gate are the shipping
// code; the only stand-ins are the OS boundaries the dialog reaches through:
// the native `open_external` command and the system clipboard.
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
	flush,
	installAnimationApis,
	isDisabled,
	maybeButton,
	type PeerCall,
	registerDomWithNativeNetworking,
	startCorePeer,
	text,
	until,
} from "../models-plugins-settings.test-support.ts";

registerDomWithNativeNetworking();
installAnimationApis();
setDefaultTimeout(30_000);

interface NativeCall {
	args: unknown;
	command: string;
}
const nativeCalls: NativeCall[] = [];
let refuseNativeOpens = 0;
// The desktop shell's IPC kernel: `open_external` is the only command this
// dialog sends, and a refusal is how a missing default browser surfaces.
Reflect.set(window, "__TAURI_INTERNALS__", {
	invoke: async (command: string, args: unknown) => {
		nativeCalls.push({ command, args });
		if (command === "open_external" && refuseNativeOpens > 0) {
			refuseNativeOpens -= 1;
			throw new Error("No default browser is configured");
		}
		return null;
	},
	transformCallback: () => 1,
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { ProviderLoginDialog } = await import("./ProviderLoginDialog.tsx");

const TOKEN = "provider-login-token";
const SESSION = "login-session-1";
const initialNodeState = useNodeStore.getState();
const encoder = new TextEncoder();

let peer: CorePeer;
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement;
let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
let answers: { accepted: boolean; error?: string }[] = [];
let successes: unknown[] = [];
const originalClipboardWrite = navigator.clipboard.writeText.bind(
	navigator.clipboard
);

function route(call: PeerCall) {
	if (call.authorization !== `Bearer ${TOKEN}`) {
		return { status: 401, body: { error: "unauthorized" } };
	}
	if (
		call.method === "POST" &&
		call.path === "/api/pi-config/providers/github-copilot/login"
	) {
		return { body: { sessionId: SESSION } };
	}
	if (
		call.method === "GET" &&
		call.path === `/api/pi-config/login/${SESSION}/events`
	) {
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					stream = controller;
				},
			}),
			{ headers: { "content-type": "text/event-stream" } }
		);
	}
	if (
		call.method === "POST" &&
		call.path === `/api/pi-config/login/${SESSION}/answer`
	) {
		return { body: answers.shift() ?? { accepted: true } };
	}
	if (
		call.method === "POST" &&
		call.path === `/api/pi-config/login/${SESSION}/cancel`
	) {
		return { body: { cancelled: true } };
	}
	return;
}

async function emit(event: Record<string, unknown>) {
	await until(() => stream !== null, "event stream attached");
	await act(async () => {
		stream?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
	});
	await flush();
}

async function mount() {
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<>
				<ProviderLoginDialog
					onOpenChange={() => undefined}
					onSuccess={(event) => successes.push(event)}
					open
					providerId="github-copilot"
					providerLabel="GitHub Copilot"
				/>
				<Toaster />
			</>
		)
	);
	await until(() => stream !== null, "login started and streaming");
}

function answerCalls() {
	return peer.calls
		.filter((call) => call.path.endsWith("/answer"))
		.map((call) => call.body);
}

beforeEach(() => {
	nativeCalls.length = 0;
	refuseNativeOpens = 0;
	stream = null;
	answers = [];
	successes = [];
	peer = startCorePeer(route);
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: "provider-login-coverage",
		nodes: [
			{
				name: "provider-login-coverage",
				token: TOKEN,
				url: peer.url,
				userJwt: null,
			},
		],
		tabOverrides: {},
	});
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	await act(async () => {
		root?.unmount();
		sileo.clear();
	});
	root = null;
	try {
		stream?.close();
	} catch {
		// The dialog's cleanup may already have aborted the stream.
	}
	navigator.clipboard.writeText = originalClipboardWrite;
	container.remove();
	document.body.replaceChildren();
	useNodeStore.setState(initialNodeState, true);
	await flush();
	peer.stop();
	expect(peer.unexpected).toEqual([]);
});

test("a browser that will not open is reported and Open the verification page retries the native open", async () => {
	refuseNativeOpens = 1;
	await mount();
	await emit({
		type: "device_code",
		userCode: "WXYZ-1234",
		verificationUri: "https://github.com/login/device",
	});
	await until(
		() =>
			text().includes(
				"Could not open your browser. Use the button below to retry."
			),
		"browser launch failure"
	);
	await click(button("Open the verification page"));
	await until(
		() => !text().includes("Could not open your browser."),
		"failure retired after a successful open"
	);
	expect(nativeCalls).toEqual([
		{
			command: "open_external",
			args: { url: "https://github.com/login/device" },
		},
		{
			command: "open_external",
			args: { url: "https://github.com/login/device" },
		},
	]);
});

test("Copy code puts Core's code on the clipboard and says Copied; a refused clipboard says so and keeps the button", async () => {
	await mount();
	await emit({
		type: "device_code",
		userCode: "WXYZ-1234",
		verificationUri: "https://github.com/login/device",
	});
	await until(() => maybeButton("Copy code") !== null, "device code shown");

	navigator.clipboard.writeText = () =>
		Promise.reject(new DOMException("Denied", "NotAllowedError"));
	await click(button("Copy code"));
	await until(
		() => text().includes("Couldn't copy the device code"),
		"clipboard refusal"
	);
	expect(maybeButton("Copied")).toBeNull();

	navigator.clipboard.writeText = originalClipboardWrite;
	await click(button("Copy code"));
	await until(() => maybeButton("Copied") !== null, "copied state");
	expect(await navigator.clipboard.readText()).toBe("WXYZ-1234");
	expect(text()).toContain("Device code copied");

	// A fresh code from the flow resets the copied state.
	await emit({
		type: "device_code",
		userCode: "NEWC-0DE5",
		verificationUri: "https://github.com/login/device",
	});
	await until(() => maybeButton("Copy code") !== null, "new code copyable");
});

test("a choice the flow refuses keeps the prompt with the flow's reason; the next choice is sent by its id and the flow moves on", async () => {
	answers = [
		{ accepted: false, error: "That organisation has no Copilot seat." },
		{ accepted: true },
	];
	await mount();
	await emit({
		type: "prompt",
		id: "org-choice",
		prompt: {
			type: "select",
			message: "Which organisation should pay for Copilot?",
			options: [
				{ id: "org-personal", label: "Personal account" },
				{ id: "org-acme", label: "Acme Corp" },
			],
		},
	});
	await until(
		() => text().includes("Which organisation should pay for Copilot?"),
		"select prompt"
	);
	await click(button("Personal account"));
	await until(
		() => text().includes("That organisation has no Copilot seat."),
		"refusal reason"
	);
	expect(isDisabled(button("Acme Corp"))).toBe(false);
	expect(text()).toContain("Which organisation should pay for Copilot?");

	await click(button("Acme Corp"));
	await until(
		() => !text().includes("Which organisation should pay for Copilot?"),
		"prompt resolved"
	);
	expect(answerCalls()).toEqual([
		{ prompt_id: "org-choice", value: "org-personal" },
		{ prompt_id: "org-choice", value: "org-acme" },
	]);
	// The accepted choice retires the earlier refusal: the flow is running
	// again, so the dialog reports progress and is not yet dismissible.
	expect(text()).not.toContain("That organisation has no Copilot seat.");
	expect(text()).toContain("Working…");
	expect(document.querySelector('[data-slot="dialog-close"]')).toBeNull();
	expect(successes).toEqual([]);

	await emit({ type: "success", provider: "github-copilot" });
	await until(
		() => text().includes("Connected. GitHub Copilot is ready to use."),
		"success state"
	);
	expect(maybeButton("Done")).not.toBeNull();
	expect(successes).toHaveLength(1);
});
