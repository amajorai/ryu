import { Button } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import { BriefcaseBusiness, Check, Sparkles } from "lucide-react";
import { ActivationStepShell } from "./ActivationStepShell.tsx";

const HIRING_COSTS = [
	"Recruiting and ramp-up",
	"Salary and payroll",
	"Management time",
	"The tools around the role",
] as const;

export function ActivationValueStep({
	organizationPlan = false,
	onContinue,
}: {
	organizationPlan?: boolean;
	onContinue: () => void;
}) {
	const offer = organizationPlan
		? {
				amount: "$50",
				cadence: "first month",
				recurring: "$250/month from month two",
			}
		: {
				amount: "$49",
				cadence: "per month for one person",
				recurring: "Choose Max later if you need more capacity",
			};
	return (
		<ActivationStepShell
			subtitle="Ryu fits into the tools you already use, so the work can start without a new operating system."
			title="Put the work in perspective"
		>
			<Card className="w-full max-w-3xl border border-border/60">
				<CardHeader>
					<CardTitle>Ryu lives where you already work</CardTitle>
					<p className="text-muted-foreground text-sm">
						Nothing to change. Connect the work, choose the task, and keep your
						team in the same tools.
					</p>
				</CardHeader>
				<CardContent>
					<div className="grid gap-3 md:grid-cols-2">
						<div className="rounded-3xl border border-border/60 bg-muted/40 p-5">
							<div className="mb-4 flex items-center gap-2 font-medium">
								<BriefcaseBusiness className="size-4 text-muted-foreground" />
								Hire for the workflow
							</div>
							<ul className="space-y-3 text-muted-foreground text-sm">
								{HIRING_COSTS.map((item) => (
									<li className="flex items-center gap-2" key={item}>
										<span className="size-1.5 rounded-full bg-muted-foreground/60" />
										{item}
									</li>
								))}
							</ul>
						</div>
						<div className="rounded-3xl border border-primary/30 bg-primary/8 p-5">
							<div className="mb-4 flex items-center gap-2 font-medium">
								<Sparkles className="size-4 text-primary" />
								Start with Ryu
							</div>
							<div className="font-heading font-medium text-4xl tracking-tight">
								{offer.amount}
							</div>
							<p className="text-muted-foreground text-sm">{offer.cadence}</p>
							<div className="my-4 h-px bg-border/70" />
							<div className="flex items-center gap-2 font-medium text-sm">
								<Check className="size-4 text-success" />
								{offer.recurring}
							</div>
						</div>
					</div>
				</CardContent>
				<CardFooter className="justify-end border-t">
					<Button onClick={onContinue}>See your first task</Button>
				</CardFooter>
			</Card>
		</ActivationStepShell>
	);
}
