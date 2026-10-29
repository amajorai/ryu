import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Register before React and isolate this file from non-browser Bun suites.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ApiSection } = await import("./ApiSection.tsx");

const target = {
	url: "http://127.0.0.1:7981",
	token: "synthetic-traffic-node",
	userJwt: null,
};
const PERMISSION_NOTE = "Ask an organization owner or admin";
// The live-traffic retry loop waits at least two seconds before reconnecting.
const FIRST_RETRY_WINDOW_MS = 2300;
const realFetch = globalThis.fetch;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	globalThis.fetch = realFetch;
	document.body.replaceChildren();
});

function installFetch(): string[] {
	const trafficRequests: string[] = [];
	globalThis.fetch = Object.assign(
		(input: Parameters<typeof fetch>[0]) => {
			const url = new URL(
				input instanceof Request ? input.url : String(input),
				target.url
			);
			if (url.pathname === "/api/gateway/traffic") {
				trafficRequests.push(url.pathname);
				return Promise.resolve(
					Response.json(
						{ error: "insufficient permissions: audit.view" },
						{ status: 403 }
					)
				);
			}
			return Promise.resolve(
				Response.json({ error: "not part of this fixture" }, { status: 500 })
			);
		},
		{ preconnect: realFetch.preconnect }
	);
	return trafficRequests;
}

async function mount(canViewTraffic: boolean): Promise<void> {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () =>
		root?.render(
			createElement(ApiSection, {
				canViewTraffic,
				managed: true,
				reachable: true,
				statusUrl: null,
				target,
			})
		)
	);
}

async function settle(milliseconds: number): Promise<void> {
	await act(
		() => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
	);
}

test("a 403 from the traffic feed stops reconnecting and explains the missing permission", async () => {
	const trafficRequests = installFetch();
	await mount(true);
	await settle(50);

	expect(trafficRequests).toHaveLength(1);
	expect(document.body.textContent).toContain(PERMISSION_NOTE);
	expect(document.body.textContent).not.toContain("traffic feed returned 403");

	await settle(FIRST_RETRY_WINDOW_MS);
	expect(trafficRequests).toHaveLength(1);
});

test("a caller without audit.view never opens the traffic feed", async () => {
	const trafficRequests = installFetch();
	await mount(false);
	await settle(50);

	expect(trafficRequests).toHaveLength(0);
	expect(document.body.textContent).toContain(PERMISSION_NOTE);
});
