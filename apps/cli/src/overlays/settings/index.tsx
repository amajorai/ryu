/* @jsxImportSource @opentui/react */
// Settings overlay body - the desktop Settings dialog analog. Renders an inset
// left-nav (grouped exactly like apps/desktop's SettingsDialog NAV_GROUPS) beside
// a panel area. The OverlayHost supplies the centered modal chrome (title bar +
// Esc-to-close) and claims raw input; this body owns only its inner nav.
//
// Profile and Sessions use the existing authenticated account contracts;
// Account and Services retain their data-backed panels. Features, Meetings,
// Tasks, Storage and Danger Zone add read-only Core data views. Memory and
// Privacy retain their canonical editable preference/library surfaces.
// Native host features and remaining account surfaces use labeled handoffs.
// Updates uses Core's shared preference and the CLI updater.
//
// Keyboard: up/down and j/k move the nav selection. Account and Sessions own
// up/down for their rows while j/k move the Settings nav; ServicesTab suppresses
// and read-only ListTab keys while the overlay claims input. Esc (host) closes.

import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge.tsx";
import { Card } from "@/components/ui/card.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../../core/CoreContext.tsx";
import { useCliProductMode } from "../../core/ProductModeContext.tsx";
import { STARTUP_REALM_OPTIONS } from "../../core/productMode.ts";
import { AccountTab } from "../../tabs/account.tsx";
import { ServicesTab } from "../../tabs/services.tsx";
import { type ListLoader, ListTab } from "../../ui/ListTab.tsx";
import type { OverlayModule } from "../registry.ts";
import { AuthorizedAppsPanel } from "./authorized-apps.tsx";
import { ConnectionsPanel } from "./connections.tsx";
import { InferenceSettingsPanel } from "./inference.tsx";
import {
	loadDataCounts,
	loadFeatures,
	loadMeetings,
	loadQuests,
	loadStorage,
} from "./loaders.ts";
import { MemoryPanel } from "./memory.tsx";
import { PrivacyPanel } from "./privacy.tsx";
import { ProfileTab } from "./profile.tsx";
import { SessionsPanel } from "./sessions.tsx";
import { UpdatesPanel } from "./updates.tsx";

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
			{ id: "shadow", label: "Shadow" },
			{ id: "voice", label: "Voice" },
			{ id: "memory", label: "Memory" },
			{ id: "meetings", label: "Meetings" },
			{ id: "quests", label: "Tasks" },
			{ id: "predict", label: "Autocomplete" },
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
			{ id: "inference", label: "Inference" },
		],
	},
];

const FLAT_ITEMS = NAV_GROUPS.flatMap((group) => group.items);
const LAST_INDEX = FLAT_ITEMS.length - 1;
const INDEX_BY_ID = new Map(FLAT_ITEMS.map((item, i) => [item.id, i]));

// Ids whose panel is the data-backed reused AccountTab / ServicesTab content.
// Profile is its own surface: it edits the account display name, while Account
// remains the security, session, and account-switching surface.
const ACCOUNT_IDS = new Set(["account", "sessions", "authorized-apps"]);
const SERVICE_IDS = new Set(["integrations"]);

type Tone = "default" | "desktop" | "account" | "danger";

interface DataPanelMeta {
	description: string;
	emptyLabel: string;
	load: ListLoader;
	note: string;
	tone?: Tone;
}

// Read-only views over Core endpoints. `note` says where the writes live.
const DATA_PANELS = new Map<string, DataPanelMeta>(
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

interface PanelMeta {
	description: string;
	note?: string;
	tone?: Tone;
}

// Pointers for the surfaces the terminal client does not drive directly: native
// desktop features, and control-plane account surfaces that Core does not serve.
const PANEL_META = new Map<string, PanelMeta>(
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

function SettingsBody() {
	const [selIndex, setSelIndex] = useState(0);
	const [dataReloadKey, setDataReloadKey] = useState(0);
	const profileEditingRef = useRef(false);
	const [connectionsOwnNavigation, setConnectionsOwnNavigation] =
		useState(false);
	const [inferenceOwnNavigation, setInferenceOwnNavigation] = useState(false);
	const [memoryOwnNavigation, setMemoryOwnNavigation] = useState(false);
	const [memoryEditing, setMemoryEditing] = useState(false);
	const [privacyOwnNavigation, setPrivacyOwnNavigation] = useState(false);
	const [privacyEditing, setPrivacyEditing] = useState(false);
	const setProfileEditing = useCallback((editing: boolean) => {
		profileEditingRef.current = editing;
	}, []);
	const setConnectionsNavigation = useCallback((owned: boolean) => {
		setConnectionsOwnNavigation(owned);
	}, []);
	const setInferenceNavigation = useCallback((owned: boolean) => {
		setInferenceOwnNavigation(owned);
	}, []);
	const setMemoryNavigation = useCallback((owned: boolean) => {
		setMemoryOwnNavigation(owned);
	}, []);
	const setMemoryEditState = useCallback((editing: boolean) => {
		setMemoryEditing(editing);
	}, []);
	const setPrivacyNavigation = useCallback((owned: boolean) => {
		setPrivacyOwnNavigation(owned);
	}, []);
	const setPrivacyEditState = useCallback((editing: boolean) => {
		setPrivacyEditing(editing);
	}, []);
	const { height } = useTerminalDimensions();
	const theme = useTheme();
	// The Modal leaves height - 8 body rows; the hint row and its gap take two,
	// so a short terminal shrinks the panels instead of scrolling the hint away.
	const bodyHeight = Math.max(6, Math.min(30, height - 10));
	const selected = FLAT_ITEMS[selIndex] ?? FLAT_ITEMS[0];
	const accountPanelActive = ACCOUNT_IDS.has(selected.id);
	const sessionsPanelActive = selected.id === "sessions";
	const updatesPanelActive = selected.id === "updates";

	useKeyboard((key) => {
		if (
			profileEditingRef.current ||
			inferenceOwnNavigation ||
			memoryEditing ||
			privacyEditing
		) {
			return;
		}
		// The overlay owns input, so its read-only panels cannot use ListTab's
		// shell key handler. Remount only the selected data loader for retry.
		if (key.name === "r" && DATA_PANELS.get(selected.id)) {
			setDataReloadKey((value) => value + 1);
			return;
		}
		// Connections owns ↑/↓ for its toolkit list. Keep j/k available to move
		// between Settings panels so users can leave it without changing selection.
		if (connectionsOwnNavigation) {
			if (key.name === "k") {
				setSelIndex((i) => Math.max(0, i - 1));
			} else if (key.name === "j") {
				setSelIndex((i) => Math.min(LAST_INDEX, i + 1));
			}
			return;
		}
		// Privacy owns ↑/↓ for its controls while j/k remain available for the
		// Settings panel list, matching the Connections panel interaction.
		if (privacyOwnNavigation) {
			if (key.name === "k") {
				setSelIndex((i) => Math.max(0, i - 1));
			} else if (key.name === "j") {
				setSelIndex((i) => Math.min(LAST_INDEX, i + 1));
			}
			return;
		}
		// Memory owns ↑/↓ for its preference rows; j/k still move Settings panels.
		if (memoryOwnNavigation) {
			if (key.name === "k") {
				setSelIndex((i) => Math.max(0, i - 1));
			} else if (key.name === "j") {
				setSelIndex((i) => Math.min(LAST_INDEX, i + 1));
			}
			return;
		}
		if (key.name === "up") {
			if (!accountPanelActive) {
				setSelIndex((i) => Math.max(0, i - 1));
			}
			return;
		}
		if (key.name === "k") {
			setSelIndex((i) => Math.max(0, i - 1));
			return;
		}
		if (key.name === "down") {
			if (!accountPanelActive) {
				setSelIndex((i) => Math.min(LAST_INDEX, i + 1));
			}
			return;
		}
		if (key.name === "j") {
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
					<Panel
						dataReloadKey={dataReloadKey}
						height={Math.max(4, bodyHeight - 6)}
						id={selected.id}
						label={selected.label}
						onConnectionsNavigationChange={setConnectionsNavigation}
						onInferenceNavigationChange={setInferenceNavigation}
						onMemoryEditingChange={setMemoryEditState}
						onMemoryNavigationChange={setMemoryNavigation}
						onPrivacyEditingChange={setPrivacyEditState}
						onPrivacyNavigationChange={setPrivacyNavigation}
						onProfileEditingChange={setProfileEditing}
					/>
				</box>
			</box>
			<box marginTop={1}>
				<text fg={theme.colors.mutedForeground}>
					{connectionsOwnNavigation
						? "↑↓ integrations · j / k panels · v access ceiling · c connect · p check status · r retry"
						: inferenceOwnNavigation
							? "↑↓ / j k fields · ←/→ engine · e edit · x clear · s save · r reload · Esc close"
							: privacyOwnNavigation
								? "↑↓ privacy controls · j / k panels · Enter toggle · e endpoint · ←/→ duration · r retry/load"
								: memoryOwnNavigation
									? "↑↓ memory controls · j / k panels · Enter toggle · e edit values · ←/→ cycle · r retry/load"
									: updatesPanelActive
										? "Enter toggle automatic updates · r reload · Esc close"
										: sessionsPanelActive
											? "↑↓ sessions · j / k panels · x revoke · a revoke others · r retry · Esc close"
											: accountPanelActive
												? "j / k panels · ↑↓ select account · Esc close"
												: "↑↓ / j k navigate · Esc close"}
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
			<text fg={selected ? theme.colors.primary : theme.colors.mutedForeground}>
				{selected ? "›" : " "}
			</text>
			<text fg={selected ? theme.colors.primary : theme.colors.foreground}>
				{selected ? <b>{label}</b> : label}
			</text>
		</box>
	);
}

function Panel({
	dataReloadKey,
	height,
	id,
	label,
	onConnectionsNavigationChange,
	onInferenceNavigationChange,
	onMemoryNavigationChange,
	onMemoryEditingChange,
	onPrivacyNavigationChange,
	onPrivacyEditingChange,
	onProfileEditingChange,
}: {
	dataReloadKey: number;
	height: number;
	id: string;
	label: string;
	onConnectionsNavigationChange: (owned: boolean) => void;
	onInferenceNavigationChange: (owned: boolean) => void;
	onMemoryNavigationChange: (owned: boolean) => void;
	onMemoryEditingChange: (editing: boolean) => void;
	onPrivacyNavigationChange: (owned: boolean) => void;
	onPrivacyEditingChange: (editing: boolean) => void;
	onProfileEditingChange: (editing: boolean) => void;
}) {
	if (id === "connections") {
		return (
			<ConnectionsPanel
				active
				onNavigationOwnershipChange={onConnectionsNavigationChange}
			/>
		);
	}
	if (id === "profile") {
		return <ProfileTab active onEditingChange={onProfileEditingChange} />;
	}
	if (id === "inference") {
		return (
			<InferenceSettingsPanel
				active
				onNavigationOwnershipChange={onInferenceNavigationChange}
			/>
		);
	}
	if (id === "memory") {
		return (
			<MemoryPanel
				active
				onEditingChange={onMemoryEditingChange}
				onNavigationOwnershipChange={onMemoryNavigationChange}
			/>
		);
	}
	if (id === "privacy") {
		return (
			<PrivacyPanel
				active
				onEditingChange={onPrivacyEditingChange}
				onNavigationOwnershipChange={onPrivacyNavigationChange}
			/>
		);
	}
	if (id === "updates") {
		return <UpdatesPanel />;
	}
	if (id === "authorized-apps") {
		return <AuthorizedAppsPanel active />;
	}
	if (id === "sessions") {
		return <SessionsPanel active />;
	}
	if (id === "account") {
		return <AccountTab active onEditingChange={onProfileEditingChange} />;
	}
	if (SERVICE_IDS.has(id)) {
		return <ServicesTab active />;
	}
	if (id === "general") {
		return <GeneralPanel />;
	}
	const data = DATA_PANELS.get(id);
	if (data) {
		// Keyed by id so switching panels remounts the list and reloads its data.
		return (
			<DataPanel
				height={height}
				key={`${id}:${dataReloadKey}`}
				meta={data}
				title={label}
			/>
		);
	}
	const meta = PANEL_META.get(id) ?? { description: `${label} settings.` };
	return <PlaceholderPanel meta={meta} title={label} />;
}

function GeneralPanel() {
	const { url, token } = useCore();
	const theme = useTheme();
	// The card is taller than the Settings body on short terminals; scroll it
	// instead of letting Yoga shrink its rows onto each other.
	return (
		<scrollbox flexGrow={1}>
			<Card subtitle="Ryu Core node" title="General">
				<InfoLine
					label="Node"
					value={url}
					valueColor={theme.colors.foreground}
				/>
				<InfoLine
					label="Auth"
					value={token ? "token set" : "no token"}
					valueColor={token ? theme.colors.success : theme.colors.warning}
				/>
				<StartupRealmSetting />
				<box marginTop={1}>
					<text fg={theme.colors.mutedForeground}>
						Node connection is managed from the Gateway overlay and the node
						picker.
					</text>
				</box>
			</Card>
		</scrollbox>
	);
}

function StartupRealmSetting() {
	const { modePreference, setStartupRealm, startupRealmSaveError } =
		useCliProductMode();
	const theme = useTheme();
	const selectedIndex = Math.max(
		0,
		STARTUP_REALM_OPTIONS.findIndex(
			(option) => option.value === modePreference.startupRealm
		)
	);
	useKeyboard((key) => {
		if (key.name !== "left" && key.name !== "right") {
			return;
		}
		const direction = key.name === "right" ? 1 : -1;
		const nextIndex =
			(selectedIndex + direction + STARTUP_REALM_OPTIONS.length) %
			STARTUP_REALM_OPTIONS.length;
		const option = STARTUP_REALM_OPTIONS[nextIndex];
		if (option) {
			setStartupRealm(option.value);
		}
	});

	return (
		<box flexDirection="column" gap={1} marginTop={1}>
			<text fg={theme.colors.mutedForeground}>Startup realm</text>
			{/* Wrap the choices in a narrow pane rather than crushing each one. */}
			<box flexDirection="row" flexWrap="wrap" gap={1}>
				{STARTUP_REALM_OPTIONS.map((option, optionIndex) => {
					const selected = selectedIndex === optionIndex;
					return (
						<box
							borderColor={
								selected ? theme.colors.focusRing : theme.colors.border
							}
							borderStyle={selected ? "rounded" : "single"}
							key={option.value}
							onMouseDown={() => setStartupRealm(option.value)}
							paddingLeft={1}
							paddingRight={1}
						>
							<text
								fg={selected ? theme.colors.primary : theme.colors.foreground}
							>
								{selected ? `› ${option.label}` : option.label}
							</text>
						</box>
					);
				})}
			</box>
			<text fg={theme.colors.mutedForeground}>
				← / → or click · applies on next launch
			</text>
			{startupRealmSaveError ? (
				<text fg={theme.colors.error}>{startupRealmSaveError}</text>
			) : null}
		</box>
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

function DataPanel({
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

/** The Settings overlay module. The Integrate step calls registerOverlay to swap
 * the skeleton for this body under the "settings" id. */
export const settingsOverlay: OverlayModule = {
	id: "settings",
	title: "Settings",
	Body: SettingsBody,
};
