import {
	AiNetworkIcon,
	Building03Icon,
	Key01Icon,
	Wallet01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlanBadge } from "@ryu/ui/components/plan-badge.tsx";
import { createRoot } from "react-dom/client";
import {
	OrgBillingContextView,
	type OrgBillingContextViewProps,
} from "../../src/components/billing/OrgBillingContext.tsx";
import "../../src/index.css";

const org: OrgBillingContextViewProps = {
	organizationName: "Northstar Studio",
	plan: "teams",
	description:
		"Shared credits for managed inference, top-ups, and organization usage.",
};

function ProofRow({
	children,
	icon,
	title,
}: {
	children: React.ReactNode;
	icon: React.ReactNode;
	title: string;
}) {
	return (
		<div className="flex gap-3 border-b px-4 py-3 last:border-0">
			<span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
				{icon}
			</span>
			<div className="min-w-0">
				<p className="font-medium text-sm">{title}</p>
				<p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
					{children}
				</p>
			</div>
		</div>
	);
}

function Proof() {
	return (
		<main
			className="min-h-screen bg-background px-6 py-10 text-foreground"
			data-testid="org-billing-context-proof"
		>
			<div className="mx-auto max-w-2xl space-y-6">
				<header className="space-y-2">
					<p className="font-medium text-primary text-xs uppercase tracking-(--tracking-section)">
						Ryu desktop verification artifact
					</p>
					<h1 className="font-semibold text-3xl tracking-tight">
						Organization billing context
					</h1>
					<p className="text-muted-foreground">
						The plan and every managed-credit path now point at the
						organization, not the person who opened the app.
					</p>
				</header>

				<section aria-label="Organization picker" className="space-y-3">
					<p className="font-medium text-sm">Active organization</p>
					<div className="rounded-xl border bg-card p-3 shadow-sm">
						<div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2">
							<HugeiconsIcon
								className="size-4 text-primary"
								icon={Building03Icon}
							/>
							<span className="min-w-0 flex-1 truncate font-medium text-sm">
								{org.organizationName}
							</span>
							<PlanBadge plan={org.plan} size="sm" />
						</div>
						<p className="mt-2 px-1 text-muted-foreground text-xs">
							The plan badge is beside the active organization in org pickers;
							the account trigger carries identity only.
						</p>
					</div>
				</section>

				<section
					aria-label="Organization plan and wallet"
					className="space-y-3"
				>
					<p className="font-medium text-sm">Credits and plan display</p>
					<OrgBillingContextView {...org} />
				</section>

				<section
					aria-label="Billing ownership rules"
					className="overflow-hidden rounded-xl border bg-card shadow-sm"
				>
					<ProofRow
						icon={<HugeiconsIcon className="size-4" icon={Wallet01Icon} />}
						title="Ryu managed inference"
					>
						Spends{" "}
						<strong className="font-medium text-foreground">
							Northstar Studio&apos;s shared Ryu credits
						</strong>
						.
					</ProofRow>
					<ProofRow
						icon={<HugeiconsIcon className="size-4" icon={Key01Icon} />}
						title="BYOK provider balance"
					>
						Belongs to the provider key stored on this node; it is separate from
						Ryu organization credits.
					</ProofRow>
					<ProofRow
						icon={<HugeiconsIcon className="size-4" icon={AiNetworkIcon} />}
						title="Self-hosted node passthrough"
					>
						The saved <code>rgw_…</code> token remains bound to its issuing
						organization. Switching the active organization does not retarget
						the node; replace the token to move it.
					</ProofRow>
				</section>

				<p className="text-muted-foreground text-xs" data-testid="proof-status">
					Verified presentation: org plan badge, shared org wallet, separate
					BYOK balance, and token-owned node billing are visible together.
				</p>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Proof />);
}
