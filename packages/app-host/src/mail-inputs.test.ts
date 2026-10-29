import { describe, expect, test } from "bun:test";
import {
	mailCreateInputSchema,
	mailRequestInputSchema,
	mailSendInputSchema,
} from "./mail-inputs.ts";

describe("companion Mail request owners", () => {
	test("create forwards the original valid inbox and additive server fields", () => {
		const input = {
			name: "Inbox",
			address: "a@example.test",
			provider: "resend",
			metadata: { future: [true, null] },
			extra: { retained: true },
		};
		expect(mailCreateInputSchema.parse(input)).toBe(input);
		expect(
			mailCreateInputSchema.safeParse({ ...input, clientId: 3 }).success
		).toBe(false);
	});
	test("send retains every valid envelope field and attachment/header identity", () => {
		const attachment = {
			filename: "a.txt",
			content_type: "text/plain",
			content: "a",
			future: { retained: true },
		};
		const headers = JSON.parse(
			'{"X-Trace":"fixture","__proto__":"valid-header"}'
		);
		const input = {
			inboxId: "in1",
			to: ["a@example.test"],
			subject: "",
			text: "body",
			idempotencyKey: " delivery-1 ",
			attachments: [attachment],
			bcc: ["b@example.test"],
			cc: ["c@example.test"],
			replyTo: ["r@example.test"],
			labels: ["sent"],
			clientId: "client",
			headers,
			html: "<p>body</p>",
			inReplyTo: "previous",
			references: ["first", "second"],
			trackOpens: false,
		};
		const parsed = mailSendInputSchema.parse(input);
		expect(parsed).toEqual(input);
		expect(parsed.to).toBe(input.to);
		expect(parsed.attachments).toBe(input.attachments);
		expect(parsed.headers).toBe(headers);
		expect(parsed.references).toBe(input.references);
		expect(Object.hasOwn(parsed.headers ?? {}, "__proto__")).toBe(true);
	});
	test("malformed supplied recipient arrays reject the whole send rather than dropping recipients", () => {
		const input = { inboxId: "in1", to: ["a@example.test"], subject: "s" };
		for (const key of ["to", "bcc", "cc", "replyTo"]) {
			expect(
				mailSendInputSchema.safeParse({
					...input,
					[key]: ["b@example.test", 3],
				}).success
			).toBe(false);
		}
		expect(
			mailSendInputSchema.safeParse({ ...input, headers: { "X-Trace": 3 } })
				.success
		).toBe(false);
		expect(
			mailSendInputSchema.safeParse({
				...input,
				headers: JSON.parse('{"__proto__":3}'),
			}).success
		).toBe(false);
		expect(
			mailSendInputSchema.safeParse({
				...input,
				attachments: [{ filename: "a.txt" }],
			}).success
		).toBe(false);
		expect(
			mailSendInputSchema.safeParse({ ...input, idempotencyKey: "\t" }).success
		).toBe(false);
	});
	test("optional nonarray fields keep their existing omission policy", () => {
		const input = { inboxId: "in1", to: ["a@example.test"], subject: "" };
		expect(
			mailSendInputSchema.parse({
				...input,
				attachments: null,
				bcc: "not-an-array",
				cc: 3,
				labels: true,
				references: null,
				headers: null,
				html: false,
			})
		).toEqual(input);
	});
	test("relative mail routes preserve JSON bodies and reject mount escapes", () => {
		const body = JSON.parse('{"__proto__":{"future":"retained"},"x":1}');
		const parsed = mailRequestInputSchema.parse({
			path: "/api/mail/messages",
			method: null,
			body,
		});
		expect(parsed).toEqual({ path: "/api/mail/messages", method: "GET", body });
		expect(parsed.body).toBe(body);
		expect(mailRequestInputSchema.parse({ path: "/api/mail/inboxes" })).toEqual(
			{ path: "/api/mail/inboxes", method: "GET" }
		);
		for (const path of [
			"https://evil.test",
			"/api/mail/status/../secrets",
			"/api/mail/messages/%2Fsecrets",
			"/api/mail/messages\\secrets",
			"/api/mail/inbound",
			"/api/mail/status/.\t./.\t./node/reset",
			"/api/mail/status/.\n./inbound",
			"/api/mail/status/.\r./secrets",
		]) {
			expect(mailRequestInputSchema.safeParse({ path }).success).toBe(false);
		}
	});
});
