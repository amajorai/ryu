import { afterAll, expect, test } from "bun:test";
import { dispatchRpc, type HostServices } from "@ryu/app-host/rpc";
import { sendCompanionMail } from "./mail-send-service.ts";

const requests: Array<{
	path: string;
	authorization: string | null;
	identity: string | null;
	key: string | null;
	body: unknown;
}> = [];
// A complete sent-message record as the Mail sidecar returns it
// (apps-store/mail/backend); the node client admits nothing less.
const accepted = {
	id: "accepted",
	inbox_id: "inbox-a",
	direction: "outbound",
	message_id: "<accepted@example.test>",
	from_addr: "inbox-a@example.test",
	to_addrs: ["reviewed@example.test"],
	cc_addrs: [],
	bcc_addrs: [],
	subject: "Reviewed",
	created_at: "2026-10-12T00:00:00.000Z",
	attachments: [],
	thread_id: null,
	extracted_text: null,
	extracted_html: null,
	preview: null,
	opened_at: null,
	client_id: null,
	error: null,
};
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		requests.push({
			path: new URL(request.url).pathname,
			authorization: request.headers.get("authorization"),
			identity: request.headers.get("x-ryu-user-jwt"),
			key: request.headers.get("idempotency-key"),
			body: await request.json(),
		});
		return Response.json({ message: accepted });
	},
});
afterAll(() => server.stop(true));

const target = {
	url: `${server.url.toString().replace(/\/$/, "")}/selected-node`,
	token: "fixture-node-admission",
	userJwt: "fixture-delegation",
};
const unsupportedCalls: string[] = [];
const services: HostServices = {
	listAgents: async () => {
		unsupportedCalls.push("listAgents");
		throw new Error("Unexpected listAgents call");
	},
	registerRoute: async () => {
		unsupportedCalls.push("registerRoute");
		throw new Error("Unexpected registerRoute call");
	},
	mailSend: (input) => sendCompanionMail(target, input),
};
const payload = {
	inboxId: "inbox-a",
	to: ["reviewed@example.test"],
	subject: "Reviewed",
	text: "Exact body",
	references: ["<parent@example.test>", "<message@example.test>"],
	inReplyTo: "<message@example.test>",
	trackOpens: true,
};

test("actual Panel Mail service maps canonical retry key to scoped node header without message-body pollution", async () => {
	requests.length = 0;
	unsupportedCalls.length = 0;
	expect(
		await dispatchRpc(
			"mail.send",
			[{ ...payload, idempotencyKey: "reviewed-retry-1" }],
			new Set(["mail.crud"]),
			services
		)
	).toEqual(accepted);
	await dispatchRpc("mail.send", [payload], new Set(["mail.crud"]), services);
	expect(unsupportedCalls).toEqual([]);
	const body = {
		to: payload.to,
		subject: payload.subject,
		text: payload.text,
		inReplyTo: payload.inReplyTo,
		references: payload.references.join(" "),
		trackOpens: true,
	};
	expect(requests).toEqual(
		["reviewed-retry-1", null].map((key) => ({
			path: "/selected-node/api/mail/inboxes/inbox-a/send",
			authorization: "Bearer fixture-node-admission",
			identity: "fixture-delegation",
			key,
			body,
		}))
	);
});

test("denied capability and malformed canonical keys issue no node HTTP requests", async () => {
	requests.length = 0;
	unsupportedCalls.length = 0;
	await expect(
		dispatchRpc(
			"mail.send",
			[{ ...payload, idempotencyKey: "key" }],
			new Set(),
			services
		)
	).rejects.toThrow();
	for (const key of ["", " ", "é", "bad\r\nkey", "x".repeat(257)]) {
		await expect(
			dispatchRpc(
				"mail.send",
				[{ ...payload, idempotencyKey: key }],
				new Set(["mail.crud"]),
				services
			)
		).rejects.toThrow();
	}
	expect(requests).toEqual([]);
	expect(unsupportedCalls).toEqual([]);
});
