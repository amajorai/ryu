import { afterAll, expect, test } from "bun:test";
import { webcrypto } from "node:crypto";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
// Preserve real Bun HTTP transport after Happy DOM installs browser globals.
Object.defineProperty(globalThis, "fetch", {
	value: nativeFetch,
	configurable: true,
	writable: true,
});
Object.defineProperty(globalThis, "Response", {
	value: NativeResponse,
	configurable: true,
	writable: true,
});
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
	value: true,
	configurable: true,
	writable: true,
});
Object.defineProperty(globalThis, "crypto", {
	value: webcrypto,
	configurable: true,
});
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { FirstProjectStep } = await import("./FirstProjectStep.tsx");
const { persistAcknowledgedOnboardingProject, restoreOnboardingProject } =
	await import("@/src/lib/onboarding-project-persistence.ts");
const { getActiveUserId } = await import("@/lib/auth-client.ts");
const calls: { method: string; body: unknown }[] = [];
const project = {
	id: "created-once",
	name: "My first project",
	description: "",
	status: "active",
	coordinatorConversationId: "main-created-once",
};
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const text = await request.text();
		calls.push({
			method: request.method,
			body: text ? JSON.parse(text) : null,
		});
		if (
			new URL(request.url).pathname !== "/api/projects/projects" ||
			request.headers.get("authorization") !== "Bearer node-secret"
		) {
			return NativeResponse.json(
				{ error: "unexpected request" },
				{ status: 422 }
			);
		}
		if (request.method === "POST") {
			return NativeResponse.json(project);
		}
		if (request.method === "GET") {
			return NativeResponse.json({ projects: [project] });
		}
		return NativeResponse.json(
			{ error: "unsupported method" },
			{ status: 405 }
		);
	},
});
afterAll(() => server.stop(true));
async function waitForOutcome(
	container: HTMLElement,
	predicate: () => boolean,
	description: string
): Promise<void> {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		await act(async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
		});
		if (predicate()) {
			return;
		}
	}
	const alert =
		container.querySelector('[role="alert"]')?.textContent?.slice(0, 400) ??
		"none";
	const buttons = Array.from(container.querySelectorAll("button"))
		.map(
			(button) =>
				`${button.textContent?.slice(0, 80)}:${button.disabled ? "disabled" : "enabled"}`
		)
		.join(" | ")
		.slice(0, 400);
	throw new Error(
		`Timed out waiting for ${description}; calls=${calls.map((call) => call.method).join(",")}; alert=${alert}; buttons=${buttons}`
	);
}
test.each([
	"throw",
	"discard",
] as const)("mounted acknowledged form retries %s continuation without creating twice", async (mode) => {
	calls.length = 0;
	localStorage.clear();
	localStorage.setItem(
		"ryu_accounts",
		JSON.stringify([
			{
				email: "owner@example.com",
				image: null,
				name: "Actual Owner",
				token: "owner-token",
				userId: "actual-owner",
			},
		])
	);
	localStorage.setItem("ryu_active_user_id", "actual-owner");
	expect(getActiveUserId()).toBe("actual-owner");
	const target = {
		url: server.url.toString(),
		token: "node-secret",
		userJwt: null,
	};
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const underlyingStorage = localStorage;
	const storageSurfaces = [...new Set<object>([globalThis, window])];
	const descriptors = storageSurfaces.map((surface) => ({
		surface,
		descriptor: Object.getOwnPropertyDescriptor(surface, "localStorage"),
	}));
	let refuse = true;
	let continued = 0;
	let refusalHookCount = 0;
	const refusingStorage: Storage = {
		get length() {
			return underlyingStorage.length;
		},
		clear: () => underlyingStorage.clear(),
		getItem: (key) => underlyingStorage.getItem(key),
		key: (index) => underlyingStorage.key(index),
		removeItem: (key) => underlyingStorage.removeItem(key),
		setItem(key, value) {
			if (key === "ryu_desktop_onboarding_project_v1" && refuse) {
				refusalHookCount++;
				if (mode === "throw") {
					throw new Error("write refused");
				}
				return;
			}
			underlyingStorage.setItem(key, value);
		},
	};
	try {
		for (const { surface } of descriptors) {
			Object.defineProperty(surface, "localStorage", {
				value: refusingStorage,
				configurable: true,
			});
		}

		await act(async () => {
			root.render(
				<I18nProvider>
					<FirstProjectStep
						onCreated={async (ack, binding) => {
							persistAcknowledgedOnboardingProject(ack, binding);
							expect(await restoreOnboardingProject(target, binding)).toEqual({
								name: project.name,
								mainThreadId: project.coordinatorConversationId,
							});
							continued++;
						}}
						onSkip={() => {
							throw new Error("unexpected skip");
						}}
						target={target}
					/>
				</I18nProvider>
			);
		});
		const form = container.querySelector("form");
		if (!form) {
			throw new Error("production form missing");
		}
		await act(async () => {
			form.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true })
			);
		});
		await waitForOutcome(
			container,
			() =>
				Boolean(
					container
						.querySelector('[role="alert"]')
						?.textContent?.includes("project was created")
				),
			"acknowledged continuation refusal"
		);
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"project was created"
		);
		const name = container.querySelector<HTMLInputElement>(
			"#first-project-name"
		);
		const about = container.querySelector<HTMLTextAreaElement>(
			"#first-project-about"
		);
		if (!(name && about)) {
			throw new Error("production draft missing");
		}
		expect(name.disabled).toBe(true);
		expect(about.disabled).toBe(true);
		expect(continued).toBe(0);
		expect(refusalHookCount).toBe(1);
		expect(calls.map((call) => call.method)).toEqual(["POST"]);
		expect(
			underlyingStorage.getItem("ryu_desktop_onboarding_project_v1")
		).toBeNull();
		expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
		const originalPayload = calls.find((call) => call.method === "POST")?.body;
		expect(originalPayload).toMatchObject({
			name: "My first project",
			executionMode: "auto",
		});
		refuse = false;
		await act(async () => {
			form.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true })
			);
		});
		await waitForOutcome(
			container,
			() =>
				continued === 1 &&
				!container.querySelector('[role="alert"]') &&
				calls.some((call) => call.method === "GET"),
			"acknowledged project readback and continuation"
		);
		expect(continued).toBe(1);
		expect(refusalHookCount).toBe(1);
		expect(container.querySelector('[role="alert"]') === null).toBe(true);
		expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
	} finally {
		for (const { surface, descriptor } of descriptors.reverse()) {
			if (descriptor) {
				Object.defineProperty(surface, "localStorage", descriptor);
			} else {
				Reflect.deleteProperty(surface, "localStorage");
			}
		}
		await act(async () => root.unmount());
		container.remove();
		localStorage.clear();
	}
});

test("failed Skip retries skip continuation and sends no project create", async () => {
	calls.length = 0;
	localStorage.clear();
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	let attempts = 0;
	try {
		await act(async () =>
			root.render(
				<I18nProvider>
					<FirstProjectStep
						onCreated={() => {
							throw new Error("unexpected creation");
						}}
						onSkip={() => {
							attempts++;
							if (attempts === 1) {
								throw new Error("clear refused");
							}
						}}
						target={{
							url: server.url.toString(),
							token: "node-secret",
							userJwt: null,
						}}
					/>
				</I18nProvider>
			)
		);
		const skip = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.includes("Skip")
		);
		if (!skip) {
			throw new Error("production skip missing");
		}
		await act(async () => skip.click());
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"clear refused"
		);
		const form = container.querySelector("form");
		if (!form) {
			throw new Error("production form missing");
		}
		await act(async () => {
			form.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true })
			);
		});
		expect(attempts).toBe(2);
		expect(calls).toEqual([]);
		expect(container.querySelector('[role="alert"]') === null).toBe(true);
	} finally {
		await act(async () => root.unmount());
		container.remove();
		localStorage.clear();
	}
});
