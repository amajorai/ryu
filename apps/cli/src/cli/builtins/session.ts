// Interactive-adjacent commands: acp, chat, node, version and mail.

import { resolveCoreBinary } from "../../core/bootstrap.ts";
import { DEFAULT_CORE_URL } from "../../core/defaultCoreUrl.ts";
import { loadNodes, resolveActive, setActive } from "../../core/nodes.ts";
import { tf, tr } from "../../i18n/translate.ts";
import { localize } from "../localizedText.ts";
import { formatTable } from "../output.ts";
import { type CliContext, type Command, UsageError } from "../types.ts";
import { VERSION } from "../version.ts";
import { packageArg } from "./package.ts";
import {
	type CommandJsonValue,
	callCore,
	commandJsonSchema,
	REDACTED_NODE_TOKEN,
} from "./shared.ts";

/** `ryu-cli acp [--agent <id>]` — serve Ryu agents to an Agent Client Protocol
 *  editor (Zed) over stdio. The protocol lives in the Rust `ryu-core acp`
 *  subcommand; this only launches it with inherited stdio, so the editor talks
 *  JSON-RPC straight to it. Nothing may be written to stdout from here: stdout
 *  belongs to the protocol. Core must already be running (no auto-start). */
export const acpCommand: Command = {
	name: "acp",
	summary: "Serve Ryu agents to an ACP editor (e.g. Zed) over stdio",
	// Spelled with the installed binary name: this exact command line is what
	// users paste into an editor's agent-server settings (see editors.mdx).
	usage: "ryu-cli acp [--agent <id>] [--node <name|url>]",
	run: async (ctx) => {
		const coreBinary = resolveCoreBinary();
		if (!coreBinary) {
			throw new Error(
				"ryu-core is not installed. Install Ryu, then run 'ryu-cli' once to set it up."
			);
		}
		const cmd = [coreBinary, "acp"];
		if (ctx.flags.agent) {
			cmd.push("--agent", ctx.flags.agent);
		}
		// For the local node, ryu-core resolves it itself (profile port, relocated
		// data dir, minted token), which is more exact than this side. Otherwise
		// ctx.target is the resolved node: --node, else RYU_CORE_URL (which
		// ryu-core reads itself), else a remote active node.
		const targetsResolvedNode =
			Boolean(ctx.flags.node) ||
			(!ctx.env.RYU_CORE_URL?.trim() &&
				ctx.target.url.replace(/\/+$/, "") !==
					DEFAULT_CORE_URL.replace(/\/+$/, ""));
		if (targetsResolvedNode) {
			cmd.push("--core-url", ctx.target.url);
		}
		// The resolved node's token travels by env, never argv. A node without
		// one must not inherit a RYU_CORE_TOKEN issued for another node.
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(ctx.env)) {
			if (
				value !== undefined &&
				!(targetsResolvedNode && key === "RYU_CORE_TOKEN")
			) {
				env[key] = value;
			}
		}
		if (targetsResolvedNode && ctx.target.token) {
			env.RYU_CORE_TOKEN = ctx.target.token;
		}
		return await ctx.spawn(cmd, env);
	},
};

/** `ryu chat "<msg>"` — one-shot chat: stream the assistant reply, then exit. */
export const chatCommand: Command = {
	name: "chat",
	summary: "Send one message and print the reply",
	usage: 'ryu-cli chat "<message>" [--json]',
	run: async (ctx) => {
		const message = ctx.args.join(" ").trim();
		if (!message) {
			throw new UsageError('Missing message. Usage: ryu-cli chat "<message>"');
		}
		let collected = "";
		let streamError: string | null = null;
		// Set when Core starts a continuation turn in this response; its first
		// text opens a new paragraph instead of running into the last turn.
		let continuationPending = false;
		await ctx.api.streamChat(
			ctx.target,
			[{ role: "user", content: message }],
			{},
			{
				onTextDelta: (delta) => {
					if (delta.length === 0) {
						return;
					}
					let text = delta;
					if (continuationPending) {
						continuationPending = false;
						if (collected.length > 0 && !collected.endsWith("\n\n")) {
							text = `${collected.endsWith("\n") ? "\n" : "\n\n"}${delta}`;
						}
					}
					collected += text;
					if (!ctx.flags.json) {
						ctx.io.out(text);
					}
				},
				onTurnBoundary: () => {
					continuationPending = true;
				},
				onError: (m) => {
					streamError = m;
				},
				onDone: () => {
					/* resolved by streamChat returning */
				},
			}
		);
		if (streamError) {
			throw new Error(streamError);
		}
		if (ctx.flags.json) {
			ctx.io.out(`${JSON.stringify({ text: collected })}\n`);
		} else {
			ctx.io.out("\n");
		}
		return 0;
	},
};

/** `ryu node ls` / `ryu node use <name|url>` — the local multi-node store. */
export const nodeCommand: Command = {
	name: "node",
	summary: "List or switch the active Core node",
	usage: "ryu-cli node <ls | use <name|url>> [--json]",
	run: async (ctx) => {
		const sub = ctx.args[0] ?? "ls";
		if (sub === "ls" || sub === "list") {
			const config = loadNodes();
			const active = resolveActive(config).name;
			if (ctx.flags.json) {
				// Never print a node's bearer: report only whether one is saved.
				const nodes = config.nodes.map(({ sealedToken, ...node }) => ({
					...node,
					token: node.token || sealedToken ? REDACTED_NODE_TOKEN : null,
				}));
				ctx.io.out(`${JSON.stringify({ active, nodes }, null, 2)}\n`);
				return 0;
			}
			const rows = config.nodes.map((n) => [
				n.name === active ? "*" : "",
				n.name,
				n.url,
			]);
			ctx.io.out(`${formatTable(["", "NAME", "URL"], rows)}\n`);
			return 0;
		}
		if (sub === "use") {
			const ref = ctx.args[1];
			if (!ref) {
				throw new UsageError("Usage: ryu-cli node use <name|url>");
			}
			const config = loadNodes();
			const match = config.nodes.find((n) => n.name === ref || n.url === ref);
			if (match) {
				setActive(match.name);
				ctx.io.out(
					`${tf("Active node set to {name} ({url}).", { name: match.name, url: match.url })}\n`
				);
				return 0;
			}
			// The node store keys on NAME, not arbitrary URLs — be honest about the
			// per-invocation escape hatch rather than silently inventing a node.
			const names = config.nodes.map((n) => n.name).join(", ");
			ctx.io.err(
				`${tf("No configured node named or matching '{ref}'. Configured: {names}.", { names, ref })}\n${tr("To target an unsaved node for one command, use --node <url> or set RYU_CORE_URL.")}\n`
			);
			return 1;
		}
		throw new UsageError("Usage: ryu-cli node <ls | use <name|url>>");
	},
};

/** `ryu version` / `ryu --version`. */
export const versionCommand: Command = {
	name: "version",
	summary: "Print the ryu-cli version",
	usage: "ryu-cli version",
	run: async (ctx) => {
		if (ctx.flags.json) {
			ctx.io.out(`${JSON.stringify({ version: VERSION })}\n`);
		} else {
			ctx.io.out(`ryu-cli ${VERSION}\n`);
		}
		return 0;
	},
};

function mailJsonArg(
	ctx: CliContext,
	index: number,
	usage: string
): CommandJsonValue {
	const raw = packageArg(ctx, index, usage);
	try {
		return commandJsonSchema.parse(JSON.parse(raw));
	} catch {
		throw new UsageError(
			localize("Expected valid JSON for {usage}", { usage })
		);
	}
}

/** Agent Mail's scriptable resource client. Bodies are JSON so the same command
 * works for local sidecars and the hosted gateway-key plane. */
export const mailCommand: Command = {
	name: "mail",
	summary: "Manage agent inboxes, messages, threads, drafts, and webhooks",
	usage:
		"ryu-cli mail <status|inboxes|messages|threads|drafts|webhooks|events|send> …",
	run: async (ctx) => {
		const action = ctx.args[0] ?? "inboxes";
		const id = ctx.args[1];
		const usage =
			"ryu-cli mail <status|inboxes|messages|threads|drafts|webhooks|events|send> …";
		let path: string;
		let method = "GET";
		let body: CommandJsonValue;
		if (action === "status") {
			path = "/api/mail/status";
		} else if (action === "inboxes") {
			path = "/api/mail/inboxes";
		} else if (["messages", "threads", "drafts"].includes(action)) {
			if (!id) {
				throw new UsageError(
					localize("Usage: {usage}", { usage: `${usage} ${action} <inbox-id>` })
				);
			}
			path = `/api/mail/inboxes/${encodeURIComponent(id)}/${action}`;
		} else if (action === "webhooks") {
			path = "/api/mail/webhooks";
		} else if (action === "events") {
			path = id
				? `/api/mail/inboxes/${encodeURIComponent(id)}/events`
				: "/api/mail/events";
		} else if (action === "send") {
			if (!id) {
				throw new UsageError(
					localize("Usage: {usage}", {
						usage: `${usage} send <inbox-id> <json-body>`,
					})
				);
			}
			path = `/api/mail/inboxes/${encodeURIComponent(id)}/send`;
			method = "POST";
			body = mailJsonArg(ctx, 2, `${usage} send <inbox-id> <json-body>`);
		} else if (
			[
				"create-inbox",
				"create-webhook",
				"create-pod",
				"create-domain",
			].includes(action)
		) {
			const route = {
				"create-inbox": "/api/mail/inboxes",
				"create-webhook": "/api/mail/webhooks",
				"create-pod": "/api/mail/pods",
				"create-domain": "/api/mail/domains",
			}[action];
			if (!route) {
				throw new UsageError(localize("Usage: {usage}", { usage }));
			}
			path = route;
			method = "POST";
			body = mailJsonArg(ctx, 1, `${usage} ${action} <json-body>`);
		} else {
			throw new UsageError(localize("Usage: {usage}", { usage }));
		}
		const result = await callCore(ctx, path, { method, body });
		ctx.io.out(`${JSON.stringify(result, null, 2)}\n`);
		return 0;
	},
};
