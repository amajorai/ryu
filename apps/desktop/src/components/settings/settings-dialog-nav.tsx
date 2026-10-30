import {
	Analytics01Icon,
	ChartLineData01Icon,
	CloudIcon,
	Coins01Icon,
	ColorsIcon,
	CreditCardIcon,
	GiftIcon,
	KeyboardIcon,
	Mic01Icon,
	Package01Icon,
	Refresh01Icon,
	SecurityCheckIcon,
	Settings01Icon,
	SourceCodeIcon,
	UserCircleIcon,
	UserIcon,
	UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import type { SettingsSectionValue } from "@/src/store/useSettingsDialog.ts";
import { ServicesOrgSwitcher } from "./ServicesOrgSwitcher.tsx";

// Static (built-in) sections defined in the store so external openers (the Gateway
// dialog cross-link, the command palette) can request one without importing this
// component. Per-app/plugin tabs are dynamic (`app:<id>` / `plugin:<id>`) and are
// NOT part of this union — they are matched by prefix at render time.
export type SectionValue = SettingsSectionValue;

export const KEYBOARD_SHORTCUT_CONTEXT = new Map<string, string>([
	["general", "Customize shortcuts for app controls, tabs, and navigation."],
	["voice", "Customize shortcuts for voice mode and other voice actions."],
]);

export interface NavItem {
	desktopOnly?: boolean;
	/**
	 * The plain muted glyph left of the label. Optional because the dynamic
	 * Apps/Plugins items are built elsewhere and a manifest declares a settings
	 * tab, not a glyph — the label always carries the meaning.
	 */
	icon?: IconSvgElement;
	label: string;
	value: string;
}

export interface NavGroup {
	/**
	 * Renders between the group label and its first item. Exists for exactly one
	 * case — the workspace switcher above Billing — because every item in the
	 * Services group is org-scoped and the group needed one control saying WHICH
	 * org, rather than four tabs each repeating (and potentially disagreeing
	 * about) the answer.
	 */
	header?: ReactNode;
	items: NavItem[];
	title?: string;
}

// Desktop-client + user-account sections only. Everything node/gateway-level
// (meetings, memory, privacy, storage, email/alerts, connections, health,
// predictive typing, tasks, the Danger Zone, and node-scoped app/plugin settings)
// now lives in the Gateway dialog — those affect the whole node, not this per-user
// desktop client, and belong next to the other node settings.
//
// Updates is the one tab that exists in both dialogs, and deliberately so: the
// Gateway one updates the node's Core/Gateway binaries, the one here updates this
// desktop client. They are separate installs that can sit at different versions.
//
// KNOWN HYBRID — `voice` is the one entry below that is NOT the shell's own
// setting: it belongs to the voice/dictation sidecar stack and could arrive
// through `contributes.settings_tabs` under the dynamic Apps/Plugins headers
// (as memory/meetings/quests/predict already do). It is kept here because it is
// a wrapper around five desktop-client sub-panels that share no single owning
// app record. `island` and `shadow` were the other two hybrids and are now
// registered: each declares a manifest `contributes.settings_tabs` view and
// renders under the dynamic Apps/Plugins headers in the Gateway dialog, so their
// tabs appear only while the owning app is enabled instead of always.
export const NAV_GROUPS: NavGroup[] = [
	{
		items: [
			{
				value: "general",
				label: "General",
				icon: Settings01Icon,
			},
			{
				value: "appearance",
				label: "Appearance",
				icon: ColorsIcon,
			},
			{
				value: "keyboard",
				label: "Keyboard Shortcuts",
				icon: KeyboardIcon,
				desktopOnly: true,
			},
			{ value: "voice", label: "Voice", icon: Mic01Icon },
		],
	},
	{
		title: "Account",
		items: [
			{
				value: "account",
				label: "Account",
				icon: UserCircleIcon,
			},
			{
				value: "profile",
				label: "Profile",
				icon: UserIcon,
			},
			{
				value: "stats",
				label: "Stats",
				icon: Analytics01Icon,
			},
			{
				value: "sessions",
				label: "Sessions & devices",
				icon: SecurityCheckIcon,
			},
			{
				value: "ryu-apps",
				label: "Ryu apps",
				icon: Package01Icon,
			},
			{
				value: "authorized-apps",
				label: "OAuth apps",
				icon: UserMultiple02Icon,
			},
		],
	},
	{
		title: "Services",
		// The scope of everything under this heading, stated once at the top of it.
		header: <ServicesOrgSwitcher />,
		items: [
			{
				value: "billing",
				label: "Billing",
				icon: CreditCardIcon,
			},
			{ value: "referrals", label: "Referrals", icon: GiftIcon },
			{
				value: "teams",
				label: "Teams",
				icon: UserMultiple02Icon,
			},
			{ value: "credits", label: "Credits", icon: Coins01Icon },
			// Next to Credits on purpose: the balance and what drew it down are the
			// same question asked twice, and splitting them across groups is how a
			// customer ends up asking support what a charge was.
			{ value: "usage", label: "Usage", icon: ChartLineData01Icon },
		],
	},
	{
		// The three tabs nobody opens in a normal week: the client updater, the
		// developer tools, and cross-machine settings sync. Grouping them demotes
		// them out of the first block, which is now only the settings a user
		// actually tunes. Labels must stay byte-identical to
		// SETTINGS_SECTION_LABELS (lib/settings-index.ts) or the sidebar and the
		// search-result breadcrumb disagree about the same tab.
		title: "Advanced",
		items: [
			{
				value: "updates",
				label: "Updates",
				icon: Refresh01Icon,
				desktopOnly: true,
			},
			{
				value: "developer",
				label: "Developer",
				icon: SourceCodeIcon,
			},
			{
				value: "sync",
				label: "Settings Sync",
				icon: CloudIcon,
			},
		],
	},
];

export function normalizeDefaultSection(
	defaultSection: SectionValue | (string & {}) | undefined,
	isDesktop: boolean
): string {
	return !isDesktop && defaultSection === "keyboard"
		? "general"
		: (defaultSection ?? "general");
}
