import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** Native command answers, by command name. */
type Native = (args: unknown) => Promise<unknown>;
let natives: Record<string, Native> = {};
const invoked: Array<{ args: unknown; command: string }> = [];
const tauriReady = await import("@/src/lib/tauri-ready.ts");
mock.module("@/src/lib/tauri-ready.ts", () => ({
	...tauriReady,
	invokeWhenReady: (command: string, args?: unknown) => {
		invoked.push({ args, command });
		const handler = natives[command];
		return handler
			? handler(args)
			: Promise.reject(new Error(`unexpected ${command}`));
	},
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SecurityKeyRequestFlow, SECURITY_KEY_DENIED_BY_USER } = await import(
	"./SecurityKeyRequests.tsx"
);

import type { Root } from "react-dom/client";
import type {
	PendingSecurityKeyRequest,
	SecurityKeyDecision,
} from "@/src/lib/api/security-key.ts";

const CREDENTIAL = {
	id: "Y3JlZA",
	response: {
		authenticator_data: "YXV0aA",
		kind: "assertion",
		signature: "c2ln",
		user_handle: null,
	},
};

function pending(
	overrides: Partial<PendingSecurityKeyRequest> = {}
): PendingSecurityKeyRequest {
	return {
		agent_id: null,
		client_data_json: "e30",
		created_at_ms: 1,
		expires_at_ms: Date.now() + 60_000,
		id: "req-1",
		kind: "get",
		options: {},
		origin: "https://login.example.com",
		page_url: "https://login.example.com/start",
		rp_id: "example.com",
		...overrides,
	};
}

let answers: Array<{ decision: SecurityKeyDecision; id: string }> = [];
let root: Root | null = null;

beforeEach(() => {
	answers = [];
	invoked.length = 0;
	natives = {
		security_key_available: () =>
			Promise.resolve({ available: true, platform: "linux" }),
		security_key_perform: () => Promise.resolve(CREDENTIAL),
	};
});

afterEach(async () => {
	const current = root;
	root = null;
	if (current) {
		await act(async () => current.unmount());
	}
	document.body.innerHTML = "";
});

async function flush(rounds = 4): Promise<void> {
	for (let round = 0; round < rounds; round += 1) {
		await act(async () => {
			await Bun.sleep(2);
		});
	}
}

async function renderFlow(request = pending()): Promise<void> {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const answer = (id: string, decision: SecurityKeyDecision) => {
		answers.push({ decision, id });
		return Promise.resolve();
	};
	await act(async () => {
		root?.render(
			<SecurityKeyRequestFlow
				answer={answer}
				nodeName="vm-1"
				request={request}
			/>
		);
	});
	await flush();
}

function prompt(): HTMLElement {
	const element = document.querySelector<HTMLElement>(
		'[data-testid="security-key-prompt"]'
	);
	if (!element) {
		throw new Error("security key prompt is not open");
	}
	return element;
}

function button(label: string): HTMLButtonElement {
	const match = [...prompt().querySelectorAll("button")].find(
		(candidate) => candidate.textContent?.trim() === label
	);
	if (!match) {
		throw new Error(`no "${label}" button`);
	}
	return match;
}

async function click(label: string): Promise<void> {
	await act(async () => {
		button(label).click();
	});
	await flush();
}

test("shows where the request comes from before anything touches the key", async () => {
	await renderFlow(pending({ agent_id: "agent-7" }));
	const text = prompt().textContent ?? "";
	expect(text).toContain("Sign in with your security key?");
	expect(text).toContain("https://login.example.com");
	expect(text).toContain("example.com");
	expect(text).toContain("Bot agent-7");
	expect(text).toContain("vm-1");
	expect(invoked.map((call) => call.command)).toEqual([
		"security_key_available",
	]);
	expect(answers).toEqual([]);
});

test("a registration request says so and names your own browser", async () => {
	await renderFlow(pending({ kind: "create" }));
	const text = prompt().textContent ?? "";
	expect(text).toContain("Register your security key?");
	expect(text).toContain("Register a key");
	expect(text).toContain("Your browser");
});

test("approving runs the ceremony and sends the credential once", async () => {
	await renderFlow();
	await click("Use security key");
	expect(invoked.at(-1)?.command).toBe("security_key_perform");
	expect(answers).toEqual([
		{ decision: { credential: CREDENTIAL, decision: "approve" }, id: "req-1" },
	] as typeof answers);
});

test("denying answers deny without touching the key", async () => {
	await renderFlow();
	await click("Deny");
	expect(answers).toEqual([
		{
			decision: { decision: "deny", reason: SECURITY_KEY_DENIED_BY_USER },
			id: "req-1",
		},
	]);
	expect(invoked.some((call) => call.command === "security_key_perform")).toBe(
		false
	);
});

test("a key that needs its PIN asks for it and retries with it", async () => {
	natives.security_key_perform = () => Promise.reject("pin_required");
	natives.security_key_perform_with_pin = () => Promise.resolve(CREDENTIAL);
	const request = pending();
	await renderFlow(request);
	await click("Use security key");
	const input = prompt().querySelector<HTMLInputElement>(
		'input[type="password"]'
	);
	if (!input) {
		throw new Error("no PIN field");
	}
	expect(button("Continue").disabled).toBe(true);
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set;
		setter?.call(input, "123456");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await click("Continue");
	expect(invoked.at(-1)).toEqual({
		args: { pin: "123456", request },
		command: "security_key_perform_with_pin",
	});
	expect(answers.map((entry) => entry.decision.decision)).toEqual(["approve"]);
});

test("a timeout can be retried and nothing is answered yet", async () => {
	natives.security_key_perform = () => Promise.reject("timeout: no touch");
	await renderFlow();
	await click("Use security key");
	expect(prompt().textContent).toContain("No security key answered in time.");
	expect(button("Try again")).toBeTruthy();
	expect(answers).toEqual([]);
});

test("a key that cannot answer this site ends the request with its code", async () => {
	natives.security_key_perform = () =>
		Promise.reject("no_credentials: nothing stored");
	await renderFlow();
	await click("Use security key");
	expect(prompt().textContent).toContain(
		"This key has no sign-in saved for this site."
	);
	await click("Close");
	expect(answers).toEqual([
		{ decision: { decision: "deny", reason: "no_credentials" }, id: "req-1" },
	]);
});

test("a desktop with no reachable key says why and blocks approval", async () => {
	natives.security_key_available = () =>
		Promise.resolve({
			available: false,
			platform: "linux",
			reason: "no HID access",
		});
	await renderFlow();
	expect(prompt().textContent).toContain(
		"This device can't use a security key: no HID access"
	);
	expect(button("Use security key").disabled).toBe(true);
});
