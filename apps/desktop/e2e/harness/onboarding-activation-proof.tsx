import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card.tsx";
import { PageHeader } from "@ryu/ui/components/page-header.tsx";
import { Check, PartyPopper } from "lucide-react";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ActivationOfferStep } from "@/src/components/onboarding/ActivationOfferStep.tsx";
import { ActivationRecommendationsStep } from "@/src/components/onboarding/ActivationRecommendationsStep.tsx";
import { ActivationTaskStep } from "@/src/components/onboarding/ActivationTaskStep.tsx";
import type {
	ComposioConnection,
	ComposioToolkit,
} from "@/src/lib/api/composio.ts";
import {
	activationStartAction,
	buildActivationRecommendations,
	buildActivationTaskDraft,
} from "@/src/lib/onboarding-activation.ts";
import "../../src/index.css";

type Stage = "apps" | "offer" | "started" | "task" | "own-model";

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
			<Card appearance="onboarding-success" className="w-full max-w-xl">
				<CardHeader>
					<div className="flex items-center gap-2 text-sm text-success">
						<PartyPopper className="size-4" />
						Task started
					</div>
					<CardTitle>Ryu started your first task</CardTitle>
					<p className="text-muted-foreground text-sm">{title}</p>
				</CardHeader>
				<CardContent spacing="comfortable">
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
			<Card
				appearance="onboarding"
				borderTone="subtle"
				className="w-full max-w-xl"
			>
				<CardHeader>
					<CardTitle>Ask the node owner to continue</CardTitle>
				</CardHeader>
				<CardContent status="muted">
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
	const [stage, setStage] = useState<Stage>("apps");
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
	const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
	const recommendations = useMemo(
		() => buildActivationRecommendations({ connections, toolkits }),
		[connections]
	);
	const task = useMemo(
		() =>
			buildActivationTaskDraft(
				selectedSlug
					? recommendations.filter((item) => item.appSlug === selectedSlug)
					: recommendations
			),
		[recommendations, selectedSlug]
	);

	if (!owner) {
		return <BlockedState />;
	}
	if (stage === "own-model") {
		return (
			<p data-testid="own-model-chat">
				Choose your model and context. The task is not sent automatically.
			</p>
		);
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
				</div>
				{stage === "apps" ? (
					<ActivationRecommendationsStep
						busySlug={null}
						onContinue={() => setStage("task")}
						onPreview={(item) => {
							setSelectedSlug(item.appSlug);
							setStage("task");
						}}
						recommendations={recommendations}
					/>
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
						onSkip={() => setStage("own-model")}
						onStartCheckout={() => setCheckoutOpened(true)}
						organizationPlan={organizationPlan}
						subscribed={subscribed}
					/>
				) : null}
				{stage === "task" ? (
					<ActivationTaskStep
						connected={recommendations.some(
							(item) => item.appSlug === task.appSlug && item.active
						)}
						draft={task}
						onBack={() => setStage("apps")}
						onConnect={async (accessLevel) => {
							if (!task.appSlug) {
								return;
							}
							setConnections((previous) => [
								...previous,
								{
									accessLevel,
									active: true,
									id: `${task.appSlug}-1`,
									status: "ACTIVE",
									toolkit: task.appSlug!,
								},
							]);
						}}
						onStart={() => {
							const action = activationStartAction({
								task,
								recommendations,
								managedInference: subscribed,
							});
							if (action === "checkout") {
								setStage("offer");
							}
							if (action === "execute") {
								setStage("started");
							}
						}}
						onUseOwnModel={() => setStage("own-model")}
						subscribed={subscribed}
					/>
				) : null}
			</div>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(<ProofApp />);
