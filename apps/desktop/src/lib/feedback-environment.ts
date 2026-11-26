// What the app attaches to an idea or a bug report drafted in chat.
//
// The agent writes only the title and the text of a report. Everything here is
// read on the user's device by the app, shown line by line on the card, and
// removable before anything is sent. Never attached: the console buffer,
// conversation text, tool inputs or outputs, file contents.
//
// Error text can carry paths, tokens and email addresses, so it goes through
// the troubleshooter's redaction before it is shown at all.

import type {
	FeedbackAttachment,
	FeedbackKind,
} from "@ryu/blocks/desktop/agent-elements/tools/feedback-tool.ts";
import { redactDiagnosticText } from "@ryuhq/core-client/troubleshoot-redaction.ts";

/** How many of the conversation's most recent errors a bug report carries. */
export const MAX_RECENT_ERRORS = 5;

/** Longest error line attached, after redaction. */
export const MAX_ERROR_CHARS = 300;

/** Longest environment value attached (a version, a model id). */
const MAX_VALUE_CHARS = 120;

/** Redaction reads at most this much of one error; the rest is never shown. */
const MAX_ERROR_SCAN_CHARS = 4000;

/** What the host knows about the app, the node and this conversation. */
export interface FeedbackEnvironment {
	/** The agent this conversation runs with. */
	agentId: string | null;
	appVersion: string | null;
	coreVersion: string | null;
	gatewayVersion: string | null;
	locale: string | null;
	/** The model this conversation runs with. */
	model: string | null;
	/** Operating system and architecture, e.g. `windows-x86_64`. */
	system: string | null;
}

// A Windows home path whose backslashes arrived escaped (JSON, a Rust debug
// print). The shared rules cover the plain spellings.
const ESCAPED_WINDOWS_HOME = /\b[A-Za-z]:\\\\Users\\\\[^\\\s"'`]+/g;

const WHITESPACE_RUN = /\s+/g;

function cut(value: string, max: number): string {
	const scalars = [...value];
	return scalars.length <= max
		? value
		: `${scalars.slice(0, max - 1).join("")}…`;
}

/**
 * One line of diagnostic text, safe to show and send: credentials, email
 * addresses, home folders and public IP addresses removed, whitespace
 * collapsed, cut to `max` characters. Redaction runs before the cut, so a
 * secret is never left half visible at the cut.
 */
export function redactFeedbackLine(text: string, max: number): string {
	const scanned = text.slice(0, MAX_ERROR_SCAN_CHARS);
	const redacted = redactDiagnosticText(
		scanned.replace(ESCAPED_WINDOWS_HOME, "~")
	);
	return cut(redacted.replace(WHITESPACE_RUN, " ").trim(), max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function textOf(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** The tool a failed part belongs to, for a short prefix on its error line. */
function toolNameOf(part: Record<string, unknown>): string | null {
	if (part.type === "dynamic-tool") {
		return textOf(part.toolName);
	}
	const type = textOf(part.type);
	return type?.startsWith("tool-") ? type.slice(5) : null;
}

/** The error a part carries, if it is a failed tool call or an error part. */
function errorOfPart(part: unknown): string | null {
	if (!isRecord(part)) {
		return null;
	}
	if (part.type === "error") {
		return textOf(part.message) ?? textOf(part.errorText);
	}
	const error = textOf(part.errorText);
	if (!error) {
		return null;
	}
	const tool = toolNameOf(part);
	return tool ? `${tool}: ${error}` : error;
}

/**
 * The most recent error texts of a conversation, oldest first, at most
 * `limit`. Only the error text of failed parts is read: never a tool's input
 * or output, and never what the user or the agent wrote.
 */
export function recentErrorTexts(
	messages: readonly unknown[],
	limit = MAX_RECENT_ERRORS
): string[] {
	const errors: string[] = [];
	for (const message of messages) {
		const parts = isRecord(message) ? message.parts : null;
		if (!Array.isArray(parts)) {
			continue;
		}
		for (const part of parts) {
			const error = errorOfPart(part);
			if (error) {
				errors.push(error);
			}
		}
	}
	return limit > 0 ? errors.slice(-limit) : [];
}

/** Redacted, cut error lines as attachments. Duplicates are sent once. */
export function errorAttachments(
	errors: readonly string[]
): FeedbackAttachment[] {
	const seen = new Set<string>();
	const attachments: FeedbackAttachment[] = [];
	for (const error of errors) {
		const value = redactFeedbackLine(error, MAX_ERROR_CHARS);
		if (value.length === 0 || seen.has(value)) {
			continue;
		}
		seen.add(value);
		attachments.push({
			group: "error",
			id: `error-${attachments.length + 1}`,
			label: `Recent error ${attachments.length + 1}`,
			value,
		});
	}
	return attachments;
}

/** The app these reports come from. */
const SURFACE = "Desktop";

// The environment keys a report carries, in order, with each line's name in
// the report. Report wording stays English: the Ryu team reads it.
const ENVIRONMENT_KEY_NAMES = [
	["surface", "Surface"],
	["appVersion", "App version"],
	["coreVersion", "Core version"],
	["gatewayVersion", "Gateway version"],
	["system", "System"],
	["locale", "Language"],
	["agentId", "Agent"],
	["model", "Model"],
] as const satisfies readonly (readonly [
	keyof FeedbackEnvironment | "surface",
	string,
])[];

/** Versions, system, language, agent and model. Unknown values are left out. */
export function environmentAttachments(
	environment: FeedbackEnvironment
): FeedbackAttachment[] {
	const values = { ...environment, surface: SURFACE };
	const attachments: FeedbackAttachment[] = [];
	for (const [key, label] of ENVIRONMENT_KEY_NAMES) {
		const raw = values[key]?.trim();
		if (!raw) {
			continue;
		}
		const value = redactFeedbackLine(raw, MAX_VALUE_CHARS);
		if (value.length > 0) {
			attachments.push({ group: "environment", id: key, label, value });
		}
	}
	return attachments;
}

/**
 * Everything the app would attach to a report of this kind. Recent errors go
 * on bug reports only; an idea carries the environment alone.
 */
export function feedbackAttachments(
	kind: FeedbackKind,
	environment: FeedbackEnvironment,
	messages: readonly unknown[]
): FeedbackAttachment[] {
	const lines = environmentAttachments(environment);
	return kind === "bug"
		? [...lines, ...errorAttachments(recentErrorTexts(messages))]
		: lines;
}
