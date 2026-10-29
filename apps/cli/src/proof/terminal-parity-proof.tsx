/* @jsxImportSource @opentui/react */

import { Card } from "@/components/ui/card.tsx";
import { ThemeProvider, useTheme } from "@/components/ui/theme-provider.tsx";
import { ChatQueueBar } from "../components/ChatQueueBar.tsx";
import { ChatQueueOverlay } from "../components/ChatQueueOverlay.tsx";
import { TranscriptParts } from "../components/TranscriptParts.tsx";
import type { ChatPart } from "../core/chatTranscript.ts";
import { commandHelpRows } from "../core/commands.ts";
import {
	RYU_THEME_PRESETS,
	THEME_MODES,
	THEME_PRESET_IDS,
} from "../core/themePreferences.ts";
import { tf } from "../i18n/translate.ts";
import { ryuTheme } from "../ui/theme.ts";

const PROOF_QUEUE = [
	{
		createdAt: 1,
		id: "proof-1",
		options: { agentId: "builder" },
		text: "Inspect the failing tests and summarize the root cause",
	},
	{
		createdAt: 2,
		id: "proof-2",
		options: { teamId: "reviewers" },
		text: "Review the patch for edge cases before shipping",
	},
];

const PROOF_PARTS: ChatPart[] = [
	{
		type: "text",
		text: "The terminal keeps the transcript readable while work continues.",
	},
	{
		type: "reasoning",
		text: "Plan the smallest safe change, then verify the visible contract.",
	},
	{
		args: {
			path: "apps/cli/src/surfaces/chat/index.tsx",
			patch: "@@ -1 +1 @@",
		},
		name: "Edit",
		result: { status: "success", output: "Updated the chat surface" },
		status: "success",
		toolCallId: "proof-tool-1",
		type: "tool",
	},
	{
		todos: [
			{ content: "Render the queue", status: "completed" },
			{ content: "Persist the theme", status: "in_progress" },
		],
		type: "todo",
	},
];

export interface TerminalParityProofProps {
	showQueueOverlay?: boolean;
}

/**
 * Deterministic OpenTUI proof artifact for the terminal parity slice.
 *
 * It intentionally mounts the production queue, transcript, command metadata,
 * and theme definitions together so a captured frame proves the composed UX,
 * not merely isolated pure helpers.
 */
export function TerminalParityProof({
	showQueueOverlay = false,
}: TerminalParityProofProps) {
	return (
		<ThemeProvider theme={ryuTheme}>
			<ProofFrame showQueueOverlay={showQueueOverlay} />
		</ThemeProvider>
	);
}

function ProofFrame({ showQueueOverlay }: TerminalParityProofProps) {
	const theme = useTheme();
	return (
		<box
			backgroundColor={theme.colors.background}
			flexDirection="column"
			height="100%"
			padding={1}
			width="100%"
		>
			<box flexDirection="row" justifyContent="space-between">
				<text fg={theme.colors.primary}>
					<b>CLI terminal parity · proof artifact</b>
				</text>
				<text fg={theme.colors.mutedForeground}>OpenTUI / Chat</text>
			</box>
			<box flexDirection="row" flexGrow={1} gap={2} marginTop={1}>
				<box flexDirection="column" width={72}>
					<ChatQueueBar
						items={PROOF_QUEUE}
						onClear={() => undefined}
						onFocus={() => undefined}
					/>
					<box height={1} marginTop={1}>
						<text fg={theme.colors.primary}>
							<b>Transcript</b>
						</text>
					</box>
					<Card
						subtitle="collapsed reasoning · bounded tool output · todo progress"
						title=""
					>
						<TranscriptParts parts={PROOF_PARTS} />
					</Card>
				</box>
				<box flexDirection="column" width={48}>
					<Card
						subtitle="registry-backed autocomplete and /help"
						title="Commands"
					>
						{commandHelpRows()
							.slice(0, 10)
							.map((row) => (
								<text fg={theme.colors.foreground} key={row.name}>
									{`${row.usage} — ${row.description}`}
								</text>
							))}
					</Card>
					<Card subtitle="saved per active Core node" title="Themes">
						<text fg={theme.colors.mutedForeground}>
							{tf("Modes: {modes}", { modes: THEME_MODES.join(" · ") })}
						</text>
						{THEME_PRESET_IDS.map((preset) => (
							<text fg={theme.colors.foreground} key={preset}>
								{`● ${RYU_THEME_PRESETS[preset].label} (${preset})`}
							</text>
						))}
					</Card>
				</box>
			</box>
			{showQueueOverlay ? (
				<ChatQueueOverlay
					focused={false}
					items={PROOF_QUEUE}
					onCancel={() => undefined}
					onClear={() => undefined}
					onMove={() => undefined}
					onRemove={() => undefined}
					onSelect={() => undefined}
				/>
			) : null}
		</box>
	);
}
