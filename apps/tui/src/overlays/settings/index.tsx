/* @jsxImportSource @opentui/react */
// Settings overlay body - the desktop Settings dialog analog. Renders an inset
// left-nav (grouped exactly like apps/desktop's SettingsDialog NAV_GROUPS) beside
// a panel area. The OverlayHost supplies the centered modal chrome (title bar +
// Esc-to-close) and claims raw input; this body owns only its inner nav.
//
// Content reuse (no fetch logic rewritten): the Account-group panels render the
// data-backed AccountTab (src/tabs/account.tsx) and the Services-group panels
// render the data-backed ServicesTab (src/tabs/services.tsx). Desktop-only native
// surfaces (Island, Shadow, Voice, Predictive typing, Updates) and control-plane
// surfaces (Billing, Teams, Credits, ...) are light, clearly labeled placeholders.
//
// Keyboard: up/down (or j/k) move the nav selection. Nav keys never collide with
// the reused panels - AccountTab only listens for r/l, and ServicesTab suppresses
// its own keys while the overlay claims input - so the selected panel stays live
// (data loads/polls) while the nav remains navigable. Esc (host) closes.

import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge.tsx";
import { Card } from "@/components/ui/card.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../../core/CoreContext.tsx";
import { AccountTab } from "../../tabs/account.tsx";
import { ServicesTab } from "../../tabs/services.tsx";
import type { OverlayModule } from "../registry.ts";

const NAV_WIDTH = 24;

interface NavItem {
	id: string;
	label: string;
}

interface NavGroup {
	items: NavItem[];
	title?: string;
}

// Grouped verbatim from apps/desktop/src/components/settings/SettingsDialog.tsx
// NAV_GROUPS (labels and order preserved).
const NAV_GROUPS: NavGroup[] = [
	{
		items: [
			{ id: "general", label: "General" },
			{ id: "features", label: "Features" },
			{ id: "appearance", label: "Appearance" },
			{ id: "island", label: "Island" },
			{ id: "shadow", label: "Shadow" },
			{ id: "voice", label: "Voice" },
			{ id: "memory", label: "Memory" },
			{ id: "meetings", label: "Meetings" },
			{ id: "quests", label: "Tasks" },
			{ id: "predict", label: "Predictive typing" },
		],
	},
	{
		title: "Account",
		items: [
			{ id: "profile", label: "Profile" },
			{ id: "account", label: "Account" },
			{ id: "sessions", label: "Sessions" },
			{ id: "authorized-apps", label: "Authorized Apps" },
		],
	},
	{
		title: "Services",
		items: [
			{ id: "connections", label: "Connections" },
			{ id: "integrations", label: "Integrations" },
			{ id: "billing", label: "Billing" },
			{ id: "teams", label: "Teams" },
			{ id: "credits", label: "Credits" },
		],
	},
	{
		title: "System",
		items: [
			{ id: "privacy", label: "Privacy" },
			{ id: "storage", label: "Storage" },
			{ id: "updates", label: "Updates" },
			{ id: "danger", label: "Danger Zone" },
		],
	},
];

const FLAT_ITEMS = NAV_GROUPS.flatMap((group) => group.items);
const LAST_INDEX = FLAT_ITEMS.length - 1;
const INDEX_BY_ID = new Map(FLAT_ITEMS.map((item, i) => [item.id, i]));

// Ids whose panel is the data-backed reused AccountTab / ServicesTab content.
const ACCOUNT_IDS = new Set(["profile", "account", "sessions"]);
const SERVICE_IDS = new Set(["connections", "integrations"]);

type Tone = "default" | "desktop" | "danger";

interface PanelMeta {
	description: string;
	note?: string;
	tone?: Tone;
}

// Light placeholders for the surfaces the terminal client does not drive
// directly (native macOS features, or control-plane/account-backend surfaces).
const PANEL_META: Record<string, PanelMeta> = {
	features: {
		description:
			"Toggle experimental Ryu features. Feature flags are provisioned per node by Core and the desktop app.",
	},
	appearance: {
		description:
			"The terminal client renders with the built-in ryu theme. Appearance is customized from the desktop app.",
	},
	island: {
		description: "The floating Island HUD is a native macOS surface.",
		tone: "desktop",
		note: "Open the desktop app to configure the Island.",
	},
	shadow: {
		description: "Shadow screen capture runs as a native agent.",
		tone: "desktop",
		note: "Open the desktop app to configure Shadow.",
	},
	voice: {
		description:
			"Voice input, audio devices, and TTS engines are native audio features.",
		tone: "desktop",
		note: "Open the desktop app to configure Voice.",
	},
	memory: {
		description:
			"Long-term memory captured across your conversations. Managed by Core.",
	},
	meetings: {
		description:
			"Meeting capture and notes. Managed by Core and the desktop app.",
	},
	quests: {
		description:
			"Background tasks and quests. Track running work from the Tasks surface.",
	},
	predict: {
		description: "Predictive typing suggestions are a native input feature.",
		tone: "desktop",
		note: "Open the desktop app to configure Predictive typing.",
	},
	"authorized-apps": {
		description:
			"Applications authorized against your account. Manage these from the account backend.",
	},
	billing: {
		description:
			"Subscription and plan billing is handled by your Ryu account. See Account for your current plan.",
	},
	teams: {
		description:
			"Team membership and team billing. Managed from your Ryu account.",
	},
	credits: {
		description:
			"Prepaid credits and auto top-up. Managed from your Ryu account.",
	},
	privacy: {
		description:
			"Privacy controls and data disclosure. Managed by Core and your account.",
	},
	storage: {
		description: "Local storage and cache used by this node. Managed by Core.",
	},
	updates: {
		description: "Application updates are delivered to the desktop app.",
		tone: "desktop",
		note: "The terminal client updates with its package.",
	},
	danger: {
		description: "Destructive account and data actions. Proceed with caution.",
		tone: "danger",
	},
};

function SettingsBody() {
	const [selIndex, setSelIndex] = useState(0);
	const { height } = useTerminalDimensions();
	const theme = useTheme();
	const bodyHeight = Math.max(14, Math.min(30, height - 10));
	const selected = FLAT_ITEMS[selIndex] ?? FLAT_ITEMS[0];

	useKeyboard((key) => {
		if (key.name === "up" || key.name === "k") {
			setSelIndex((i) => Math.max(0, i - 1));
			return;
		}
		if (key.name === "down" || key.name === "j") {
			setSelIndex((i) => Math.min(LAST_INDEX, i + 1));
		}
	});

	return (
		<box flexDirection="column">
			<box flexDirection="row" gap={2} height={bodyHeight}>
				<box flexDirection="column" width={NAV_WIDTH}>
					<scrollbox flexGrow={1}>
						<NavColumn selIndex={selIndex} />
					</scrollbox>
				</box>
				<box flexDirection="column" flexGrow={1}>
					<Panel id={selected.id} label={selected.label} />
				</box>
			</box>
			<box marginTop={1}>
				<text fg={theme.colors.mutedForeground}>
					↑↓ / j k navigate · Esc close
				</text>
			</box>
		</box>
	);
}

function NavColumn({ selIndex }: { selIndex: number }) {
	const theme = useTheme();
	return (
		<box flexDirection="column">
			{NAV_GROUPS.map((group) => (
				<box
					flexDirection="column"
					key={group.title ?? "main"}
					marginBottom={1}
				>
					{group.title ? (
						<text fg={theme.colors.mutedForeground}>
							<b>{group.title.toUpperCase()}</b>
						</text>
					) : null}
					{group.items.map((item) => (
						<NavRow
							key={item.id}
							label={item.label}
							selected={(INDEX_BY_ID.get(item.id) ?? -1) === selIndex}
						/>
					))}
				</box>
			))}
		</box>
	);
}

function NavRow({ label, selected }: { label: string; selected: boolean }) {
	const theme = useTheme();
	return (
		<box flexDirection="row" gap={1}>
			<text fg={selected ? theme.colors.primary : theme.colors.muted}>
				{selected ? "›" : " "}
			</text>
			<text fg={selected ? theme.colors.primary : theme.colors.foreground}>
				{selected ? <b>{label}</b> : label}
			</text>
		</box>
	);
}

function Panel({ id, label }: { id: string; label: string }) {
	if (ACCOUNT_IDS.has(id)) {
		return <AccountTab active />;
	}
	if (SERVICE_IDS.has(id)) {
		return <ServicesTab active />;
	}
	if (id === "general") {
		return <GeneralPanel />;
	}
	const meta = PANEL_META[id] ?? { description: `${label} settings.` };
	return <PlaceholderPanel meta={meta} title={label} />;
}

function GeneralPanel() {
	const { url, token } = useCore();
	const theme = useTheme();
	return (
		<Card subtitle="Ryu Core node" title="General">
			<InfoLine label="Node" value={url} valueColor={theme.colors.foreground} />
			<InfoLine
				label="Auth"
				value={token ? "token set" : "no token"}
				valueColor={token ? theme.colors.success : theme.colors.warning}
			/>
			<box marginTop={1}>
				<text fg={theme.colors.mutedForeground}>
					Node connection is managed from the Gateway overlay and the node
					picker.
				</text>
			</box>
		</Card>
	);
}

function InfoLine({
	label,
	value,
	valueColor,
}: {
	label: string;
	value: string;
	valueColor: string;
}) {
	const theme = useTheme();
	return (
		<box flexDirection="row" gap={1}>
			<text fg={theme.colors.mutedForeground}>{label.padEnd(6, " ")}</text>
			<text fg={valueColor}>{value}</text>
		</box>
	);
}

function PlaceholderPanel({ meta, title }: { meta: PanelMeta; title: string }) {
	const theme = useTheme();
	const borderColor =
		meta.tone === "danger" ? theme.colors.error : theme.colors.border;
	return (
		<Card borderColor={borderColor} title={title}>
			<ToneBadge tone={meta.tone} />
			<text fg={theme.colors.mutedForeground}>{meta.description}</text>
			{meta.note ? (
				<box marginTop={1}>
					<text fg={theme.colors.muted}>{meta.note}</text>
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

/** The Settings overlay module. The Integrate step calls registerOverlay to swap
 * the skeleton for this body under the "settings" id. */
export const settingsOverlay: OverlayModule = {
	id: "settings",
	title: "Settings",
	Body: SettingsBody,
};
