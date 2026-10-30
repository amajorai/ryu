import { KeyboardIcon } from "@hugeicons/core-free-icons";
import { SettingsNavRow } from "@ryu/blocks/desktop/settings-nav.tsx";
import { useI18n, useLocalizedText } from "@ryu/i18n/react";
import { OAuthAppsTab, ReferralsTab } from "@ryu/settings";
import { useTheme } from "next-themes";
import type { ReactNode } from "react";
import { useSession } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { useSettingReveal } from "@/src/hooks/useSettingReveal.ts";
import CreditsTab from "@/src/pages/CreditsPage.tsx";
import UsageTab from "@/src/pages/UsagePage.tsx";
import { AccountTab } from "./AccountTab.tsx";
import { AppearanceTab } from "./AppearanceTab.tsx";
import { AppUpdatesSettings } from "./AppUpdatesSettings.tsx";
import { AudioDevicesSettings } from "./AudioDevicesSettings.tsx";
import { BillingTab } from "./BillingTab.tsx";
import { DeveloperTab } from "./DeveloperTab.tsx";
import { GeneralTab } from "./GeneralTab.tsx";
import { KeyboardShortcutsTab } from "./KeyboardShortcutsTab.tsx";
import { ProfileTab } from "./ProfileTab.tsx";
import { RyuAppsTab } from "./RyuAppsTab.tsx";
import { SessionsTab } from "./SessionsTab.tsx";
import { SettingsSyncTab } from "./SettingsSyncTab.tsx";
import { StatsTab } from "./StatsTab.tsx";
import { SettingsGroup, SettingsSection } from "./shared/settings-items.tsx";
import { TeamsBillingTab } from "./TeamsBillingTab.tsx";
import { TtsEngineSettings } from "./TtsEngineSettings.tsx";
import { VoiceInputSettings } from "./VoiceInputSettings.tsx";
import { VoiceModeDisplaySettings } from "./VoiceModeDisplaySettings.tsx";
import { VoiceReadbackSettings } from "./VoiceReadbackSettings.tsx";

/**
 * The Referrals tab, with the two things `ReferralsTab` cannot resolve itself:
 * whose name goes on the invite pass, and which metal ring to paint on it.
 *
 * Its own component rather than inline in `SectionContent`, because both facts
 * come from hooks (`useSession`, `useTheme`) and `SectionContent` is a switch —
 * calling hooks in one arm of it would be a conditional hook.
 */
function ReferralsSection() {
	const { data: session } = useSession();
	const { resolvedTheme } = useTheme();
	return (
		<ReferralsTab
			holderName={session?.user?.name ?? null}
			// The app's RESOLVED theme, not the OS's: this shell has a manual toggle
			// that can disagree with `prefers-color-scheme`, and a ring following the
			// OS would be the one part of the card lit for the wrong scheme.
			metalTheme={resolvedTheme === "dark" ? "dark" : "light"}
			onOpenExternal={openExternal}
		/>
	);
}

/**
 * The pointer to Keyboard shortcuts at the foot of General and Voice: one flush
 * chevron row, the same shape as a sub-page row, so it reads as navigation and
 * not as a form with a button in it.
 */
export function KeyboardShortcutsLink({
	description,
	onOpen,
}: {
	description: string;
	onOpen: () => void;
}) {
	const { t } = useI18n();
	const localizedDescription = useLocalizedText(description);
	return (
		<SettingsSection>
			<SettingsGroup>
				<SettingsNavRow
					description={localizedDescription}
					icon={KeyboardIcon}
					onClick={onOpen}
					title={t("settings.keyboard.title")}
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}

export function SectionContent({ value }: { value: string }) {
	switch (value) {
		case "general":
			return <GeneralTab />;
		case "account":
			return <AccountTab />;
		case "profile":
			return <ProfileTab />;
		case "stats":
			return <StatsTab />;
		case "sessions":
			return <SessionsTab />;
		case "ryu-apps":
			return <RyuAppsTab />;
		case "authorized-apps":
			return <OAuthAppsTab />;
		case "appearance":
			return <AppearanceTab />;
		case "keyboard":
			return <KeyboardShortcutsTab />;
		case "sync":
			return <SettingsSyncTab />;
		case "updates":
			return <AppUpdatesSettings />;
		case "billing":
			return <BillingTab />;
		case "referrals":
			return <ReferralsSection />;
		case "teams":
			return <TeamsBillingTab />;
		case "credits":
			return <CreditsTab />;
		case "usage":
			return <UsageTab />;
		case "developer":
			return <DeveloperTab />;
		case "voice":
			// Siblings in the pane body, so each section's own `mt-8 first:mt-0`
			// sets the rhythm; no wrapper spacing of its own.
			return (
				<>
					<AudioDevicesSettings />
					<VoiceModeDisplaySettings />
					<VoiceInputSettings />
					<VoiceReadbackSettings />
					<TtsEngineSettings />
				</>
			);
		default:
			return null;
	}
}

/**
 * The content pane, and the owner of the settings-search reveal.
 *
 * The reveal hook lives here rather than on `SettingsDialog` because the
 * dialog's popup mounts in a portal one render after the dialog itself. At the
 * dialog level the hook's effect ran before the pane existed: it claimed the
 * pending reveal against the whole document, so a sub-paged section (General,
 * Appearance) never saw the request and stayed on its index, and reopening
 * Settings on the section it already showed claimed nothing at all. Mounted
 * with the pane, the section's own render peeks the request first (to open the
 * right sub-page) and the reveal is then scoped to this pane. The hook also
 * claims a result chosen in the section already on screen, which switches no
 * section and so would otherwise stay pending until the next visit.
 */
export function SettingsContentPane({
	children,
	className,
	section,
}: {
	children: ReactNode;
	className: string;
	section: string;
}) {
	const contentRef = useSettingReveal(section, "app");
	return (
		<div className={className} ref={contentRef}>
			{children}
		</div>
	);
}
