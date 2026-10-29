import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";

// The Fresh cloud box rollout gate in the chat environment picker. Only the
// flag hook is replaced; the picker, its API client and the selection store
// are real, and the node is a fetch fixture.

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let boxBackendFlag = false;
mock.module("@/src/hooks/useFeatureFlag.ts", () => ({
	useFeatureFlag: () => boxBackendFlag,
}));
const { createRoot } = await import("react-dom/client");
const { CloudEnvironmentPicker } = await import("./CloudEnvironmentPicker.tsx");

const target: ApiTarget = {
	url: "https://cloud-environment-picker.fixture",
	token: "node-token",
	userJwt: "user-jwt",
};
const originalFetch = globalThis.fetch;
const roots: Root[] = [];

function environment(
	id: string,
	name: string,
	runtime: { backend: "auto" | "box"; executor: string }
) {
	return {
		id,
		name,
		repositories: ["acme/app"],
		installScript: "",
		startInstructions: "",
		internet: { enabled: true, domainPolicy: "all", allowedDomains: [] },
		privacy: "private",
		vaultKeys: [],
		tailscaleVaultKey: null,
		published: true,
		runtime: { ...runtime, lifetimeMinutes: 30 },
	};
}
const snapshot = {
	environments: [
		environment("env-auto", "Automatic environment", {
			backend: "auto",
			executor: "ryu",
		}),
		environment("env-box", "Box environment", {
			backend: "box",
			executor: "codex",
		}),
	],
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

async function openPicker() {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () =>
		root.render(
			<CloudEnvironmentPicker
				scope="chat-scope"
				selection={{
					mode: "cloud",
					environmentId: null,
					runtime: null,
					locked: false,
				}}
				target={target}
			/>
		)
	);
	await settle();
	const trigger = document.querySelector<HTMLButtonElement>(
		"[aria-label='Choose cloud environment']"
	);
	if (!trigger) {
		throw new Error("Missing environment trigger");
	}
	await act(async () => {
		trigger.click();
	});
	await settle();
}

function profileButton(name: string): HTMLButtonElement {
	const found = [...document.querySelectorAll("button")].find((candidate) =>
		candidate.textContent?.includes(name)
	);
	if (!found) {
		throw new Error(`Missing profile ${name}`);
	}
	return found;
}

test("with the preview off, box profiles are disabled previews with no badges", async () => {
	await openPicker();
	const box = profileButton("Box environment");
	expect(box.disabled).toBe(true);
	expect(box.textContent).toContain("Preview");
	expect(box.textContent).not.toContain("Fresh box");
	expect(box.textContent).not.toContain("Codex");
	expect(profileButton("Automatic environment").disabled).toBe(false);
});

test("with the preview on, box profiles are selectable and badged", async () => {
	boxBackendFlag = true;
	await openPicker();
	const box = profileButton("Box environment");
	expect(box.disabled).toBe(false);
	expect(box.textContent).not.toContain("Preview");
	expect(box.textContent).toContain("Fresh box");
	expect(box.textContent).toContain("Codex");
});
