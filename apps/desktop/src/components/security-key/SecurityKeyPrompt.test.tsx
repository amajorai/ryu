import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

import type { Root } from "react-dom/client";
import type { PendingSecurityKeyRequest } from "@/src/lib/api/security-key.ts";
import type {
	SecurityKeyPhase,
	SecurityKeyPromptProps,
} from "./SecurityKeyPrompt.tsx";

// React DOM is loaded after the DOM is registered (see the hook test).
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SecurityKeyPrompt, SECURITY_KEY_PIN_MIN_CHARS } = await import(
	"./SecurityKeyPrompt.tsx"
);

const REQUEST: PendingSecurityKeyRequest = {
	agent_id: "agent-7",
	client_data_json: "e30",
	created_at_ms: 1,
	expires_at_ms: Date.now() + 60_000,
	id: "req-1",
	kind: "get",
	options: {},
	origin: "https://login.example.com",
	page_url: "https://login.example.com/start",
	rp_id: "example.com",
};

let root: Root | null = null;
let events: string[] = [];

afterEach(async () => {
	const current = root;
	root = null;
	if (current) {
		await act(async () => current.unmount());
	}
	document.body.innerHTML = "";
	events = [];
});

async function renderPrompt(
	phase: SecurityKeyPhase,
	overrides: Partial<SecurityKeyPromptProps> = {}
): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(
			<SecurityKeyPrompt
				nodeName="vm-1"
				onApprove={() => events.push("approve")}
				onDeny={() => events.push("deny")}
				onSubmitPin={(pin) => events.push(`pin:${pin}`)}
				phase={phase}
				request={REQUEST}
				{...overrides}
			/>
		);
	});
	const prompt = document.querySelector<HTMLElement>(
		'[data-testid="security-key-prompt"]'
	);
	if (!prompt) {
		throw new Error("security key prompt is not open");
	}
	return prompt;
}

function buttonLabels(prompt: HTMLElement): string[] {
	return [...prompt.querySelectorAll("button")].map(
		(button) => button.textContent?.trim() ?? ""
	);
}

function button(prompt: HTMLElement, label: string): HTMLButtonElement {
	const match = [...prompt.querySelectorAll("button")].find(
		(candidate) => candidate.textContent?.trim() === label
	);
	if (!match) {
		throw new Error(`no ${label} button`);
	}
	return match;
}

async function typePin(prompt: HTMLElement, pin: string): Promise<void> {
	const input = prompt.querySelector<HTMLInputElement>(
		'input[type="password"]'
	);
	if (!input) {
		throw new Error("no PIN field");
	}
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set;
		setter?.call(input, pin);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

test("shows the site, relying party and lane from the request", async () => {
	const prompt = await renderPrompt("confirm");
	const text = prompt.textContent ?? "";
	expect(text).toContain("Sign in with your security key?");
	expect(text).toContain("https://login.example.com");
	expect(text).toContain("example.com");
	expect(text).toContain("Bot agent-7");
	expect(button(prompt, "Use security key").disabled).toBe(false);
});

test("the PIN form submits only once the PIN is long enough", async () => {
	const prompt = await renderPrompt("pin");
	const short = "1".repeat(SECURITY_KEY_PIN_MIN_CHARS - 1);
	await typePin(prompt, short);
	expect(button(prompt, "Continue").disabled).toBe(true);
	const form = prompt.querySelector("form");
	await act(async () => {
		form?.dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true })
		);
	});
	expect(events).toEqual([]);

	await typePin(prompt, "1234");
	expect(button(prompt, "Continue").disabled).toBe(false);
	await act(async () => button(prompt, "Continue").click());
	expect(events).toEqual(["pin:1234"]);
});

test("a wrong-PIN message is announced in the PIN form", async () => {
	const prompt = await renderPrompt("pin", {
		message: "Wrong PIN. 2 attempts left.",
	});
	expect(prompt.querySelector('[role="alert"]')?.textContent).toBe(
		"Wrong PIN. 2 attempts left."
	);
});

test("a failed request offers only Close, which denies", async () => {
	const prompt = await renderPrompt("failed", {
		message: "This key has no sign-in saved for this site.",
	});
	expect(buttonLabels(prompt)).toEqual(["Close"]);
	expect(prompt.textContent).toContain(
		"This key has no sign-in saved for this site."
	);
	await act(async () => button(prompt, "Close").click());
	expect(events).toEqual(["deny"]);
});

test("a retryable failure offers Try again", async () => {
	const prompt = await renderPrompt("retry", {
		message: "No security key answered in time.",
	});
	expect(buttonLabels(prompt)).toEqual(["Deny", "Try again"]);
	await act(async () => button(prompt, "Try again").click());
	expect(events).toEqual(["approve"]);
});

test("a desktop without a key backend cannot approve", async () => {
	const prompt = await renderPrompt("confirm", {
		availabilityProblem: "This device can't use a security key.",
	});
	expect(button(prompt, "Use security key").disabled).toBe(true);
	expect(prompt.textContent).toContain("This device can't use a security key.");
});
