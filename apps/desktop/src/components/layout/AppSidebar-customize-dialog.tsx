import { useI18n } from "@ryu/i18n/react";
import { APPROVALS_ALIAS } from "@/src/contributions/companion-alias.ts";
import { useCompanionAlias } from "@/src/contributions/use-companion-alias.ts";
import type { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { CustomizeSidebarDialog } from "./CustomizeSidebarDialog.tsx";
import {
	CHROME_LABELS,
	CHROME_ORDER,
	type ChromeKey,
	FOOTER_CHROME,
	isChromeKey,
	isHeaderButtonChrome,
} from "./sidebar-panel-state.tsx";
import type { SectionKey } from "./sidebar-sections.ts";

/** The Customize sidebar dialog, wired to the panel's section and header-button
 *  layout writers. */
export function SidebarCustomizeDialog({
	contributedButtons,
	customizeOpen,
	effectiveChromeOrder,
	handleResetSidebar,
	hiddenChrome,
	hiddenSections,
	renderOrder,
	reorderChrome,
	reorderSections,
	sectionLabels,
	setChromeHidden,
	setChromeItemsHidden,
	setCustomizeOpen,
	setSectionHidden,
	setSectionsHidden,
}: {
	contributedButtons: ReturnType<
		typeof usePluginContributions
	>["sidebar_buttons"];
	customizeOpen: boolean;
	effectiveChromeOrder: ChromeKey[];
	handleResetSidebar: () => void;
	hiddenChrome: Set<string>;
	hiddenSections: Set<string>;
	renderOrder: SectionKey[];
	reorderChrome: (next: ChromeKey[]) => void;
	reorderSections: (next: SectionKey[]) => void;
	sectionLabels: Record<string, string>;
	setChromeHidden: (key: ChromeKey, hidden: boolean) => void;
	setChromeItemsHidden: (keys: ChromeKey[], hidden: boolean) => void;
	setCustomizeOpen: (open: boolean) => void;
	setSectionHidden: (key: SectionKey, hidden: boolean) => void;
	setSectionsHidden: (keys: SectionKey[], hidden: boolean) => void;
}) {
	const { t } = useI18n();
	// "inbox" is the last built-in chrome key still owned by an APP (the approvals
	// app's tray, rendered in NavUser). NavUser hides the button itself when nothing
	// claims the path; the Customize dialog has to make the same call, or it offers a
	// "show Inbox" toggle whose only outcome is a tab reading "App not enabled".
	const inboxOwner = useCompanionAlias(APPROVALS_ALIAS);
	// Same idea for app-contributed header buttons (Memory, Home): the dialog's
	// "Top buttons" list needs their titles or the row shows the namespaced key.
	const chromeButtonLabels: Record<string, string> = {};
	for (const button of contributedButtons) {
		chromeButtonLabels[`plugin:${button.plugin}:${button.id}`] = button.title;
	}
	return (
		<CustomizeSidebarDialog
			bottomChromeItems={CHROME_ORDER.filter(
				(key) =>
					FOOTER_CHROME.has(key) && (key !== "inbox" || inboxOwner !== null)
			).map((key) => ({
				key,
				label: t(
					`sidebar.chrome.${key}`,
					{},
					Object.entries(CHROME_LABELS).find(
						([chromeKey]) => chromeKey === key
					)?.[1] ?? key
				),
			}))}
			chromeHidden={hiddenChrome}
			fixedTopChromeItems={CHROME_ORDER.filter(
				(key) => !(FOOTER_CHROME.has(key) || isHeaderButtonChrome(key))
			).map((key) => ({
				key,
				label: t(
					`sidebar.chrome.${key}`,
					{},
					Object.entries(CHROME_LABELS).find(
						([chromeKey]) => chromeKey === key
					)?.[1] ?? key
				),
			}))}
			hidden={hiddenSections}
			labels={sectionLabels}
			onClose={() => setCustomizeOpen(false)}
			onReorder={reorderSections}
			onReorderChrome={reorderChrome}
			onReset={handleResetSidebar}
			onSetChromeItemsHidden={(keys, hidden) =>
				setChromeItemsHidden(keys.filter(isChromeKey), hidden)
			}
			onSetSectionsHidden={setSectionsHidden}
			onToggleChromeHidden={(key) =>
				isChromeKey(key) && setChromeHidden(key, !hiddenChrome.has(key))
			}
			onToggleHidden={(key) => setSectionHidden(key, !hiddenSections.has(key))}
			open={customizeOpen}
			order={renderOrder}
			topButtonItems={effectiveChromeOrder.map((key) => ({
				key,
				label:
					chromeButtonLabels[key] ??
					(Object.entries(CHROME_LABELS).find(
						([chromeKey]) => chromeKey === key
					)?.[1]
						? t(
								`sidebar.chrome.${key}`,
								{},
								Object.entries(CHROME_LABELS).find(
									([chromeKey]) => chromeKey === key
								)?.[1]
							)
						: key),
			}))}
		/>
	);
}
