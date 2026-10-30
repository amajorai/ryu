/** Built-in slash-command specs and their pure handlers (see `commands.ts`). */

import type {
	CommandAction,
	CommandHandler,
	CommandHandlerContext,
	CommandHandlerResult,
	CommandOverlay,
	CommandSpec,
	LocalCommandAction,
	OverlayCommandAction,
} from "./commands-types.ts";

const action = (value: CommandAction): CommandHandlerResult => ({
	action: value,
	kind: "action",
});

const usage = (context: CommandHandlerContext): CommandHandlerResult => ({
	kind: "usage",
	message: `Usage: ${context.spec.usage}`,
});

const requireNoArguments = (
	context: CommandHandlerContext,
	value: LocalCommandAction | OverlayCommandAction
): CommandHandlerResult =>
	context.args.length === 0 ? action(value) : usage(context);

const requireArgument = (
	context: CommandHandlerContext,
	value: (argument: string) => CommandAction
): CommandHandlerResult =>
	context.argument.length > 0
		? action(value(context.argument))
		: usage(context);

const requireOneArgument = (
	context: CommandHandlerContext,
	value: (argument: string) => CommandAction
): CommandHandlerResult =>
	context.args.length === 1 && context.argument.length > 0
		? action(value(context.argument))
		: usage(context);

const optionalOneArgument = (
	context: CommandHandlerContext,
	value: (argument: string | null) => CommandAction
): CommandHandlerResult =>
	context.args.length <= 1
		? action(value(context.argument.length > 0 ? context.argument : null))
		: usage(context);

const local = (value: LocalCommandAction): CommandHandlerResult =>
	action(value);

const overlay = (
	context: CommandHandlerContext,
	name: CommandOverlay
): CommandHandlerResult =>
	action({
		argument: context.argument,
		args: context.args,
		kind: "overlay",
		overlay: name,
	});

const noArgumentOverlay =
	(name: CommandOverlay): CommandHandler =>
	(context) =>
		requireNoArguments(context, {
			argument: "",
			args: [],
			kind: "overlay",
			overlay: name,
		});

const requiredPassThrough = (
	context: CommandHandlerContext
): CommandHandlerResult =>
	context.argument.length > 0
		? action({
				args: context.args,
				kind: "passthrough",
				text: context.raw,
			})
		: usage(context);

const queueCommand: CommandHandler = (context) => {
	const [subcommand, itemId, extra] = context.args;
	if (!subcommand || subcommand === "list" || subcommand === "show") {
		return context.args.length <= 1
			? overlay(context, "queue")
			: usage(context);
	}
	if (subcommand === "clear") {
		return context.args.length === 1
			? local({ action: "clear-queue", kind: "local" })
			: usage(context);
	}
	if (subcommand === "drop" || subcommand === "remove") {
		return itemId && !extra
			? local({ action: "remove-queue-item", itemId, kind: "local" })
			: usage(context);
	}
	if (subcommand === "up" || subcommand === "down") {
		return itemId && !extra
			? local({
					action: "move-queue-item",
					direction: subcommand === "up" ? "up" : "down",
					itemId,
					kind: "local",
				})
			: usage(context);
	}
	return usage(context);
};

/**
 * The one source of built-in terminal command metadata and pure handlers.
 * Keep canonical command order stable: autocomplete lists commands in this
 * order for an empty query and uses it to break ties within a rank tier.
 */
export const COMMAND_SPECS = [
	{
		name: "agent",
		aliases: [],
		description: "choose an agent",
		usage: "/agent",
		takesArguments: false,
		completion: "command",
		mode: "overlay",
		handler: noArgumentOverlay("agent-picker"),
	},
	{
		name: "btw",
		aliases: ["b"],
		description: "ask a side question",
		usage: "/btw <question>",
		takesArguments: true,
		completion: "command",
		mode: "overlay",
		handler: (context) =>
			requireArgument(context, () => ({
				argument: context.argument,
				args: context.args,
				kind: "overlay",
				overlay: "btw",
			})),
	},
	{
		name: "check",
		aliases: ["double-check"],
		description: "toggle double-check",
		usage: "/check",
		takesArguments: false,
		completion: "command",
		mode: "local",
		handler: (context) =>
			requireNoArguments(context, {
				action: "toggle-double-check",
				kind: "local",
			}),
	},
	{
		name: "config",
		aliases: ["acp"],
		description: "choose ACP settings",
		usage: "/config",
		takesArguments: false,
		completion: "command",
		mode: "overlay",
		handler: noArgumentOverlay("acp-settings"),
	},
	{
		name: "fork",
		aliases: [],
		description: "fork this conversation",
		usage: "/fork [message-id]",
		takesArguments: true,
		completion: "command",
		mode: "local",
		handler: (context) =>
			optionalOneArgument(context, (messageId) => ({
				action: "fork-conversation",
				kind: "local",
				messageId,
			})),
	},
	{
		name: "model",
		aliases: [],
		description: "choose or set a model",
		usage: "/model [id|clear]",
		takesArguments: true,
		completion: "command",
		mode: "overlay",
		handler: (context) => {
			if (context.args.length === 0) {
				return overlay(context, "model-picker");
			}
			if (context.argument.toLowerCase() === "clear") {
				return context.args.length === 1
					? local({ action: "set-model", kind: "local", model: null })
					: usage(context);
			}
			return local({
				action: "set-model",
				kind: "local",
				model: context.argument,
			});
		},
	},
	{
		name: "new",
		aliases: ["newchat"],
		description: "start a new chat",
		usage: "/new",
		takesArguments: false,
		completion: "command",
		mode: "local",
		handler: (context) =>
			requireNoArguments(context, { action: "new-chat", kind: "local" }),
	},
	{
		name: "reasoning",
		aliases: [],
		description: "choose ACP settings",
		usage: "/reasoning",
		takesArguments: false,
		completion: "command",
		mode: "overlay",
		handler: noArgumentOverlay("acp-settings"),
	},
	{
		name: "resume",
		aliases: [],
		description: "resume a conversation",
		usage: "/resume <conversation-id>",
		takesArguments: true,
		completion: "command",
		mode: "local",
		handler: (context) =>
			requireOneArgument(context, (conversationId) => ({
				action: "resume-conversation",
				conversationId,
				kind: "local",
			})),
	},
	{
		name: "rename",
		aliases: [],
		description: "rename this conversation",
		usage: "/rename <title>",
		takesArguments: true,
		completion: "command",
		mode: "local",
		handler: (context) =>
			requireArgument(context, (title) => ({
				action: "rename-conversation",
				kind: "local",
				title,
			})),
	},
	{
		name: "delete",
		aliases: [],
		description: "delete a conversation",
		usage: "/delete [conversation-id]",
		takesArguments: true,
		completion: "command",
		mode: "overlay",
		handler: (context) =>
			optionalOneArgument(context, (conversationId) => ({
				argument: conversationId ?? "",
				args: conversationId ? [conversationId] : [],
				kind: "overlay",
				overlay: "conversation-delete",
			})),
	},
	{
		name: "sessions",
		aliases: ["session"],
		description: "list turn sessions",
		usage: "/sessions",
		takesArguments: false,
		completion: "command",
		mode: "overlay",
		handler: noArgumentOverlay("session-list"),
	},
	{
		name: "group",
		aliases: ["team"],
		description: "route turns to a group",
		usage: "/group [group-id|clear]",
		takesArguments: true,
		completion: "command",
		mode: "local",
		handler: (context) =>
			optionalOneArgument(context, (team) => ({
				action: "set-team",
				kind: "local",
				team: !team || team.toLowerCase() === "clear" ? null : team,
			})),
	},
	{
		name: "goal",
		aliases: [],
		description: "send a goal turn",
		usage: "/goal <text>",
		takesArguments: true,
		completion: "command",
		mode: "passthrough",
		handler: requiredPassThrough,
	},
	{
		name: "proof",
		aliases: [],
		description: "send a proof turn",
		usage: "/proof <text>",
		takesArguments: true,
		completion: "command",
		mode: "passthrough",
		handler: requiredPassThrough,
	},
	{
		name: "receipt",
		aliases: [],
		description: "send a receipt turn",
		usage: "/receipt <text>",
		takesArguments: true,
		completion: "command",
		mode: "passthrough",
		handler: requiredPassThrough,
	},
	{
		name: "pin",
		aliases: [],
		description: "pin or unpin this conversation",
		usage: "/pin [off]",
		takesArguments: true,
		completion: "command",
		mode: "local",
		handler: (context) =>
			optionalOneArgument(context, (value) => ({
				action: "pin-conversation",
				kind: "local",
				pinned:
					value?.toLowerCase() !== "off" && value?.toLowerCase() !== "false",
			})),
	},
	{
		name: "unpin",
		aliases: [],
		description: "unpin this conversation",
		usage: "/unpin",
		takesArguments: false,
		completion: "command",
		mode: "local",
		handler: (context) =>
			requireNoArguments(context, {
				action: "pin-conversation",
				kind: "local",
				pinned: false,
			}),
	},
	{
		name: "help",
		aliases: ["commands"],
		description: "show slash command help",
		usage: "/help [command]",
		takesArguments: true,
		completion: "command",
		mode: "overlay",
		handler: (context) =>
			optionalOneArgument(context, () => ({
				argument: context.argument,
				args: context.args,
				kind: "overlay",
				overlay: "help",
			})),
	},
	{
		name: "queue",
		aliases: ["q"],
		description: "inspect or change queued prompts",
		usage: "/queue [list|clear|drop <id>|up <id>|down <id>]",
		takesArguments: true,
		completion: "command",
		mode: "overlay",
		handler: queueCommand,
	},
	{
		name: "theme",
		aliases: [],
		description: "choose the terminal theme",
		usage: "/theme [mode|preset]",
		takesArguments: true,
		completion: "command",
		mode: "overlay",
		handler: (context) => overlay(context, "theme"),
	},
] as const satisfies readonly CommandSpec[];

/** Alias kept explicit so consumers can name the source as a registry. */
export const COMMAND_REGISTRY = COMMAND_SPECS;
