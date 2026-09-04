import { Button } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import { ArrowRight, Check, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { ActivationStepShell } from "./ActivationStepShell.tsx";

export function ActivationOfferStep({
	checkoutOpened = false,
	dialog,
	error,
	organizationPlan = false,
	onConfirmCheckout,
	onContinue,
	onSkip,
	onStartCheckout,
	pending = false,
	subscribed,
}: {
	checkoutOpened?: boolean;
	dialog?: ReactNode;
	error?: string | null;
	onConfirmCheckout: () => void;
	onContinue: () => void;
	onSkip: () => void;
	onStartCheckout: () => void;
	pending?: boolean;
	organizationPlan?: boolean;
	subscribed: boolean;
}) {
	const offerDescription = organizationPlan
		? "The first month is $50. From month two onward, the five-seat Teams floor is $250/month."
		: "Ryu Pro is $49/month for one person. Choose Max later from Pricing if you need more capacity.";
	const checkoutLabel = organizationPlan
		? "Start first month for $50"
		: "Start Pro for $49/month";
	return (
		<>
			<ActivationStepShell
				subtitle="One secure checkout unlocks Ryu-managed work and your first agent task."
				title={subscribed ? "Your subscription is ready" : "Start with Ryu"}
			>
				<Card className="w-full max-w-xl border border-border/60">
					<CardHeader>
						<div className="flex items-center gap-2">
							<ShieldCheck className="size-5 text-primary" />
							<CardTitle>
								{subscribed ? "Ready to start" : "Start your first task"}
							</CardTitle>
						</div>
						<p className="text-muted-foreground text-sm">
							{subscribed
								? "Your existing subscription covers this workspace."
								: offerDescription}
						</p>
					</CardHeader>
					<CardContent className="space-y-3">
						{[
							"Ryu lives where you already work",
							"Connect apps and earn up to $10 in Ryu Fast bonus credits",
							"Create the first task only after subscription confirmation",
						].map((item) => (
							<div className="flex items-start gap-2 text-sm" key={item}>
								<Check className="mt-0.5 size-4 shrink-0 text-success" />
								<span>{item}</span>
							</div>
						))}
						{error ? (
							<p className="text-destructive text-sm" role="alert">
								{error}
							</p>
						) : null}
					</CardContent>
					<CardFooter className="flex-wrap justify-between gap-3 border-t">
						<Button onClick={onSkip} variant="ghost">
							Not now
						</Button>
						{subscribed ? (
							<Button disabled={pending} loading={pending} onClick={onContinue}>
								Continue to task <ArrowRight className="size-4" />
							</Button>
						) : (
							<Button
								disabled={pending}
								loading={pending}
								onClick={checkoutOpened ? onConfirmCheckout : onStartCheckout}
							>
								{checkoutOpened ? "I finished checkout" : checkoutLabel}
								<ArrowRight className="size-4" />
							</Button>
						)}
					</CardFooter>
				</Card>
			</ActivationStepShell>
			{dialog}
		</>
	);
}
