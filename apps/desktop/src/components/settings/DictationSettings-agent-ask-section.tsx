// apps/desktop/src/components/settings/DictationSettings-agent-ask-section.tsx
//
// The "Agent ask" section of the Dictation settings page: speak a question, run
// an agent, paste the answer.

import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { AgentSelectionField } from "@/components/agent-elements/input/agent-selection-field.tsx";
import type { useActiveTarget } from "@/src/hooks/useActiveNode.ts";
import {
	DEFAULT_DICTATION_ASK,
	type DictationMode,
	type DictationPrefs,
} from "@/src/lib/api/preferences.ts";
import {
	DICTATION_MODE_OPTIONS,
	type DictationPrefsUpdate,
} from "./DictationSettings-options.ts";
import { ShortcutCapture } from "./shared/ShortcutCapture.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

export function DictationAgentAskSection({
	nodeTarget,
	prefs,
	writePrefs,
}: {
	nodeTarget: ReturnType<typeof useActiveTarget>;
	prefs: DictationPrefs;
	writePrefs: (update: DictationPrefsUpdate) => void;
}) {
	return (
		<SettingsSection
			caption="Speak a question anywhere; an agent answers and the text is pasted into the focused app. Uses a separate shortcut from plain dictation."
			title="Agent ask"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							aria-label="Enable agent ask"
							checked={prefs.ask.enabled}
							onCheckedChange={(v) =>
								writePrefs((current) => ({
									...current,
									ask: { ...current.ask, enabled: v },
								}))
							}
						/>
					}
					description="Hold the agent-ask shortcut, ask a question, and paste the agent's answer."
					title="Agent ask"
				/>
				{prefs.ask.enabled ? (
					<SettingsItem
						actions={
							<ShortcutCapture
								ariaLabel="Set agent-ask shortcut"
								onChange={(acc) =>
									writePrefs((current) => ({
										...current,
										ask: { ...current.ask, shortcut: acc },
									}))
								}
								onReset={() =>
									writePrefs((current) => ({
										...current,
										ask: {
											...current.ask,
											shortcut: DEFAULT_DICTATION_ASK.shortcut,
										},
									}))
								}
								value={prefs.ask.shortcut}
							/>
						}
						description="Global key for agent-ask. Kept separate from the dictation shortcut."
						title="Agent-ask shortcut"
					/>
				) : null}
				{prefs.ask.enabled ? (
					<SettingsItem
						actions={
							<Select<DictationMode>
								items={DICTATION_MODE_OPTIONS}
								onValueChange={(v) =>
									writePrefs((current) => ({
										...current,
										ask: { ...current.ask, mode: v },
									}))
								}
								value={prefs.ask.mode}
							>
								<SelectTrigger
									aria-label="Agent-ask activation mode"
									className="h-8 w-56"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{DICTATION_MODE_OPTIONS.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description={
							prefs.ask.mode === "push-to-talk"
								? "Hold the shortcut to record; release to ask and paste the answer."
								: "Press once to start, again to stop, ask, and paste the answer."
						}
						title="Activation"
					/>
				) : null}
				{prefs.ask.enabled ? (
					<SettingsItem
						description="Prefer an agent when you want tool access (Spaces, Ghost, other apps). A model-only pick answers without tools."
						title="Agent"
					>
						<AgentSelectionField
							ariaLabel="Agent-ask agent or model"
							onChange={(selection) =>
								writePrefs((current) => ({
									...current,
									ask: { ...current.ask, selection },
								}))
							}
							placeholder="Default local model"
							target={nodeTarget}
							value={prefs.ask.selection}
						/>
					</SettingsItem>
				) : null}
			</SettingsGroup>
			{/* `bare`, outside the group — same reason as the cleanup prompt. */}
			{prefs.ask.enabled ? (
				<SettingsItem
					bare
					description="Instructions for the ask agent. It sees this plus your spoken question."
					title="Ask prompt"
				>
					<Textarea
						aria-label="Agent-ask prompt"
						className="min-h-24"
						onChange={(e) =>
							writePrefs((current) => ({
								...current,
								ask: { ...current.ask, prompt: e.target.value },
							}))
						}
						typography="small"
						value={prefs.ask.prompt}
					/>
				</SettingsItem>
			) : null}
		</SettingsSection>
	);
}
