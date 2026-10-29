import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import { sileo } from "sileo";
import { z } from "zod";
import type { Node } from "@/src/store/useNodeStore.ts";

// The REAL Email & alerts tab, the real node store and the production SDK
// against a loopback Bun "Core" that keeps the SMTP transport (including the
// write-only password), the relay's sent mail, and the alert-delivery targets
// durably per test. No module is replaced; only that origin is reachable.
const NativeResponse = globalThis.Response;
const NativeRequest = globalThis.Request;
const nativeFetch = globalThis.fetch;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let ownedOrigin: string | null = null;
const rejectedEgress: string[] = [];
let inFlight = 0;
const guardedFetch = Object.assign(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(new NativeRequest(input, init).url);
		if (url.origin !== ownedOrigin) {
			rejectedEgress.push(url.href);
			throw new Error("Email coverage refuses unowned HTTP egress");
		}
		inFlight++;
		try {
			return await nativeFetch(input, init);
		} finally {
			inFlight--;
		}
	},
	{ preconnect: nativeFetch.preconnect }
);
globalThis.fetch = guardedFetch;
window.fetch = guardedFetch;

const { createRoot } = await import("react-dom/client");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { EmailAlertsSettings } = await import("./EmailAlertsSettings.tsx");
const { useNodeStore, stopAutoSelectProbe, stopCloudTokenRefresh } =
	await import("@/src/store/useNodeStore.ts");
const {
	blur,
	button,
	click,
	fill,
	flush,
	input,
	isDisabled,
	isOn,
	maybeButton,
	settle,
} = await import("./privacy-security.test-support.ts");

// ── Native Core fixture ────────────────────────────────────────────────────
const TOKEN = "email-node-token";
const transportInput = z
	.object({
		from: z.string(),
		host: z.string(),
		password: z.string().optional(),
		port: z.number().int(),
		starttls: z.boolean(),
		username: z.string(),
	})
	.strict();
const targetSchema = z.union([
	z.object({ kind: z.literal("webhook"), url: z.string() }).strict(),
	z
		.object({
			kind: z.literal("telegram"),
			bot_token: z.string(),
			chat_id: z.string(),
		})
		.strict(),
	z.object({ kind: z.literal("expo_push"), token: z.string() }).strict(),
	z.object({ kind: z.literal("email"), to: z.string() }).strict(),
]);
const deliveryInput = z
	.object({ emails: z.array(z.string()), targets: z.array(targetSchema) })
	.strict();
type Transport = Omit<z.infer<typeof transportInput>, "password"> & {
	password: string | null;
};
type Delivery = z.infer<typeof deliveryInput>;

interface Call {
	body: unknown;
	method: string;
	path: string;
}
interface Armed {
	error: string;
	method: string;
	path: string;
	status: number;
}
const INITIAL_TRANSPORT: Transport = {
	from: "Ryu <alerts@initial.test>",
	host: "smtp.initial.test",
	password: "stored-secret",
	port: 2525,
	starttls: true,
	username: "relay-user",
};
const INITIAL_DELIVERY: Delivery = {
	emails: ["ops@initial.test"],
	targets: [
		{ kind: "webhook", url: "https://hooks.initial.test/a" },
		{ kind: "telegram", bot_token: "bot-secret", chat_id: "chat-7" },
		{ kind: "expo_push", token: "ExponentPushToken[fixture]" },
	],
};
let transport: Transport = { ...INITIAL_TRANSPORT };
let delivery: Delivery = structuredClone(INITIAL_DELIVERY);
let sentMail: Array<{ host: string; password: string | null; to: string }> = [];
let calls: Call[] = [];
let armed: Armed[] = [];
let unexpected: string[] = [];

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const route = `${request.method} ${url.pathname}`;
		if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
			unexpected.push(`unauthenticated ${route}`);
			return NativeResponse.json({ error: "Unauthorized" }, { status: 401 });
		}
		const body = request.method === "GET" ? null : await request.json();
		calls.push({ body, method: request.method, path: url.pathname });
		const trap = armed.find(
			(a) => a.method === request.method && a.path === url.pathname
		);
		if (trap) {
			armed = armed.filter((a) => a !== trap);
			return NativeResponse.json(
				{ error: trap.error },
				{ status: trap.status }
			);
		}
		switch (route) {
			case "GET /api/email/transport": {
				const { password, ...visible } = transport;
				return NativeResponse.json({
					...visible,
					passwordSet: password !== null,
				});
			}
			case "PUT /api/email/transport": {
				const parsed = transportInput.safeParse(body);
				if (!parsed.success) {
					unexpected.push(`bad transport ${JSON.stringify(body)}`);
					return NativeResponse.json({ error: "Bad body" }, { status: 400 });
				}
				const { password, ...rest } = parsed.data;
				transport = { ...rest, password: password ?? transport.password };
				return NativeResponse.json({ ok: true });
			}
			case "POST /api/email/test": {
				const parsed = z.object({ to: z.string() }).strict().safeParse(body);
				if (!parsed.success) {
					unexpected.push("bad test body");
					return NativeResponse.json({ error: "Bad body" }, { status: 400 });
				}
				sentMail.push({
					host: transport.host,
					password: transport.password,
					to: parsed.data.to,
				});
				return NativeResponse.json({ messageId: "fixture-1", ok: true });
			}
			case "GET /api/alerts/delivery":
				return NativeResponse.json(delivery);
			case "PUT /api/alerts/delivery": {
				const parsed = deliveryInput.safeParse(body);
				if (!parsed.success) {
					unexpected.push(`bad delivery ${JSON.stringify(body)}`);
					return NativeResponse.json({ error: "Bad body" }, { status: 400 });
				}
				delivery = parsed.data;
				return NativeResponse.json({ ok: true });
			}
			default:
				unexpected.push(route);
				return NativeResponse.json({ error: "Unknown route" }, { status: 404 });
		}
	},
});
ownedOrigin = server.url.origin;

const selfHosted: Node = {
	name: "self-hosted",
	url: server.url.origin,
	token: TOKEN,
	userJwt: null,
};
const savedNodeState = useNodeStore.getState();
let root: Root | null = null;

function refuse(method: string, path: string, status: number, error: string) {
	armed.push({ error, method, path, status });
}
function mutations() {
	return calls
		.filter((call) => call.method !== "GET")
		.map((call) => `${call.method} ${call.path}`);
}
function bodiesOf(method: string, path: string) {
	return calls
		.filter((call) => call.method === method && call.path === path)
		.map((call) => call.body);
}
const text = () => document.body.textContent ?? "";
function starttls(): HTMLElement {
	const control = document.querySelector<HTMLElement>(
		'[role="switch"][aria-label="Use STARTTLS"]'
	);
	if (!control) {
		throw new Error("Missing Use STARTTLS switch");
	}
	return control;
}

async function mount(node: Node = selfHosted) {
	useNodeStore.setState({
		nodes: [node],
		localNodes: [],
		defaultNode: node.name,
		tabOverrides: {},
		autoSelect: false,
	});
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root!.render(
			<>
				<EmailAlertsSettings />
				<Toaster />
			</>
		)
	);
	if (!node.managed) {
		await settle(
			() =>
				!input("#smtp-host").disabled &&
				maybeButton("Add email")?.disabled === false,
			"email settings loaded"
		);
		await flush();
	}
}
async function unmount() {
	await settle(() => inFlight === 0, "email HTTP drained");
	if (root) {
		const current = root;
		await act(async () => current.unmount());
		root = null;
	}
	document.body.replaceChildren();
}
async function remount() {
	await unmount();
	await mount();
}

beforeEach(() => {
	stopAutoSelectProbe();
	stopCloudTokenRefresh();
	sileo.clear();
	transport = { ...INITIAL_TRANSPORT };
	delivery = structuredClone(INITIAL_DELIVERY);
	sentMail = [];
	calls = [];
	armed = [];
	unexpected = [];
});
afterEach(async () => {
	await unmount();
	stopAutoSelectProbe();
	stopCloudTokenRefresh();
	sileo.clear();
	useNodeStore.setState(savedNodeState);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case keeps to the owned Core contract.
	expect(unexpected).toEqual([]);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case refuses foreign egress.
	expect(rejectedEgress).toEqual([]);
});
afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
});

test("SMTP host, Use STARTTLS and username save exact trimmed values, keep the stored password, roll back nothing on refusal, and reload after a remount", async () => {
	await mount();
	const host = input("#smtp-host");
	const username = input("#smtp-username");
	expect(host.placeholder).toBe("smtp.example.com");
	expect(username.placeholder).toBe("apikey / user@example.com");
	expect(host.value).toBe("smtp.initial.test");
	expect(username.value).toBe("relay-user");
	expect(isOn(starttls())).toBe(true);
	expect(input("#smtp-password").placeholder).toBe("•••••••• (unchanged)");
	expect(text()).toContain("A password is stored. Leave blank to keep it.");

	await fill(host, "  smtp.relay.test  ");
	await fill(username, "  apikey  ");
	await click(starttls());
	expect(isOn(starttls())).toBe(false);
	expect(mutations()).toEqual([]);

	refuse("PUT", "/api/email/transport", 503, "Core unavailable");
	await click(button("Save"));
	await settle(() => text().includes("Couldn't save SMTP settings"), "refusal");
	expect(transport).toEqual(INITIAL_TRANSPORT);
	expect(input("#smtp-host").value).toBe("  smtp.relay.test  ");
	expect(isOn(starttls())).toBe(false);

	await click(button("Save"));
	await settle(() => text().includes("SMTP settings saved"), "save");
	expect(bodiesOf("PUT", "/api/email/transport")).toEqual([
		{
			from: "Ryu <alerts@initial.test>",
			host: "smtp.relay.test",
			port: 2525,
			starttls: false,
			username: "apikey",
		},
		{
			from: "Ryu <alerts@initial.test>",
			host: "smtp.relay.test",
			port: 2525,
			starttls: false,
			username: "apikey",
		},
	]);
	expect(transport).toEqual({
		...INITIAL_TRANSPORT,
		host: "smtp.relay.test",
		starttls: false,
		username: "apikey",
	});

	await remount();
	expect(input("#smtp-host").value).toBe("smtp.relay.test");
	expect(input("#smtp-username").value).toBe("apikey");
	expect(isOn(starttls())).toBe(false);
	expect(input("#smtp-password").value).toBe("");
	expect(delivery).toEqual(INITIAL_DELIVERY);
	expect(mutations()).toEqual([
		"PUT /api/email/transport",
		"PUT /api/email/transport",
	]);
});

test("From address saves exactly, an invalid port falls back to the saved port, and a typed password is sent once then cleared", async () => {
	await mount();
	const from = input("#smtp-from");
	expect(from.placeholder).toBe("Ryu <alerts@example.com>");
	await fill(from, "  Ops <ops@relay.test>  ");
	await fill(input("#smtp-port"), "not-a-port");
	await fill(input("#smtp-password"), "rotated-secret");
	await click(button("Save"));
	await settle(() => transport.from === "Ops <ops@relay.test>", "from saved");
	expect(bodiesOf("PUT", "/api/email/transport")).toEqual([
		{
			from: "Ops <ops@relay.test>",
			host: "smtp.initial.test",
			password: "rotated-secret",
			port: 2525,
			starttls: true,
			username: "relay-user",
		},
	]);
	expect(transport.password).toBe("rotated-secret");
	expect(input("#smtp-port").value).toBe("2525");
	expect(input("#smtp-password").value).toBe("");

	await fill(input("#smtp-port"), "465");
	await click(button("Save"));
	await settle(() => transport.port === 465, "port saved");
	expect(bodiesOf("PUT", "/api/email/transport").at(-1)).toEqual({
		from: "Ops <ops@relay.test>",
		host: "smtp.initial.test",
		port: 465,
		starttls: true,
		username: "relay-user",
	});
	expect(transport.password).toBe("rotated-secret");

	await remount();
	expect(input("#smtp-from").value).toBe("Ops <ops@relay.test>");
	expect(input("#smtp-port").value).toBe("465");
});

test("Send test requires a recipient, saves the unsaved draft before sending, surfaces the relay's refusal and a failed save, and retries", async () => {
	await mount();
	const recipient = input("#smtp-test");
	expect(recipient.placeholder).toBe("you@example.com");
	await click(button("Send test"));
	await settle(
		() => text().includes("Enter a recipient for the test email"),
		"recipient required"
	);
	expect(mutations()).toEqual([]);

	await fill(input("#smtp-host"), "smtp.draft.test");
	await fill(input("#smtp-password"), "draft-secret");
	await fill(recipient, " you@relay.test ");
	refuse("POST", "/api/email/test", 502, "SMTP relay rejected the message.");
	await click(button("Send test"));
	await settle(() => text().includes("Test email failed"), "relay refusal");
	expect(text()).toContain("SMTP relay rejected the message.");
	expect(transport.host).toBe("smtp.draft.test");
	expect(transport.password).toBe("draft-secret");
	expect(sentMail).toEqual([]);
	expect(input("#smtp-password").value).toBe("");

	refuse("PUT", "/api/email/transport", 503, "Core unavailable");
	await click(button("Send test"));
	await settle(
		() => text().includes("Couldn't save SMTP settings"),
		"save fail"
	);
	expect(sentMail).toEqual([]);

	await click(button("Send test"));
	await settle(() => sentMail.length === 1, "test mail sent");
	await settle(() => text().includes("Delivered to you@relay.test"), "toast");
	expect(sentMail).toEqual([
		{ host: "smtp.draft.test", password: "draft-secret", to: "you@relay.test" },
	]);
	expect(mutations()).toEqual([
		"PUT /api/email/transport",
		"POST /api/email/test",
		"PUT /api/email/transport",
		"PUT /api/email/transport",
		"POST /api/email/test",
	]);
	expect(bodiesOf("POST", "/api/email/test")).toEqual([
		{ to: "you@relay.test" },
		{ to: "you@relay.test" },
	]);
	expect(isDisabled(button("Send test"))).toBe(false);
});

test("alert recipients auto-save trimmed emails and webhooks, keep Telegram and push targets, and survive a remount", async () => {
	await mount();
	await click(button("Add email"));
	const added = input('[aria-label="Email recipient 2"]');
	await fill(added, "  oncall@relay.test ");
	await blur(added);
	await settle(() => delivery.emails.length === 2, "email saved");
	expect(delivery).toEqual({
		emails: ["ops@initial.test", "oncall@relay.test"],
		targets: INITIAL_DELIVERY.targets,
	});

	await click(button("Add webhook"));
	const hook = input('[aria-label="Webhook URL 2"]');
	await fill(hook, " https://hooks.relay.test/b ");
	await blur(hook);
	await settle(
		() => delivery.targets.some((t) => "url" in t && t.url.endsWith("/b")),
		"webhook saved"
	);
	await click(button("Remove webhook URL 1"));
	await settle(
		() => !delivery.targets.some((t) => "url" in t && t.url.endsWith("/a")),
		"webhook removed"
	);
	expect(delivery).toEqual({
		emails: ["ops@initial.test", "oncall@relay.test"],
		targets: [
			{ kind: "webhook", url: "https://hooks.relay.test/b" },
			{ kind: "telegram", bot_token: "bot-secret", chat_id: "chat-7" },
			{ kind: "expo_push", token: "ExponentPushToken[fixture]" },
		],
	});

	await remount();
	expect(input('[aria-label="Email recipient 2"]').value).toBe(
		"oncall@relay.test"
	);
	expect(input('[aria-label="Webhook URL 1"]').value).toBe(
		"https://hooks.relay.test/b"
	);
	expect(document.querySelector('[aria-label="Webhook URL 2"]')).toBeNull();
	expect(transport).toEqual(INITIAL_TRANSPORT);
});

test("a managed node explains cloud ownership and never reads or writes node-local email routes", async () => {
	await mount({ ...selfHosted, managed: true, name: "managed" });
	await flush();
	expect(text()).toContain(
		"Email transport and alert delivery are configured by Ryu Cloud"
	);
	expect(document.querySelector("#smtp-host")).toBeNull();
	expect(calls).toEqual([]);
});
