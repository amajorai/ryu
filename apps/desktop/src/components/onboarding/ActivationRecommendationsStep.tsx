import {
	OnboardingActions,
	OnboardingCta,
} from "@ryu/blocks/desktop/onboarding-shell.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from "@ryu/ui/components/item.tsx";
import type { ActivationRecommendation } from "@/src/lib/onboarding-activation.ts";
import { ActivationStepShell } from "./ActivationStepShell.tsx";

export function ActivationRecommendationsStep({
	busySlug,
	error,
	onPreview,
	onContinue,
	recommendations,
}: {
	busySlug: string | null;
	error?: string | null;
	onPreview: (recommendation: ActivationRecommendation) => void;
	onContinue: () => void;
	recommendations: readonly ActivationRecommendation[];
}) {
	return (
		<ActivationStepShell
			subtitle="Explore a task before connecting an app. Previews don't run work or use credits."
			title="What would you like Ryu to do?"
		>
			{recommendations.length > 0 ? (
				<ItemGroup variant="flush">
					{recommendations.map((recommendation) => (
						<Item className="px-0" key={recommendation.appSlug} size="sm">
							<ItemContent>
								<ItemTitle>{recommendation.title}</ItemTitle>
								<ItemDescription>
									{recommendation.appName} ·{" "}
									{recommendation.active
										? "Connected"
										: "Connect only if you choose this task"}
								</ItemDescription>
							</ItemContent>
							<ItemActions>
								<Button
									disabled={busySlug !== null}
									onClick={() => onPreview(recommendation)}
									size="sm"
									variant="outline"
								>
									Preview task
								</Button>
							</ItemActions>
						</Item>
					))}
				</ItemGroup>
			) : (
				<p className="text-center text-muted-foreground text-sm">
					Start with a general task using context you provide.
				</p>
			)}
			{error ? (
				<p className="text-sm text-status-destructive" role="alert">
					{error}
				</p>
			) : null}
			<OnboardingActions>
				<OnboardingCta
					disabled={busySlug !== null}
					onClick={onContinue}
					tone="secondary"
				>
					Preview a starting task
				</OnboardingCta>
			</OnboardingActions>
		</ActivationStepShell>
	);
}
