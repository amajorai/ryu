import {
	OnboardingActions,
	OnboardingCta,
	OnboardingShell,
} from "@ryu/blocks/desktop/onboarding-shell.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { GlyphPicker } from "@ryu/ui/components/glyph-picker.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { Logo as GhostOrb } from "@ryu/ui/components/logo.tsx";
import { type SubmitEvent, useEffect, useState } from "react";
import { useRyuOnboardingPersona } from "@/src/components/onboarding/RyuOnboardingPersona.tsx";
import { personaToGlyphValue } from "@/src/lib/agent-persona.ts";
import { type Agent, fetchAgent, updateAgent } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { triggerAgentsRefresh } from "@/src/lib/core-refresh.ts";
import { buildRyuPersonalizationInput } from "@/src/lib/ryu-personalization.ts";

interface RyuPersonalizationStepProps {
	onContinue: () => void;
	onSkip: () => void;
	target: ApiTarget;
}

function errorMessage<TCause>(cause: TCause): string {
	return cause instanceof Error
		? cause.message
		: "Ryu couldn't load these settings. Try again.";
}

export function RyuPersonalizationStep({
	target,
	onContinue,
	onSkip,
}: RyuPersonalizationStepProps) {
	const { setPersona } = useRyuOnboardingPersona();
	const [agent, setAgent] = useState<Agent | null>(null);
	const [name, setName] = useState("Ryu");
	const [avatar, setAvatar] = useState<GlyphValue>(null);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [loadAttempt, setLoadAttempt] = useState(0);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setLoadError(null);
		void fetchAgent(target, "ryu")
			.then((currentAgent) => {
				if (cancelled) {
					return;
				}
				setAgent(currentAgent);
				setName(currentAgent.name || "Ryu");
				setAvatar(personaToGlyphValue(currentAgent.persona));
			})
			.catch((error) => {
				if (!cancelled) {
					setLoadError(errorMessage(error));
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [loadAttempt, target]);

	const handleSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!(agent && name.trim()) || submitting) {
			return;
		}
		setSubmitting(true);
		setSaveError(null);
		try {
			await updateAgent(
				target,
				"ryu",
				buildRyuPersonalizationInput(agent, name, avatar)
			);
			setPersona({ avatar, name: name.trim() });
			triggerAgentsRefresh();
			onContinue();
		} catch (error) {
			setSaveError(errorMessage(error));
		} finally {
			setSubmitting(false);
		}
	};

	const handleSkip = () => {
		setPersona({
			avatar: personaToGlyphValue(agent?.persona),
			name: agent?.name || "Ryu",
		});
		onSkip();
	};

	const locked = agent?.locked ?? false;
	const canSave = Boolean(
		agent && !locked && name.trim() && !loading && !submitting
	);

	return (
		<OnboardingShell
			avatar={
				<GlyphPicker
					allowed="agent"
					className="shrink-0"
					clearable={false}
					disabled={loading || !agent || locked || submitting}
					fallback={<GhostOrb size="64px" variant="outline" />}
					onChange={setAvatar}
					previewSize={64}
					title="Choose your agent avatar"
					value={avatar}
				/>
			}
			subtitle="Your default agent. You can change its name and avatar later."
			title={
				<>
					<Label className="sr-only" htmlFor="ryu-agent-name">
						Agent name
					</Label>
					<Input
						aria-label="Agent name"
						autoComplete="off"
						className="h-auto w-full text-center"
						disabled={loading || !agent || locked || submitting}
						id="ryu-agent-name"
						maxLength={60}
						onChange={(event) => setName(event.target.value)}
						placeholder="Ryu"
						value={name}
						variant="title"
					/>
				</>
			}
		>
			<div
				className="flex flex-col gap-4"
				data-testid="ryu-personalization-step"
			>
				{loading ? (
					<p
						aria-live="polite"
						className="text-center text-muted-foreground text-sm"
						role="status"
					>
						Loading your default agent…
					</p>
				) : null}
				{loadError ? (
					<div className="flex flex-col items-center gap-2" role="alert">
						<p className="text-center text-sm text-status-destructive">
							{loadError}
						</p>
						<Button
							onClick={() => setLoadAttempt((current) => current + 1)}
							size="sm"
							variant="outline"
						>
							Retry
						</Button>
					</div>
				) : null}
				{locked ? (
					<p
						className="text-center text-muted-foreground text-sm"
						role="status"
					>
						Ryu is locked on this node. You can change its settings later after
						unlocking it.
					</p>
				) : null}
				{saveError ? (
					<p
						className="text-center text-sm text-status-destructive"
						role="alert"
					>
						{saveError}
					</p>
				) : null}
				<form onSubmit={(event) => void handleSubmit(event)}>
					<OnboardingActions className="justify-center">
						<OnboardingCta
							disabled={submitting}
							onClick={handleSkip}
							tone="secondary"
							type="button"
						>
							Skip
						</OnboardingCta>
						<OnboardingCta disabled={!canSave} type="submit">
							Save and continue
						</OnboardingCta>
					</OnboardingActions>
				</form>
			</div>
		</OnboardingShell>
	);
}
