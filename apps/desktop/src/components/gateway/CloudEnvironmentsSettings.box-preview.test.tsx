import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";

// The Fresh cloud box rollout gate in the environment editor. Only the flag
// hook is replaced; the editor, its API client and the protocol validation are
// real, and the node is a fetch fixture.

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let boxBackendFlag = false;
mock.module("@/src/hooks/useFeatureFlag.ts", () => ({
	useFeatureFlag: () => boxBackendFlag,
}));
const { createRoot } = await import("react-dom/client");
const { CloudEnvironmentsSettings } = await import(
	"./CloudEnvironmentsSettings.tsx"
);

const target: ApiTarget = {
	url: "https://cloud-environments-settings.fixture",
	token: "node-token",
	userJwt: "user-jwt",
};
const originalFetch = globalThis.fetch;
const roots: Root[] = [];

function boxEnvironment() {
	return {
		id: "env-box",
		name: "Box environment",
		repositories: ["acme/app"],
		installScript: "",
		startInstructions: "",
		internet: { enabled: true, domainPolicy: "all", allowedDomains: [] },
		privacy: "private",
		vaultKeys: [],
		tailscaleVaultKey: null,
		published: true,
		runtime: { backend: "box", executor: "codex", lifetimeMinutes: 30 },
	};
}
const snapshot = {
	environments: [boxEnvironment()],
	revision: 1,
	schemaVersion: 1,
	vault: [],
};

beforeEach(() => {
	boxBackendFlag = false;
	globalThis.fetch = Object.assign(
		(_input: RequestInfo | URL, _init?: RequestInit) =>
			Promise.resolve(Response.json(snapshot)),
		{ preconnect: originalFetch.preconnect }
	);
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	globalThis.fetch = originalFetch;
});

async function settle() {
	await act(async () => {
		await Bun.sleep(30);
	});
}

async function mount(startCreate = false) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () =>
		root.render(
			<CloudEnvironmentsSettings startCreate={startCreate} target={target} />
		)
	);
	await settle();
}

function button(label: string): HTMLButtonElement {
	const found = [...document.querySelectorAll("button")].find(
		(candidate) => candidate.textContent?.trim() === label
	);
	if (!found) {
		throw new Error(`Missing button ${label}`);
	}
	return found;
}

function backendOptions(): { disabled: boolean; label: string }[] {
	const select = document.querySelector<HTMLSelectElement>(
		"#cloud-runtime-backend"
	);
	if (!select) {
		throw new Error("Missing backend select");
	}
	return [...select.options].map((option) => ({
		disabled: option.disabled,
		label: option.textContent?.trim() ?? "",
	}));
}

async function editBoxEnvironment() {
	await mount();
	await act(async () => {
		button("Edit").click();
	});
	await settle();
}

test("with the preview off, a new environment offers no Fresh cloud box backend", async () => {
	await mount(true);
	expect(backendOptions()).toEqual([{ disabled: false, label: "Automatic" }]);
	expect(document.querySelector("#cloud-runtime-agent")).toBeNull();
});

test("with the preview off, an existing box environment cannot be saved", async () => {
	await editBoxEnvironment();
	expect(backendOptions()).toContainEqual({
		disabled: true,
		label: "Fresh cloud box (preview not enabled)",
	});
	expect(document.body.textContent).toContain(
		"Fresh cloud box is a preview that is not enabled for your account."
	);
	expect(button("Save draft").disabled).toBe(true);
	expect(button("Publish").disabled).toBe(true);
	expect(document.querySelector("#cloud-runtime-agent")).toBeNull();
	expect(document.querySelector("#cloud-runtime-lifetime")).toBeNull();
});

test("with the preview on, the box backend is offered and saving is allowed", async () => {
	boxBackendFlag = true;
	await editBoxEnvironment();
	expect(backendOptions()).toContainEqual({
		disabled: false,
		label: "Fresh cloud box",
	});
	expect(document.body.textContent).not.toContain("preview not enabled");
	expect(document.querySelector("#cloud-runtime-agent")).not.toBeNull();
	expect(document.querySelector("#cloud-runtime-lifetime")).not.toBeNull();
	expect(button("Save draft").disabled).toBe(false);
	expect(button("Publish").disabled).toBe(false);
});
