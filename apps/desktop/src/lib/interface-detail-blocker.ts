// Why a thread's newest turn stopped, from its saved parts (spec §3.2, phase
// 1b): a saved error card, the last failed tool or shell command, or a turn
// the node died in. Titles are written in the UI's language, so templates
// that embed them ("Likely {title}") read whole.

import { readToolTiming } from "@ryu/blocks/desktop/agent-elements/tools/tool-timing.tsx";
import { translate as tl } from "@ryu/i18n/core";
import type {
	InterfaceBlocker,
	InterfaceBlockerKind,
} from "@ryuhq/protocol/interfaces";
import { toolNameOf } from "@/src/lib/mission-control/turn-groups.ts";
import {
	clamp,
	DETAIL_MAX,
	iso,
	isTool,
	lastWhere,
	partsOf,
	stringIn,
	TITLE_MAX,
	toolDisplayName,
} from "./interface-detail-parts.ts";
import type { DetailMessage } from "./interface-detail-types.ts";

const AUTH_CODES = new Set([
	"auth_required",
	"native_account_required",
	"pi_account_required",
]);
const BILLING_CODES = new Set([
	"insufficient_credits",
	"provider_payment_required",
	"provider_usage_unavailable",
]);

/** Saved error code → blocker kind (spec §3.2). No code maps to rate-limited. */
export function errorCodeKind(code: string | null): InterfaceBlockerKind {
	if (code && AUTH_CODES.has(code)) {
		return "auth";
	}
	if (code && BILLING_CODES.has(code)) {
		return "billing";
	}
	return code === "execution_paused" ? "interrupted" : "error";
}

const SHELL_TOOLS = new Set(["bash", "bashoutput", "execute", "shell.run"]);

export function deriveBlocker(
	turn: readonly DetailMessage[]
): InterfaceBlocker | null {
	const assistant = turn.filter((m) => m.role === "assistant");
	// 1. A saved error card.
	for (let i = assistant.length - 1; i >= 0; i -= 1) {
		const message = assistant[i];
		const error = lastWhere(partsOf(message), (part) => part.type === "error");
		if (message && error) {
			const code = typeof error.code === "string" ? error.code : null;
			const kind = errorCodeKind(code);
			const message_ = typeof error.message === "string" ? error.message : null;
			const title =
				typeof error.title === "string" && error.title.trim()
					? error.title
					: (message_ ?? tl("Run failed"));
			return {
				at: iso(message.timestamp),
				atApprox: true,
				detail: message_ ? clamp(message_, DETAIL_MAX) : null,
				kind,
				source: "messages",
				title: clamp(title, TITLE_MAX),
			};
		}
	}
	// 2 / 3. The last failed tool; a failed shell command names its command.
	for (let i = assistant.length - 1; i >= 0; i -= 1) {
		const message = assistant[i];
		const failed = lastWhere(
			partsOf(message),
			(part) => isTool(part) && part.state === "output-error"
		);
		if (message && failed) {
			const tool = toolNameOf(failed);
			const timing = readToolTiming(failed);
			const at = timing?.completedAt;
			const errorText =
				typeof failed.errorText === "string" ? failed.errorText : null;
			const command = stringIn(failed.input, "command");
			const shell = SHELL_TOOLS.has(tool.toLowerCase()) && command;
			return {
				at: iso(at ?? message.timestamp),
				atApprox: at === undefined,
				detail: errorText ? clamp(errorText, DETAIL_MAX) : null,
				kind: shell ? "command-failed" : "tool-failed",
				source: "messages",
				title: clamp(
					shell
						? tl("{command} failed", {
								command: command.split(/\s+/).slice(0, 2).join(" "),
							})
						: tl("{tool} failed", { tool: toolDisplayName(tool) }),
					TITLE_MAX
				),
			};
		}
	}
	// 4. A turn the node died in the middle of.
	const cut = lastWhere(assistant, (message) => message.interrupted === true);
	if (cut) {
		return {
			at: iso(cut.timestamp),
			atApprox: true,
			kind: "interrupted",
			source: "messages",
			title: tl("Interrupted"),
		};
	}
	return null;
}
