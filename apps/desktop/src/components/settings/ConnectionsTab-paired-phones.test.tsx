import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

// Control-level coverage for the paired-phones and app sign-ins sections. Core
// is a real loopback HTTP server that keeps device state across requests, so
// every assertion follows a real request and the refetch that comes after it.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
globalThis.fetch = nativeFetch;
window.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

interface Phone {
	always_allowed: string[];
	app: string;
	check_code: string | null;
	device_id: string;
	foreground: boolean;
	label: string;
	last_seen_ms: number;
	paired_at_ms: number;
	platform: string;
	state: "active" | "pending";
}

const core = {
	approveStatus: 200,
	devices: [] as Phone[],
	listStatus: 200,
	lists: 0,
	principal: "owner:local",
	revokeStatus: 200,
	writes: [] as string[],
};

function phone(overrides: Partial<Phone>): Phone {
	return {
		always_allowed: [],
		app: "ryu",
		check_code: null,
		device_id: "phone",
		foreground: false,
		label: "Phone",
		last_seen_ms: Date.now(),
		paired_at_ms: Date.now(),
		platform: "ios",
		state: "active",
		...overrides,
	};
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const body = request.method === "GET" ? "" : await request.text();
		if (request.method !== "GET") {
			core.writes.push(`${request.method} ${url.pathname} ${body}`.trim());
		}
		if (url.pathname === "/api/app-delegations/revoke") {
			if (core.revokeStatus === 404) {
				return new NativeResponse("not found", { status: 404 });
			}
			const { user_id } = JSON.parse(body) as { user_id: string };
			return core.revokeStatus === 200
				? NativeResponse.json({ user_id, revoked_before: 1_700_000_000 })
				: NativeResponse.json(
						{ error: "forbidden" },
						{ status: core.revokeStatus }
					);
		}
		if (url.pathname === "/api/device-tools/devices") {
			core.lists += 1;
			return core.listStatus === 200
				? NativeResponse.json({
						devices: core.devices,
						principal_id: core.principal,
					})
				: NativeResponse.json({ error: "nope" }, { status: core.listStatus });
		}
		const match =
			/^\/api\/device-tools\/devices\/([^/]+)(\/approve-pair)?$/.exec(
				url.pathname
			);
		const id = decodeURIComponent(match?.[1] ?? "");
		const device = core.devices.find((entry) => entry.device_id === id);
		if (!device) {
			return NativeResponse.json({ error: "not_found" }, { status: 404 });
		}
		if (match?.[2]) {
			if (core.approveStatus !== 200) {
				return NativeResponse.json(
					{ error: "device_not_paired" },
					{ status: core.approveStatus }
				);
			}
			device.state = "active";
			return NativeResponse.json({ device_id: id, state: "active" });
		}
		if (request.method === "DELETE") {
			core.devices = core.devices.filter((entry) => entry !== device);
			return NativeResponse.json({ forgotten: true });
		}
		const patch = JSON.parse(body) as { label?: string; revoke?: string[] };
		device.label = patch.label ?? device.label;
		device.always_allowed = device.always_allowed.filter(
			(tool) => !patch.revoke?.includes(tool)
		);
		return NativeResponse.json({
			always_allowed: device.always_allowed,
			device_id: id,
		});
	},
});

const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { PairedPhonesPanel } = await import(
	"./ConnectionsTab-paired-phones.tsx"
);
const { AppDelegationsPanel } = await import(
	"./ConnectionsTab-app-delegations.tsx"
);
const { PairedPhoneRow } = await import(
	"./ConnectionsTab-paired-phone-row.tsx"
);
const { button, click, flush, maybeButton, settle, typeInto } = await import(
	"./connections-providers.test-support.ts"
);

let root: Root | null = null;
let queryClient = new QueryClient();
let container = document.createElement("div");
const target: {
	token: string | null;
	url: string;
	userJwt?: string | null;
} = { token: null, url: server.url.origin };

const text = () => document.body.textContent ?? "";

function render(
	canApprove: boolean,
	selfUserId: string | null,
	panelTarget: typeof target
) {
	return act(async () =>
		root?.render(
			<QueryClientProvider client={queryClient}>
				<PairedPhonesPanel
					canApprove={canApprove}
					selfUserId={selfUserId}
					target={panelTarget}
				/>
			</QueryClientProvider>
		)
	);
}

async function mount(canApprove = true, selfUserId: string | null = null) {
	queryClient = new QueryClient();
	root = createRoot(container);
	await render(canApprove, selfUserId, target);
}

/** An unsigned JWT whose payload carries `sub` (Core verifies; the UI only scopes). */
function fakeJwt(sub: string): string {
	const encode = (value: object) =>
		btoa(JSON.stringify(value)).replaceAll("=", "");
	return `${encode({ alg: "none" })}.${encode({ sub })}.sig`;
}

function confirmDialog(): HTMLElement {
	const dialog = document.querySelector<HTMLElement>(
		'[role="alertdialog"], [role="dialog"]'
	);
	if (!dialog) {
		throw new Error(`Missing confirmation dialog: ${text()}`);
	}
	return dialog;
}

async function confirm(trigger: HTMLElement, action: string) {
	await click(trigger);
	await settle(
		() => trigger.getAttribute("aria-expanded") === "true",
		"confirmation dialog"
	);
	await click(button(action, confirmDialog()));
	await settle(
		() => trigger.getAttribute("aria-expanded") !== "true",
		"confirmation closed"
	);
	// happy-dom never finishes the exit animation, so drop the closed popup the
	// way the shared ConnectionsTab harness does between cases.
	for (const leftover of document.querySelectorAll(
		'[role="alertdialog"], [role="dialog"]'
	)) {
		leftover.remove();
	}
}

beforeEach(() => {
	core.approveStatus = 200;
	core.devices = [];
	core.listStatus = 200;
	core.lists = 0;
	core.principal = "owner:local";
	core.revokeStatus = 200;
	core.writes = [];
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	const mounted = root;
	root = null;
	await act(async () => mounted?.unmount());
	await act(async () => {
		await queryClient.cancelQueries();
		queryClient.clear();
	});
	document.body.replaceChildren();
});

afterAll(() => {
	server.stop(true);
});

test("approves a pending phone on the host and shows it active after the refetch", async () => {
	core.devices = [
		phone({ device_id: "p1", label: "Ana's iPhone", state: "pending" }),
		phone({ device_id: "a1", label: "Work Pixel", platform: "android" }),
	];
	await mount();
	await settle(() => text().includes("Waiting for approval"), "pending phone");
	expect(text()).toContain("Android");
	await confirm(button("Approve Ana's iPhone"), "Approve");
	await settle(() => !text().includes("Waiting for approval"), "approved");
	expect(core.writes).toEqual([
		"POST /api/device-tools/devices/p1/approve-pair",
	]);
	expect(core.devices.every((entry) => entry.state === "active")).toBe(true);
	expect(maybeButton("Approve Ana's iPhone")).toBeNull();
});

test("approving needs a confirmation that shows details to check against the phone", async () => {
	core.devices = [
		phone({
			app: "ryu-bot",
			// The shared golden vector: Core's code for this id and 91 zero SPKI bytes.
			check_code: "ZDX-MJ5",
			device_id: "00000000-0000-4000-8000-000000000001",
			label: "Alice's iPhone",
			paired_at_ms: Date.now() - 60_000,
			state: "pending",
		}),
	];
	await mount();
	await settle(() => text().includes("Alice's iPhone"), "pending phone");
	expect(text()).toContain("Waiting for approval · Check code ZDX-MJ5");
	const trigger = button("Approve Alice's iPhone");
	await click(trigger);
	await settle(
		() => trigger.getAttribute("aria-expanded") === "true",
		"approve dialog"
	);
	const dialog = confirmDialog();
	const detail = (term: string) =>
		dialog.querySelector(`dd[data-term="${term}"]`)?.textContent ?? "";
	expect(dialog.textContent).toContain("Approve Alice's iPhone?");
	expect(detail("Platform")).toBe("iPhone");
	expect(detail("App")).toBe("ryu-bot");
	expect(detail("Check code")).toBe("ZDX-MJ5");
	expect(detail("Requested")).toContain("ago");
	// Opening the dialog alone approves nothing.
	expect(core.writes).toEqual([]);
	await click(button("Cancel", dialog));
	await settle(
		() => trigger.getAttribute("aria-expanded") !== "true",
		"dialog dismissed"
	);
	await flush();
	expect(core.writes).toEqual([]);
	expect(core.devices[0]?.state).toBe("pending");
});

test("an older node without a check code shows no code, never the device id", async () => {
	core.devices = [
		phone({
			device_id: "dev-0123456789abcdef",
			label: "Old node phone",
			state: "pending",
		}),
	];
	await mount();
	await settle(() => text().includes("Old node phone"), "pending phone");
	expect(text()).not.toContain("Check code");
	const trigger = button("Approve Old node phone");
	await click(trigger);
	await settle(
		() => trigger.getAttribute("aria-expanded") === "true",
		"approve dialog"
	);
	const dialog = confirmDialog();
	expect(dialog.querySelector('dd[data-term="Check code"]')).toBeNull();
	expect(dialog.textContent).toContain("check these details against it");
	expect(dialog.textContent).not.toContain("ABCDEF");
	expect(dialog.textContent?.toLowerCase()).not.toContain("abcdef");
	await click(button("Cancel", dialog));
	expect(core.writes).toEqual([]);
});

test("leaves a phone pending when Core refuses the approval", async () => {
	core.approveStatus = 403;
	core.devices = [
		phone({ device_id: "p1", label: "Remote", state: "pending" }),
	];
	await mount();
	await settle(() => text().includes("Remote"), "pending phone");
	await confirm(button("Approve Remote"), "Approve");
	await settle(() => core.writes.length === 1 && core.lists > 1, "refetched");
	expect(core.devices[0]?.state).toBe("pending");
	expect(text()).toContain("Waiting for approval");
});

test("keeps Approve disabled away from the host and still lets the owner deny", async () => {
	core.devices = [
		phone({ device_id: "p1", label: "Stranger", state: "pending" }),
	];
	await mount(false);
	await settle(() => text().includes("Stranger"), "pending phone");
	expect(button("Approve Stranger").disabled).toBe(true);
	expect(text()).toContain(
		"Phones waiting for approval can only be approved on the computer that runs this node."
	);
	await confirm(button("Deny Stranger"), "Deny");
	await settle(() => text().includes("No phones are paired"), "denied");
	expect(core.writes).toEqual(["DELETE /api/device-tools/devices/p1"]);
});

test("renames a phone, revokes one Always allow grant and forgets it", async () => {
	core.devices = [
		phone({
			always_allowed: ["calendar.read", "contacts.search"],
			device_id: "a1",
			label: "Old name",
		}),
	];
	await mount();
	await settle(() => text().includes("calendar.read"), "grants");

	await click(button("Rename Old name"));
	const field = container.querySelector<HTMLInputElement>(
		'input[aria-label="New name for Old name"]'
	);
	if (!field) {
		throw new Error("Missing rename field");
	}
	await typeInto(field, "  Kitchen phone ");
	await click(button("Save"));
	await settle(() => text().includes("Kitchen phone"), "renamed");

	await click(button("Revoke Always allow for calendar.read"));
	await settle(() => !text().includes("calendar.read"), "grant revoked");
	expect(text()).toContain("contacts.search");

	await confirm(button("Forget Kitchen phone"), "Forget");
	await settle(() => text().includes("No phones are paired"), "forgotten");
	expect(core.writes).toEqual([
		'PATCH /api/device-tools/devices/a1 {"label":"Kitchen phone"}',
		'PATCH /api/device-tools/devices/a1 {"revoke":["calendar.read"]}',
		"DELETE /api/device-tools/devices/a1",
	]);
});

test("renders nothing on a node without the device-tools routes", async () => {
	core.listStatus = 404;
	await mount();
	await settle(() => core.lists > 0 && text() === "", "hidden");
	expect(text()).not.toContain("App sign-ins");
});

test("shows a retryable error when the node refuses the list", async () => {
	core.listStatus = 503;
	await mount();
	await settle(
		() => text().includes("Paired phones are unavailable on this node."),
		"error card"
	);
	core.listStatus = 200;
	await click(button("Retry paired phones"));
	await settle(() => text().includes("No phones are paired"), "recovered");
});

test("revokes the signed-in member's app sign-ins and explains a refusal", async () => {
	core.principal = "user:member-7";
	await mount(true, "session-user");
	await settle(() => text().includes("App sign-ins"), "app sign-ins");
	const field = container.querySelector<HTMLInputElement>("input");
	expect(field?.value).toBe("member-7");

	await confirm(button("Revoke"), "Revoke");
	await settle(
		() =>
			core.writes.includes(
				'POST /api/app-delegations/revoke {"user_id":"member-7"}'
			),
		"revoked"
	);

	core.revokeStatus = 403;
	if (!field) {
		throw new Error("Missing member field");
	}
	await typeInto(field, " someone-else ");
	await confirm(button("Revoke"), "Revoke");
	await settle(
		() => text().includes("Only that member, an admin"),
		"refusal explained"
	);
	expect(core.writes.at(-1)).toBe(
		'POST /api/app-delegations/revoke {"user_id":"someone-else"}'
	);

	await typeInto(field, "   ");
	expect(button("Revoke").disabled).toBe(true);
});

test("app sign-ins explain an older node and reject an oversized member id", async () => {
	core.revokeStatus = 404;
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<QueryClientProvider client={queryClient}>
				<AppDelegationsPanel defaultUserId={null} target={target} />
			</QueryClientProvider>
		)
	);
	const field = container.querySelector<HTMLInputElement>("input");
	if (!field) {
		throw new Error("Missing member field");
	}
	expect(field.value).toBe("");
	expect(button("Revoke").disabled).toBe(true);
	await typeInto(field, "x".repeat(257));
	expect(text()).toContain("That user ID is too long.");
	expect(button("Revoke").disabled).toBe(true);
	await typeInto(field, "member-1");
	await confirm(button("Revoke"), "Revoke");
	await settle(() => text().includes("Update Ryu on it."), "older node");
});

test("a phone open in the foreground reads as open now and stays put without actions", async () => {
	const calls: string[] = [];
	const noop = (name: string) => () => calls.push(name);
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<PairedPhoneRow
				actions={{
					approve: noop("approve"),
					forget: noop("forget"),
					rename: noop("rename"),
					revokeGrant: noop("revoke"),
				}}
				busy
				canApprove
				device={phone({ foreground: true, label: "Desk phone" })}
			/>
		)
	);
	expect(text()).toContain("iPhone · Open now");
	expect(button("Rename Desk phone").disabled).toBe(true);
	expect(button("Forget Desk phone").disabled).toBe(true);
	expect(calls).toEqual([]);
});

test("app sign-ins stay available when the device list fails", async () => {
	core.listStatus = 503;
	await mount(true, "self-user");
	await settle(
		() =>
			text().includes("Paired phones are unavailable on this node.") &&
			text().includes("App sign-ins"),
		"error card and app sign-ins"
	);
	const field = container.querySelector<HTMLInputElement>("input");
	expect(field?.value).toBe("self-user");
	await confirm(button("Revoke"), "Revoke");
	await settle(
		() =>
			core.writes.includes(
				'POST /api/app-delegations/revoke {"user_id":"self-user"}'
			),
		"revoked without device tools"
	);
});

test("switching the principal resets the member field and names the node", async () => {
	core.principal = "user:first";
	await mount(true, "first");
	await settle(
		() => container.querySelector("input")?.value === "first",
		"first member"
	);
	const field = container.querySelector<HTMLInputElement>("input");
	if (!field) {
		throw new Error("Missing member field");
	}
	await typeInto(field, "typed-by-first");

	core.principal = "user:second";
	await render(true, "second", target);
	await settle(
		() => container.querySelector("input")?.value === "second",
		"field reset for the new principal"
	);
	const trigger = button("Revoke");
	await click(trigger);
	await settle(
		() => trigger.getAttribute("aria-expanded") === "true",
		"revoke dialog"
	);
	expect(confirmDialog().textContent).toContain(
		`Every app on ${server.url.origin} stops acting`
	);
});

test("switching the delegated account refetches instead of showing the old phones", async () => {
	core.devices = [phone({ device_id: "a1", label: "First account phone" })];
	core.principal = "user:first";
	const firstTarget = { ...target, userJwt: fakeJwt("first") };
	queryClient = new QueryClient();
	root = createRoot(container);
	await render(true, null, firstTarget);
	await settle(() => text().includes("First account phone"), "first list");
	const listsBefore = core.lists;

	core.devices = [phone({ device_id: "b1", label: "Second account phone" })];
	core.principal = "user:second";
	await render(true, null, { ...target, userJwt: fakeJwt("second") });
	expect(text()).not.toContain("First account phone");
	await settle(() => text().includes("Second account phone"), "second list");
	expect(core.lists).toBeGreaterThan(listsBefore);
	expect(container.querySelector("input")?.value).toBe("second");
});
