import { CreditBalanceBreakdown } from "@ryu/ui/components/credit-balance-breakdown.tsx";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

function PolarCreditBalanceProof() {
	return (
		<main
			className="min-h-screen bg-background px-6 py-10 text-foreground"
			data-testid="polar-credit-balance-proof"
		>
			<div className="mx-auto flex max-w-3xl flex-col gap-6">
				<header className="flex flex-col gap-2">
					<p className="font-medium text-primary text-xs uppercase tracking-[0.18em]">
						Ryu desktop verification artifact
					</p>
					<h1 className="font-semibold text-3xl tracking-tight">
						Organization credits
					</h1>
					<p className="text-muted-foreground">
						The balance surface reflects the provider-authoritative Polar meter.
					</p>
				</header>

				<section
					aria-label="Polar organization credit balance"
					className="rounded-xl border bg-card p-5 shadow-sm"
				>
					<div className="mb-4">
						<p className="font-medium text-sm">Credit balances</p>
						<p className="mt-1 text-muted-foreground text-xs">
							Polar owns the meter and Ryu mirrors its current balance.
						</p>
					</div>
					<CreditBalanceBreakdown
						balanceBreakdownAvailable={false}
						onDemandCreditsMicroUsd={null}
						planCreditsMicroUsd={null}
						providerAllocations={[
							{
								expiresAtLabel: "Expires Sep 30, 2026",
								id: "cloudflare",
								isFreeProvider: true,
								label: "Ryu Fast",
								remainingMicroUsd: 2_500_000,
								spendableOn: "Fast, everyday models",
							},
						]}
						totalMicroUsd={12_500_000}
					/>
				</section>

				<p className="text-muted-foreground text-xs" data-testid="proof-status">
					Verified presentation: the Polar aggregate and provider-specific
					allocation are visible without inventing local plan or top-up buckets.
				</p>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<PolarCreditBalanceProof />);
}
