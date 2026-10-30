import {
	CloudServerIcon,
	CpuIcon,
	DollarCircleIcon,
	ServerStack01Icon,
	Share01Icon,
	ShieldKeyIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Alert,
	AlertDescription,
	AlertTitle,
} from "@ryu/ui/components/alert.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { PageHeader } from "@ryu/ui/components/page-header.tsx";
import { isLocalNode, useNodeStore } from "@/src/store/useNodeStore.ts";
import { ComputeFinder } from "./ComputeShareSurface-compute-finder.tsx";
import { ShareBuilder } from "./ComputeShareSurface-share-builder.tsx";

export type ComputeShareMode = "compute" | "share";

interface ContractItem {
	description: string;
	icon: IconSvgElement;
	title: string;
}

const COMPUTE_CONTRACT: readonly ContractItem[] = [
	{
		description:
			"A short-lived workcell, not a login to someone else's machine.",
		icon: ServerStack01Icon,
		title: "Bounded lease",
	},
	{
		description:
			"Inputs and outputs cross the job boundary; host files stay put.",
		icon: ShieldKeyIcon,
		title: "Private host",
	},
	{
		description:
			"The final lease receipt carries the measured duration and cost.",
		icon: DollarCircleIcon,
		title: "Clear receipt",
	},
];

const SHARE_CONTRACT: readonly ContractItem[] = [
	{
		description: "Ryu supervises the workcell and can stop it at any time.",
		icon: ShieldKeyIcon,
		title: "You stay in control",
	},
	{
		description: "Share a node, an approved agent, or both on your schedule.",
		icon: Share01Icon,
		title: "Choose the offer",
	},
	{
		description: "Usage will be metered before a provider payout is released.",
		icon: DollarCircleIcon,
		title: "Earn per run",
	},
];

function NodeSummary() {
	const activeNode = useNodeStore((state) => state.getActiveNode());
	const local = isLocalNode(activeNode);
	const label = activeNode.managed
		? "Ryu Cloud"
		: local
			? "This device"
			: activeNode.name;
	const kind = activeNode.managed
		? "Managed node"
		: local
			? "Local node"
			: "Remote node";

	return (
		<section
			aria-labelledby="exchange-current-node-heading"
			className="flex flex-col gap-3"
			data-testid="exchange-current-node"
		>
			<div>
				<h2
					className="font-semibold text-sm"
					id="exchange-current-node-heading"
				>
					Current node
				</h2>
				<p className="text-detail text-muted-foreground">
					Your active node is never silently turned into a provider.
				</p>
			</div>
			<div className="flex items-center gap-3 border-border border-y py-3">
				<HugeiconsIcon
					className="size-5 shrink-0 text-muted-foreground"
					icon={CloudServerIcon}
				/>
				<div className="min-w-0 flex-1">
					<p className="truncate text-sm">{label}</p>
					<p className="text-muted-foreground text-xs">{kind}</p>
				</div>
				<span className="shrink-0 text-muted-foreground text-xs">
					{local ? "Private" : "Connected"}
				</span>
			</div>
			<p className="flex items-start gap-2 text-detail text-muted-foreground">
				<HugeiconsIcon
					className="mt-0.5 size-3.5 shrink-0 text-status-success"
					icon={ShieldKeyIcon}
				/>
				{local
					? "This device stays private until you configure a safe network origin."
					: "The node stays yours; a lease receives only a scoped workcell."}
			</p>
		</section>
	);
}

/** The surface's one-line promise under the page header. No art, no kicker. */
function ExchangeHero({ mode }: { mode: ComputeShareMode }) {
	const compute = mode === "compute";
	return (
		<section className="flex flex-col gap-1" data-testid={`${mode}-hero`}>
			<h2 className="text-balance font-semibold text-lg tracking-tight">
				{compute
					? "Borrow a lane. Keep your node."
					: "Put an idle node to work."}
			</h2>
			<p className="max-w-xl text-pretty text-detail text-muted-foreground">
				{compute
					? "Rent governed CPU or GPU capacity for the next bounded run. The host supplies compute, not access to its machine."
					: "Share a clean Ryu workcell or an approved agent on your terms. You choose when it can earn."}
			</p>
		</section>
	);
}

/** A section of three plain facts: an icon, a title and one line each. */
function FactGrid({
	headingId,
	items,
	title,
	trailing,
}: {
	headingId: string;
	items: readonly {
		description: string;
		icon?: IconSvgElement;
		title: string;
	}[];
	title: string;
	trailing?: string;
}) {
	return (
		<section aria-labelledby={headingId} className="flex flex-col gap-3">
			<div className="flex items-baseline justify-between gap-4">
				<h2 className="font-semibold text-sm" id={headingId}>
					{title}
				</h2>
				{trailing ? (
					<span className="text-muted-foreground/70 text-xs">{trailing}</span>
				) : null}
			</div>
			<div className="grid gap-6 md:grid-cols-3">
				{items.map((item) => (
					<div className="flex flex-col gap-1" key={item.title}>
						{item.icon ? (
							<HugeiconsIcon
								className="mb-1 size-4 text-muted-foreground"
								icon={item.icon}
							/>
						) : null}
						<p className="font-medium text-sm">{item.title}</p>
						<p className="text-detail text-muted-foreground">
							{item.description}
						</p>
					</div>
				))}
			</div>
		</section>
	);
}

function ContractGrid({ mode }: { mode: ComputeShareMode }) {
	return (
		<FactGrid
			headingId={`${mode}-contract-heading`}
			items={mode === "compute" ? COMPUTE_CONTRACT : SHARE_CONTRACT}
			title={
				mode === "compute" ? "What a lane includes" : "What providers control"
			}
			trailing="Intended contract"
		/>
	);
}

function ShareSafety() {
	return (
		<FactGrid
			headingId="share-safety-heading"
			items={[
				{ description: "Never sent to a renter.", title: "Node token" },
				{ description: "Stay on the provider node.", title: "Host files" },
				{
					description: "Returned only to the lease owner.",
					title: "Job output",
				},
			]}
			title="The host boundary"
		/>
	);
}

export function ComputeShareSurface({ mode }: { mode: ComputeShareMode }) {
	const compute = mode === "compute";
	return (
		<div
			className="flex h-full min-h-0 flex-col"
			data-exchange-mode={mode}
			data-exchange-state="preview"
			data-testid={`${mode}-surface`}
		>
			<div className="scroll-fade min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 pt-6 pb-12">
					<header className="flex items-start justify-between gap-4">
						<PageHeader
							size="app"
							subtitle={
								compute
									? "Rent governed capacity for the next run."
									: "Earn from an idle node without giving up control."
							}
							title={compute ? "Compute" : "Share"}
						/>
						<Badge className="mt-1 shrink-0" variant="outline">
							Early access
						</Badge>
					</header>
					<ExchangeHero mode={mode} />
					{compute ? (
						<div className="grid gap-8 xl:grid-cols-[minmax(0,1.15fr)_minmax(300px,0.85fr)]">
							<ComputeFinder />
							<NodeSummary />
						</div>
					) : (
						<div className="grid gap-8 xl:grid-cols-[minmax(0,1.15fr)_minmax(300px,0.85fr)]">
							<ShareBuilder />
							<NodeSummary />
						</div>
					)}
					<ContractGrid mode={mode} />
					{!compute && <ShareSafety />}
					<Alert borderTone="subtle" variant="info">
						<HugeiconsIcon icon={compute ? CpuIcon : Share01Icon} />
						<AlertTitle>Exchange preview</AlertTitle>
						<AlertDescription>
							{compute
								? "This deployment has no live provider network yet. Filters and lease boundaries are ready for the next control-plane release."
								: "This deployment cannot publish a node yet. Provider enrollment, metering, and payout controls must land before sharing goes live."}
						</AlertDescription>
					</Alert>
				</div>
			</div>
		</div>
	);
}
