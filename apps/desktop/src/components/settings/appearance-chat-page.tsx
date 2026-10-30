import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ryu/ui/components/collapsible.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { setUsageBarPrefs } from "@/src/hooks/useUsageBarPrefs.ts";
import { ToolDetailSlider } from "./appearance-level-sliders.tsx";
import type { AppearanceTabState } from "./appearance-tab-state.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

export function AppearanceChatPage({ state }: { state: AppearanceTabState }) {
	const {
		groupToolUses,
		setGroupToolUses,
		expandFileEdits,
		setExpandFileEdits,
		expandCommands,
		setExpandCommands,
		expandCodeBlocks,
		setExpandCodeBlocks,
		hideToolDetail,
		pinUserMessage,
		setPinUserMessage,
		openChatAtBottom,
		setOpenChatAtBottom,
		inferenceStats,
		setInferenceStats,
		toolDetailPreset,
		toolDetailStep,
		handleToolDetailStep,
		toolDetailAdvancedOpen,
		setToolDetailAdvancedOpen,
	} = state;
	return (
		<SettingsSection>
			<SettingsGroup>
				<SettingsItem
					actions={
						<ToolDetailSlider
							onStepChange={handleToolDetailStep}
							preset={toolDetailPreset}
							step={toolDetailStep}
						/>
					}
					description="How much of each reply shows. Fine-tune the pieces under Advanced."
					title="Detail level"
				/>
			</SettingsGroup>

			<Collapsible
				onOpenChange={setToolDetailAdvancedOpen}
				open={toolDetailAdvancedOpen}
			>
				<CollapsibleTrigger
					appearance="settings-detail"
					className="flex w-full items-center justify-between text-left"
				>
					<span>Advanced detail</span>
					<HugeiconsIcon
						className={cn(
							"size-4 shrink-0 transition-transform",
							toolDetailAdvancedOpen && "rotate-180"
						)}
						icon={ArrowDown01Icon}
					/>
				</CollapsibleTrigger>
				<CollapsibleContent spacing="settings-detail">
					{/* At None there are no tool rows left for the first three to
						    expand, so they are disabled rather than left as switches
						    that flip and change nothing. Their stored values are
						    untouched — step the ladder back up and they apply again
						    exactly as set. "Expand code blocks" stays live: it also
						    governs fenced code in the assistant's own reply. */}
					{hideToolDetail ? (
						<p className="pb-1 text-detail text-muted-foreground">
							Detail level is None, so the chat shows no tool calls to expand.
						</p>
					) : null}
					<SettingsGroup>
						<SettingsItem
							actions={
								<Switch
									checked={groupToolUses}
									disabled={hideToolDetail}
									id="group-tool-uses-toggle"
									onCheckedChange={setGroupToolUses}
								/>
							}
							description="Collapse consecutive tool calls into one summary row."
							title="Group tool uses"
						/>
						<SettingsItem
							actions={
								<Switch
									checked={expandFileEdits}
									disabled={hideToolDetail}
									id="expand-file-edits-toggle"
									onCheckedChange={setExpandFileEdits}
								/>
							}
							title="Show file edits expanded"
						/>
						<SettingsItem
							actions={
								<Switch
									checked={expandCommands}
									disabled={hideToolDetail}
									id="expand-commands-toggle"
									onCheckedChange={setExpandCommands}
								/>
							}
							description="When off, output is capped at a few lines."
							title="Auto-expand commands"
						/>
						<SettingsItem
							actions={
								// NOT disabled at None: this one reaches past tool rows
								// into fenced code inside the assistant's own markdown
								// (see markdown.tsx), which None still renders.
								<Switch
									checked={expandCodeBlocks}
									id="expand-code-blocks-toggle"
									onCheckedChange={setExpandCodeBlocks}
								/>
							}
							description="When off, long blocks are capped and scroll inside their own box."
							title="Expand code blocks"
						/>
					</SettingsGroup>
				</CollapsibleContent>
			</Collapsible>

			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							checked={pinUserMessage}
							id="pin-user-message-toggle"
							onCheckedChange={setPinUserMessage}
						/>
					}
					description="Keep your latest prompt at the top while you scroll a long reply."
					title="Pin user message while scrolling"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={openChatAtBottom}
							id="open-chat-at-bottom-toggle"
							onCheckedChange={setOpenChatAtBottom}
						/>
					}
					description="Jump to the newest message when you open a chat."
					title="Open chats at the latest message"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={inferenceStats}
							id="inference-stats-toggle"
							onCheckedChange={setInferenceStats}
						/>
					}
					description="Turns, tokens, speed, context and cost under the latest reply."
					title="Session stats"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}

export function AppearanceUsagePage({ state }: { state: AppearanceTabState }) {
	const { usageBarPrefs } = state;
	return (
		<SettingsSection caption="For subscription agents such as Claude Code, Codex and Copilot.">
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							checked={usageBarPrefs.visible}
							id="usage-meter-visible-toggle"
							onCheckedChange={(v) => setUsageBarPrefs({ visible: v })}
						/>
					}
					title="Show usage meter"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={usageBarPrefs.sidebar}
							id="usage-meter-sidebar-toggle"
							onCheckedChange={(v) => setUsageBarPrefs({ sidebar: v })}
						/>
					}
					description="Shown when Ryu can read that agent's provider credentials."
					title="Show in sidebar"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={usageBarPrefs.showBar}
							disabled={!usageBarPrefs.visible}
							id="usage-meter-bar-toggle"
							onCheckedChange={(v) => setUsageBarPrefs({ showBar: v })}
						/>
					}
					title="Show progress bar"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={usageBarPrefs.barStyle === "ring"}
							disabled={!(usageBarPrefs.visible && usageBarPrefs.showBar)}
							id="usage-meter-ring-toggle"
							onCheckedChange={(v) =>
								setUsageBarPrefs({ barStyle: v ? "ring" : "bar" })
							}
						/>
					}
					title="Circular progress ring"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={usageBarPrefs.showPercent}
							disabled={!usageBarPrefs.visible}
							id="usage-meter-percent-toggle"
							onCheckedChange={(v) => setUsageBarPrefs({ showPercent: v })}
						/>
					}
					title="Show percentage"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={usageBarPrefs.mode === "remaining"}
							disabled={!usageBarPrefs.visible}
							id="usage-meter-mode-toggle"
							onCheckedChange={(v) =>
								setUsageBarPrefs({ mode: v ? "remaining" : "used" })
							}
						/>
					}
					title="Show remaining instead of used"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}

export function AppearanceResetPage({ state }: { state: AppearanceTabState }) {
	const {
		appearanceResetConfirm,
		setAppearanceResetConfirm,
		resetAppearanceDefaults,
	} = state;
	return (
		<SettingsSection>
			<SettingsGroup>
				<SettingsItem
					actions={
						appearanceResetConfirm ? (
							<div className="flex shrink-0 items-center gap-2">
								<Button
									onClick={resetAppearanceDefaults}
									size="sm"
									variant="destructive"
								>
									Confirm reset
								</Button>
								<Button
									onClick={() => setAppearanceResetConfirm(false)}
									size="sm"
									variant="ghost"
								>
									Cancel
								</Button>
							</div>
						) : (
							<Button
								className="shrink-0"
								onClick={() => setAppearanceResetConfirm(true)}
								size="sm"
								variant="ghost"
							>
								Reset to defaults
							</Button>
						)
					}
					description="Saved custom theme presets are kept."
					title="Reset appearance"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}
