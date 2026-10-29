import {
	PlanBadge,
	type PlanTier,
	planTierLabel,
} from "@ryu/ui/components/plan-badge.tsx";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

const plans: PlanTier[] = [
	"pro",
	"plus",
	"max",
	"teams",
	"teams-lite",
	"business",
	"enterprise",
	"marketplace-membership",
	"desktop-license",
];
const root = document.getElementById("root");
if (!root) {
	throw new Error("Plan badge proof root is missing");
}

createRoot(root).render(
	<main
		className="dark min-h-screen bg-background p-10 text-foreground"
		data-testid="plan-badge-proof"
	>
		<section className="mx-auto max-w-xl overflow-hidden rounded-xl border bg-card">
			<header className="border-b p-6">
				<h1 className="font-semibold text-xl">Ryu plans</h1>
				<p className="mt-1 text-muted-foreground text-sm">Shared plan badges</p>
			</header>
			{plans.map((plan) => (
				<div
					className="flex items-center justify-between gap-8 border-b px-6 py-4 last:border-0"
					data-plan={plan}
					key={plan}
				>
					<span className="text-sm">{planTierLabel(plan)}</span>
					<div className="flex items-center gap-6">
						<PlanBadge plan={plan} size="sm" />
						<PlanBadge plan={plan} size="md" />
					</div>
				</div>
			))}
		</section>
	</main>
);
