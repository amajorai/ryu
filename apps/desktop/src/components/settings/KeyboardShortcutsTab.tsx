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
	eventToChord,
	toElectronAccelerator,
} from "@ryu/hotkeys/chord";
import { useHotkeysAdmin } from "@ryu/hotkeys/react";
import { groupByCategory, type HotkeyAction } from "@ryu/hotkeys/registry";
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
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useApps } from "@/src/hooks/useApps.ts";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { usePluginShortcutOverrides } from "@/src/hooks/usePluginShortcutOverrides.ts";
import {
	QUICK_PREVIEW_MODIFIER_OPTIONS,
	useQuickPreviewModifier,
} from "@/src/hooks/useQuickPreviewModifier.ts";
import {
	QUICK_REPLY_MODIFIER_OPTIONS,
	useQuickReplyModifier,
} from "@/src/hooks/useQuickReplyModifier.ts";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	DEFAULT_DICTATION_PREFS,
	DEFAULT_ISLAND_COMMAND_SHORTCUT,
	DEFAULT_VOICE_PREFS,
	getDictationPrefs,
	getIslandCommandShortcut,
	getVoiceInputPrefs,
	setDictationPrefs,
	setIslandCommandShortcut,
	setVoiceInputPrefs,
} from "@/src/lib/api/preferences.ts";
import {
	ISLAND_ENABLED,
	ISLAND_UNAVAILABLE_NOTE,
} from "@/src/lib/island-availability.ts";
import { ClipsQuickAttachSettings } from "./ClipsQuickAttachSettings.tsx";
import { QuickCaptureSettings } from "./QuickCaptureSettings.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/** Render a chord as keycaps, or a muted "Unbound" when null. */
function ChordCaps({ chord }: { chord: Chord | null }) {
	if (!chord) {
		return <span className="text-muted-foreground text-xs">Unbound</span>;
	}
	return (
		<span className="flex items-center gap-1">
			{chordTokens(chord).map((token, index) => (
				<Kbd key={`${index}-${token}`}>{token}</Kbd>
			))}
		</span>
	);
}

interface ChordRecorderProps {
	conflicting?: boolean;
	disabled?: boolean;
	onChange: (chord: Chord) => void;
	testId?: string;
	value: Chord | null;
}

/** A keycap button that records the next chord in canonical cross-platform form. */
function ChordRecorder({
	disabled = false,
	value,
	onChange,
	conflicting,
	testId,
}: ChordRecorderProps) {
	const [capturing, setCapturing] = useState(false);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (disabled || !capturing) {
			return;
		}
		e.preventDefault();
		if (e.key === "Escape") {
			setCapturing(false);
			return;
		}
		const chord = eventToChord(e.nativeEvent);
		if (chord) {
			onChange(chord);
			setCapturing(false);
		}
	};

	return (
		<button
			className={`flex min-w-32 items-center justify-center gap-1 rounded-md bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring ${conflicting ? "ring-2 ring-destructive" : ""}`}
			data-testid={testId}
			disabled={disabled}
			onBlur={() => setCapturing(false)}
			onClick={() => setCapturing(true)}
			onKeyDown={handleKeyDown}
			type="button"
		>
			{capturing ? (
				<span className="text-muted-foreground text-xs">Press keys…</span>
			) : (
				<ChordCaps chord={value} />
			)}
		</button>
	);
}

interface InAppRowProps {
	action: HotkeyAction;
	binding: Chord | null;
	conflictLabels: string[];
	hasOverride: boolean;
	onChange: (chord: Chord) => void;
	onClear: () => void;
	onReset: () => void;
}

/** One editable in-app shortcut row. */
function InAppRow({
	action,
	binding,
	hasOverride,
	conflictLabels,
	onChange,
	onClear,
	onReset,
}: InAppRowProps) {
	return (
		<SettingsItem
			actions={
				<div className="flex items-center gap-1.5">
					<ChordRecorder
						conflicting={conflictLabels.length > 0}
						onChange={onChange}
						testId={`shortcut-recorder-${action.id}`}
						value={binding}
					/>
					<Button
						data-testid={`shortcut-clear-${action.id}`}
						disabled={binding === null}
						onClick={onClear}
						size="sm"
						variant="ghost"
					>
						Clear
					</Button>
					<Button
						data-testid={`shortcut-reset-${action.id}`}
						disabled={!hasOverride}
						onClick={onReset}
						size="sm"
						variant="ghost"
					>
						Reset
					</Button>
				</div>
			}
			title={
				<span className="flex flex-col gap-0.5">
					<span>{action.label}</span>
					{conflictLabels.length > 0 ? (
						<span className="text-status-destructive text-xs">
							Also bound to {conflictLabels.join(", ")}
						</span>
					) : null}
				</span>
			}
		/>
	);
}

interface GlobalRowProps {
	beginWrite: () => boolean;
	defaultAccelerator: string;
	description: string;
	endWrite: () => void;
	label: string;
	load: (target: ApiTarget) => Promise<string>;
	pendingElsewhere: boolean;
	readVersion: number;
	save: (target: ApiTarget, accelerator: string) => Promise<boolean>;
	target: ApiTarget;
}

/** A system-wide shortcut row, editing the real island/voice preference. */
function GlobalRow({
	label,
	description,
	defaultAccelerator,
	target,
	pendingElsewhere,
	readVersion,
	beginWrite,
	endWrite,
	load,
	save,
}: GlobalRowProps) {
	const [accelerator, setAccelerator] = useState(defaultAccelerator);
	const [loading, setLoading] = useState(true);
	const [readError, setReadError] = useState(false);
	const [reloadIndex, setReloadIndex] = useState(0);
	const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
	const [pending, setPending] = useState(false);
	const callbacks = useRef({ load, save });
	callbacks.current = { load, save };
	const alive = useRef(false);
	const pendingWrite = useRef(false);

	useEffect(() => {
		let current = true;
		alive.current = true;
		setLoading(true);
		setReadError(false);
		void callbacks.current
			.load(target)
			.then((value) => {
				if (current) {
					setAccelerator(value);
					setLoadedVersion(readVersion);
				}
			})
			.catch(() => {
				if (current) {
					setReadError(true);
					toast.error({ title: `Couldn't load ${label}` });
				}
			})
			.finally(() => {
				if (current) {
					setLoading(false);
				}
			});
		return () => {
			current = false;
			alive.current = false;
		};
	}, [
		target.url,
		target.token,
		target.userJwt,
		label,
		reloadIndex,
		readVersion,
	]);

	const persist = async (next: string) => {
		if (
			!alive.current ||
			loading ||
			loadedVersion !== readVersion ||
			readError ||
			pendingWrite.current ||
			!beginWrite()
		) {
			return;
		}
		pendingWrite.current = true;
		setPending(true);
		const previous = accelerator;
		setAccelerator(next);
		try {
			const ok = await callbacks.current.save(target, next);
			if (!ok) {
				throw new Error("Shortcut preference write was refused");
			}
		} catch {
			if (alive.current) {
				setAccelerator(previous);
				toast.error({ title: `Couldn't update ${label}` });
			}
		} finally {
			pendingWrite.current = false;
			endWrite();
			if (alive.current) {
				setPending(false);
			}
		}
	};

	return (
		<SettingsItem
			actions={
				<div className="flex items-center gap-1.5">
					<ChordRecorder
						disabled={
							loading ||
							loadedVersion !== readVersion ||
							readError ||
							pending ||
							pendingElsewhere
						}
						onChange={(chord) => persist(toElectronAccelerator(chord))}
						testId={`global-shortcut-recorder-${label.toLowerCase().replaceAll(" ", "-")}`}
						value={chordFromElectron(accelerator)}
					/>
					<Button
						data-testid={`global-shortcut-reset-${label.toLowerCase().replaceAll(" ", "-")}`}
						disabled={
							loading ||
							loadedVersion !== readVersion ||
							readError ||
							pending ||
							pendingElsewhere ||
							accelerator === defaultAccelerator
						}
						onClick={() => persist(defaultAccelerator)}
						size="sm"
						variant="ghost"
					>
						Reset
					</Button>
					{readError ? (
						<Button
							disabled={loading}
							onClick={() => setReloadIndex((index) => index + 1)}
							size="sm"
							variant="ghost"
						>
							Retry {label}
						</Button>
					) : null}
				</div>
			}
			title={
				<span className="flex flex-col gap-0.5">
					<span>{label}</span>
					<span className="text-muted-foreground text-xs">{description}</span>
				</span>
			}
		/>
	);
}

const QUICK_REPLY_MODIFIER_DESCRIPTION =
	"Hold this modifier while clicking a chat in the sidebar to open its floating quick-reply bar.";
const QUICK_PREVIEW_MODIFIER_DESCRIPTION =
	"Hold this modifier while clicking and holding a chat in the sidebar to preview its messages without opening it.";

interface ModifierRowProps {
	/**
	 * Footer caption for the row's card. The enclosing SettingsGroup reads it
	 * off THIS element, because it cannot see the SettingsItem inside the
	 * wrapper, so every call site passes it (see settings-items).
	 */
	description: string;
}

function QuickReplyModifierRow({ description }: ModifierRowProps) {
	const [modifier, setModifier] = useQuickReplyModifier();
	return (
		<SettingsItem
			actions={
				<Select
					onValueChange={(value) => {
						const option = QUICK_REPLY_MODIFIER_OPTIONS.find(
							(item) => item.value === value
						);
						if (option) {
							setModifier(option.value);
						}
					}}
					value={modifier}
				>
					<SelectTrigger
						aria-label="Quick reply click modifier"
						className="w-40"
						size="sm"
					>
						<SelectValue>
							{(value) =>
								QUICK_REPLY_MODIFIER_OPTIONS.find(
									(option) => option.value === value
								)?.label ?? value
							}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{QUICK_REPLY_MODIFIER_OPTIONS.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			}
			description={description}
			title="Quick reply click modifier"
		/>
	);
}

function QuickPreviewModifierRow({ description }: ModifierRowProps) {
	const [modifier, setModifier] = useQuickPreviewModifier();
	return (
		<SettingsItem
			actions={
				<Select
					onValueChange={(value) => {
						const option = QUICK_PREVIEW_MODIFIER_OPTIONS.find(
							(item) => item.value === value
						);
						if (option) {
							setModifier(option.value);
						}
					}}
					value={modifier}
				>
					<SelectTrigger
						aria-label="Quick preview click modifier"
						className="w-40"
						size="sm"
					>
						<SelectValue>
							{(value) =>
								QUICK_PREVIEW_MODIFIER_OPTIONS.find(
									(option) => option.value === value
								)?.label ?? value
							}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{QUICK_PREVIEW_MODIFIER_OPTIONS.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			}
			description={description}
			title="Quick preview click modifier"
		/>
	);
}

export function KeyboardShortcutsTab() {
	const globalNode = useActiveNode();
	const globalTarget = toTarget(globalNode);
	const globalScopeSequence = useRef(0);
	const globalResources = useRef<
		Array<{ target: ApiTarget; pending: number | null; version: number }>
	>([]);
	const globalScope = useMemo(() => {
		// Keep the shared complete-JSON write resource across A→B→A, but give
		// each mounted UI scope a new opaque id; credentials never enter keys.
		let resource = globalResources.current.find(
			({ target }) =>
				target.url === globalTarget.url &&
				target.token === globalTarget.token &&
				(target.userJwt ?? null) === (globalTarget.userJwt ?? null)
		);
		if (!resource) {
			resource = { target: globalTarget, pending: null, version: 0 };
			globalResources.current.push(resource);
		}
		return {
			id: ++globalScopeSequence.current,
			target: globalTarget,
			resource,
		};
	}, [globalTarget.url, globalTarget.token, globalTarget.userJwt]);
	const globalAlive = useRef(false);
	useEffect(() => {
		globalAlive.current = true;
		return () => {
			globalAlive.current = false;
		};
	}, []);
	const [, refreshGlobalControls] = useState(0);
	const beginGlobalWrite = () => {
		if (!globalAlive.current || globalScope.resource.pending !== null) {
			return false;
		}
		globalScope.resource.pending = globalScope.id;
		refreshGlobalControls((version) => version + 1);
		return true;
	};
	const endGlobalWrite = () => {
		if (globalScope.resource.pending !== globalScope.id) {
			return;
		}
		globalScope.resource.pending = null;
		globalScope.resource.version += 1;
		if (globalAlive.current) {
			refreshGlobalControls((version) => version + 1);
		}
	};

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
					size="lg"
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
								size="sm"
								variant="default"
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
						<SettingsSection
							caption={
								ISLAND_ENABLED
									? "System-wide shortcuts work anywhere on your desktop and are managed by the island companion."
									: `${ISLAND_UNAVAILABLE_NOTE} Shortcuts you set here are saved for when it ships.`
							}
							title="Global"
						>
							<SettingsGroup>
								{ISLAND_ENABLED ? (
									<>
										<GlobalRow
											beginWrite={beginGlobalWrite}
											defaultAccelerator={DEFAULT_ISLAND_COMMAND_SHORTCUT}
											description="Open the island command bar from anywhere."
											endWrite={endGlobalWrite}
											key={`${globalScope.id}:island-command`}
											label="Summon Command Bar"
											load={(target) => getIslandCommandShortcut(target)}
											pendingElsewhere={globalScope.resource.pending !== null}
											readVersion={globalScope.resource.version}
											save={(target, acc) =>
												setIslandCommandShortcut(target, acc)
											}
											target={globalScope.target}
										/>
										<GlobalRow
											beginWrite={beginGlobalWrite}
											defaultAccelerator={DEFAULT_VOICE_PREFS.shortcut}
											description="Hold to dictate a voice message into the island."
											endWrite={endGlobalWrite}
											key={`${globalScope.id}:push-to-talk`}
											label="Push-To-Talk"
											load={(target) =>
												getVoiceInputPrefs(target).then((p) => p.shortcut)
											}
											pendingElsewhere={globalScope.resource.pending !== null}
											readVersion={globalScope.resource.version}
											save={async (target, acc) => {
												const prefs = await getVoiceInputPrefs(target);
												return setVoiceInputPrefs(target, {
													...prefs,
													shortcut: acc,
												});
											}}
											target={globalScope.target}
										/>
									</>
								) : null}
								{showGlobalDictation ? (
									<GlobalRow
										beginWrite={beginGlobalWrite}
										defaultAccelerator={DEFAULT_DICTATION_PREFS.shortcut}
										description="Dictate into the focused app (Dictation plugin)."
										endWrite={endGlobalWrite}
										key={`${globalScope.id}:dictation`}
										label="System-Wide Dictation"
										load={(target) =>
											getDictationPrefs(target).then((p) => p.shortcut)
										}
										pendingElsewhere={globalScope.resource.pending !== null}
										readVersion={globalScope.resource.version}
										save={async (target, acc) => {
											const prefs = await getDictationPrefs(target);
											return setDictationPrefs(target, {
												...prefs,
												shortcut: acc,
											});
										}}
										target={globalScope.target}
									/>
								) : null}
								{showGlobalAgentAsk ? (
									<GlobalRow
										beginWrite={beginGlobalWrite}
										defaultAccelerator={DEFAULT_DICTATION_PREFS.ask.shortcut}
										description="Speak a question; paste the agent answer (Dictation → Agent ask)."
										endWrite={endGlobalWrite}
										key={`${globalScope.id}:ask`}
										label="Agent Ask"
										load={(target) =>
											getDictationPrefs(target).then((p) => p.ask.shortcut)
										}
										pendingElsewhere={globalScope.resource.pending !== null}
										readVersion={globalScope.resource.version}
										save={async (target, acc) => {
											const prefs = await getDictationPrefs(target);
											return setDictationPrefs(target, {
												...prefs,
												ask: { ...prefs.ask, shortcut: acc },
											});
										}}
										target={globalScope.target}
									/>
								) : null}
							</SettingsGroup>
						</SettingsSection>
					) : null}

					{showPluginsSection ? (
						<SettingsSection
							caption={
								ISLAND_ENABLED
									? "Shortcuts contributed by enabled plugins and apps. Changes apply to the Island global shortcut bridge."
									: `Shortcuts contributed by enabled plugins and apps. ${ISLAND_UNAVAILABLE_NOTE}`
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
							No keyboard shortcuts match “{search.trim()}”.
						</p>
					) : null}
				</div>
			</div>
		</div>
	);
}
