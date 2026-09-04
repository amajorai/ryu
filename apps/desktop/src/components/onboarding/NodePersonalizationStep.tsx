import { Building03Icon, UserIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { Card, CardContent, CardFooter } from "@ryu/ui/components/card";
import { Label } from "@ryu/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ryu/ui/components/radio-group";
import { Textarea } from "@ryu/ui/components/textarea";
import { useState } from "react";
import type {
	NodeSetupKind,
	SaveNodeOnboardingStateInput,
} from "@/src/lib/api/onboarding-profile.ts";
import {
	DEFAULT_USER_PERSONALIZATION,
	type UserPersonalization,
} from "@/src/lib/api/preferences.ts";
import { ActivationStepShell } from "./ActivationStepShell.tsx";

interface NodePersonalizationStepProps {
	busy?: boolean;
	canConfigure?: boolean;
	companyContext?: string;
	error?: string | null;
	initialPersonalization?: UserPersonalization;
	initialSetupKind?: NodeSetupKind | null;
	onContinue: (
		input: SaveNodeOnboardingStateInput & {
			personalization: UserPersonalization;
		}
	) => void;
}

const SETUP_KIND_COPY: Record<
	NodeSetupKind,
	{ description: string; label: string }
> = {
	personal: {
		description: "Keep personal details private to this node.",
		label: "Personal use",
	},
	team: {
		description: "Build shared company knowledge for this node.",
		label: "Team or company use",
	},
};

export function NodePersonalizationStep({
	busy = false,
	canConfigure = true,
	companyContext: initialCompanyContext = "",
	error,
	initialPersonalization = DEFAULT_USER_PERSONALIZATION,
	initialSetupKind = null,
	onContinue,
}: NodePersonalizationStepProps) {
	const [setupKind, setSetupKind] = useState<NodeSetupKind | null>(
		initialSetupKind
	);
	const [companyContext, setCompanyContext] = useState(initialCompanyContext);
	const [personalization, setPersonalization] = useState(
		initialPersonalization
	);

	const canContinue = canConfigure && setupKind !== null;

	return (
		<ActivationStepShell
			subtitle="Set the context for this node"
			title="How will you use this node?"
		>
			<Card
				className="w-full max-w-xl border-0 shadow-none"
				data-testid="onboarding-node-setup"
			>
				<CardContent className="space-y-4">
					<RadioGroup
						aria-label="How will you use this node?"
						className="grid grid-cols-1 gap-3 sm:grid-cols-2"
						onValueChange={(value: string) => {
							if (value === "personal" || value === "team") {
								setSetupKind(value);
							}
						}}
						value={setupKind ?? ""}
					>
						{(["personal", "team"] as const).map((kind) => {
							const id = `onboarding-node-${kind}`;
							const copy = SETUP_KIND_COPY[kind];
							return (
								<div
									className="flex items-start gap-3 rounded-lg border border-border/60 p-3 transition-colors has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
									key={kind}
								>
									<RadioGroupItem
										aria-label={copy.label}
										id={id}
										value={kind}
									/>
									<div className="flex min-w-0 flex-1 items-start gap-3">
										<HugeiconsIcon
											className="mt-0.5 shrink-0 text-muted-foreground"
											icon={kind === "team" ? Building03Icon : UserIcon}
											size={18}
										/>
										<div className="min-w-0 space-y-1">
											<Label className="font-medium text-sm" htmlFor={id}>
												{copy.label}
											</Label>
											<p className="text-muted-foreground text-xs leading-relaxed">
												{copy.description}
											</p>
										</div>
									</div>
								</div>
							);
						})}
					</RadioGroup>
					{canConfigure ? null : (
						<p className="text-destructive text-sm" role="alert">
							This node still needs setup, but only a node administrator can
							choose its shared context.
						</p>
					)}

					{setupKind === "personal" ? (
						<div className="space-y-2">
							<Label htmlFor="onboarding-personal-information">
								More information about you
							</Label>
							<Textarea
								id="onboarding-personal-information"
								maxLength={2000}
								onChange={(event) =>
									setPersonalization({
										...personalization,
										aboutYou: event.target.value,
									})
								}
								value={personalization.aboutYou}
							/>
						</div>
					) : null}

					{setupKind === "team" ? (
						<div className="space-y-2">
							<Label htmlFor="onboarding-company-information">
								More information about your company
							</Label>
							<Textarea
								id="onboarding-company-information"
								maxLength={4000}
								onChange={(event) => setCompanyContext(event.target.value)}
								value={companyContext}
							/>
						</div>
					) : null}

					{error ? (
						<p className="text-destructive text-sm" role="alert">
							{error}
						</p>
					) : null}
				</CardContent>
				<CardFooter className="justify-end">
					<Button
						disabled={busy || !canContinue}
						loading={busy}
						onClick={() => {
							if (!setupKind) {
								return;
							}
							onContinue({
								companyContext,
								companyKnowledgeEnabled: setupKind === "team",
								completed: false,
								personalization,
								setupKind,
							});
						}}
					>
						Continue
					</Button>
				</CardFooter>
			</Card>
		</ActivationStepShell>
	);
}
