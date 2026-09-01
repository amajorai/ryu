import { Button } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import {
	Progress,
	ProgressLabel,
	ProgressValue,
} from "@ryu/ui/components/progress";
import { Check, ExternalLink, Gift, PlugZap } from "lucide-react";
import { useState } from "react";
import { ConnectionPermissionDialog } from "@/src/components/marketplace/ConnectionPermissionDialog.tsx";
import type { ConnectionAccessLevel } from "@/src/lib/connection-permissions.ts";
import type { ActivationRecommendation } from "@/src/lib/onboarding-activation.ts";
import { ActivationStepShell } from "./ActivationStepShell.tsx";

export function ActivationRecommendationsStep({
	busySlug,
	error,
	onConnect,
	onContinue,
	recommendations,
	rewardProgress,
}: {
	busySlug: string | null;
	error?: string | null;
	onConnect: (
		recommendation: ActivationRecommendation,
		accessLevel: ConnectionAccessLevel
	) => Promise<void>;
	onContinue: () => void;
	recommendations: readonly ActivationRecommendation[];
	rewardProgress: { completed: number; remaining: number };
}) {
	const [pendingRecommendation, setPendingRecommendation] =
		useState<ActivationRecommendation | null>(null);
	const percentage = Math.round((rewardProgress.completed / 20) * 100);

	return (
		<ActivationStepShell
			subtitle="Connect the tools that already hold your work. Each new connection earns $0.50 in Ryu Fast bonus credits."
			title="Recommended for you"
		>
			<Card className="w-full max-w-2xl border border-border/60">
				<CardHeader>
					<div className="flex items-start justify-between gap-4">
						<CardTitle>Connect your work</CardTitle>
						<div className="flex items-center gap-1.5 text-muted-foreground text-xs">
							<Gift className="size-3.5" />
							<span>Up to $10 bonus</span>
						</div>
					</div>
					<Progress
						aria-label={`${rewardProgress.completed} of 20 bonus-credit connection quests complete`}
						className="mt-4"
						value={percentage}
					>
						<ProgressLabel>Bonus-credit quests</ProgressLabel>
						<ProgressValue>
							{() =>
								`${rewardProgress.completed}/20 · $${(
									rewardProgress.completed * 0.5
								).toFixed(2)}`
							}
						</ProgressValue>
					</Progress>
				</CardHeader>
				<CardContent className="space-y-2">
					{recommendations.length === 0 ? (
						<div className="rounded-2xl bg-muted/60 px-4 py-5 text-muted-foreground text-sm">
							No app catalog is available right now. You can continue and start
							with a general task.
						</div>
					) : (
						recommendations.map((recommendation) => (
							<div
								className="flex items-center gap-3 rounded-2xl border border-border/60 bg-background/60 p-3"
								key={recommendation.appSlug}
							>
								{recommendation.logo ? (
									// biome-ignore lint/performance/noImgElement: Composio supplies the app logo URL.
									<img
										alt=""
										className="size-9 rounded-xl object-contain"
										height={36}
										src={recommendation.logo}
										width={36}
									/>
								) : (
									<div className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
										<PlugZap className="size-4" />
									</div>
								)}
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<p className="truncate font-medium text-sm">
											{recommendation.appName}
										</p>
										{recommendation.active ? (
											<span className="inline-flex items-center gap-1 text-success text-xs">
												<Check className="size-3" /> Connected
											</span>
										) : null}
									</div>
									<p className="truncate text-muted-foreground text-xs">
										{recommendation.reason}
									</p>
								</div>
								{recommendation.active ? (
									<span className="text-muted-foreground text-xs">Ready</span>
								) : (
									<Button
										disabled={busySlug !== null}
										loading={busySlug === recommendation.appSlug}
										onClick={() => setPendingRecommendation(recommendation)}
										size="sm"
										variant="secondary"
									>
										Connect · +$0.50
										<ExternalLink className="size-3.5" />
									</Button>
								)}
							</div>
						))
					)}
					{error ? (
						<p className="text-destructive text-sm" role="alert">
							{error}
						</p>
					) : null}
				</CardContent>
				<CardFooter className="justify-end border-t">
					<Button onClick={onContinue}>Continue</Button>
				</CardFooter>
			</Card>
			<ConnectionPermissionDialog
				connectionName={pendingRecommendation?.appName ?? "this integration"}
				connectionType="Composio"
				onConfirm={async (accessLevel) => {
					if (!pendingRecommendation) {
						return;
					}
					await onConnect(pendingRecommendation, accessLevel);
					setPendingRecommendation(null);
				}}
				onOpenChange={(open) => {
					if (!open) {
						setPendingRecommendation(null);
					}
				}}
				open={pendingRecommendation !== null}
			/>
		</ActivationStepShell>
	);
}
