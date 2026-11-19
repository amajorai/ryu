/* @jsxImportSource @opentui/react */
// Settings overlay body - the desktop Settings dialog analog. Renders an inset
// left-nav (grouped exactly like apps/desktop's SettingsDialog NAV_GROUPS) beside
// a panel area. The OverlayHost supplies the centered modal chrome (title bar +
// Esc-to-close) and claims raw input; this body owns only its inner nav.
//
// Profile and Sessions use the authenticated account contracts; Account and
// Services keep data-backed panels. Features, Meetings, Tasks, Storage and
// Danger Zone are read-only Core views. Memory and Privacy keep their editable
// surfaces; native host features use labeled handoffs. Updates uses Core's
// shared preference and the CLI updater.
//
// Keyboard: up/down and j/k move the nav selection. Account and Sessions own
// up/down for their rows while j/k move the Settings nav; ServicesTab suppresses
// and read-only ListTab keys while the overlay claims input. Esc (host) closes.

import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useRef, useState } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { sectionHeading } from "../../sidebar/section-heading.ts";
import { AccountTab } from "../../tabs/account.tsx";
import { ServicesTab } from "../../tabs/services.tsx";
import type { OverlayModule } from "../registry.ts";
import { AuthorizedAppsPanel } from "./authorized-apps.tsx";
import { ConnectionsPanel } from "./connections.tsx";
import { GeneralPanel } from "./general-panel.tsx";
import { InferenceSettingsPanel } from "./inference.tsx";
import {
	DATA_PANELS,
	DataPanel,
	fallbackPanelMeta,
	PANEL_META,
	PlaceholderPanel,
} from "./info-panels.tsx";
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
							<b>{sectionHeading(group.title)}</b>
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
	const meta = PANEL_META.get(id) ?? fallbackPanelMeta(label);
	return <PlaceholderPanel meta={meta} title={label} />;
}

/** The Settings overlay module. The Integrate step calls registerOverlay to swap
 * the skeleton for this body under the "settings" id. */
export const settingsOverlay: OverlayModule = {
	id: "settings",
	title: "Settings",
	Body: SettingsBody,
};
