import { afterEach, describe, expect, test } from "bun:test";
import {
	type AgentMailMessage,
	type MailAlias,
	MailAPI,
	type MailMailbox,
	type MailWebSocketConstructor,
} from "./mail.ts";
import { installFetch } from "./test-fetch.ts";
import { wireJsonRecordSchema } from "./wire-json.ts";

const options = { baseUrl: "http://node.example", token: "node-token" };
const realFetch = globalThis.fetch;
const realWebSocket = globalThis.WebSocket;

afterEach(() => {
	globalThis.fetch = realFetch;
	globalThis.WebSocket = realWebSocket;
});

/** Record WebSocket constructions without opening a real socket. */
function installFakeWebSocket(opened: { protocols?: string[]; url: string }[]) {
	class FakeWebSocket extends EventTarget {
		constructor(url: string, protocols?: string[]) {
			super();
			opened.push({ url, protocols });
		}
	}
	globalThis.WebSocket = Object.assign(FakeWebSocket, {
		CONNECTING: 0,
		OPEN: 1,
		CLOSING: 2,
		CLOSED: 3,
	}) as unknown as typeof WebSocket;
}

describe("MailAPI", () => {
	test("normalizes sidecar inbox and message fields", async () => {
		installFetch(() =>
			Promise.resolve(
				Response.json({
					inboxes: [
						{
							address: "agent@example.com",
							created_at: "now",
							id: "in-1",
							name: "Agent",
							provider: "webhook",
						},
					],
				})
			)
		);
		const inboxes = await new MailAPI(options).listInboxes();
		expect(inboxes[0]).toMatchObject({
			id: "in-1",
			address: "agent@example.com",
			clientId: null,
		});
	});

	test("status() reports the hosted domain, null when the server has none", async () => {
		installFetch(() =>
			Promise.resolve(
				Response.json({
					apiVersion: "v1",
					configured: true,
					domain: "agents.example.com",
					domainMode: "managed",
					inbound: "sns",
					sendConfigured: true,
				})
			)
		);
		expect(await new MailAPI(options).status()).toEqual({
			apiVersion: "v1",
			configured: true,
			domain: "agents.example.com",
			domainMode: "managed",
			inboxCount: 0,
			inbound: "sns",
			sendConfigured: true,
		});
		installFetch(() =>
			Promise.resolve(Response.json({ configured: true, inboxCount: "3" }))
		);
		expect(await new MailAPI(options).status()).toMatchObject({
			domain: null,
			inboxCount: 3,
		});
	});

	test("a count or size Number() cannot read is refused instead of returned as NaN", async () => {
		installFetch(() =>
			Promise.resolve(Response.json({ configured: true, inboxCount: "n/a" }))
		);
		// A ZodError, as for any malformed field: @ryuhq/services maps it to invalid_response.
		await expect(new MailAPI(options).status()).rejects.toMatchObject({
			name: "ZodError",
		});
		installFetch(() =>
			Promise.resolve(
				Response.json({
					id: "msg-1",
					inbox_id: "in-1",
					attachments: [{ id: "att-1", size: { bytes: 4 } }],
				})
			)
		);
		await expect(
			new MailAPI(options).getMessage("msg-1")
		).rejects.toMatchObject({ name: "ZodError" });
		installFetch(() =>
			Promise.resolve(
				Response.json({
					id: "msg-1",
					inbox_id: "in-1",
					attachments: [{ id: "att-1", size: "42" }],
				})
			)
		);
		const message = await new MailAPI(options).getMessage("msg-1");
		expect(message.attachments[0]?.size).toBe(42);
	});

	test("forwards without a subject so the server defaults it", async () => {
		let url = "";
		let body = "";
		installFetch((input, init) => {
			url = String(input);
			body = String(init?.body ?? "");
			return Promise.resolve(
				Response.json({ message: { id: "msg-2", subject: "Fwd: Hi" } })
			);
		});
		await new MailAPI(options).forward("in-1", "msg-1", {
			to: ["ops@example.com"],
		});
		expect(url).toBe(
			"http://node.example/api/mail/inboxes/in-1/messages/msg-1/forward"
		);
		expect(JSON.parse(body)).toEqual({ to: ["ops@example.com"] });
	});

	test("sends attachments in the sidecar-compatible wire shape", async () => {
		let body = "";
		installFetch((_url, init) => {
			body = String(init?.body);
			return Promise.resolve(
				Response.json({
					message: {
						id: "msg-1",
						inbox_id: "in-1",
						to_addrs: [],
						attachments: [],
					},
				})
			);
		});
		await new MailAPI(options).send("in-1", {
			attachments: [
				{
					contentBase64: "AQI=",
					contentId: "cid-1",
					contentType: "application/octet-stream",
					filename: "a.bin",
				},
			],
			references: ["<root@example.com>"],
			subject: "Report",
			text: "body",
			to: ["person@example.com"],
		});
		const sent = wireJsonRecordSchema.parse(JSON.parse(body));
		expect(sent.references).toBe("<root@example.com>");
		expect(sent.attachments).toEqual([
			{
				content: "AQI=",
				content_id: "cid-1",
				content_type: "application/octet-stream",
				filename: "a.bin",
			},
		]);
	});

	test("sends a draft with no body unless the caller confirms an unresolved send", async () => {
		const bodies: unknown[] = [];
		installFetch((_url, init) => {
			bodies.push(init?.body);
			return Promise.resolve(
				Response.json({ id: "msg-1", inbox_id: "in-1", to_addrs: [] })
			);
		});
		const mail = new MailAPI(options);
		await mail.sendDraft("in-1", "draft-1");
		await mail.sendDraft("in-1", "draft-1", "key-2", { confirmNotSent: true });
		expect(bodies[0]).toBeUndefined();
		expect(JSON.parse(String(bodies[1]))).toEqual({ confirmNotSent: true });
	});
});

describe("MailAPI agent addresses", () => {
	test("checks an address and returns the server's alternatives", async () => {
		let url = "";
		installFetch((input) => {
			url = String(input);
			return Promise.resolve(
				Response.json({
					address: "nova@mail.example",
					available: false,
					reason: "taken",
					suggestions: ["nova-7k3p@mail.example"],
				})
			);
		});
		const check = await new MailAPI(options).checkAddress("nova");
		expect(url).toBe(
			"http://node.example/api/mail/addresses/check?localPart=nova"
		);
		expect(check).toEqual({
			address: "nova@mail.example",
			available: false,
			reason: "taken",
			suggestions: ["nova-7k3p@mail.example"],
		});
	});

	test("claims an agent inbox and maps its agent id", async () => {
		let url = "";
		let body = "";
		installFetch((input, init) => {
			url = String(input);
			body = String(init?.body);
			return Promise.resolve(
				Response.json(
					{
						address: "nova-7k3p@mail.example",
						agentId: "agent/1",
						id: "in-1",
						name: "Nova",
					},
					{ status: 201 }
				)
			);
		});
		const inbox = await new MailAPI(options).ensureAgentInbox("agent/1", {
			name: "Nova",
		});
		expect(url).toBe("http://node.example/api/mail/agents/agent%2F1/inbox");
		expect(JSON.parse(body)).toEqual({ name: "Nova" });
		expect(inbox).toMatchObject({ agentId: "agent/1", id: "in-1" });
	});

	test("unwraps an address change", async () => {
		installFetch(() =>
			Promise.resolve(
				Response.json({
					forwardUntil: "2026-11-10T00:00:00.000Z",
					inbox: { address: "orion@mail.example", id: "in-1" },
					previousAddress: "nova@mail.example",
				})
			)
		);
		const change = await new MailAPI(options).changeInboxAddress("in-1", {
			localPart: "orion",
		});
		expect(change.inbox.address).toBe("orion@mail.example");
		expect(change.previousAddress).toBe("nova@mail.example");
		expect(change.forwardUntil).toBe("2026-11-10T00:00:00.000Z");
	});
});

interface RecordedCall {
	body: string | null;
	method: string;
	url: string;
}

function recordFetch(reply: (call: RecordedCall) => Response): RecordedCall[] {
	const calls: RecordedCall[] = [];
	installFetch((url, init) => {
		const call = {
			body: typeof init?.body === "string" ? init.body : null,
			method: init?.method ?? "GET",
			url: String(url),
		};
		calls.push(call);
		return Promise.resolve(reply(call));
	});
	return calls;
}

/** The hosted `serializeInbox` view (packages/db email.model.ts). */
const hostedInbox = {
	id: "in-1",
	organizationId: "org-1",
	createdBy: "user-1",
	name: "Support",
	address: "support@mail.example.com",
	description: null,
	webhookUrl: "https://hooks.example.com/inbox",
	webhookConfigured: true,
	webhookSigned: true,
	clientId: null,
	metadata: {},
	podId: null,
	enabled: true,
	lifecycleState: "active",
	lapsedAt: null,
	deactivatedAt: null,
	brandingRemoved: false,
	createdAt: "2026-10-12T00:00:00.000Z",
	updatedAt: "2026-10-12T00:00:00.000Z",
};

/** The hosted `serializeMailWebhook` view (packages/api mail-webhooks.ts). */
const hostedWebhook = {
	id: "wh-1",
	url: "https://hooks.example.com/events",
	eventTypes: ["message.received"],
	headers: [],
	inboxIds: [],
	podIds: [],
	clientId: null,
	enabled: true,
	signatureScheme: "legacy",
	createdAt: "2026-10-12T00:00:00.000Z",
	updatedAt: "2026-10-12T00:00:00.000Z",
};

/** The hosted `serializeDomain` view (packages/api routers/mail.ts). */
const hostedDomain = {
	id: "dom-1",
	domain: "agents.example.com",
	status: "pending",
	subdomainsEnabled: false,
	trackingEnabled: false,
	records: [
		{
			type: "MX",
			name: "agents.example.com",
			value: "inbound-smtp.us-east-1.amazonaws.com",
			priority: 10,
			ttl: 3600,
			purpose: "inbound",
			required: false,
		},
		{
			type: "TXT",
			name: "agents.example.com",
			value: '"v=spf1 include:amazonses.com ~all"',
			ttl: 3600,
			purpose: "spf",
			required: false,
		},
		{
			type: "CNAME",
			name: "tok1._domainkey.agents.example.com",
			value: "tok1.dkim.amazonses.com",
			ttl: 3600,
			purpose: "dkim",
			required: true,
		},
	],
	verificationError: null,
	lastCheckedAt: "2026-10-12T00:00:01.000Z",
	verifiedAt: null,
	podId: null,
	clientId: null,
	createdAt: "2026-10-12T00:00:00.000Z",
	updatedAt: "2026-10-12T00:00:01.000Z",
};

describe("MailAPI inbox createdWith", () => {
	const createdWith = {
		apiKeyId: "key-1",
		gatewayCredentialId: null,
		oauthClientId: null,
		serviceAccountId: "sa-1",
		via: "api_key",
	};

	test("keeps hosted createdWith, null for legacy inboxes, absent when omitted", async () => {
		recordFetch(() =>
			Response.json({
				inboxes: [
					{ ...hostedInbox, createdWith },
					{ ...hostedInbox, id: "in-legacy", createdWith: null },
					{ id: "in-2", address: "a@example.com", name: "A", created_at: "t" },
				],
			})
		);
		const [attributed, legacy, selfHosted] = await new MailAPI(
			options
		).listInboxes();
		expect(attributed?.createdWith).toEqual(createdWith);
		expect(legacy?.createdWith).toBeNull();
		expect(selfHosted?.createdWith).toBeUndefined();
		expect(Object.keys(selfHosted ?? {})).not.toContain("created_with");
	});

	test("fills missing ids with null, drops unknown keys and leaves a bad shape out", async () => {
		recordFetch(() =>
			Response.json({
				inboxes: [
					{
						...hostedInbox,
						createdWith: { via: "oauth", oauthClientId: "app-1", extra: 1 },
					},
					{ ...hostedInbox, createdWith: { apiKeyId: "key-1" } },
					{ ...hostedInbox, createdWith: "api_key" },
					{ ...hostedInbox, createdWith: { via: "api_key", apiKeyId: 7 } },
					{ ...hostedInbox, created_with: { via: "session" } },
				],
			})
		);
		const [oauth, noVia, text, badId, snake] = await new MailAPI(
			options
		).listInboxes();
		expect(oauth?.createdWith).toEqual({
			apiKeyId: null,
			gatewayCredentialId: null,
			oauthClientId: "app-1",
			serviceAccountId: null,
			via: "oauth",
		});
		expect(noVia?.createdWith).toBeUndefined();
		expect(text?.createdWith).toBeUndefined();
		expect(badId?.createdWith).toBeUndefined();
		expect(snake?.createdWith?.via).toBe("session");
	});
});

describe("MailAPI inbox webhook signing", () => {
	test("createInbox sends webhookUrl and returns the one-time webhookSecret", async () => {
		const calls = recordFetch(() =>
			Response.json(
				{ ...hostedInbox, webhookSecret: "whsec_AAAA" },
				{ status: 201 }
			)
		);
		const inbox = await new MailAPI(options).createInbox({
			address: "support",
			name: "Support",
			webhookUrl: "https://hooks.example.com/inbox",
		});
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url).toBe("http://node.example/api/mail/inboxes");
		expect(
			wireJsonRecordSchema.parse(JSON.parse(calls[0]?.body ?? "{}")).webhookUrl
		).toBe("https://hooks.example.com/inbox");
		expect(inbox).toMatchObject({
			id: "in-1",
			webhookConfigured: true,
			webhookSecret: "whsec_AAAA",
			webhookSigned: true,
			webhookUrl: "https://hooks.example.com/inbox",
		});
	});

	test("updateInbox sends rotateWebhookSecret; reads never carry a secret", async () => {
		const calls = recordFetch((call) =>
			Response.json(
				call.method === "PATCH"
					? { ...hostedInbox, webhookSecret: "whsec_BBBB" }
					: { ...hostedInbox, webhookSigned: false }
			)
		);
		const api = new MailAPI(options);
		const rotated = await api.updateInbox("in-1", {
			rotateWebhookSecret: true,
		});
		expect(calls[0]?.method).toBe("PATCH");
		expect(calls[0]?.url).toBe("http://node.example/api/mail/inboxes/in-1");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			rotateWebhookSecret: true,
		});
		expect(rotated.webhookSecret).toBe("whsec_BBBB");
		const read = await api.getInbox("in-1");
		expect(read.webhookSecret).toBeUndefined();
		expect(read.webhookSigned).toBe(false);
	});

	test("keeps a cleared webhookUrl as null and leaves fields older servers omit undefined", async () => {
		recordFetch(() =>
			Response.json({
				inboxes: [
					{
						...hostedInbox,
						webhookUrl: null,
						webhookConfigured: false,
						webhookSigned: false,
					},
					{ id: "in-2", address: "a@example.com", name: "A", created_at: "t" },
				],
			})
		);
		const [hosted, older] = await new MailAPI(options).listInboxes();
		expect(hosted?.webhookUrl).toBeNull();
		expect(hosted?.webhookConfigured).toBe(false);
		expect(older?.webhookUrl).toBeUndefined();
		expect(older?.webhookSigned).toBeUndefined();
		expect(older?.webhookConfigured).toBeUndefined();
		expect(older?.webhookSecret).toBeUndefined();
	});
});

describe("MailAPI managed webhook signing", () => {
	test("reads signatureScheme from hosted and sidecar replies, undefined when omitted", async () => {
		const { signatureScheme: _omitted, ...beforeSigning } = hostedWebhook;
		recordFetch(() =>
			Response.json({
				webhooks: [
					hostedWebhook,
					{ webhook_id: "wh-2", url: "u", signature_scheme: "standard" },
					{ ...beforeSigning, id: "wh-3" },
				],
			})
		);
		const webhooks = await new MailAPI(options).listWebhooks();
		expect(webhooks.map((webhook) => webhook.signatureScheme)).toEqual([
			"legacy",
			"standard",
			undefined,
		]);
	});

	test("rotateWebhookSecret PATCHes rotateSecret and returns the new secret once", async () => {
		const calls = recordFetch(() =>
			Response.json({
				webhook: { ...hostedWebhook, signatureScheme: "standard" },
				secret: "whsec_CCCC",
			})
		);
		const rotated = await new MailAPI(options).rotateWebhookSecret("wh-1");
		expect(calls[0]?.method).toBe("PATCH");
		expect(calls[0]?.url).toBe("http://node.example/api/mail/webhooks/wh-1");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ rotateSecret: true });
		expect(rotated.secret).toBe("whsec_CCCC");
		expect(rotated.webhook).toMatchObject({
			id: "wh-1",
			signatureScheme: "standard",
		});
	});

	test("a replayed create returns a null secret", async () => {
		recordFetch(() => Response.json({ webhook: hostedWebhook, secret: null }));
		const created = await new MailAPI(options).createWebhook({
			clientId: "once",
			url: hostedWebhook.url,
		});
		expect(created.secret).toBeNull();
		expect(created.webhook.signatureScheme).toBe("legacy");
	});
});

describe("MailAPI custom domain verification", () => {
	test("createDomain returns the DNS records, status and verificationError", async () => {
		recordFetch(() => Response.json(hostedDomain, { status: 201 }));
		const created = await new MailAPI(options).createDomain({
			domain: "agents.example.com",
		});
		expect(created.status).toBe("pending");
		expect(created.verificationError).toBeNull();
		expect(created.lastCheckedAt).toBe("2026-10-12T00:00:01.000Z");
		expect(created.verifiedAt).toBeNull();
		expect(created.records).toEqual(hostedDomain.records);
		expect(
			created.records
				.filter((record) => record.required)
				.map((record) => record.type)
		).toEqual(["CNAME"]);
	});

	test("verifyDomain POSTs to the verify route and returns the updated domain", async () => {
		const calls = recordFetch(() =>
			Response.json({
				...hostedDomain,
				status: "verified",
				verifiedAt: "2026-10-12T01:00:00.000Z",
			})
		);
		const verified = await new MailAPI(options).verifyDomain("dom-1");
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url).toBe(
			"http://node.example/api/mail/domains/dom-1/verify"
		);
		expect(verified.status).toBe("verified");
		expect(verified.verifiedAt).toBe("2026-10-12T01:00:00.000Z");
	});

	test("keeps a provider error and accepts records from servers without purpose fields", async () => {
		recordFetch(() =>
			Response.json({
				domains: [
					{
						...hostedDomain,
						records: [],
						verificationError: "the mail provider could not be reached",
					},
					{
						id: "dom-2",
						domain: "older.example.com",
						status: "pending",
						records: [
							{ type: "TXT", name: "_ryu-verification.older", value: "v=1" },
						],
					},
				],
			})
		);
		const [unavailable, older] = await new MailAPI(options).listDomains();
		expect(unavailable?.verificationError).toBe(
			"the mail provider could not be reached"
		);
		expect(older?.verificationError).toBeUndefined();
		expect(older?.records).toEqual([
			{ type: "TXT", name: "_ryu-verification.older", value: "v=1" },
		]);
	});

	test("connectRealtime uses a one-use ticket and never URL credentials", async () => {
		const ticketCalls: { body: string; headers: Headers; url: string }[] = [];
		installFetch((url, init) => {
			ticketCalls.push({
				url: String(url),
				body: String(init?.body),
				headers: new Headers(init?.headers),
			});
			return Promise.resolve(Response.json({ ticket: "ticket-1" }));
		});
		const opened: { protocols?: string[]; url: string }[] = [];
		installFakeWebSocket(opened);
		await new MailAPI({ ...options, userJwt: "user-jwt" }).connectRealtime(
			() => undefined
		);
		expect(ticketCalls).toHaveLength(1);
		expect(ticketCalls[0]?.url).toBe("http://node.example/api/ws/ticket");
		expect(JSON.parse(ticketCalls[0]?.body ?? "")).toEqual({
			route: "ext",
			path: "/api/ext/ws/@ryu/mail/ws",
		});
		expect(ticketCalls[0]?.headers.get("Authorization")).toBe(
			"Bearer node-token"
		);
		expect(ticketCalls[0]?.headers.get("x-ryu-user-jwt")).toBe("user-jwt");
		const socketUrl = new URL(opened[0]?.url ?? "");
		expect(socketUrl.protocol).toBe("ws:");
		expect(socketUrl.pathname).toBe("/api/ext/ws/@ryu/mail/ws");
		expect([...socketUrl.searchParams.keys()]).toEqual(["ticket"]);
		expect(socketUrl.searchParams.get("ticket")).toBe("ticket-1");
		expect(opened[0]?.protocols).toBeUndefined();
	});

	test("connectRealtime keeps the standalone bearer subprotocol", async () => {
		installFetch(() => Promise.reject(new Error("no ticket in standalone")));
		const opened: { protocols?: string[]; url: string }[] = [];
		installFakeWebSocket(opened);
		await new MailAPI({
			...options,
			mailRealtime: "standalone",
		}).connectRealtime(() => undefined);
		expect(opened[0]).toEqual({
			url: "ws://node.example/api/mail/ws",
			protocols: ["ryu-mail.v1", "ryu-bearer.node-token"],
		});
	});
});

/** The hosted `serializeAlias` view (packages/db email.model.ts). */
const hostedAlias = {
	id: "al-1",
	address: "nova@acme.mail.example.com",
	localPart: "nova",
	host: "acme.mail.example.com",
	domainId: null,
	kind: "alias",
	status: "active",
	agentId: "node-1:nova",
	nodeId: "node-1",
	displayName: "Nova",
	claimedVia: "agent_tool",
	claimedAt: "2026-10-12T00:00:00.000Z",
	pendingExpiresAt: null,
	revokedAt: null,
	revokeReason: null,
	reinstatableUntil: null,
} satisfies MailAlias;

const hostedMailbox = {
	id: "mb-1",
	address: "acme@mail.example.com",
	handle: "acme",
	aliasHost: "acme.mail.example.com",
	name: "Acme",
	enabled: true,
	lifecycleState: "active",
	aliasClaimPolicy: "approval",
	brandingRemoved: false,
	createdAt: "2026-10-12T00:00:00.000Z",
	primaryLockedAt: "2026-10-12T00:00:00.000Z",
} satisfies MailMailbox;

describe("MailAPI organization mailbox and agent addresses", () => {
	const api = () => new MailAPI(options);
	const body = (call: RecordedCall | undefined) =>
		call?.body ? wireJsonRecordSchema.parse(JSON.parse(call.body)) : null;

	test("reads the mailbox and the adoption candidates", async () => {
		const calls = recordFetch(() =>
			Response.json({
				mailbox: null,
				selection: {
					required: true,
					candidates: [
						{ inboxId: "in-1", address: "ops@mail.example.com", name: "Ops" },
					],
				},
				aliasHostsEnabled: true,
			})
		);
		const state = await api().getMailbox();
		expect(calls[0]).toMatchObject({
			method: "GET",
			url: "http://node.example/api/mail/mailbox",
		});
		expect(state.mailbox).toBeNull();
		expect(state.aliasHostsEnabled).toBe(true);
		expect(state.selection).toEqual({
			required: true,
			candidates: [
				{ inboxId: "in-1", address: "ops@mail.example.com", name: "Ops" },
			],
		});
	});

	test("checks, claims, adopts, and updates the mailbox", async () => {
		const calls = recordFetch((call) => {
			if (call.url.includes("/mailbox/check")) {
				return Response.json({
					handle: "acme",
					address: "acme@mail.example.com",
					aliasHost: "acme.mail.example.com",
					available: false,
					reason: "address_unavailable",
					message:
						"That address is taken, and addresses are never reissued, so retrying it cannot succeed. Choose a different name.",
					suggestions: ["acme-hq@mail.example.com"],
				});
			}
			return Response.json({ mailbox: hostedMailbox });
		});
		const check = await api().checkMailboxHandle("acme");
		expect(calls[0]?.url).toBe(
			"http://node.example/api/mail/mailbox/check?handle=acme"
		);
		expect(check).toMatchObject({
			aliasHost: "acme.mail.example.com",
			available: false,
			reason: "address_unavailable",
			suggestions: ["acme-hq@mail.example.com"],
		});
		expect(check.message).toContain("never reissued");

		const claimed = await api().claimMailbox({
			handle: "acme",
			confirmAddress: "acme@mail.example.com",
		});
		expect(calls[1]).toMatchObject({
			method: "POST",
			url: "http://node.example/api/mail/mailbox",
		});
		expect(body(calls[1])).toEqual({
			handle: "acme",
			confirmAddress: "acme@mail.example.com",
		});
		expect(claimed).toEqual(hostedMailbox);

		await api().adoptMailbox({
			inboxId: "in-1",
			confirmAddress: "ops@mail.example.com",
		});
		expect(calls[2]).toMatchObject({
			method: "POST",
			url: "http://node.example/api/mail/mailbox/adopt",
		});
		expect(body(calls[2])).toEqual({
			inboxId: "in-1",
			confirmAddress: "ops@mail.example.com",
		});

		await api().setMailboxAliasHost("acme");
		expect(calls[3]?.url).toBe(
			"http://node.example/api/mail/mailbox/alias-host"
		);
		expect(body(calls[3])).toEqual({ label: "acme" });

		await api().updateMailbox({ aliasClaimPolicy: "admins_only" });
		expect(calls[4]).toMatchObject({
			method: "PATCH",
			url: "http://node.example/api/mail/mailbox",
		});
		expect(body(calls[4])).toEqual({ aliasClaimPolicy: "admins_only" });
	});

	test("lists aliases with usage and drives every admin action", async () => {
		const calls = recordFetch((call) => {
			if (call.url.endsWith("/reject")) {
				return new Response(null, { status: 204 });
			}
			if (call.url.includes("/aliases/check")) {
				return Response.json({
					address: "billing@acme.mail.example.com",
					available: false,
					reason: "reserved",
					suggestions: [],
				});
			}
			if (call.method === "GET") {
				return Response.json({
					aliases: [
						hostedAlias,
						{ ...hostedAlias, id: "al-2", status: "pending" },
					],
					nextCursor: "c-2",
					usage: { used: 2, limit: 3 },
				});
			}
			return Response.json({ alias: hostedAlias });
		});
		const page = await api().listAliases({ status: "active", limit: 10 });
		expect(calls[0]?.url).toBe(
			"http://node.example/api/mail/aliases?limit=10&status=active"
		);
		expect(page.aliases.map((entry) => entry.status)).toEqual([
			"active",
			"pending",
		]);
		expect(page.aliases[0]).toEqual(hostedAlias);
		expect(page.usage).toEqual({ used: 2, limit: 3 });
		expect(page.nextCursor).toBe("c-2");

		const check = await api().checkAlias("billing", "dom-1");
		expect(calls[1]?.url).toBe(
			"http://node.example/api/mail/aliases/check?domainId=dom-1&localPart=billing"
		);
		expect(check.reason).toBe("reserved");

		await api().assignAlias({ agentId: "node-1:nova", localPart: "nova" });
		expect(calls[2]).toMatchObject({
			method: "POST",
			url: "http://node.example/api/mail/aliases",
		});
		expect(body(calls[2])).toEqual({
			agentId: "node-1:nova",
			localPart: "nova",
		});

		await api().approveAlias("al-2");
		await api().rejectAlias("al-2");
		await api().revokeAlias("al-1", "compromised");
		await api().reinstateAlias("al-1");
		await api().transferAlias("al-1", {
			agentId: "node-2:nova",
			confirmAddress: "nova@acme.mail.example.com",
		});
		expect(
			calls
				.slice(3)
				.map((call) => [
					call.method,
					call.url.replace("http://node.example", ""),
				])
		).toEqual([
			["POST", "/api/mail/aliases/al-2/approve"],
			["POST", "/api/mail/aliases/al-2/reject"],
			["POST", "/api/mail/aliases/al-1/revoke"],
			["POST", "/api/mail/aliases/al-1/reinstate"],
			["POST", "/api/mail/aliases/al-1/transfer"],
		]);
		expect(body(calls[5])).toEqual({ reason: "compromised" });
		expect(body(calls[7])).toEqual({
			agentId: "node-2:nova",
			confirmAddress: "nova@acme.mail.example.com",
		});
	});

	test("claims and reads an agent's own address", async () => {
		const calls = recordFetch((call) => {
			if (call.url.includes("/alias/check")) {
				return Response.json({
					address: "nova@acme.mail.example.com",
					available: true,
					suggestions: [],
				});
			}
			if (call.method === "POST") {
				return Response.json(
					{
						status: "pending_approval",
						alias: { ...hostedAlias, status: "pending" },
						mailbox: { address: "acme@mail.example.com" },
					},
					{ status: 201 }
				);
			}
			return Response.json({
				alias: null,
				mailbox: {
					address: "acme@mail.example.com",
					aliasHost: "acme.mail.example.com",
				},
			});
		});
		const current = await api().getAgentAlias("node-1:nova");
		expect(calls[0]?.url).toBe(
			"http://node.example/api/mail/agents/node-1%3Anova/alias"
		);
		expect(current).toEqual({
			alias: null,
			mailbox: {
				address: "acme@mail.example.com",
				aliasHost: "acme.mail.example.com",
			},
		});

		const check = await api().checkAgentAlias("node-1:nova");
		expect(calls[1]?.url).toBe(
			"http://node.example/api/mail/agents/node-1%3Anova/alias/check"
		);
		expect(check.available).toBe(true);

		const claim = await api().claimAgentAlias(
			"node-1:nova",
			{ localPart: "nova", displayName: "Nova" },
			"claim-1"
		);
		expect(calls[2]?.method).toBe("POST");
		expect(body(calls[2])).toEqual({ localPart: "nova", displayName: "Nova" });
		expect(claim.status).toBe("pending_approval");
		expect(claim.alias.status).toBe("pending");
		expect(claim.mailbox).toEqual({ address: "acme@mail.example.com" });
	});

	test("reads the agent view and sends as the agent", async () => {
		const view = {
			id: "m-1",
			receivedAt: "2026-10-12T00:00:00.000Z",
			direction: "inbound",
			alias: "nova@acme.mail.example.com",
			threadId: "t-1",
			routing: "alias",
			trust: {
				origin: "external",
				senderAuthenticated: true,
				dmarc: "PASS",
				spf: "PASS",
				dkim: "PASS",
				screening: { verdict: "clean", flags: [] },
			},
			untrusted: {
				from: "a@example.com",
				replyTo: null,
				subject: "Hi",
				text: "Hello",
				attachments: [],
			},
			withheld: null,
			notice: "Fields under `untrusted` were written by an outside sender.",
		} satisfies AgentMailMessage;
		const calls = recordFetch((call) => {
			if (call.url.endsWith("/send")) {
				return Response.json(
					{
						status: "pending_approval",
						draftId: "d-1",
						reasons: ["first_contact"],
					},
					{ status: 202 }
				);
			}
			if (call.url.endsWith("/reply")) {
				return Response.json({ status: "sent", messageId: "m-2" });
			}
			if (call.url.includes("/messages?")) {
				return Response.json({
					messages: [
						{
							id: "m-1",
							receivedAt: view.receivedAt,
							direction: "inbound",
							threadId: "t-1",
							read: false,
							trust: view.trust,
							untrusted: {
								from: "a@example.com",
								subject: "Hi",
								preview: "Hello",
							},
							withheld: null,
						},
					],
					nextCursor: null,
				});
			}
			if (call.url.includes("/threads/")) {
				return Response.json({ messages: [view] });
			}
			return Response.json({ message: view });
		});
		const list = await api().listAgentMessages("node-1:nova", {
			limit: 5,
			unread: true,
		});
		expect(calls[0]?.url).toBe(
			"http://node.example/api/mail/agents/node-1%3Anova/messages?limit=5&unread=1"
		);
		expect(list.messages[0]?.untrusted.preview).toBe("Hello");
		const read = await api().getAgentMessage("node-1:nova", "m-1");
		expect(read).toEqual(view);
		const held = await api().sendAsAgent("node-1:nova", {
			to: ["b@example.com"],
			subject: "Hi",
			text: "Hello",
		});
		expect(held).toEqual({
			status: "pending_approval",
			draftId: "d-1",
			reasons: ["first_contact"],
		});
		const sent = await api().replyAsAgent("node-1:nova", "m-1", {
			text: "Thanks",
			replyAll: true,
		});
		expect(sent).toEqual({ status: "sent", messageId: "m-2" });
		expect(calls[3]?.url).toBe(
			"http://node.example/api/mail/agents/node-1%3Anova/messages/m-1/reply"
		);
		expect(body(calls[3])).toEqual({ text: "Thanks", replyAll: true });
		const thread = await api().getAgentThread("node-1:nova", "m-1");
		expect(thread).toEqual([view]);
		expect(calls[4]?.url).toBe(
			"http://node.example/api/mail/agents/node-1%3Anova/threads/m-1"
		);
	});

	test("manages the send policy and the approval queue", async () => {
		const policy = {
			mode: "always",
			maxRecipientsPerMessage: 5,
			newRecipientsPerDay: 10,
			preApprovedDomains: ["acme.com"],
			source: "alias",
		};
		const calls = recordFetch((call) => {
			if (call.method === "DELETE" || call.url.endsWith("/reject")) {
				return new Response(null, { status: 204 });
			}
			if (call.url.includes("/approvals")) {
				return Response.json({
					approvals: [
						{
							draftId: "d-1",
							aliasId: "al-1",
							alias: "nova@acme.mail.example.com",
							to: ["b@example.com"],
							cc: [],
							bcc: ["hidden@example.com"],
							replyTo: ["r@example.com"],
							headers: { "X-Campaign": "q4" },
							attachments: [
								{
									contentType: "application/pdf",
									filename: "quote.pdf",
									inline: false,
									size: 2048,
								},
							],
							subject: "Hi",
							text: "Hello",
							html: null,
							reasons: ["first_contact"],
							requestedAt: "2026-10-12T00:00:00.000Z",
							expiresAt: "2026-10-19T00:00:00.000Z",
						},
					],
					nextCursor: null,
				});
			}
			if (call.url.endsWith("/approve")) {
				return Response.json({
					message: { id: "m-9", inboxId: "mb-1", to: ["b@example.com"] },
				});
			}
			return Response.json(policy);
		});
		expect(await api().getSendPolicy("al-1")).toEqual({
			...policy,
			mode: "always",
			source: "alias",
		});
		expect(calls[0]?.url).toBe(
			"http://node.example/api/mail/send-policy?aliasId=al-1"
		);
		await api().setSendPolicy({ aliasId: null, mode: "first_contact" });
		expect(calls[1]?.method).toBe("PUT");
		expect(body(calls[1])).toEqual({ aliasId: null, mode: "first_contact" });
		await api().deleteAliasSendPolicy("al-1");
		expect(calls[2]).toMatchObject({
			method: "DELETE",
			url: "http://node.example/api/mail/send-policy/alias/al-1",
		});
		const queue = await api().listApprovals();
		expect(queue.approvals[0]).toMatchObject({
			draftId: "d-1",
			alias: "nova@acme.mail.example.com",
			reasons: ["first_contact"],
			bcc: ["hidden@example.com"],
			replyTo: ["r@example.com"],
			headers: { "X-Campaign": "q4" },
			attachments: [
				{
					contentType: "application/pdf",
					filename: "quote.pdf",
					inline: false,
					size: 2048,
				},
			],
		});
		const sent = await api().approveDraft("d-1");
		expect(calls[4]?.url).toBe(
			"http://node.example/api/mail/drafts/d-1/approve"
		);
		expect(sent.id).toBe("m-9");
		await api().rejectDraft("d-1", "not now");
		expect(body(calls[5])).toEqual({ reason: "not now" });
	});

	test("the deprecated agent inbox methods keep their wire shapes", async () => {
		const calls = recordFetch((call) => {
			if (call.url.endsWith("/address")) {
				return Response.json(
					{
						error: "Agent email addresses are permanent.",
						code: "address_permanent",
					},
					{ status: 409 }
				);
			}
			return Response.json({
				inbox: { ...hostedInbox, id: "mb-1", agentId: "node-1:nova" },
			});
		});
		const ensured = await api().ensureAgentInbox("node-1:nova", {
			localPart: "nova",
		});
		expect(calls[0]?.url).toBe(
			"http://node.example/api/mail/agents/node-1%3Anova/inbox"
		);
		expect(body(calls[0])).toEqual({ localPart: "nova" });
		expect(ensured.agentId).toBe("node-1:nova");
		const fetched = await api().getAgentInbox("node-1:nova");
		expect(fetched.id).toBe("mb-1");
		await expect(
			api().changeInboxAddress("mb-1", { localPart: "other" })
		).rejects.toThrow("address_permanent");
	});

	test("checkAddress reports the collapsed address_unavailable reason", async () => {
		recordFetch(() =>
			Response.json({
				address: "nova@mail.example.com",
				available: false,
				reason: "address_unavailable",
				message: "That address is taken, and addresses are never reissued.",
				suggestions: ["nova-2@mail.example.com"],
			})
		);
		const check = await api().checkAddress("nova");
		expect(check.reason).toBe("address_unavailable");
		expect(check.message).toContain("never reissued");
		expect(check.suggestions).toEqual(["nova-2@mail.example.com"]);
	});
});

describe("MailAPI.connectRealtime", () => {
	interface OpenedSocket {
		protocols: string | string[] | undefined;
		url: string;
	}
	const realWebSocket = globalThis.WebSocket;

	afterEach(() => {
		globalThis.WebSocket = realWebSocket;
	});

	function captureSockets(): OpenedSocket[] {
		const opened: OpenedSocket[] = [];
		globalThis.WebSocket = class {
			constructor(url: string, protocols?: string | string[]) {
				opened.push({ protocols, url });
			}
			addEventListener(): void {
				// The tests only inspect the handshake arguments.
			}
		} as unknown as typeof WebSocket;
		return opened;
	}

	test("standalone sends the token in Sec-WebSocket-Protocol and never in the URL", () => {
		const opened = captureSockets();
		new MailAPI({
			baseUrl: "https://mail.example.com/",
			mailRealtime: "standalone",
			token: "standalone-secret",
			userJwt: "user-jwt-secret",
		}).connectRealtime(() => undefined);
		expect(opened).toEqual([
			{
				protocols: ["ryu-mail.v1", "ryu-bearer.standalone-secret"],
				url: "wss://mail.example.com/api/mail/ws",
			},
		]);
	});

	test("standalone ignores a ticket and offers no protocols without a token", () => {
		const opened = captureSockets();
		new MailAPI({
			baseUrl: "http://127.0.0.1:7990",
			mailRealtime: "standalone",
		}).connectRealtime(() => undefined, undefined, { ticket: "t-1" });
		expect(opened).toEqual([
			{ protocols: undefined, url: "ws://127.0.0.1:7990/api/mail/ws" },
		]);
	});

	test("Core mode without a ticket mints one and keeps credentials out of the socket", async () => {
		const opened = captureSockets();
		installFetch(() => Promise.resolve(Response.json({ ticket: "ticket-9" })));
		await new MailAPI({
			baseUrl: "http://node.example",
			token: "node-token",
			userJwt: () => "user-jwt-secret",
		}).connectRealtime(() => undefined);
		expect(opened).toEqual([
			{
				protocols: undefined,
				url: "ws://node.example/api/ext/ws/@ryu/mail/ws?ticket=ticket-9",
			},
		]);
		expect(JSON.stringify(opened)).not.toContain("node-token");
		expect(JSON.stringify(opened)).not.toContain("user-jwt-secret");
	});

	test("a token outside the subprotocol charset rejects with a redacted error", async () => {
		const opened = captureSockets();
		for (const token of ["abc/secret==", "has space", "plus+slash/", "a,b"]) {
			let message = "";
			try {
				await new MailAPI({
					baseUrl: "https://mail.example.com",
					mailRealtime: "standalone",
					token,
				}).connectRealtime(() => undefined);
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			expect(message).toContain("Sec-WebSocket-Protocol");
			expect(message).not.toContain(token);
		}
		expect(opened).toEqual([]);
	});

	test("hosted gateway (rgw_) and ryu_ keys never reach the socket URL or protocols", () => {
		const opened = captureSockets();
		for (const token of ["rgw_gateway_secret", "ryu_account_secret"]) {
			new MailAPI({
				baseUrl: "https://api.ryu.example",
				token,
			}).connectRealtime(() => undefined, undefined, { ticket: "t-1" });
		}
		expect(JSON.stringify(opened)).not.toContain("secret");
		expect(
			opened.every((socket) => socket.url.endsWith("/ws?ticket=t-1"))
		).toBe(true);
		expect(opened.every((socket) => socket.protocols === undefined)).toBe(true);
	});

	const TICKET = "mrt_2r7Yf0kQ6bWm9pXcJ3hT1sLeAa8uVnZg4oDiRyKqE5w";

	test("connectRealtimeWithTicket mints a ticket with the key, then offers it as a subprotocol", async () => {
		const opened = captureSockets();
		const calls: { headers: Headers; method: string; url: string }[] = [];
		await new MailAPI({
			baseUrl: "https://api.ryu.example/",
			token: "rgw_gateway_secret",
			fetch: (input, init) => {
				calls.push({
					headers: new Headers(init?.headers),
					method: init?.method ?? "GET",
					url: String(input),
				});
				return Promise.resolve(
					Response.json(
						{
							ticket: TICKET,
							expiresAt: "2026-10-23T12:00:30.000Z",
							expiresIn: 30,
							path: "/api/mail/realtime",
							protocols: ["ryu-mail.v1", `ryu-ticket.${TICKET}`],
						},
						{ status: 201 }
					)
				);
			},
		}).connectRealtimeWithTicket(() => undefined);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url).toBe(
			"https://api.ryu.example/api/mail/realtime/tickets"
		);
		expect(calls[0]?.headers.get("authorization")).toBe(
			"Bearer rgw_gateway_secret"
		);
		expect(opened).toEqual([
			{
				protocols: ["ryu-mail.v1", `ryu-ticket.${TICKET}`],
				url: "wss://api.ryu.example/api/mail/realtime",
			},
		]);
		expect(JSON.stringify(opened)).not.toContain("secret");
	});

	test("connectRealtimeWithTicket uses a given ticket without minting", async () => {
		const opened = captureSockets();
		let fetched = false;
		await new MailAPI({
			baseUrl: "http://127.0.0.1:3000",
			token: "ryu_account_secret",
			fetch: () => {
				fetched = true;
				return Promise.resolve(Response.json({}));
			},
		}).connectRealtimeWithTicket(() => undefined, undefined, {
			ticket: TICKET,
		});
		expect(fetched).toBe(false);
		expect(opened).toEqual([
			{
				protocols: ["ryu-mail.v1", `ryu-ticket.${TICKET}`],
				url: "ws://127.0.0.1:3000/api/mail/realtime",
			},
		]);
	});

	test("connectRealtimeWithTicket refuses an unusable ticket without echoing it", async () => {
		const opened = captureSockets();
		const api = new MailAPI({
			baseUrl: "https://api.ryu.example",
			token: "ryu_account_secret",
			fetch: () => Promise.resolve(Response.json({ ticket: "bad ticket/x" })),
		});
		for (const options of [{}, { ticket: "has space" }]) {
			let message = "";
			try {
				await api.connectRealtimeWithTicket(
					() => undefined,
					undefined,
					options
				);
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			expect(message).toContain("Sec-WebSocket-Protocol");
			expect(message).not.toContain("bad ticket");
			expect(message).not.toContain("has space");
		}
		expect(opened).toEqual([]);
	});

	test("createRealtimeTicket decodes the ticket reply", async () => {
		const ticket = await new MailAPI({
			baseUrl: "https://api.ryu.example",
			fetch: () =>
				Promise.resolve(
					Response.json({
						ticket: TICKET,
						expiresAt: "2026-10-23T12:00:30.000Z",
						expiresIn: 30,
						path: "/api/mail/realtime",
						protocols: ["ryu-mail.v1", `ryu-ticket.${TICKET}`],
					})
				),
		}).createRealtimeTicket();
		expect(ticket).toEqual({
			ticket: TICKET,
			expiresAt: "2026-10-23T12:00:30.000Z",
			expiresIn: 30,
			path: "/api/mail/realtime",
			protocols: ["ryu-mail.v1", `ryu-ticket.${TICKET}`],
			url: "wss://api.ryu.example/api/mail/realtime",
		});
	});

	test("connectRealtimeWithTicket refuses before minting when there is no WebSocket", async () => {
		let fetched = false;
		const api = new MailAPI({
			baseUrl: "https://api.ryu.example",
			token: "ryu_account_secret",
			fetch: () => {
				fetched = true;
				return Promise.resolve(Response.json({ ticket: TICKET }));
			},
		});
		Reflect.deleteProperty(globalThis, "WebSocket");
		await expect(
			api.connectRealtimeWithTicket(() => undefined)
		).rejects.toThrow("no global WebSocket");
		// No ticket slot was spent on a socket that could never open.
		expect(fetched).toBe(false);
	});

	test("connectRealtimeWithTicket opens with a given WebSocket constructor", async () => {
		Reflect.deleteProperty(globalThis, "WebSocket");
		const opened: { protocols: string | string[] | undefined; url: string }[] =
			[];
		class NodeWebSocket {
			constructor(url: string, protocols?: string | string[]) {
				opened.push({ protocols, url });
			}
			addEventListener(): void {
				// Only the handshake arguments are inspected.
			}
		}
		await new MailAPI({
			baseUrl: "https://api.ryu.example",
			token: "ryu_account_secret",
			fetch: () => Promise.resolve(Response.json({})),
		}).connectRealtimeWithTicket(() => undefined, undefined, {
			ticket: TICKET,
			WebSocket: NodeWebSocket as unknown as MailWebSocketConstructor,
		});
		expect(opened).toEqual([
			{
				protocols: ["ryu-mail.v1", `ryu-ticket.${TICKET}`],
				url: "wss://api.ryu.example/api/mail/realtime",
			},
		]);
	});

	test("connectRealtimeWithTicket takes a ws-shaped class and the global WebSocket without a cast", async () => {
		Reflect.deleteProperty(globalThis, "WebSocket");
		const sent: string[] = [];
		// The shape of the `ws` package's class (@types/ws 8): an overloaded
		// constructor and typed event listeners, not the DOM WebSocket.
		class WsShaped {
			readonly listeners = new Map<string, (event: never) => void>();
			constructor(address: null);
			constructor(
				address: string | URL,
				protocols?: string | string[],
				options?: { headers?: Record<string, string> }
			);
			constructor(
				readonly address: string | URL | null,
				readonly protocols?: string | string[],
				readonly options?: { headers?: Record<string, string> }
			) {}
			addEventListener(
				type: "message",
				listener: (event: {
					data: unknown;
					target: WsShaped;
					type: string;
				}) => void,
				options?: { once?: boolean }
			): void;
			addEventListener(
				type: "open",
				listener: (event: { target: WsShaped; type: string }) => void,
				options?: { once?: boolean }
			): void;
			addEventListener(
				type: "close",
				listener: (event: { code: number; reason: string }) => void,
				options?: { once?: boolean }
			): void;
			addEventListener(type: string, listener: (event: never) => void): void {
				this.listeners.set(type, listener);
			}
			close(_code?: number, _data?: string | Uint8Array): void {
				// Not exercised.
			}
			send(
				data: string | ArrayBuffer,
				_callback?: (error?: Error) => void
			): void {
				sent.push(String(data));
			}
		}
		const fromWs: MailWebSocketConstructor = WsShaped;
		const fromGlobal: MailWebSocketConstructor | null =
			typeof WebSocket === "function" ? WebSocket : null;
		expect(fromGlobal).toBeNull();
		const socket = await new MailAPI({
			baseUrl: "https://api.ryu.example",
			token: "ryu_account_secret",
			fetch: () => Promise.resolve(Response.json({})),
		}).connectRealtimeWithTicket(
			() => undefined,
			{ eventTypes: ["message.received"] },
			{ ticket: TICKET, WebSocket: fromWs }
		);
		const opened = socket as unknown as WsShaped;
		expect(opened.address).toBe("wss://api.ryu.example/api/mail/realtime");
		const onOpen = opened.listeners.get("open") as (() => void) | undefined;
		onOpen?.();
		expect(sent).toEqual([
			JSON.stringify({ eventTypes: ["message.received"] }),
		]);
	});

	test("the ticket methods refuse a self-hosted (standalone) Mail client", async () => {
		const opened = captureSockets();
		let fetched = false;
		const api = new MailAPI({
			baseUrl: "http://127.0.0.1:7996",
			mailRealtime: "standalone",
			token: "self-hosted",
			fetch: () => {
				fetched = true;
				return Promise.resolve(Response.json({}));
			},
		});
		await expect(api.createRealtimeTicket()).rejects.toThrow("hosted Mail");
		await expect(
			api.connectRealtimeWithTicket(() => undefined, undefined, {
				ticket: TICKET,
			})
		).rejects.toThrow("hosted Mail");
		expect(fetched).toBe(false);
		expect(opened).toEqual([]);
	});

	test("drafts, events and webhook deliveries lists send an optional limit", async () => {
		const urls: string[] = [];
		installFetch((input) => {
			const url = new URL(String(input));
			urls.push(`${url.pathname}${url.search}`);
			return Promise.resolve(
				Response.json({ drafts: [], events: [], deliveries: [] })
			);
		});
		const api = new MailAPI(options);
		await api.listDrafts("in-1");
		await api.listDrafts("in-1", { limit: 25 });
		await api.listWebhookDeliveries("wh-1", { limit: 500 });
		await api.listWebhookDeliveries("wh-1", {});
		await api.listEvents();
		await api.listEvents(undefined, "message.received", { limit: 10 });
		await api.listEvents(undefined, undefined, { limit: 5 });
		await api.listEvents("in-1", "message.received", { limit: 3 });
		expect(urls).toEqual([
			"/api/mail/inboxes/in-1/drafts",
			"/api/mail/inboxes/in-1/drafts?limit=25",
			"/api/mail/webhooks/wh-1/deliveries?limit=500",
			"/api/mail/webhooks/wh-1/deliveries",
			"/api/mail/events",
			"/api/mail/events?eventType=message.received&limit=10",
			"/api/mail/events?limit=5",
			// The inbox route takes no eventType, as before.
			"/api/mail/inboxes/in-1/events?limit=3",
		]);
	});
});
