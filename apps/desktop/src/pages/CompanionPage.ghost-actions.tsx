import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { useCallback, useState } from "react";
import type { AskIntent } from "@/src/hooks/useAskScreen.ts";
import type { UseGhostActionResult } from "@/src/hooks/useGhostAction.ts";
import type { GhostActionInput, GhostActionKind } from "@/src/lib/api/mcp.ts";

/** Label shown on each action button. */
export const ACTION_LABELS = {
	explain: "Explain",
	summarize: "Summarize",
	translate: "Translate",
} satisfies Record<AskIntent, string>;

/** Max characters of selected text shown in the context pill. */
export const SELECTION_PREVIEW_MAX = 120;

// ── Ghost action config ────────────────────────────────────────────────────

export interface GhostActionDef {
	/** Short description shown in the confirmation panel. */
	description: (target?: string) => string;
	kind: GhostActionKind;
	label: string;
	/** When true, a target input is shown before confirmation. */
	needsTarget: boolean;
	/** Placeholder text for the target input. */
	targetPlaceholder?: string;
}

export const GHOST_ACTIONS: GhostActionDef[] = [
	{
		kind: "focus",
		label: "Focus App",
		needsTarget: true,
		targetPlaceholder: "App name (e.g. Finder)",
		description: (t) => `Bring "${t ?? "app"}" to the foreground.`,
	},
	{
		kind: "click",
		label: "Click Element",
		needsTarget: true,
		targetPlaceholder: "Element text or name",
		description: (t) => `Click the element matching "${t ?? "element"}".`,
	},
	{
		kind: "screenshot",
		label: "Screenshot",
		needsTarget: false,
		description: () => "Take a screenshot of the current screen.",
	},
];

// ── GhostActionPanel ──────────────────────────────────────────────────────

export interface GhostActionPanelProps {
	agentId: string | null;
	ghost: UseGhostActionResult;
	loadError: boolean;
	noAgentWarning: boolean;
	onRetryAgents: () => void;
}

export function GhostActionPanel({
	ghost,
	agentId,
	loadError,
	noAgentWarning,
	onRetryAgents,
}: GhostActionPanelProps) {
	const tl = useLiteralMessages();
	// Which action is staged for confirmation; null = none.
	const [staged, setStaged] = useState<GhostActionDef | null>(null);
	// Target text for actions that need it.
	const [targetText, setTargetText] = useState("");

	const handleActionClick = useCallback((def: GhostActionDef) => {
		setTargetText("");
		setStaged(def);
	}, []);

	const handleConfirm = useCallback(async () => {
		if (
			!(staged && agentId) ||
			ghost.executing ||
			(staged.needsTarget && !targetText.trim())
		) {
			return;
		}
		const input: GhostActionInput = {
			kind: staged.kind,
			target: staged.needsTarget ? targetText.trim() || undefined : undefined,
		};
		ghost.confirm(input);
		setStaged(null);
		await ghost.execute(agentId);
	}, [staged, targetText, agentId, ghost]);

	const handleCancel = useCallback(() => {
		setStaged(null);
		setTargetText("");
	}, []);

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-between">
				<span className="font-semibold text-sm">Do it</span>
				{(ghost.result || ghost.error) && (
					<Button
						onClick={ghost.reset}
						size="sm"
						type="button"
						variant="ghost-muted"
					>
						Clear
					</Button>
				)}
			</div>

			{loadError && (
				<div
					className="flex items-center justify-between gap-3 text-sm"
					role="alert"
				>
					<span className="text-muted-foreground">
						Couldn't reach your device to load its agents.
					</span>
					<Button
						onClick={onRetryAgents}
						size="sm"
						type="button"
						variant="outline"
					>
						Retry
					</Button>
				</div>
			)}

			{!loadError && noAgentWarning && (
				<p className="text-detail text-muted-foreground">
					No agents set up yet — add one on the Agents page to enable desktop
					actions.
				</p>
			)}

			{/* Action buttons */}
			{!staged && (
				<div className="flex gap-2">
					{GHOST_ACTIONS.map((def) => (
						<Button
							className="flex-1"
							disabled={ghost.executing || !agentId}
							key={def.kind}
							onClick={() => handleActionClick(def)}
							size="sm"
							type="button"
							variant="outline"
						>
							{def.label}
						</Button>
					))}
				</div>
			)}

			{/* Confirmation panel — the explicit approval gate (issue #201 AC2) */}
			{staged && (
				<div className="flex flex-col gap-2 rounded-xl bg-muted px-4 py-3">
					<p className="font-medium text-sm">
						{tl("Confirm: {label}", { label: staged.label })}
					</p>
					{staged.needsTarget && (
						<Input
							aria-label="Target"
							autoFocus
							onChange={(e) => setTargetText(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									handleConfirm().catch(() => undefined);
								}
								if (e.key === "Escape") {
									handleCancel();
								}
							}}
							placeholder={staged.targetPlaceholder}
							type="text"
							value={targetText}
						/>
					)}
					<p className="text-detail text-muted-foreground">
						{tl(
							"{description} This action will run on your desktop. Continue?",
							{
								description: staged.description(
									staged.needsTarget
										? targetText.trim() || undefined
										: undefined
								),
							}
						)}
					</p>
					<div className="flex gap-2">
						<Button
							className="flex-1"
							onClick={handleCancel}
							size="sm"
							type="button"
							variant="ghost"
						>
							Cancel
						</Button>
						<Button
							className="flex-1"
							disabled={staged.needsTarget && !targetText.trim()}
							onClick={() => {
								handleConfirm().catch(() => undefined);
							}}
							size="sm"
							type="button"
							variant="mono"
						>
							Run
						</Button>
					</div>
				</div>
			)}

			{/* Executing indicator */}
			{ghost.executing && (
				<p className="animate-skeleton text-detail text-muted-foreground">
					Running action…
				</p>
			)}

			{/* Result — success or failure reflected back into the overlay (AC3) */}
			{ghost.result && (
				<output
					className={`text-sm ${
						ghost.result.ok ? "text-foreground" : "text-status-destructive"
					}`}
				>
					{ghost.result.ok ? (
						<>
							<span className="font-medium">Done.</span>
							{isNativeText(ghost.result.output) &&
								ghost.result.output.trim() !== "" && (
									<p className="mt-1 whitespace-pre-wrap break-words text-detail text-muted-foreground">
										{ghost.result.output}
									</p>
								)}
						</>
					) : (
						<>
							<span className="font-medium">Failed: </span>
							{ghost.result.error ?? "Unknown error"}
						</>
					)}
				</output>
			)}

			{/* Network / Core error (before a result arrives) */}
			{ghost.error && !ghost.result && (
				<div className="text-sm text-status-destructive" role="alert">
					{ghost.error}
				</div>
			)}
		</div>
	);
}
