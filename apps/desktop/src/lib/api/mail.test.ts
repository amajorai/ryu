import { expect, it } from "bun:test";
import { appJsonValueSchema } from "@ryuhq/core-client/app-request-json.ts";
import { mailJsonRecordSchema } from "@ryuhq/core-client/mail.ts";
import {
	createDraft,
	createWebhook,
	deleteInbox,
	getInbox,
	getThread,
	type Inbox,
	listDrafts,
	listEvents,
	listInboxes,
	listMessages,
	listThreads,
	mailRequest,
	rotateInboundSecret,
	sendMessage,
	updateWebhook,
} from "./mail.ts";

const inbox = {
	id: "i",
	name: "Inbox",
	address: "mail@example.test",
	provider: "webhook",
	created_at: "now",
	updated_at: "later",
	metadata: {},
} satisfies Inbox;
const message = {
	id: "m",
	inbox_id: "i",
	direction: "inbound",
	message_id: "<m@test>",
	from_addr: "a@test",
	to_addrs: ["b@test"],
	cc_addrs: [],
	bcc_addrs: [],
	subject: "Subject",
	created_at: "now",
	attachments: [],
};
const draft = {
	id: "d",
	inbox_id: "i",
	thread_id: null,
	client_id: null,
	to_addrs: [],
	cc_addrs: [],
	bcc_addrs: [],
	reply_to_addrs: [],
	subject: "Draft",
	text: null,
	html: null,
	headers: {},
	labels: [],
	attachments: [
		{
			filename: "f",
			content: "YmFzZQ==",
			content_type: "text/plain",
			content_id: null,
			inline: false,
		},
	],
	send_at: null,
	status: "draft",
	created_at: "now",
	updated_at: "later",
};
const thread = {
	inboxId: "i",
	threadId: "t",
	labels: [],
	senders: ["a@test"],
	recipients: ["b@test"],
	lastMessageId: "m",
	messageCount: 1,
	size: 42,
	subject: "Thread",
	preview: null,
	attachments: [],
	createdAt: "now",
	updatedAt: "later",
};
const webhook = {
	webhook_id: "w",
	url: "https://example.test",
	secret: null,
	enabled: true,
	event_types: [],
	inbox_ids: [],
	pod_ids: [],
	client_id: null,
	header_names: [],
	created_at: "now",
	updated_at: "later",
};

it("reads both legacy bare and native wrapped inboxes/messages without changing native queries", async () => {
	let bare = false;
	const requests: { url: string; authorization: string | null }[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			requests.push({
				url: request.url,
				authorization: request.headers.get("authorization"),
			});
			const path = new URL(request.url).pathname;
			if (path.endsWith("/rotate-secret")) {
				return Response.json(
					bare ? { inbound_secret: "legacy" } : { inboundSecret: "current" }
				);
			}
			if (path.endsWith("/messages")) {
				return Response.json(bare ? [message] : { messages: [message] });
			}
			if (path.endsWith("/inboxes")) {
				return Response.json(bare ? [inbox] : { inboxes: [inbox] });
			}
			return Response.json(bare ? inbox : { inbox });
		},
	});
	try {
		const target = { url: server.url.origin, token: "node-token" };
		for (bare of [false, true]) {
			expect(await listInboxes(target)).toEqual([inbox]);
			expect(await getInbox(target, "i")).toEqual(inbox);
			expect(
				await listMessages(target, "i", {
					labels: ["one", "two"],
					read: false,
					limit: 0,
					empty: "",
					missing: undefined,
					absent: null,
				})
			).toEqual([message]);
			expect(await rotateInboundSecret(target, "i")).toBe(
				bare ? "legacy" : "current"
			);
		}
		expect(new URL(requests[2]?.url ?? "").search).toBe(
			"?labels=one%2Ctwo&read=false&limit=0"
		);
		expect(requests[0]?.authorization).toBe("Bearer node-token");
	} finally {
		server.stop(true);
	}
});
it("keeps Companion-supplied inbox IDs inside one /api/mail segment", async () => {
	const requests: { method: string; pathname: string; search: string }[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			requests.push({
				method: request.method,
				pathname: url.pathname,
				search: url.search,
			});
			if (url.pathname.endsWith("/rotate-secret")) {
				return Response.json({ inboundSecret: "current" });
			}
			if (url.pathname.endsWith("/messages")) {
				return Response.json({ messages: [message] });
			}
			if (url.pathname.endsWith("/send")) {
				return Response.json({ message });
			}
			return new Response("");
		},
	});
	try {
		const target = { url: server.url.origin, token: "node-token" };
		for (const id of [
			"../../conversations/c1",
			"../../plugins/%40ryu%2Fbrowser/uninstall?",
		]) {
			requests.length = 0;
			const segment = encodeURIComponent(id);
			await deleteInbox(target, id);
			await rotateInboundSecret(target, id);
			await listMessages(target, id);
			await sendMessage(target, id, { to: ["b@test"], subject: "Subject" });
			expect(requests).toEqual([
				{
					method: "DELETE",
					pathname: `/api/mail/inboxes/${segment}`,
					search: "",
				},
				{
					method: "POST",
					pathname: `/api/mail/inboxes/${segment}/rotate-secret`,
					search: "",
				},
				{
					method: "GET",
					pathname: `/api/mail/inboxes/${segment}/messages`,
					search: "",
				},
				{
					method: "POST",
					pathname: `/api/mail/inboxes/${segment}/send`,
					search: "",
				},
			]);
		}
		requests.length = 0;
		for (const id of [".", ".."]) {
			await expect(deleteInbox(target, id)).rejects.toThrow("dot segment");
			await expect(rotateInboundSecret(target, id)).rejects.toThrow(
				"dot segment"
			);
			await expect(listMessages(target, id)).rejects.toThrow("dot segment");
			await expect(
				sendMessage(target, id, { to: ["b@test"], subject: "Subject" })
			).rejects.toThrow("dot segment");
		}
		expect(requests).toEqual([]);
	} finally {
		server.stop(true);
	}
});
it("retains real raw draft/thread/webhook forms and arbitrary serde event payloads", async () => {
	const event = {
		event_id: "e",
		event_type: "future-event",
		payload: [true, null, { future: "value" }],
		created_at: "now",
	};
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path.endsWith("/events")) {
				return Response.json({ events: [event] });
			}
			if (path.endsWith("/drafts")) {
				return Response.json(
					request.method === "GET" ? { drafts: [draft] } : draft
				);
			}
			if (path.endsWith("/threads")) {
				return Response.json({ threads: [thread] });
			}
			if (path.endsWith("/threads/t")) {
				return Response.json({ ...thread, messages: [message] });
			}
			return Response.json(webhook);
		},
	});
	try {
		const target = { url: server.url.origin, token: "node-token" };
		expect(await listDrafts(target, "i")).toEqual([draft]);
		expect(
			await createDraft(target, "i", {
				subject: "Draft",
				attachments: [{ filename: "f", content: "YmFzZQ==" }],
			})
		).toEqual(draft);
		expect(await listThreads(target, "i")).toEqual([thread]);
		expect(await getThread(target, "i", "t")).toEqual([message]);
		expect(
			await createWebhook(target, { url: "https://example.test" })
		).toEqual(webhook);
		expect(await updateWebhook(target, "w", { enabled: true })).toEqual(
			webhook
		);
		expect(await listEvents(target)).toEqual([event]);
	} finally {
		server.stop(true);
	}
});
it("retains native JSON serialization omissions, prototype keys, idempotency and empty replies", async () => {
	const requests: Request[] = [];
	const bodies = mailJsonRecordSchema.parse({});
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			requests.push(request);
			const text = await request.text();
			if (text) {
				bodies[request.url] = appJsonValueSchema.parse(JSON.parse(text));
			}
			return request.url.endsWith("/send")
				? Response.json({ message })
				: new Response("");
		},
	});
	try {
		const target = { url: server.url.origin, token: "node-token" };
		const input = mailJsonRecordSchema.parse(
			JSON.parse('{"__proto__":{"future":true}}')
		);
		expect(
			await mailRequest(target, {
				path: "/api/mail/future",
				method: "POST",
				body: {
					...input,
					omitted: undefined,
					slots: [undefined, Number.POSITIVE_INFINITY],
					future: { enabled: true },
				},
			})
		).toBeUndefined();
		const body = bodies[`${server.url.origin}/api/mail/future`];
		expect(body).toEqual(
			JSON.parse(
				'{"__proto__":{"future":true},"slots":[null,null],"future":{"enabled":true}}'
			)
		);
		expect(
			await sendMessage(
				target,
				"i",
				{ to: ["b@test"], subject: "Subject" },
				"send-key"
			)
		).toEqual(message);
		expect(requests[1]?.headers.get("idempotency-key")).toBe("send-key");
		expect(bodies[`${server.url.origin}/api/mail/inboxes/i/send`]).toEqual({
			to: ["b@test"],
			subject: "Subject",
		});
	} finally {
		server.stop(true);
	}
});
it("mailRequest forwards only the normalized path and refuses escapes from /api/mail", async () => {
	const paths: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			paths.push(new URL(request.url).pathname);
			return Response.json({ ok: true });
		},
	});
	try {
		const target = { url: server.url.origin, token: "node-token" };
		for (const path of [
			"/api/mail/status/.\t./.\t./node/reset",
			"/api/mail/status/.\n./.\r./agents",
			"/api/mail/status/%2e%2e/%2e%2e/agents",
			"/api/mail/../node/reset",
			"/api/mailbox",
			"//evil.test/api/mail/status",
		]) {
			await expect(
				mailRequest(target, { path, method: "POST" })
			).rejects.toThrow("Refusing to forward");
		}
		expect(paths).toEqual([]);
		expect(
			await mailRequest(target, { path: "/api/mail/status/.\t./inboxes" })
		).toEqual({ ok: true });
		expect(paths).toEqual(["/api/mail/inboxes"]);
	} finally {
		server.stop(true);
	}
});
