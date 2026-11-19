/* @jsxImportSource @opentui/react */
// Services tab row model: the fixed sidecar order, category mapping, POST
// helper, status-bar hints and per-row status cell, split from services.tsx.

import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { type ApiTarget, request } from "@ryuhq/core-client/client";
import { Spinner } from "@/components/ui/spinner.tsx";
import { HINT, type KeyHint } from "../core/keymap.ts";
import { tr } from "../i18n/translate.ts";

// The fixed sidecar order, verbatim from apps/cli/src/app.rs SIDECAR_ORDER.
export const SIDECAR_ORDER = [
	"temporal",
	"spider",
	"screenpipe",
	"llmfit",
	"qmd",
	"shadow",
	"ghost",
	"llamacpp",
	"ollama",
	"vllm",
	"zeroclaw",
	"openclaw",
	"nanoclaw",
	"picoclaw",
	"nemoclaw",
	"ironclaw",
] as const;

export type Category = "provider" | "tool" | "agent";

// Name -> category, matching the inline switch in ui.rs render_services_content
// (note: shadow/ghost render as "agent" there even though app.rs tags them Tool;
// we follow the UI's name-based mapping for visual parity).
export const PROVIDERS = new Set(["llamacpp", "ollama", "vllm"]);
export const TOOLS = new Set([
	"temporal",
	"spider",
	"screenpipe",
	"llmfit",
	"qmd",
]);

export function categoryOf(name: string): Category {
	if (PROVIDERS.has(name)) {
		return "provider";
	}
	if (TOOLS.has(name)) {
		return "tool";
	}
	return "agent";
}

export const POLL_MS = 2500;
export const NAME_WIDTH = 12;
export const CATEGORY_WIDTH = 8;
export const LIST_HEIGHT = 16;

export async function postAction(
	target: ApiTarget,
	path: string
): Promise<boolean> {
	try {
		await request(target, path, { method: "POST" }, appResponseValueSchema);
		return true;
	} catch {
		return false;
	}
}

export interface RowStatus {
	color: string;
	downloading: boolean;
	icon: string;
	text: string;
}

// Published to the shell's status bar (Services renders inside the Settings
// overlay, which owns the keyboard while open). Lower priority survives narrow bars.
export const SERVICES_HINTS: KeyHint[] = [
	{ ...HINT.move, priority: 0 },
	{ keys: "d", label: tr("install"), priority: 1 },
	{ keys: "s", label: tr("start"), priority: 1 },
	{ keys: "x", label: tr("stop"), priority: 1 },
	{ keys: "r", label: tr("restart"), priority: 2 },
	{ keys: "A", label: tr("all start"), priority: 3 },
	{ keys: "Z", label: tr("all stop"), priority: 3 },
	{ keys: "D", label: tr("uninstall"), priority: 2 },
];

export function StatusCell({ status }: { status: RowStatus }) {
	if (status.downloading) {
		return <Spinner color={status.color} label={status.text} type="dots" />;
	}
	return (
		<box flexDirection="row" gap={1}>
			<text fg={status.color}>{status.icon}</text>
			<text fg={status.color}>{status.text}</text>
		</box>
	);
}

// A bulk or destructive action held until the user answers the ConfirmPrompt.
export interface PendingConfirm {
	confirmLabel: string;
	consequence: string;
	run: () => void;
	title: string;
}

export interface ThemeLike {
	colors: {
		error: string;
		mutedForeground: string;
		primary: string;
		success: string;
		warning: string;
	};
}

export interface RowFlags {
	downloading: boolean;
	installed: boolean;
	installFailed: boolean;
	running: boolean;
}

// Status icon/text/color, matching the precedence in ui.rs render_services_content.
export function rowStatus(theme: ThemeLike, flags: RowFlags): RowStatus {
	if (flags.installFailed) {
		return {
			icon: "✗",
			text: tr("install failed"),
			color: theme.colors.error,
			downloading: false,
		};
	}
	if (flags.downloading) {
		return {
			icon: "",
			text: tr("downloading"),
			color: theme.colors.primary,
			downloading: true,
		};
	}
	if (!flags.installed) {
		return {
			icon: " ",
			text: "—",
			color: theme.colors.mutedForeground,
			downloading: false,
		};
	}
	if (flags.running) {
		return {
			icon: "●",
			text: tr("running"),
			color: theme.colors.success,
			downloading: false,
		};
	}
	return {
		icon: "○",
		text: tr("stopped"),
		color: theme.colors.warning,
		downloading: false,
	};
}
