import { Button } from "@ryu/ui/components/button.tsx";
import {
	Card,
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card.tsx";
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
			subtitle="Explore a task before connecting an app. These previews do not run work or use credits."
			title="What would you like Ryu to do?"
		>
			<Card
				appearance="onboarding"
				borderTone="subtle"
				className="w-full max-w-2xl"
			>
				<CardHeader>
					<CardTitle>Choose an outcome</CardTitle>
				</CardHeader>
				<CardContent spacing="compact">
					{recommendations.map((recommendation) => (
						<div
							className="flex items-start gap-3 rounded-2xl border border-border/60 p-4"
							key={recommendation.appSlug}
						>
							<div className="min-w-0 flex-1">
								<p className="font-medium text-sm">{recommendation.title}</p>
								<p className="mt-1 text-muted-foreground text-xs">
									{recommendation.appName} ·{" "}
									{recommendation.active
										? "Connected"
										: "Connect only if you choose this task"}
								</p>
							</div>
							<Button
								disabled={busySlug !== null}
								onClick={() => onPreview(recommendation)}
								size="sm"
								variant="secondary"
							>
								Preview task
							</Button>
						</div>
					))}
					{recommendations.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							Start with a general task using context you provide.
						</p>
					) : null}
					{error ? (
						<p className="text-sm text-status-destructive" role="alert">
							{error}
						</p>
					) : null}
				</CardContent>
				<CardFooter appearance="onboarding-step" className="justify-end">
					<Button
						disabled={busySlug !== null}
						onClick={onContinue}
						variant="ghost"
					>
						Preview a starting task
					</Button>
				</CardFooter>
			</Card>
		</ActivationStepShell>
	);
}
