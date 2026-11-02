// Localized state, kind and progress labels for the TUI Downloads list.

import type {
	DownloadKind,
	DownloadState,
	DownloadTask,
} from "@ryuhq/core-client/downloads";
import { formatCliBytes, formatCliNumber } from "../../i18n/format.ts";
import { CLI_FORMAT_LOCALE, tf, tr } from "../../i18n/translate.ts";

/** The translator and number locale the labels render with (the CLI's by default). */
export interface DownloadLabelI18n {
	formatLocale: string;
	tf(source: string, values: Readonly<Record<string, string | number>>): string;
	tr(value: string): string;
}

const CLI_I18N: DownloadLabelI18n = { formatLocale: CLI_FORMAT_LOCALE, tf, tr };

/** The label for a download's lifecycle state; unknown states show as-is. */
export function downloadStateLabel(
	state: DownloadState,
	i18n: DownloadLabelI18n = CLI_I18N
): string {
	switch (state) {
		case "queued":
			return i18n.tr("queued");
		case "active":
			return i18n.tr("active");
		case "paused":
			return i18n.tr("paused");
		case "verifying":
			return i18n.tr("verifying");
		case "completed":
			return i18n.tr("completed");
		case "failed":
			return i18n.tr("failed");
		case "cancelled":
			return i18n.tr("cancelled");
		default:
			return state;
	}
}

/** The label for what a download fetches; unknown kinds show as-is. */
export function downloadKindLabel(
	kind: DownloadKind,
	i18n: DownloadLabelI18n = CLI_I18N
): string {
	switch (kind) {
		case "model":
			return i18n.tr("model");
		case "engine":
			return i18n.tr("engine");
		case "agent":
			return i18n.tr("agent");
		case "tool":
			return i18n.tr("tool");
		case "skill":
			return i18n.tr("skill");
		case "embedding":
			return i18n.tr("embedding");
		case "voice":
			return i18n.tr("voice");
		case "media":
			return i18n.tr("media");
		case "mcp":
			return i18n.tr("MCP");
		case "other":
			return i18n.tr("other");
		default:
			return kind;
	}
}

/**
 * The row badge: the state plus percent complete when the total is known,
 * otherwise the received size (as the desktop download center degrades on an
 * unknown total), otherwise the bare state.
 */
export function progressBadge(
	task: Pick<DownloadTask, "received_bytes" | "state" | "total_bytes">,
	i18n: DownloadLabelI18n = CLI_I18N
): string {
	const state = downloadStateLabel(task.state, i18n);
	let progress: string | null = null;
	if (task.total_bytes !== null && task.total_bytes > 0) {
		const ratio =
			Math.floor((task.received_bytes / task.total_bytes) * 100) / 100;
		progress = formatCliNumber(ratio, { style: "percent" }, i18n.formatLocale);
	} else if (task.received_bytes > 0) {
		progress = formatCliBytes(
			task.received_bytes,
			{ fractionDigits: 1, minUnit: "megabyte" },
			i18n.formatLocale
		);
	}
	return progress === null
		? state
		: i18n.tf("{state} {progress}", { progress, state });
}
