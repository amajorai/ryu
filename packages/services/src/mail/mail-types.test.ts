// Type-level assertions for `ryu.mail`'s resource namespaces and their
// object-mode projections. `expectTypeOf` is checked by `tsc --noEmit`
// (check-types); at runtime it is a no-op.

import { describe, expect, expectTypeOf, test } from "bun:test";
import type {
	MailAPI,
	MailDraft,
	MailInbox,
	MailMessage,
	MailWebhookWithSecret,
} from "@ryuhq/client";
import type { Paginated } from "../pagination.ts";
import type { RyuResult } from "../result.ts";
import { Ryu } from "../ryu.ts";
import { MAIL_CANONICAL_METHODS, type MailFlatAliases } from "./namespace.ts";

/** The flat alias every canonical row implies (`send` is aliased as `sendFromInbox`). */
type ExpectedFlatAliases =
	| Exclude<
			(typeof MAIL_CANONICAL_METHODS)[keyof typeof MAIL_CANONICAL_METHODS],
			"send"
	  >
	| "sendFromInbox";

describe("ryu.mail resource namespaces", () => {
	const throwing = new Ryu({ env: {} });
	const objects = new Ryu({ env: {}, result: "object" });

	test("canonical methods keep the MailAPI signatures in throw mode", () => {
		expectTypeOf(throwing.mail.inboxes.list).returns.toEqualTypeOf<
			Promise<MailInbox[]>
		>();
		expectTypeOf(throwing.mail.messages.get).parameters.toEqualTypeOf<
			Parameters<MailAPI["getMessage"]>
		>();
		expectTypeOf(throwing.mail.messages.send).parameters.toEqualTypeOf<
			Parameters<MailAPI["send"]>
		>();
		expectTypeOf(throwing.mail.drafts.send).returns.toEqualTypeOf<
			Promise<MailMessage>
		>();
		expectTypeOf(
			throwing.mail.webhooks.headers.update
		).parameters.toEqualTypeOf<Parameters<MailAPI["updateWebhookHeaders"]>>();
		expectTypeOf(throwing.mail.messages.iterate).returns.toEqualTypeOf<
			Paginated<MailMessage, MailMessage[]>
		>();
		expect(throwing.resultMode).toBe("throw");
	});

	test("MailFlatAliases declares exactly one deprecated alias per canonical row", () => {
		expectTypeOf<keyof MailFlatAliases>().toEqualTypeOf<ExpectedFlatAliases>();
		expect(Object.keys(MAIL_CANONICAL_METHODS).length).toBeGreaterThan(0);
	});

	test("deprecated flat aliases have the same types as their canonical form", () => {
		expectTypeOf(throwing.mail.listInboxes).toEqualTypeOf(
			throwing.mail.inboxes.list
		);
		expectTypeOf(throwing.mail.sendFromInbox).toEqualTypeOf(
			throwing.mail.messages.send
		);
		expectTypeOf(objects.mail.getDraft).toEqualTypeOf(objects.mail.drafts.get);
		expectTypeOf(objects.mail.listWebhookDeliveries).toEqualTypeOf(
			objects.mail.webhooks.deliveries.list
		);
		expectTypeOf(throwing.mail.downloadRaw).toEqualTypeOf(
			throwing.mail.messages.downloadRaw
		);
		expectTypeOf(throwing.mail.listEntries).toEqualTypeOf(
			throwing.mail.lists.entries
		);
	});

	test("object mode and ryu.safe project every sub-namespace", () => {
		expectTypeOf(objects.mail.inboxes.list).returns.toEqualTypeOf<
			Promise<RyuResult<MailInbox[]>>
		>();
		expectTypeOf(objects.mail.drafts.create).returns.toEqualTypeOf<
			Promise<RyuResult<MailDraft>>
		>();
		expectTypeOf(objects.mail.webhooks.rotateSecret).returns.toEqualTypeOf<
			Promise<RyuResult<MailWebhookWithSecret>>
		>();
		expectTypeOf(
			throwing.safe.mail.webhooks.headers.list
		).returns.toEqualTypeOf<Promise<RyuResult<string[]>>>();
		expectTypeOf(throwing.safe.mail.messages.reply).parameters.toEqualTypeOf<
			Parameters<MailAPI["reply"]>
		>();
		expectTypeOf(objects.mail.messages.iterate).returns.toEqualTypeOf<
			Paginated<MailMessage, MailMessage[]>
		>();
		expectTypeOf(objects.mail.send).returns.toEqualTypeOf<
			Promise<RyuResult<MailMessage>>
		>();
		expectTypeOf(objects.mail.with({}).domains.verify).returns.toEqualTypeOf<
			ReturnType<typeof objects.mail.domains.verify>
		>();
		expect(objects.resultMode).toBe("object");
	});
});
