import { Button } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import { PageHeader } from "@ryu/ui/components/page-header";
import { Check, CircleDollarSign, PartyPopper } from "lucide-react";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AcquisitionSourceStep } from "@/src/components/onboarding/AcquisitionSourceStep.tsx";
import { ActivationOfferStep } from "@/src/components/onboarding/ActivationOfferStep.tsx";
import { ActivationRecommendationsStep } from "@/src/components/onboarding/ActivationRecommendationsStep.tsx";
import { ActivationTaskStep } from "@/src/components/onboarding/ActivationTaskStep.tsx";
import { ActivationValueStep } from "@/src/components/onboarding/ActivationValueStep.tsx";
import type {
	ComposioConnection,
	ComposioToolkit,
} from "@/src/lib/api/composio.ts";
import {
	type ActivationRecommendation,
	activationRewardProgress,
	buildActivationRecommendations,
	buildActivationTaskDraft,
} from "@/src/lib/onboarding-activation.ts";
import "../../src/index.css";

type Stage = "apps" | "offer" | "source" | "started" | "task" | "value";

const toolkits: ComposioToolkit[] = [
	{
		description: "Email and inbox work",
		logo: null,
		name: "Gmail",
		slug: "gmail",
	},
	{
		description: "Team knowledge",
		logo: null,
		name: "Notion",
		slug: "notion",
	},
	{
		description: "Team conversations",
		logo: null,
		name: "Slack",
		slug: "slack",
	},
];

const initialConnections: ComposioConnection[] = [
	{
		accessLevel: "risk_based",
		active: true,
		id: "gmail-1",
		status: "ACTIVE",
		toolkit: "gmail",
	},
];

function TaskStarted({
	appName,
	title,
}: {
	appName: string | null;
	title: string;
}) {
	const appLabel = appName ?? "your connected apps";
	return (
		<div
			className="flex min-h-screen items-center justify-center bg-background p-8 text-foreground"
			data-testid="task-started"
		>
			<Card className="w-full max-w-xl border border-success/30">
				<CardHeader>
					<div className="flex items-center gap-2 text-sm text-success">
						<PartyPopper className="size-4" />
						Task started
					</div>
					<CardTitle>Ryu started your first task</CardTitle>
					<p className="text-muted-foreground text-sm">{title}</p>
				</CardHeader>
				<CardContent className="space-y-3">
					<div className="flex items-center gap-2 rounded-2xl bg-success/10 p-4 text-sm">
						<Check className="size-4 text-success" />
						Ryu is running the first task with {appLabel} context.
					</div>
					<p className="text-muted-foreground text-sm">
						Ryu lives where you already work — nothing to change.
					</p>
				</CardContent>
			</Card>
		</div>
	);
}

function BlockedState() {
	return (
		<div className="flex min-h-screen items-center justify-center bg-background p-8 text-foreground">
			<Card className="w-full max-w-xl border border-border/60">
				<CardHeader>
					<CardTitle>Ask the node owner to continue</CardTitle>
				</CardHeader>
				<CardContent className="text-muted-foreground text-sm">
					This shared node does not allow profile-derived recommendations, bonus
					claims, or first-task creation for individual members.
				</CardContent>
			</Card>
		</div>
	);
}

function ProofApp() {
	const params = new URLSearchParams(window.location.search);
	const paid = params.get("paid") === "true";
	const organizationPlan = params.get("organization") === "true";
	const owner = params.get("role") !== "member";
	const [stage, setStage] = useState<Stage>(paid ? "offer" : "source");
	const [checkoutOpened, setCheckoutOpened] = useState(false);
	const [subscribed, setSubscribed] = useState(paid);
	const [connections, setConnections] = useState(() =>
		params.get("notion") === "true"
			? [
					...initialConnections,
					{
						accessLevel: "risk_based",
						active: true,
						id: "notion-1",
						status: "ACTIVE",
						toolkit: "notion",
					},
				]
			: initialConnections
	);
	const [rewardCount, setRewardCount] = useState(1);
	const recommendations = useMemo(
		() => buildActivationRecommendations({ connections, toolkits }),
		[connections]
	);
	const task = useMemo(
		() => buildActivationTaskDraft(recommendations),
		[recommendations]
	);
	const reward = activationRewardProgress(rewardCount);

	if (!owner) {
		return <BlockedState />;
	}
	if (stage === "started") {
		return <TaskStarted appName={task.appName} title={task.title} />;
	}

	return (
		<div className="min-h-screen bg-background text-foreground">
			<div className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-5 p-6 md:p-10">
				<div className="flex items-center justify-between gap-4">
					<PageHeader
						stagger={false}
						subtitle="A product-state proof of the desktop activation runway."
						title="Onboarding activation"
					/>
					<div className="flex items-center gap-2 rounded-full bg-primary/10 px-3 py-2 text-primary text-xs">
						<CircleDollarSign className="size-3.5" />
						{reward.completed}/20 quests · $
						{(reward.amountMicroUsd / 1_000_000).toFixed(2)}
					</div>
				</div>
				{stage === "source" ? (
					<AcquisitionSourceStep onContinue={() => setStage("apps")} />
				) : null}
				{stage === "apps" ? (
					<ActivationRecommendationsStep
						busySlug={null}
						onConnect={async (recommendation: ActivationRecommendation) => {
							if (!recommendation.appSlug) {
								return;
							}
							setConnections((previous) => [
								...previous,
								{
									accessLevel: "risk_based",
									active: true,
									id: `${recommendation.appSlug}-1`,
									status: "ACTIVE",
									toolkit: recommendation.appSlug,
								},
							]);
							setRewardCount((count) => Math.min(20, count + 1));
						}}
						onContinue={() => setStage("value")}
						recommendations={recommendations}
						rewardProgress={reward}
					/>
				) : null}
				{stage === "value" ? (
					<ActivationValueStep onContinue={() => setStage("offer")} />
				) : null}
				{stage === "offer" ? (
					<ActivationOfferStep
						checkoutOpened={checkoutOpened}
						error={null}
						onConfirmCheckout={() => {
							setSubscribed(true);
							setStage("task");
						}}
						onContinue={() => setStage("task")}
						onSkip={() => setStage("task")}
						onStartCheckout={() => setCheckoutOpened(true)}
						organizationPlan={organizationPlan}
						subscribed={subscribed}
					/>
				) : null}
				{stage === "task" ? (
					<ActivationTaskStep
						draft={task}
						onStart={() => setStage("started")}
					/>
				) : null}
				{stage === "apps" ? (
					<Button onClick={() => setRewardCount(20)} variant="ghost">
						Test cap: fill bonus meter
					</Button>
				) : null}
			</div>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(<ProofApp />);
