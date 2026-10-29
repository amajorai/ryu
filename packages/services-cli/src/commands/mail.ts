// packages/services-cli/src/commands/mail.ts
//
// `ryu-services mail …`: Ryu Mail commands (design §10). Hosted Mail reads
// RYU_MAIL_GATEWAY_KEY (a node gateway key) or, without one, the control-plane
// `ryu_` key in RYU_API_KEY (scopes mail:read / mail:send / mail:manage, sent
// as x-api-key, with RYU_ORGANIZATION_ID for personal keys); self-hosted Mail
// reads RYU_MAIL_URL and RYU_MAIL_API_KEY. `send` goes
// through `ryu.mail.send`, so `--from` takes an inbox address or id and the
// global `--idempotency-key` makes a retried send safe. Commands call the
// canonical resource spelling (`ryu.mail.inboxes.list`, `messages.get`).
// `inboxes create` is the first step on a fresh self-hosted server, which
// starts with no inbox to send from.

import {
	createEnvReader,
	mailPageSize,
	resolveServiceConfig,
} from "@ryuhq/services";
import {
	CliUsageError,
	numberFlag,
	requireStringFlag,
	stringFlag,
	stringsFlag,
} from "../args.ts";
import { listPage } from "../list-output.ts";
import type { CommandContext, ServiceCommand } from "../registry.ts";
import { settled } from "../settled.ts";

/** The one positional `name` a command needs, or a usage error. */
function requirePositional(ctx: CommandContext, name: string): string {
	const value = ctx.args[0];
	if (value === undefined || value === "") {
		throw new CliUsageError(`<${name}> is required.`);
	}
	if (ctx.args.length > 1) {
		throw new CliUsageError(
			`Unexpected argument ${JSON.stringify(ctx.args[1])}.`
		);
	}
	return value;
}

function rejectPositionals(ctx: CommandContext): void {
	if (ctx.args.length > 0) {
		throw new CliUsageError(
			`Unexpected argument ${JSON.stringify(ctx.args[0])}.`
		);
	}
}

/** `--limit` as a page size the servers accept (1-200). */
function limitFlag(ctx: CommandContext): number | undefined {
	const limit = numberFlag(ctx.flags, "limit");
	if (limit === undefined) {
		return undefined;
	}
	if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
		throw new CliUsageError("--limit must be an integer from 1 to 200.");
	}
	return limit;
}

/**
 * `mail send`. Returns the facade promise itself for a `--text` body so
 * `--json` carries the response meta; an `--html-file` body is read first and
 * the send is returned through `settled()` to keep its meta.
 */
function sendCommand(ctx: CommandContext): unknown {
	rejectPositionals(ctx);
	const from = requireStringFlag(ctx.flags, "from");
	const to = stringsFlag(ctx.flags, "to");
	if (to.length === 0) {
		throw new CliUsageError(
			"--to is required (repeat it for more recipients)."
		);
	}
	const subject = requireStringFlag(ctx.flags, "subject");
	const text = stringFlag(ctx.flags, "text");
	const htmlFile = stringFlag(ctx.flags, "html-file");
	if ((text === undefined) === (htmlFile === undefined)) {
		throw new CliUsageError("Pass exactly one of --text or --html-file.");
	}
	const cc = stringsFlag(ctx.flags, "cc");
	const bcc = stringsFlag(ctx.flags, "bcc");
	const base = {
		from,
		to: [...to],
		subject,
		...(cc.length > 0 ? { cc: [...cc] } : {}),
		...(bcc.length > 0 ? { bcc: [...bcc] } : {}),
	};
	if (htmlFile === undefined) {
		return ctx.ryu.mail.send({ ...base, text });
	}
	return ctx.io
		.readFile(htmlFile)
		.then((html) => settled(ctx.ryu.mail.send({ ...base, html })));
}

/**
 * `mail send --dry-run --from <address>` prints only the inbox lookup
 * (`GET .../inboxes`): the send needs the inbox id that lookup returns.
 */
export function sendDryRunNote(ctx: CommandContext): string | null {
	const from = stringFlag(ctx.flags, "from");
	if (from === undefined || !from.includes("@")) {
		return null;
	}
	return "dry run: printed step 1 of 2, the inbox lookup for the --from address; the send was left out. Pass the inbox id as --from (see mail inboxes list) to print the send request.";
}

/**
 * Whether Mail is reached hosted or self-hosted with the options the command's
 * client was built from; null when that is unknown (no options, or a
 * configuration error, which the call itself then reports).
 */
function mailMode(ctx: CommandContext): "hosted" | "self-hosted" | null {
	if (ctx.options === undefined) {
		return null;
	}
	try {
		return resolveServiceConfig(
			"mail",
			ctx.options,
			createEnvReader(ctx.options.env)
		).mailMode;
	} catch {
		return null;
	}
}

/**
 * `mail inboxes create`: one inbox, so `send --from` has something to name.
 * Self-hosted Mail needs `--address` and has no `--local-part`. Hosted Mail
 * derives the address from `--local-part`, else from `--name`, on the default
 * domain (or `domainId`) and ignores an address, so `--address` is not sent
 * there and a note on stderr says so.
 */
function createInboxCommand(ctx: CommandContext): unknown {
	rejectPositionals(ctx);
	const name = requireStringFlag(ctx.flags, "name");
	const webhookUrl = stringFlag(ctx.flags, "webhook-url");
	const address = stringFlag(ctx.flags, "address");
	const localPart = stringFlag(ctx.flags, "local-part");
	const mode = mailMode(ctx);
	if (mode === "self-hosted") {
		if (localPart !== undefined) {
			throw new CliUsageError(
				"--local-part is a hosted Mail option; self-hosted Mail takes the full --address."
			);
		}
		if (address === undefined || address === "") {
			// Not "--address is required": the flag is required only here.
			throw new CliUsageError(
				"Self-hosted Mail needs --address, the inbox's full email address."
			);
		}
	}
	if (localPart === "") {
		throw new CliUsageError("--local-part needs a value.");
	}
	const sendAddress = mode !== "hosted" && address !== undefined;
	if (mode === "hosted" && address !== undefined) {
		ctx.io.stderr.write(
			`note: hosted Mail ignores --address; the address comes from ${localPart === undefined ? "--name" : "--local-part"} on the default domain.\n`
		);
	}
	return ctx.ryu.mail.inboxes.create({
		name,
		...(sendAddress ? { address } : {}),
		...(localPart === undefined ? {} : { localPart }),
		...(webhookUrl === undefined ? {} : { webhookUrl }),
	});
}

/**
 * The next-page note for `messages list`. Mail lists have no cursor: a full
 * page may have more below it, which `--before <last createdAt>` reads.
 */
export function nextMailPage(
	messages: readonly { createdAt?: unknown }[],
	limit: number | undefined
): string | null {
	// The SDK's page size, so this note agrees with what `--all` pages by.
	const pageSize = mailPageSize(limit);
	const last = messages.at(-1)?.createdAt;
	if (messages.length < pageSize || typeof last !== "string" || last === "") {
		return null;
	}
	return `More messages may follow: pass --before ${last} for the next page, or --all for every message.`;
}

/** Every `ryu-services mail` command. */
export const mailCommands: readonly ServiceCommand[] = [
	{
		path: ["status"],
		summary: "Show whether Mail is configured (public on hosted Mail).",
		readOnly: true,
		run: (ctx) => {
			rejectPositionals(ctx);
			return ctx.ryu.mail.status();
		},
	},
	{
		path: ["inboxes", "list"],
		summary: "List the inboxes this key can see, one JSON line each.",
		readOnly: true,
		run: (ctx) => {
			rejectPositionals(ctx);
			return listPage(ctx, ctx.ryu.mail.inboxes.list(), {
				noun: "inboxes",
				items: (inboxes) => inboxes,
			});
		},
	},
	{
		path: ["inboxes", "create"],
		summary:
			"Create an inbox to send from and receive into (hosted keys need mail:manage).",
		example:
			"ryu-services mail inboxes create --name Agent --address agent@acme.example",
		flags: {
			name: {
				type: "string",
				valueName: "text",
				description: "The inbox's display name.",
				required: true,
			},
			address: {
				type: "string",
				valueName: "address",
				description:
					"Self-hosted Mail (required): the inbox's email address, on a domain the server receives for. Hosted Mail ignores it.",
			},
			"local-part": {
				type: "string",
				valueName: "text",
				description:
					"Hosted Mail only: the part before @ on the default domain. Without it the address comes from --name.",
			},
			"webhook-url": {
				type: "string",
				valueName: "url",
				description:
					"POST message.received here; the signing secret is printed once as webhookSecret.",
			},
		},
		run: createInboxCommand,
	},
	{
		path: ["messages", "list"],
		usage: "<inbox>",
		summary:
			"List an inbox's messages, newest first (one page: one JSON line per message, the next page's --before on stderr). --all pages through every message.",
		readOnly: true,
		flags: {
			limit: {
				type: "number",
				valueName: "n",
				description: "Messages per page, 1-200 (server default 50).",
			},
			before: {
				type: "string",
				valueName: "iso",
				description: "Only messages created before this ISO timestamp.",
			},
			all: {
				type: "boolean",
				description:
					"Page through every message (one JSON line each), deduplicated by id.",
			},
		},
		run: (ctx) => {
			const inbox = requirePositional(ctx, "inbox");
			const limit = limitFlag(ctx);
			const before = stringFlag(ctx.flags, "before");
			const query = {
				...(limit === undefined ? {} : { limit }),
				...(before === undefined ? {} : { before }),
			};
			if (ctx.flags.all === true) {
				return ctx.ryu.mail.messages.iterate(inbox, query);
			}
			return listPage(ctx, ctx.ryu.mail.messages.list(inbox, query), {
				noun: "messages",
				items: (messages) => messages,
				next: (messages) => nextMailPage(messages, limit),
			});
		},
	},
	{
		path: ["messages", "get"],
		usage: "<message>",
		summary: "Show one message.",
		readOnly: true,
		run: (ctx) => ctx.ryu.mail.messages.get(requirePositional(ctx, "message")),
	},
	{
		path: ["send"],
		summary:
			"Send a message from an inbox (--from takes its address or id). Use --idempotency-key to make a retry safe.",
		effect:
			"Sends real email to every --to, --cc and --bcc address. Try it with --dry-run first.",
		example:
			'ryu-services mail send --from agent@acme.example --to you@example.com --subject "Hello" --text "First send" --idempotency-key first-send',
		flags: {
			from: {
				type: "string",
				valueName: "inbox|address",
				description:
					"The sending inbox: its address or its id (see mail inboxes list).",
				required: true,
			},
			to: {
				type: "strings",
				valueName: "address",
				description: "A recipient; repeat for more.",
				required: true,
			},
			cc: {
				type: "strings",
				valueName: "address",
				description: "A Cc recipient; repeat for more.",
			},
			bcc: {
				type: "strings",
				valueName: "address",
				description: "A Bcc recipient; repeat for more.",
			},
			subject: {
				type: "string",
				valueName: "text",
				description: "The subject line.",
				required: true,
			},
			text: {
				type: "string",
				valueName: "text",
				description: "A plain-text body (give this or --html-file).",
			},
			"html-file": {
				type: "string",
				valueName: "path",
				description: "Read the HTML body from this file (or give --text).",
			},
		},
		dryRunNote: sendDryRunNote,
		run: sendCommand,
	},
];
