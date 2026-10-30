import {
	OnboardingActions,
	OnboardingCta,
} from "@ryu/blocks/desktop/onboarding-shell.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { RadioGroup, RadioGroupItem } from "@ryu/ui/components/radio-group.tsx";
import { useState } from "react";
import {
	ONBOARDING_SOURCES,
	type OnboardingSource,
} from "@/src/lib/api/onboarding-activation.ts";
import { ActivationStepShell } from "./ActivationStepShell.tsx";

const SOURCE_LABELS = {
	community: "A community or event",
	friend: "A friend or colleague",
	newsletter: "A newsletter",
	other: "Somewhere else",
	podcast: "A podcast",
	search: "Search",
	social: "Social media",
	work: "My workplace",
	youtube: "YouTube",
} satisfies Readonly<Record<OnboardingSource, string>>;

export function AcquisitionSourceStep({
	busy = false,
	error,
	onContinue,
	onSkip,
}: {
	busy?: boolean;
	error?: string | null;
	onContinue: (source: OnboardingSource) => void;
	onSkip: () => void;
}) {
	const [source, setSource] = useState<OnboardingSource | null>(null);

	return (
		<ActivationStepShell
			subtitle="This helps us understand how people find Ryu."
			title="Where did you hear about us?"
		>
			<RadioGroup
				aria-label="Where did you hear about us?"
				onValueChange={(value) => {
					const selected = ONBOARDING_SOURCES.find(
						(source) => source === value
					);
					if (selected) {
						setSource(selected);
					}
				}}
				value={source ?? ""}
			>
				{ONBOARDING_SOURCES.map((value) => {
					const id = `onboarding-source-${value}`;
					return (
						<div className="flex items-center gap-3" key={value}>
							<RadioGroupItem id={id} value={value} />
							<Label htmlFor={id} typography="field-choice">
								{SOURCE_LABELS[value]}
							</Label>
						</div>
					);
				})}
			</RadioGroup>
			{error ? (
				<p className="text-sm text-status-destructive" role="alert">
					{error}
				</p>
			) : null}
			<OnboardingActions className="justify-between">
				<OnboardingCta disabled={busy} onClick={onSkip} tone="secondary">
					Skip for now
				</OnboardingCta>
				<OnboardingCta
					disabled={busy || source === null}
					loading={busy}
					onClick={() => {
						if (source) {
							onContinue(source);
						}
					}}
				>
					Continue
				</OnboardingCta>
			</OnboardingActions>
		</ActivationStepShell>
	);
}
