// Settings → Keyboard Shortcuts.
//
// The single place to see and customize every shortcut at once. In-app actions
// are edited through the @ryu/hotkeys registry (rebind / clear / reset, with live
// conflict detection); the reset-all button reverts them all to defaults. The
// OS-level "Global" shortcuts are edited in place too, writing the same island /
// voice preferences their dedicated tabs use, so this tab stays the one surface
// without forking the native re-registration logic.

import {
	type Chord,
	chordFromElectron,
	chordTokens,
	toElectronAccelerator,
} from "@ryu/hotkeys/chord";
import { useHotkeysAdmin } from "@ryu/hotkeys/react";
import { groupByCategory, type HotkeyAction } from "@ryu/hotkeys/registry";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@ryu/ui/components/alert-dialog.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { useState } from "react";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useApps } from "@/src/hooks/useApps.ts";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { usePluginShortcutOverrides } from "@/src/hooks/usePluginShortcutOverrides.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { DEFAULT_DICTATION_PREFS } from "@/src/lib/api/preferences.ts";
import {
	ISLAND_ENABLED,
	ISLAND_UNAVAILABLE_NOTE,
} from "@/src/lib/island-availability.ts";
import { ClipsQuickAttachSettings } from "./ClipsQuickAttachSettings.tsx";
import { ChordRecorder } from "./KeyboardShortcutsTab-chord-recorder.tsx";
import { useGlobalWriteScope } from "./KeyboardShortcutsTab-global-scope.ts";
import { GlobalShortcutsSection } from "./KeyboardShortcutsTab-global-section.tsx";
import { InAppRow } from "./KeyboardShortcutsTab-in-app-row.tsx";
import {
	QUICK_PREVIEW_MODIFIER_DESCRIPTION,
	QUICK_REPLY_MODIFIER_DESCRIPTION,
	QuickPreviewModifierRow,
	QuickReplyModifierRow,
} from "./KeyboardShortcutsTab-modifier-rows.tsx";
import { QuickCaptureSettings } from "./QuickCaptureSettings.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

export function KeyboardShortcutsTab() {
	const globalNode = useActiveNode();
	const globalTarget = toTarget(globalNode);
	const tl = useLiteralMessages();
	const { beginGlobalWrite, endGlobalWrite, globalScope } =
		useGlobalWriteScope(globalTarget);

	const { canUseNativeShell } = useAppSurface();
	const {
		registry,
		bindings,
		overrides,
		conflicts,
		setOverride,
		reset,
		resetAll,
	} = useHotkeysAdmin();

	const inAppGroups = groupByCategory(registry.filter((a) => !a.global));
	const { apps } = useApps();
	const { companions } = usePluginContributions();
	const pluginShortcuts = usePluginShortcutOverrides(globalTarget);
	const pluginOverrides = pluginShortcuts.overrides;
	const [resetDialogOpen, setResetDialogOpen] = useState(false);
	const [search, setSearch] = useState("");

	const shortcutApps = apps
		.filter((app) => app.enabled)
		.map((app) => {
			const companion = companions.find((entry) => entry.pluginId === app.id);
			const declared = companion?.shortcut ?? app.companion?.shortcut ?? null;
			return declared ? { app, companion, declared } : null;
		})
		.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
		.sort((a, b) => a.app.name.localeCompare(b.app.name));

	const query = search.trim().toLowerCase();
	const matchesSearch = (...values: Array<string | null | undefined>) =>
		query.length === 0 ||
		values.some((value) => value?.toLowerCase().includes(query) === true);
	const filteredInAppGroups = inAppGroups
		.map((group) => ({
			...group,
			actions: group.actions.filter((action) => {
				const binding = bindings.get(action.id);
				return matchesSearch(
					action.category,
					action.description,
					action.id,
					action.label,
					binding ? chordTokens(binding).join(" ") : "unbound"
				);
			}),
		}))
		.filter((group) => group.actions.length > 0);

	const matchesGlobalSearch = (
		label: string,
		description: string,
		accelerator: string
	) =>
		matchesSearch(
			"global",
			label,
			description,
			accelerator,
			accelerator.replaceAll("+", " ")
		);
	const showGlobalDictation = matchesGlobalSearch(
		"System-Wide Dictation",
		"Dictate into the focused app (Dictation plugin).",
		DEFAULT_DICTATION_PREFS.shortcut
	);
	const showGlobalAgentAsk = matchesGlobalSearch(
		"Agent Ask",
		"Speak a question; paste the agent answer (Dictation → Agent ask).",
		DEFAULT_DICTATION_PREFS.ask.shortcut
	);

	const visibleShortcutApps = shortcutApps.filter(
		({ app, companion, declared }) => {
			const actionId = `plugin:${app.id}`;
			const configured = Object.hasOwn(pluginOverrides, actionId)
				? pluginOverrides[actionId]
				: declared;
			return matchesSearch(
				"plugins and apps",
				app.name,
				app.id,
				companion?.label,
				declared,
				configured
			);
		}
	);
	const showPluginsSection =
		query.length === 0 ||
		(matchesSearch(
			"plugins and apps",
			"No enabled plugins or apps currently declare a shortcut."
		) &&
			(query.length > 0
				? shortcutApps.length === 0 || visibleShortcutApps.length > 0
				: true));
	const showQuickCapture = matchesSearch(
		"quick capture",
		"keep the selection with a double-tap of shift",
		"which shift",
		"input monitoring",
		"accessibility",
		"quests app",
		"permissions"
	);
	const clipsInstalled = apps.some(
		(app) => app.id === "@ryu/clips" && app.installed
	);
	const showClipsQuickAttach =
		clipsInstalled &&
		matchesSearch(
			"clips quick attach",
			"attach recent activity to a new chat",
			"command twice",
			"alt twice",
			"recent activity",
			"new chat"
		);
	const showQuickReply = matchesSearch(
		"chat",
		"quick reply",
		"sidebar",
		"click",
		"modifier",
		"alt",
		"option"
	);
	const showQuickPreview = matchesSearch(
		"chat",
		"quick preview",
		"preview",
		"sidebar",
		"click",
		"hold",
		"modifier",
		"shift",
		"telegram"
	);
	const hasMatches =
		filteredInAppGroups.length > 0 ||
		showGlobalDictation ||
		showGlobalAgentAsk ||
		(showPluginsSection &&
			(shortcutApps.length === 0 || visibleShortcutApps.length > 0)) ||
		showQuickCapture ||
		showClipsQuickAttach ||
		showQuickReply ||
		showQuickPreview;
	const hasChatGroup = filteredInAppGroups.some(
		(group) => group.category === "Chat"
	);

	const savePluginShortcut = (appId: string, chord: Chord | null) =>
		pluginShortcuts.save(appId, chord ? toElectronAccelerator(chord) : null);

	// Look up the labels of the OTHER actions a chord collides with, for a row.
	const conflictLabelsFor = (action: HotkeyAction): string[] => {
		const binding = bindings.get(action.id);
		if (!binding) {
			return [];
		}
		const ids = conflicts.get(binding);
		if (!ids) {
			return [];
		}
		return ids
			.filter((id) => id !== action.id)
			.map((id) => registry.find((a) => a.id === id)?.label ?? id);
	};

	return (
		<div className="flex h-full min-h-0 flex-col gap-4">
			<div className="flex items-center gap-2">
				<Input
					aria-label="Filter keyboard shortcuts"
					className="min-w-0 flex-1"
					data-testid="keyboard-shortcuts-filter"
					onChange={(event) => setSearch(event.target.value)}
					placeholder="Search"
					value={search}
				/>

				<AlertDialog
					onOpenChange={(open) => setResetDialogOpen(open)}
					open={resetDialogOpen}
				>
					<AlertDialogTrigger
						render={
							<Button
								data-testid="keyboard-shortcuts-reset-all"
								variant="outline"
							>
								Reset all to defaults
							</Button>
						}
					/>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>
								Reset all shortcuts to defaults?
							</AlertDialogTitle>
							<AlertDialogDescription>
								Every in-app shortcut returns to its default. Cleared and custom
								bindings are removed. This can't be undone.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction
								onClick={() => {
									resetAll();
									setResetDialogOpen(false);
								}}
							>
								Reset all to defaults
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</div>

			<div
				className="scroll-fade min-h-0 flex-1 overflow-y-auto pr-2"
				data-testid="keyboard-shortcuts-scroll"
			>
				<div className="space-y-6">
					{filteredInAppGroups.map((group) => (
						<SettingsSection key={group.category} title={group.category}>
							<SettingsGroup>
								{group.actions.map((action) => (
									<InAppRow
										action={action}
										binding={bindings.get(action.id) ?? null}
										conflictLabels={conflictLabelsFor(action)}
										hasOverride={Object.hasOwn(overrides, action.id)}
										key={action.id}
										onChange={(chord) => setOverride(action.id, chord)}
										onClear={() => setOverride(action.id, null)}
										onReset={() => reset(action.id)}
									/>
								))}
								{group.category === "Chat" && showQuickReply ? (
									<QuickReplyModifierRow
										description={QUICK_REPLY_MODIFIER_DESCRIPTION}
									/>
								) : null}
								{group.category === "Chat" && showQuickPreview ? (
									<QuickPreviewModifierRow
										description={QUICK_PREVIEW_MODIFIER_DESCRIPTION}
									/>
								) : null}
							</SettingsGroup>
						</SettingsSection>
					))}
					{(showQuickReply || showQuickPreview) && !hasChatGroup ? (
						<SettingsSection title="Chat">
							<SettingsGroup>
								{showQuickReply ? (
									<QuickReplyModifierRow
										description={QUICK_REPLY_MODIFIER_DESCRIPTION}
									/>
								) : null}
								{showQuickPreview ? (
									<QuickPreviewModifierRow
										description={QUICK_PREVIEW_MODIFIER_DESCRIPTION}
									/>
								) : null}
							</SettingsGroup>
						</SettingsSection>
					) : null}

					{canUseNativeShell && (showGlobalDictation || showGlobalAgentAsk) ? (
						<GlobalShortcutsSection
							beginGlobalWrite={beginGlobalWrite}
							endGlobalWrite={endGlobalWrite}
							globalScope={globalScope}
							showGlobalAgentAsk={showGlobalAgentAsk}
							showGlobalDictation={showGlobalDictation}
						/>
					) : null}

					{showPluginsSection ? (
						<SettingsSection
							caption={
								ISLAND_ENABLED
									? "Shortcuts contributed by enabled plugins and apps. Changes apply to the Island global shortcut bridge."
									: tl(
											"Shortcuts contributed by enabled plugins and apps. {note}",
											{
												note: ISLAND_UNAVAILABLE_NOTE,
											}
										)
							}
							title="Plugins and apps"
						>
							{pluginShortcuts.error ? (
								<div role="alert">
									Couldn't load plugin shortcuts.{" "}
									<Button
										onClick={() => {
											void pluginShortcuts.retry();
										}}
										size="sm"
										variant="ghost"
									>
										Retry plugin shortcuts
									</Button>
								</div>
							) : null}
							{shortcutApps.length === 0 ? (
								<p className="px-3 text-muted-foreground text-sm">
									No enabled plugins or apps currently declare a shortcut.
								</p>
							) : (
								visibleShortcutApps.map(({ app, companion, declared }) => {
									const actionId = `plugin:${app.id}`;
									const configured = Object.hasOwn(pluginOverrides, actionId)
										? pluginOverrides[actionId]
										: declared;
									return (
										<SettingsSection
											key={`${globalScope.id}:${app.id}`}
											title={app.name}
										>
											<SettingsGroup>
												<SettingsItem
													actions={
														<div className="flex items-center gap-1.5">
															<ChordRecorder
																disabled={pluginShortcuts.disabled}
																onChange={(chord) =>
																	savePluginShortcut(app.id, chord)
																}
																value={
																	configured
																		? chordFromElectron(configured)
																		: null
																}
															/>
															<Button
																disabled={
																	pluginShortcuts.disabled ||
																	!Object.hasOwn(pluginOverrides, actionId)
																}
																onClick={() => {
																	void pluginShortcuts.save(app.id, undefined);
																}}
																size="sm"
																variant="ghost"
															>
																Reset
															</Button>
														</div>
													}
													title={
														<span className="flex flex-col gap-0.5">
															<span>{companion?.label ?? app.name}</span>
															<span className="text-muted-foreground text-xs">
																{app.id}
															</span>
														</span>
													}
												/>
											</SettingsGroup>
										</SettingsSection>
									);
								})
							)}
						</SettingsSection>
					) : null}
					{/* The one "shortcut" that is not an accelerator: a bare-modifier double
			    tap, owned by the native layer rather than the hotkey registry. */}
					{canUseNativeShell && showQuickCapture ? (
						<QuickCaptureSettings />
					) : null}
					{canUseNativeShell && showClipsQuickAttach ? (
						<ClipsQuickAttachSettings />
					) : null}
					{query.length > 0 && !hasMatches ? (
						<p className="px-3 text-muted-foreground text-sm">
							{tl("No keyboard shortcuts match “{query}”.", {
								query: search.trim(),
							})}
						</p>
					) : null}
				</div>
			</div>
		</div>
	);
}
