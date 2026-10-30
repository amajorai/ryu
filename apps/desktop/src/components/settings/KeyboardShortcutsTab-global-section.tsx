import { useLiteralMessages } from "@ryu/i18n/react";
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
import { GlobalRow } from "./KeyboardShortcutsTab-global-row.tsx";
import type { GlobalWriteScope } from "./KeyboardShortcutsTab-global-scope.ts";
import { SettingsGroup, SettingsSection } from "./shared/settings-items.tsx";

interface GlobalShortcutsSectionProps {
	beginGlobalWrite: () => boolean;
	endGlobalWrite: () => void;
	globalScope: GlobalWriteScope;
	showGlobalAgentAsk: boolean;
	showGlobalDictation: boolean;
}

/** The OS-level "Global" shortcuts, editing the island / voice preferences. */
export function GlobalShortcutsSection({
	beginGlobalWrite,
	endGlobalWrite,
	globalScope,
	showGlobalAgentAsk,
	showGlobalDictation,
}: GlobalShortcutsSectionProps) {
	const tl = useLiteralMessages();
	return (
		<SettingsSection
			caption={
				ISLAND_ENABLED
					? "System-wide shortcuts work anywhere on your desktop and are managed by the island companion."
					: tl("{note} Shortcuts you set here are saved for when it ships.", {
							note: ISLAND_UNAVAILABLE_NOTE,
						})
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
							save={(target, acc) => setIslandCommandShortcut(target, acc)}
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
						load={(target) => getDictationPrefs(target).then((p) => p.shortcut)}
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
	);
}
