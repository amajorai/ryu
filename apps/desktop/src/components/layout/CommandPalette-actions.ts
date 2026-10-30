import {
	Add01Icon,
	ArrowRight01Icon,
	DeliverySecure01Icon,
	Package01Icon,
	PlugSocketIcon,
} from "@hugeicons/core-free-icons";
import { renderTemplate } from "@ryu/app-host/views";
import type { CommandAction, CommandPaletteTab } from "@ryu/command/types";
import { marketplaceBrowseKindLabel } from "@ryu/marketplace/catalog/chrome/marketplace-sections";
import { parseContributedTarget } from "@/src/contributions/contributed-target.ts";
import { contributionRegistry } from "@/src/contributions/registry.ts";
import type { useCommandSearchSections } from "@/src/hooks/useCommandSearchSections.ts";
import type { ContributedSectionItems } from "@/src/hooks/useContributedCommands.ts";
import type { MessageSearchHit } from "@/src/lib/api/conversation-search.ts";
import {
	formatPricingLabel,
	type MarketplaceCard,
} from "@/src/lib/api/marketplace.ts";
import type { PluginContributions } from "@/src/lib/api/plugins.ts";
import type { ShadowSearchResult } from "@/src/lib/api/shadow.ts";
import type { SpaceLexicalHit } from "@/src/lib/api/spaces.ts";
import { compactAge } from "@/src/lib/time.ts";
import type { DesktopWorkbenchValue } from "@/src/workbench/DesktopWorkbenchContext.tsx";
import {
	DESKTOP_SHELL_REGIONS,
	type WorkbenchTools,
} from "@/src/workbench/workbench-chrome.tsx";
import { workbenchLayoutCommands } from "@/src/workbench/workbench-commands.ts";
import {
	pushLibraryAndCoreActions,
	pushSecondaryNavActions,
	pushThemeActions,
} from "./CommandPalette-builtin-actions.ts";
import {
	COMPUTE_SHARE_NAV_TARGETS,
	contribString,
	humanizeCaptureKind,
	MAX_CHAT_RESULTS,
	NAV_ITEMS,
	NAV_RESULT_TYPES,
	type SettingsSection,
} from "./CommandPalette-nav-items.ts";

export interface CommandPaletteActionContext {
	close: () => void;
	commandSearchSections: ReturnType<
		typeof useCommandSearchSections
	>["sections"];
	computeShareEnabled: boolean;
	contributedButtons: PluginContributions["sidebar_buttons"];
	contributedSectionItems: ContributedSectionItems[];
	handleImportSetup: () => void;
	handleImportThread: () => void;
	handleNavigate: (to: string, title?: string) => void;
	handleNewChat: () => void;
	handleOpenCapture: (ts: number) => void;
	handleOpenSettings: (section: SettingsSection) => void;
	handleRunPluginCommand: (commandId: string, label: string) => void;
	handleSelectChat: (id: string, messageId?: string) => void;
	handleSelectMarketplace: (card: MarketplaceCard, queryText: string) => void;
	handleSelectPage: (hit: SpaceLexicalHit) => void;
	handleSignOutAction: () => void;
	handleToggleFullscreen: () => void;
	isSigningOut: boolean;
	marketplaceResults: MarketplaceCard[];
	messageResults: MessageSearchHit[];
	modKey: string;
	pluginCommands: PluginContributions["slash_commands"];
	query: string;
	requestRemember: () => void;
	searchTabs: CommandPaletteTab[];
	setTheme: (theme: string) => void;
	shadowResults: ShadowSearchResult[];
	spaceResults: SpaceLexicalHit[];
	theme: string | undefined;
	workbench: DesktopWorkbenchValue | null;
	workbenchTools: WorkbenchTools | null;
}

const formatAgeAgo = (timestamp?: number): string | undefined => {
	if (!(timestamp && Number.isFinite(timestamp))) {
		return undefined;
	}
	const age = compactAge(timestamp);
	return age === "now" ? "just now" : `${age} ago`;
};
const resultMeta = (
	subtitle: string | null | undefined,
	timestamp?: number
): string | undefined =>
	[subtitle, formatAgeAgo(timestamp)].filter(Boolean).join(" · ") || undefined;

/** Build the flat action list the shared palette renders. */
export function buildCommandPaletteActions(
	ctx: CommandPaletteActionContext
): CommandAction[] {
	const {
		close,
		commandSearchSections,
		computeShareEnabled,
		contributedButtons,
		contributedSectionItems,
		handleNavigate,
		handleOpenCapture,
		handleRunPluginCommand,
		handleSelectChat,
		handleSelectMarketplace,
		handleSelectPage,
		marketplaceResults,
		messageResults,
		pluginCommands,
		query,
		requestRemember,
		searchTabs,
		shadowResults,
		spaceResults,
		workbench,
		workbenchTools,
	} = ctx;
	const items: CommandAction[] = [];

	// Every built-in sidebar section contributes its live rows to the same flat
	// action list. The section id is the filter id, so adding a sidebar section
	// only requires extending the shared section registry/data source.
	for (const section of commandSearchSections) {
		const rows =
			section.id === "chats"
				? section.items.slice(0, MAX_CHAT_RESULTS)
				: section.items;
		for (const row of rows) {
			items.push({
				id: `sidebar-${section.id}-${row.id}`,
				group: section.label,
				title: row.title,
				value: `${section.label} ${row.title} ${row.subtitle ?? ""} ${row.keywords ?? ""}`,
				resultType: section.id,
				trailing: resultMeta(row.subtitle, row.timestamp),
				icon: row.icon ?? section.icon,
				onSelect: () => {
					row.onSelect();
					close();
				},
			});
		}
	}

	pushThemeActions(items, ctx);

	for (const { to, label, icon } of NAV_ITEMS) {
		if (!computeShareEnabled && COMPUTE_SHARE_NAV_TARGETS.has(to)) {
			continue;
		}
		const resultType = NAV_RESULT_TYPES.get(to);
		if (resultType && !searchTabs.some((tab) => tab.id === resultType)) {
			continue;
		}
		items.push({
			id: `nav-${to}`,
			group: "Navigation",
			title: label,
			value: `navigate ${label}`,
			icon,
			resultType,
			prefetchPath: parseContributedTarget(to).path,
			onSelect: () => handleNavigate(to, label),
		});
	}

	// App-registered sidebar buttons (Home, Memory, …) — navigable entries from
	// the contributions feed, so the palette isn't a second hardcoded nav list.
	// Skip any whose target already appears in NAV_ITEMS to avoid a dupe row.
	const navTargets = new Set<string>(NAV_ITEMS.map((n) => n.to));
	for (const button of contributedButtons) {
		if (navTargets.has(button.target)) {
			continue;
		}
		items.push({
			id: `nav-contrib-${button.plugin}-${button.id}`,
			group: "Navigation",
			title: button.title,
			value: `navigate ${button.title}`,
			icon: ArrowRight01Icon,
			prefetchPath: parseContributedTarget(button.target).path,
			onSelect: () => handleNavigate(button.target, button.title),
		});
	}

	// App-registered sidebar sections' live items (meeting notes, canvas boards,
	// …), each searchable and grouped under its section name — so the palette
	// reaches an app's own lists without the shell knowing they exist.
	for (const section of contributedSectionItems) {
		const itemTarget = section.itemTarget;
		if (!itemTarget) {
			continue;
		}
		for (const row of section.items) {
			const route = renderTemplate(
				itemTarget,
				{ item: row.raw },
				{ uriEncode: true }
			);
			items.push({
				id: `section-${section.plugin}-${section.sectionId}-${row.item.id}`,
				group: section.title,
				title: row.item.title,
				value: `${section.title} ${row.item.title} ${row.item.subtitle ?? ""}`,
				resultType: `plugin:${section.plugin}:${section.sectionId}`,
				icon: ArrowRight01Icon,
				prefetchPath: parseContributedTarget(route).path,
				onSelect: () => handleNavigate(route, row.item.title),
			});
		}
	}

	pushSecondaryNavActions(items, ctx);

	// Slash/commands contributed by enabled plugins. Selecting one fires its
	// onCommand activation event so command-gated plugins wake.
	for (const command of pluginCommands) {
		const commandId = contribString(command, "id");
		if (!commandId) {
			continue;
		}
		const trigger = contribString(command, "command");
		const description = contribString(command, "description");
		const label = trigger ?? commandId;
		items.push({
			id: `plugin-command-${commandId}`,
			group: "Plugin Commands",
			title: label,
			value: `plugin command ${label} ${commandId} ${description ?? ""}`,
			icon: PlugSocketIcon,
			trailing: description ? undefined : trigger,
			onSelect: () => handleRunPluginCommand(commandId, label),
		});
	}

	// Commands registered directly into the contribution registry (the seam the
	// plugin extension host #446 registers into). Merged in alongside — never
	// replacing — the built-in actions and the API-driven plugin commands above.
	// A non-reactive singleton read: nothing calls `registerCommand` until the
	// plugin host lands, so the list is static at render time (fine for PR-1).
	for (const entry of contributionRegistry.listCommands()) {
		items.push({
			id: `contribution-${entry.id}`,
			group: entry.group,
			title: entry.title,
			value: `${entry.title} ${entry.keywords ?? ""}`,
			shortcut: entry.shortcut,
			icon: PlugSocketIcon,
			onSelect: () => {
				void entry.run();
				close();
			},
		});
	}

	pushLibraryAndCoreActions(items, ctx);

	for (const tool of workbenchTools?.tools ?? []) {
		items.push({
			group: "Layout",
			id: `workbench-open-${tool.id}`,
			onSelect: () => {
				workbenchTools?.openTool(tool.id);
				close();
			},
			title: `Open ${tool.label}`,
			value: `open ${tool.label.toLowerCase()} pane panel tool ${tool.region}`,
		});
	}
	if (workbench) {
		for (const command of workbenchLayoutCommands({
			dispatch: workbench.dispatch,
			movableRegions: DESKTOP_SHELL_REGIONS,
			state: workbench.state,
		})) {
			items.push({
				checked: command.checked,
				disabled: command.disabled,
				group: "Layout",
				icon: command.icon,
				id: command.id,
				onSelect: () => {
					command.run();
					close();
				},
				title: command.title,
				value: `${command.title.toLowerCase()} ${command.keywords}`,
			});
		}
	}

	// "Search everything" + "remember" — only when there is a real query.
	const q = query.trim();
	if (q.length >= 2) {
		for (const [i, r] of shadowResults.entries()) {
			const text =
				r.window_title ||
				r.snippet ||
				r.app_name ||
				humanizeCaptureKind(r.event_type);
			items.push({
				id: `shadow-${i}`,
				group: "Search Everything",
				title: text,
				value: `${q} ${text}`,
				trailing: r.app_name ?? undefined,
				onSelect: () => handleOpenCapture(r.ts),
			});
		}
		// Exact + semantic message hits — jump straight to the conversation that
		// contains the matching message.
		for (const [i, hit] of messageResults.entries()) {
			const snippet =
				hit.content.length > 90 ? `${hit.content.slice(0, 90)}…` : hit.content;
			items.push({
				id: `message-${hit.messageId || i}`,
				group: "Messages",
				title: snippet,
				// Keep the query in `value` so the shared palette's own filter
				// never hides a semantic hit that lacks a literal substring match.
				value: `${q} message ${hit.messageId}`,
				resultType: "messages",
				trailing: `${hit.role === "user" ? "you" : "assistant"} · ${formatAgeAgo(hit.createdAt) ?? "just now"}`,
				onSelect: () => handleSelectChat(hit.conversationId, hit.messageId),
			});
		}
		for (const [i, hit] of spaceResults.entries()) {
			items.push({
				id: `page-${hit.documentId || i}`,
				group: "Pages",
				title: hit.title,
				value: `${q} page ${hit.title} ${hit.spaceName} ${hit.snippet}`,
				resultType: "pages",
				trailing: resultMeta(hit.spaceName, hit.updatedAt),
				icon: DeliverySecure01Icon,
				onSelect: () => handleSelectPage(hit),
			});
		}
		for (const card of marketplaceResults) {
			items.push({
				id: `marketplace-${card.kind}-${card.id}`,
				group: "Marketplace",
				title: card.name,
				value: `${q} marketplace ${card.kind} ${card.id} ${card.description ?? ""} ${card.author ?? ""}`,
				resultType: "marketplace",
				trailing: card.pricing
					? formatPricingLabel(card.pricing)
					: marketplaceBrowseKindLabel(card.kind),
				icon: Package01Icon,
				onSelect: () => handleSelectMarketplace(card, q),
			});
		}
		// "Remember" is listed last so it's never the auto-highlighted default
		// Enter target for an unmatched query — pressing Enter on a stray search
		// should land on a real result, not silently create a junk memory.
		items.push({
			id: "remember-query",
			group: "Memory",
			title: `Remember "${q}"`,
			value: `remember ${q}`,
			icon: Add01Icon,
			onSelect: requestRemember,
		});
	}

	return items;
}
