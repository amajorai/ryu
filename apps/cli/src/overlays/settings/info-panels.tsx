/* @jsxImportSource @opentui/react */
// Settings panels with no editable body: read-only Core data lists (Features,
// Meetings, Tasks, Storage, Danger Zone) and labeled handoffs for desktop-only
// and account-only surfaces.

import { Badge } from "@/components/ui/badge.tsx";
import { Card } from "@/components/ui/card.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { CLI_TRANSLATOR, type CliTranslator } from "../../i18n/translate.ts";
import { type ListLoader, ListTab } from "../../ui/ListTab.tsx";
import {
	loadDataCounts,
	loadFeatures,
	loadMeetings,
	loadQuests,
	loadStorage,
} from "./loaders.ts";

type Tone = "default" | "desktop" | "account" | "danger";

interface DataPanelMeta {
	description: string;
	emptyLabel: string;
	load: ListLoader;
	note: string;
	tone?: Tone;
}

// Read-only views over Core endpoints. `note` says where the writes live.
export const DATA_PANELS = new Map<string, DataPanelMeta>(
	Object.entries({
		features: {
			description: "Apps and features installed on this node.",
			emptyLabel: "No apps installed",
			load: loadFeatures,
			note: "Enable or disable apps from the Store or the desktop app.",
		},
		meetings: {
			description: "Captured meetings and their status.",
			emptyLabel: "No meetings",
			load: loadMeetings,
			note: "Open the Meetings surface for notes and transcripts.",
		},
		quests: {
			description: "Background tasks, captures, and their status.",
			emptyLabel: "No tasks",
			load: loadQuests,
			note: "Manage tasks from the Tasks surface or the desktop app.",
		},
		storage: {
			description: "The data folder this node uses and its disk usage.",
			emptyLabel: "No storage info",
			load: loadStorage,
			note: "Relocate or import the data folder from the desktop app.",
		},
		danger: {
			description: "Deletable data on this node, by category.",
			emptyLabel: "No deletable data",
			load: loadDataCounts,
			note: "Deletion is only available from the desktop app's Danger Zone.",
			tone: "danger",
		},
	} satisfies Record<string, DataPanelMeta>)
);

export interface PanelMeta {
	description: string;
	note?: string;
	tone?: Tone;
}

// Pointers for the surfaces the terminal client does not drive directly: native
// desktop features, and control-plane account surfaces that Core does not serve.
export const PANEL_META = new Map<string, PanelMeta>(
	Object.entries({
		appearance: {
			description:
				"Terminal appearance follows the active theme preference. Use /theme in Chat to choose system, light, dark, Ryu, or Ryu Mono.",
		},
		shadow: {
			description: "Shadow screen capture runs as a native agent.",
			tone: "desktop",
			note: "Open the desktop app to configure Shadow.",
		},
		voice: {
			description:
				"Voice Recognition, audio devices, and Audio engines are native audio features.",
			tone: "desktop",
			note: "Open the desktop app to configure Voice.",
		},
		predict: {
			description: "Autocomplete suggestions are a native input feature.",
			tone: "desktop",
			note: "Open the desktop app to configure Autocomplete.",
		},
		"authorized-apps": {
			description:
				"Applications authorized against your account. These live on your Ryu account backend, not on this node.",
			tone: "account",
			note: "Review and revoke authorized apps from the desktop app.",
		},
		billing: {
			description:
				"Subscription and plan billing is handled by your Ryu account. See Account for your current plan.",
			tone: "account",
		},
		teams: {
			description:
				"Team membership and team billing. Managed from your Ryu account.",
			tone: "account",
		},
		credits: {
			description:
				"Prepaid credits and auto top-up. Managed from your Ryu account.",
			tone: "account",
		},
		updates: {
			description: "Manage automatic updates for the terminal client.",
		},
	} satisfies Record<string, PanelMeta>)
);

/** A panel without its own copy: "<label> settings.", translated whole. */
export function fallbackPanelMeta(
	label: string,
	translator: Pick<CliTranslator, "tf" | "tr"> = CLI_TRANSLATOR
): PanelMeta {
	return {
		description: translator.tf("{label} settings.", {
			label: translator.tr(label),
		}),
	};
}

export function DataPanel({
	height,
	meta,
	title,
}: {
	height: number;
	meta: DataPanelMeta;
	title: string;
}) {
	const theme = useTheme();
	return (
		<box flexDirection="column" flexGrow={1}>
			<box flexDirection="column" paddingLeft={1}>
				<text fg={theme.colors.foreground}>
					<b>{title}</b>
				</text>
				<ToneBadge tone={meta.tone} />
				<text fg={theme.colors.mutedForeground}>{meta.description}</text>
				<text fg={theme.colors.mutedForeground}>{meta.note}</text>
			</box>
			<ListTab
				active
				emptyLabel={meta.emptyLabel}
				height={height}
				load={meta.load}
			/>
		</box>
	);
}

export function PlaceholderPanel({
	meta,
	title,
}: {
	meta: PanelMeta;
	title: string;
}) {
	const theme = useTheme();
	const borderColor =
		meta.tone === "danger" ? theme.colors.error : theme.colors.border;
	return (
		<Card borderColor={borderColor} title={title}>
			<ToneBadge tone={meta.tone} />
			<text fg={theme.colors.mutedForeground}>{meta.description}</text>
			{meta.note ? (
				<box marginTop={1}>
					<text fg={theme.colors.mutedForeground}>{meta.note}</text>
				</box>
			) : null}
		</Card>
	);
}

function ToneBadge({ tone }: { tone?: Tone }) {
	if (tone === "desktop") {
		return (
			<box marginBottom={1}>
				<Badge bordered={false} variant="secondary">
					Desktop only
				</Badge>
			</box>
		);
	}
	if (tone === "account") {
		return (
			<box marginBottom={1}>
				<Badge bordered={false} variant="secondary">
					Account only
				</Badge>
			</box>
		);
	}
	if (tone === "danger") {
		return (
			<box marginBottom={1}>
				<Badge bordered={false} variant="error">
					Danger zone
				</Badge>
			</box>
		);
	}
	return null;
}
