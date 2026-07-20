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
} from "@ryu/ui/components/alert-dialog";
import { Button } from "@ryu/ui/components/button";
import { Kbd } from "@ryu/ui/components/kbd";
import { toast } from "@ryu/ui/components/sileo";
import { useCallback, useEffect, useState } from "react";
import { toTarget } from "@/src/lib/api/client.ts";
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
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

function activeTarget() {
	return toTarget(useNodeStore.getState().getActiveNode());
}

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
	onChange: (chord: Chord) => void;
	value: Chord | null;
}

/** A keycap button that records the next chord in canonical cross-platform form. */
function ChordRecorder({ value, onChange, conflicting }: ChordRecorderProps) {
	const [capturing, setCapturing] = useState(false);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (!capturing) {
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
						value={binding}
					/>
					<Button
						disabled={binding === null}
						onClick={onClear}
						size="sm"
						variant="ghost"
					>
						Clear
					</Button>
					<Button
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
						<span className="text-destructive text-xs">
							Also bound to {conflictLabels.join(", ")}
						</span>
					) : null}
				</span>
			}
		/>
	);
}

interface GlobalRowProps {
	defaultAccelerator: string;
	description: string;
	label: string;
	load: () => Promise<string>;
	save: (accelerator: string) => Promise<boolean>;
}

/** A system-wide shortcut row, editing the real island/voice preference. */
function GlobalRow({
	label,
	description,
	defaultAccelerator,
	load,
	save,
}: GlobalRowProps) {
	const [accelerator, setAccelerator] = useState<string>(defaultAccelerator);

	useEffect(() => {
		let active = true;
		load().then((value) => {
			if (active) {
				setAccelerator(value);
			}
		});
		return () => {
			active = false;
		};
	}, [load]);

	const persist = useCallback(
		async (next: string) => {
			setAccelerator(next);
			const ok = await save(next);
			if (!ok) {
				toast.error({ title: `Couldn't update ${label}` });
			}
		},
		[label, save]
	);

	return (
		<SettingsItem
			actions={
				<div className="flex items-center gap-1.5">
					<ChordRecorder
						onChange={(chord) => persist(toElectronAccelerator(chord))}
						value={chordFromElectron(accelerator)}
					/>
					<Button
						disabled={accelerator === defaultAccelerator}
						onClick={() => persist(defaultAccelerator)}
						size="sm"
						variant="ghost"
					>
						Reset
					</Button>
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

export function KeyboardShortcutsTab() {
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
		<div className="space-y-6">
			{inAppGroups.map((group, index) => (
				<SettingsSection
					headerAction={
						index === 0 ? (
							<AlertDialog>
								<AlertDialogTrigger
									render={
										<Button size="sm" variant="ghost">
											Reset all
										</Button>
									}
								/>
								<AlertDialogContent>
									<AlertDialogHeader>
										<AlertDialogTitle>Reset all shortcuts?</AlertDialogTitle>
										<AlertDialogDescription>
											Every in-app shortcut returns to its default. Cleared and
											custom bindings are removed. This can't be undone.
										</AlertDialogDescription>
									</AlertDialogHeader>
									<AlertDialogFooter>
										<AlertDialogCancel>Cancel</AlertDialogCancel>
										<AlertDialogAction onClick={resetAll}>
											Reset all
										</AlertDialogAction>
									</AlertDialogFooter>
								</AlertDialogContent>
							</AlertDialog>
						) : undefined
					}
					key={group.category}
					title={group.category}
				>
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
					</SettingsGroup>
				</SettingsSection>
			))}

			<SettingsSection
				caption="System-wide shortcuts work anywhere on your desktop and are managed by the island companion."
				title="Global"
			>
				<SettingsGroup>
					<GlobalRow
						defaultAccelerator={DEFAULT_ISLAND_COMMAND_SHORTCUT}
						description="Open the island command bar from anywhere."
						label="Summon command bar"
						load={() => getIslandCommandShortcut(activeTarget())}
						save={(acc) => setIslandCommandShortcut(activeTarget(), acc)}
					/>
					<GlobalRow
						defaultAccelerator={DEFAULT_VOICE_PREFS.shortcut}
						description="Hold to dictate a voice message into the island."
						label="Push-to-talk"
						load={() =>
							getVoiceInputPrefs(activeTarget()).then((p) => p.shortcut)
						}
						save={async (acc) => {
							const prefs = await getVoiceInputPrefs(activeTarget());
							return setVoiceInputPrefs(activeTarget(), {
								...prefs,
								shortcut: acc,
							});
						}}
					/>
					<GlobalRow
						defaultAccelerator={DEFAULT_DICTATION_PREFS.shortcut}
						description="Toggle inline dictation anywhere on the desktop."
						label="System-wide dictation"
						load={() =>
							getDictationPrefs(activeTarget()).then((p) => p.shortcut)
						}
						save={async (acc) => {
							const prefs = await getDictationPrefs(activeTarget());
							return setDictationPrefs(activeTarget(), {
								...prefs,
								shortcut: acc,
							});
						}}
					/>
				</SettingsGroup>
			</SettingsSection>
		</div>
	);
}
