// Number matching: the approval prompt never shows the user code. The approver
// types the code the requesting device shows, and the requester's own device
// name and browser are labelled as reported by that device.

import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { I18nProvider } = await import("@ryu/i18n/react");
const { LoginApprovalPrompt } = await import("./login-approval.tsx");

const REQUEST = {
	clientId: "ryu-desktop",
	createdAt: "2026-11-06T00:00:00.000Z",
	deviceLabel: "Your MacBook Pro (this device)",
	expiresAt: "2026-11-06T00:05:00.000Z",
	id: "request-1",
	ipAddress: "203.0.113.44",
	status: "pending",
	surface: "desktop",
	userAgent: "Chromium 141",
} as const;

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
	registerLiteralCatalogLoader(null);
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

function approveButton(): HTMLButtonElement {
	const button = [...document.querySelectorAll("button")].find((candidate) =>
		candidate.textContent?.includes("Approve sign-in")
	);
	if (!button) {
		throw new Error("Expected the approve button");
	}
	return button;
}

test("requires the device's code before approving and labels device-reported identity", async () => {
	const approved: string[] = [];
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<LoginApprovalPrompt
				onApprove={(code) => {
					approved.push(code);
				}}
				onDeny={() => undefined}
				open
				request={REQUEST}
			/>
		);
	});

	const text = document.body.textContent ?? "";
	expect(text).toContain(
		"Reported by the requesting device: Your MacBook Pro (this device) · Chromium 141"
	);
	expect(text).toContain("Requested from 203.0.113.44");
	expect(approveButton().disabled).toBe(true);

	const input = document.querySelector<HTMLInputElement>(
		'input[aria-label="Code shown on the requesting device"]'
	);
	if (!input) {
		throw new Error("Expected the code input");
	}
	await act(async () => {
		const setValue = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set;
		setValue?.call(input, "abcd2345");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	expect(approveButton().disabled).toBe(false);
	await act(async () => {
		approveButton().click();
	});
	expect(approved).toEqual(["ABCD2345"]);
});

test("translates the device-reported identity as one whole message", async () => {
	const german: Record<string, string> = {
		"Reported by the requesting device: {deviceLabel}":
			"Vom anfragenden Gerät gemeldet: {deviceLabel}",
	};
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("de") ? german : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="de" initialPackId={null}>
				<LoginApprovalPrompt
					onApprove={() => undefined}
					onDeny={() => undefined}
					open
					request={{ ...REQUEST, userAgent: null }}
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});

	const text = document.body.textContent ?? "";
	expect(text).toContain(
		"Vom anfragenden Gerät gemeldet: Your MacBook Pro (this device)"
	);
	expect(text).not.toContain("Reported by the requesting device");
});
