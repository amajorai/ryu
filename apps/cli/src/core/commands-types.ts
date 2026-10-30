/** Type contracts for the terminal slash-command registry in `commands.ts`. */

export type CommandExecutionMode = "local" | "overlay" | "passthrough";

/** Commands offered by the built-in terminal composer. */
export type CommandName =
	| "agent"
	| "btw"
	| "check"
	| "config"
	| "fork"
	| "model"
	| "new"
	| "reasoning"
	| "resume"
	| "rename"
	| "delete"
	| "sessions"
	| "group"
	| "goal"
	| "proof"
	| "receipt"
	| "pin"
	| "unpin"
	| "help"
	| "queue"
	| "theme";

/** The completion surface a command is eligible for. */
export type CommandCompletionKind = "command" | "none";

export type CommandOverlay =
	| "agent-picker"
	| "acp-settings"
	| "btw"
	| "conversation-delete"
	| "help"
	| "model-picker"
	| "queue"
	| "session-list"
	| "theme";

export type LocalCommandAction =
	| { readonly action: "new-chat"; readonly kind: "local" }
	| { readonly action: "toggle-double-check"; readonly kind: "local" }
	| {
			readonly action: "set-model";
			readonly kind: "local";
			readonly model: string | null;
	  }
	| {
			readonly action: "set-team";
			readonly kind: "local";
			readonly team: string | null;
	  }
	| {
			readonly action: "fork-conversation";
			readonly kind: "local";
			readonly messageId: string | null;
	  }
	| {
			readonly action: "resume-conversation";
			readonly conversationId: string;
			readonly kind: "local";
	  }
	| {
			readonly action: "rename-conversation";
			readonly kind: "local";
			readonly title: string;
	  }
	| {
			readonly action: "pin-conversation";
			readonly kind: "local";
			readonly pinned: boolean;
	  }
	| { readonly action: "clear-queue"; readonly kind: "local" }
	| {
			readonly action: "remove-queue-item";
			readonly itemId: string;
			readonly kind: "local";
	  }
	| {
			readonly action: "move-queue-item";
			readonly direction: "up" | "down";
			readonly itemId: string;
			readonly kind: "local";
	  };

export interface OverlayCommandAction {
	readonly args: readonly string[];
	readonly argument: string;
	readonly kind: "overlay";
	readonly overlay: CommandOverlay;
}

export interface PassthroughCommandAction {
	readonly args: readonly string[];
	readonly kind: "passthrough";
	readonly text: string;
}

export type CommandAction =
	| LocalCommandAction
	| OverlayCommandAction
	| PassthroughCommandAction;

export interface CommandHandlerContext {
	readonly args: readonly string[];
	readonly argument: string;
	/** The token the user typed, without the leading slash. */
	readonly invokedAs: string;
	/** The trimmed slash command, retained for Core pass-through. */
	readonly raw: string;
	/** The canonical spec selected after alias resolution. */
	readonly spec: CommandSpec;
}

export type CommandHandlerResult =
	| { readonly action: CommandAction; readonly kind: "action" }
	| { readonly kind: "usage"; readonly message: string };

export type CommandHandler = (
	context: CommandHandlerContext
) => CommandHandlerResult;

export interface CommandSpec {
	/** Alternate spellings accepted by {@link resolveCommand}. */
	readonly aliases: readonly string[];
	readonly completion: CommandCompletionKind;
	readonly description: string;
	/** Pure conversion from parsed input to a data-only intent. */
	readonly handler: CommandHandler;
	/** Default surface intent; a handler may open a picker for optional input. */
	readonly mode: CommandExecutionMode;
	/** Stable name used in help, completion rows, and dispatch results. */
	readonly name: CommandName;
	/** True when {@link usage} accepts an argument; bare no-argument commands run on Enter. */
	readonly takesArguments: boolean;
	readonly usage: string;
}

export interface ParsedCommand {
	readonly args: readonly string[];
	readonly argument: string;
	/** Canonical command name when the token is known. */
	readonly canonicalName: CommandName | undefined;
	/** Name or alias as entered, normalized to lower case. */
	readonly invokedAs: string;
	/** Trimmed source text, including the leading slash. */
	readonly raw: string;
	/** The resolved spec, or undefined for an unknown command. */
	readonly spec: CommandSpec | undefined;
}

export type CommandDispatch =
	| {
			readonly action: CommandAction;
			readonly args: readonly string[];
			readonly canonicalName: CommandName;
			readonly invokedAs: string;
			readonly kind: "handled";
			readonly mode: CommandExecutionMode;
			readonly spec: CommandSpec;
	  }
	| {
			readonly args: readonly string[];
			readonly canonicalName: CommandName;
			readonly invokedAs: string;
			readonly kind: "usage";
			readonly message: string;
			readonly spec: CommandSpec;
			readonly usage: string;
	  }
	| {
			readonly invokedAs: string;
			readonly kind: "unknown";
			readonly message: string;
			readonly raw: string;
	  };
