import {
	OnboardingActions,
	OnboardingCta,
} from "@ryu/blocks/desktop/onboarding-shell.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { TextMorph } from "@ryu/ui/components/text-morph.tsx";
import { useEffect, useState } from "react";
import type {
	NodeSetupKind,
	ProfileJobStatus,
} from "@/src/lib/api/onboarding-profile.ts";
import { ContinueRow } from "./OnboardingSetupStep.parts.tsx";

export const PROFILE_LINES = [
	"Reviewing your connected sources",
	"Looking for patterns in what you do",
	"Learning how your agent group fits together",
	"Drafting useful memories",
	"Checking recommendations before sharing them",
];

export function ProfileSetup({
	alreadyBuilt,
	job,
	nodeSetupKind,
	startedAt,
	onStart,
	onSkip,
	onBackground,
	onCancel,
	onContinueAfterBackground,
}: {
	alreadyBuilt: boolean | null;
	job: ProfileJobStatus | null;
	nodeSetupKind: NodeSetupKind | null;
	onBackground: () => void;
	onCancel: () => void;
	onContinueAfterBackground: () => void;
	onSkip: () => void;
	onStart: () => void;
	startedAt: number | null;
}) {
	const tl = useLiteralMessages();
	const [lineIndex, setLineIndex] = useState(0);
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (!job || (job.state !== "queued" && job.state !== "building")) {
			return;
		}
		const interval = window.setInterval(() => {
			setLineIndex((current) => (current + 1) % PROFILE_LINES.length);
			setNow(Date.now());
		}, 1800);
		return () => window.clearInterval(interval);
	}, [job]);
	const elapsed = startedAt ? now - startedAt : 0;
	if (!job) {
		if (alreadyBuilt === null) {
			return (
				<div
					className="flex flex-col gap-4"
					data-testid="onboarding-profile-check"
				>
					<p className="text-muted-foreground text-sm">
						Ryu could not verify whether a profile already exists, so onboarding
						will not start another profile build.
					</p>
					<ContinueRow continueLabel="Continue" onContinue={onSkip} />
				</div>
			);
		}
		return (
			<div
				className="flex flex-col gap-4"
				data-testid="onboarding-profile-check"
			>
				<p className="text-muted-foreground text-sm">
					{alreadyBuilt
						? nodeSetupKind === "team"
							? "You already did this before. Ryu can rebuild shared company knowledge from your current connected sources and imported conversations."
							: "You already did this before. Ryu can rebuild your private profile from your current connected sources and imported conversations."
						: nodeSetupKind === "team"
							? "Ryu can create shared company knowledge from your connected sources and imported conversations. It will only draft facts and recommendations for you to review."
							: "Ryu can create a private starting profile from your connected sources and imported conversations. It will only draft facts and recommendations for you to review."}
				</p>
				{alreadyBuilt ? null : (
					<p className="text-pretty text-detail text-muted-foreground">
						<span className="text-status-warning">Heads up:</span> local models
						may produce a weaker setup. An ACP agent or the Ryu cloud model does
						better here.
					</p>
				)}
				<ContinueRow
					continueLabel={alreadyBuilt ? "Rebuild Profile" : "Build my profile"}
					onContinue={onStart}
					onSkip={onSkip}
				/>
			</div>
		);
	}
	if (job.state === "failed") {
		return (
			<div className="flex flex-col gap-4">
				<p className="font-medium text-sm">
					The profile build needs another try
				</p>
				<p className="text-detail text-muted-foreground">
					{job.error ?? "The agent could not finish the first draft."}
				</p>
				<ContinueRow
					continueLabel="Try again"
					onContinue={onStart}
					onSkip={onSkip}
				/>
			</div>
		);
	}
	if (job.state === "completed") {
		const suggestionCount = job.agentSuggestions.length;
		return (
			<div className="flex flex-col gap-4">
				<p className="font-medium text-sm">
					{suggestionCount > 0
						? tl(
								"Your profile and {count, plural, one {{countText} agent draft} other {{countText} agent drafts}} are ready",
								{ count: suggestionCount, countText: String(suggestionCount) }
							)
						: "Your starting profile is ready"}
				</p>
				<p className="text-detail text-muted-foreground">
					{nodeSetupKind === "team"
						? suggestionCount > 0
							? tl(
									"Ryu wrote shared company knowledge. You can review the source-backed draft in the new chat and choose which suggested agents to add."
								)
							: tl(
									"Ryu wrote shared company knowledge. You can review the source-backed draft in the new chat."
								)
						: suggestionCount > 0
							? tl(
									"Ryu wrote a private profile. You can review the source-backed draft in the new chat and choose which suggested agents to add."
								)
							: tl(
									"Ryu wrote a private profile. You can review the source-backed draft in the new chat."
								)}
				</p>
				<ContinueRow continueLabel="Continue" onContinue={onSkip} />
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-4">
			<div
				aria-live="polite"
				className="rounded-lg bg-muted px-4 py-3 text-sm"
				role="status"
			>
				<TextMorph duration={320} numbers={false}>
					{PROFILE_LINES[lineIndex]}
				</TextMorph>
			</div>
			<p className="text-detail text-muted-foreground">
				{job.background
					? "Your profile keeps building in the background. Wait here to review agent drafts when it finishes, or continue setup now."
					: "The connected content is read-only and treated as untrusted data. Recommendations never change your agents or external accounts automatically."}
			</p>
			<div className="flex items-center justify-between text-muted-foreground/70 text-xs tabular-nums">
				<span>
					{tl("{seconds}s elapsed", {
						seconds: String(Math.floor(elapsed / 1000)),
					})}
				</span>
				{elapsed >= 20_000 && !job.background ? (
					<Button onClick={onBackground} size="sm" variant="outline">
						Run in background
					</Button>
				) : null}
			</div>
			<OnboardingActions className="justify-between">
				<OnboardingCta onClick={onCancel} tone="secondary">
					Skip and cancel
				</OnboardingCta>
				{job.background ? (
					<OnboardingCta onClick={onContinueAfterBackground}>
						Continue setup
					</OnboardingCta>
				) : null}
			</OnboardingActions>
		</div>
	);
}
