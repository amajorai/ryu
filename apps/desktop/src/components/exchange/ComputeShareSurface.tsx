import {
	ArrowRight01Icon,
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
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card.tsx";
import { PageHeader } from "@ryu/ui/components/page-header.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import { useMemo, useState } from "react";
import { shareOriginsForNode } from "@/src/lib/api/node-share.ts";
import { isLocalNode, useNodeStore } from "@/src/store/useNodeStore.ts";

export type ComputeShareMode = "compute" | "share";

type ComputeWorkload = "any" | "cpu" | "gpu";
type LeaseDuration = "15m" | "1h" | "4h";
type ShareOffer = "compute" | "agent";
type ShareAvailability = "idle" | "schedule";

const WORKLOAD_OPTIONS: readonly { label: string; value: ComputeWorkload }[] = [
	{ label: "Any lane", value: "any" },
	{ label: "CPU", value: "cpu" },
	{ label: "GPU", value: "gpu" },
];

const LEASE_OPTIONS: readonly { label: string; value: LeaseDuration }[] = [
	{ label: "15 minutes", value: "15m" },
	{ label: "1 hour", value: "1h" },
	{ label: "4 hours", value: "4h" },
];

const OFFER_OPTIONS: readonly { label: string; value: ShareOffer }[] = [
	{ label: "Compute lane", value: "compute" },
	{ label: "Hosted agent", value: "agent" },
];

const AVAILABILITY_OPTIONS: readonly {
	label: string;
	value: ShareAvailability;
}[] = [
	{ label: "When idle", value: "idle" },
	{ label: "On a schedule", value: "schedule" },
];

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
		<Card
			borderTone="subtle"
			data-testid="exchange-current-node"
			elevation="flat"
		>
			<CardHeader>
				<CardTitle>Current node</CardTitle>
				<CardDescription>
					Your active node is never silently turned into a provider.
				</CardDescription>
			</CardHeader>
			<CardContent spacing="relaxed">
				<div className="flex items-center gap-3 rounded-2xl bg-muted/45 p-4">
					<div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-background text-foreground shadow-sm">
						<HugeiconsIcon className="size-5" icon={CloudServerIcon} />
					</div>
					<div className="min-w-0 flex-1">
						<p className="truncate font-medium text-sm">{label}</p>
						<p className="text-muted-foreground text-xs">{kind}</p>
					</div>
					<Badge variant={local ? "secondary" : "outline"}>
						{local ? "Private" : "Connected"}
					</Badge>
				</div>
				<div className="flex items-start gap-2.5 text-muted-foreground text-sm leading-5">
					<HugeiconsIcon
						className="mt-0.5 size-4 shrink-0 text-status-success"
						icon={ShieldKeyIcon}
					/>
					<p>
						{local
							? "This device stays private until you explicitly configure a safe network origin."
							: "The node remains yours; an exchange lease would receive only a scoped workcell."}
					</p>
				</div>
			</CardContent>
		</Card>
	);
}

function ExchangeHero({ mode }: { mode: ComputeShareMode }) {
	const compute = mode === "compute";
	return (
		<section
			className="grid overflow-hidden rounded-4xl bg-foreground text-background lg:grid-cols-[minmax(0,1fr)_minmax(15rem,0.72fr)]"
			data-testid={`${mode}-hero`}
		>
			<div className="p-6 lg:p-8">
				<p className="type-caption font-mono text-background/55 uppercase tracking-(--tracking-exchange-kicker)">
					{compute ? "Ryu Compute" : "Ryu Share"}
				</p>
				<h2 className="mt-4 max-w-xl font-heading font-medium text-3xl tracking-tight lg:text-4xl">
					{compute
						? "Borrow a lane. Keep your node."
						: "Put an idle node to work."}
				</h2>
				<p className="mt-3 max-w-xl text-background/70 text-sm leading-6">
					{compute
						? "Rent governed CPU or GPU capacity for the next bounded run. The host supplies compute, not access to its machine."
						: "Share a clean Ryu workcell or an approved agent on your terms. You choose when it can earn."}
				</p>
				<div className="mt-6 flex flex-wrap gap-2">
					<Badge appearance="exchange-hero" variant="outline">
						{compute ? "No host login" : "Pause any time"}
					</Badge>
				</div>
			</div>
			<div
				aria-hidden="true"
				className="relative hidden min-h-64 overflow-hidden border-background/10 border-l bg-background/[0.03] lg:block"
			>
				<div className="absolute inset-0 flex items-center justify-center">
					<div className="relative size-48">
						<div className="absolute inset-2 rounded-full border border-background/15" />
						<div className="absolute inset-10 rounded-full border border-background/15" />
						<span className="absolute top-8 left-10 size-2 rounded-full bg-primary" />
						<span className="absolute top-24 right-8 size-1.5 rounded-full bg-background/70" />
						<span className="absolute bottom-9 left-18 size-1.5 rounded-full bg-background/50" />
						<div className="absolute top-1/2 left-1/2 flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-3xl border border-background/15 bg-background/10">
							<HugeiconsIcon
								className="size-7 text-background"
								icon={compute ? CpuIcon : Share01Icon}
							/>
						</div>
						<div className="type-compact absolute top-1/2 right-0 flex -translate-y-1/2 items-center gap-2 text-background/60">
							<span className="h-px w-8 bg-background/20" />
							{compute ? "workcell" : "payout"}
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}

function ContractGrid({ mode }: { mode: ComputeShareMode }) {
	const items = mode === "compute" ? COMPUTE_CONTRACT : SHARE_CONTRACT;
	return (
		<section aria-labelledby={`${mode}-contract-heading`} className="space-y-3">
			<div className="flex items-baseline justify-between gap-4">
				<h2
					className="font-heading font-medium text-lg tracking-tight"
					id={`${mode}-contract-heading`}
				>
					{mode === "compute"
						? "What a lane includes"
						: "What providers control"}
				</h2>
				<span className="text-muted-foreground text-xs">Intended contract</span>
			</div>
			<div className="grid gap-3 md:grid-cols-3">
				{items.map((item) => (
					<Card borderTone="subtle" elevation="flat" key={item.title}>
						<CardContent inset="comfortable" spacing="comfortable">
							<HugeiconsIcon className="size-5 text-primary" icon={item.icon} />
							<div>
								<p className="font-medium text-sm">{item.title}</p>
								<p className="mt-1 text-muted-foreground text-sm leading-5">
									{item.description}
								</p>
							</div>
						</CardContent>
					</Card>
				))}
			</div>
		</section>
	);
}

function ComputeFinder() {
	const [workload, setWorkload] = useState<ComputeWorkload>("any");
	const [duration, setDuration] = useState<LeaseDuration>("1h");

	return (
		<Card borderTone="subtle" data-testid="compute-finder" elevation="flat">
			<CardHeader>
				<CardTitle>Find capacity</CardTitle>
				<CardDescription>Set the shape of the next lease.</CardDescription>
				<CardAction>
					<Badge variant="outline">Preview</Badge>
				</CardAction>
			</CardHeader>
			<CardContent spacing="generous">
				<fieldset className="space-y-2">
					<legend className="font-medium text-muted-foreground text-xs">
						Workload
					</legend>
					<ToggleGroup
						aria-label="Workload type"
						multiple={false}
						onValueChange={(values: string[]) => {
							const value = values[0];
							if (value === "any" || value === "cpu" || value === "gpu") {
								setWorkload(value);
							}
						}}
						size="sm"
						value={[workload]}
						variant="outline"
					>
						{WORKLOAD_OPTIONS.map((option) => (
							<ToggleGroupItem key={option.value} value={option.value}>
								{option.label}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
				</fieldset>
				<fieldset className="space-y-2">
					<legend className="font-medium text-muted-foreground text-xs">
						Lease length
					</legend>
					<ToggleGroup
						aria-label="Lease length"
						className="flex-wrap"
						multiple={false}
						onValueChange={(values: string[]) => {
							const value = values[0];
							if (value === "15m" || value === "1h" || value === "4h") {
								setDuration(value);
							}
						}}
						size="sm"
						value={[duration]}
						variant="outline"
					>
						{LEASE_OPTIONS.map((option) => (
							<ToggleGroupItem key={option.value} value={option.value}>
								{option.label}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
				</fieldset>
				<div className="rounded-2xl bg-muted/45 p-4">
					<div className="flex items-center justify-between gap-3">
						<p className="font-medium text-sm">Live network</p>
						<Badge variant="secondary">Not connected</Badge>
					</div>
					<p className="mt-1 text-muted-foreground text-xs leading-5">
						Your selection is ready for the lease API. No job will be submitted
						from this build.
					</p>
				</div>
			</CardContent>
			<CardFooter appearance="exchange-actions">
				<Button disabled>
					Find capacity
					<HugeiconsIcon className="size-4" icon={ArrowRight01Icon} />
				</Button>
				<span className="text-muted-foreground text-xs">
					Provider network is not enabled.
				</span>
			</CardFooter>
		</Card>
	);
}

function ShareBuilder() {
	const activeNode = useNodeStore((state) => state.getActiveNode());
	const origins = useMemo(
		() => (activeNode.managed ? [] : shareOriginsForNode(activeNode, null)),
		[activeNode.managed, activeNode.url]
	);
	const [offer, setOffer] = useState<ShareOffer>("compute");
	const [availability, setAvailability] = useState<ShareAvailability>("idle");
	const [onlyWhenIdle, setOnlyWhenIdle] = useState(true);
	const nodeLabel = activeNode.managed
		? "Ryu Cloud"
		: isLocalNode(activeNode)
			? "This device"
			: activeNode.name;

	return (
		<Card borderTone="subtle" data-testid="share-builder" elevation="flat">
			<CardHeader>
				<CardTitle>Build your offer</CardTitle>
				<CardDescription>
					Choose what this node may do while you are away.
				</CardDescription>
				<CardAction>
					<Badge variant="outline">Preview</Badge>
				</CardAction>
			</CardHeader>
			<CardContent spacing="generous">
				<fieldset className="space-y-2">
					<legend className="font-medium text-muted-foreground text-xs">
						Offer type
					</legend>
					<ToggleGroup
						aria-label="Offer type"
						multiple={false}
						onValueChange={(values: string[]) => {
							const value = values[0];
							if (value === "compute" || value === "agent") {
								setOffer(value);
							}
						}}
						size="sm"
						value={[offer]}
						variant="outline"
					>
						{OFFER_OPTIONS.map((option) => (
							<ToggleGroupItem key={option.value} value={option.value}>
								{option.label}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
					<p className="text-muted-foreground text-xs leading-5">
						{offer === "compute"
							? "Approved jobs receive a clean compute lane."
							: "A signed agent package runs here without exposing your node."}
					</p>
				</fieldset>
				<fieldset className="space-y-2">
					<legend className="font-medium text-muted-foreground text-xs">
						Availability
					</legend>
					<ToggleGroup
						aria-label="Availability"
						multiple={false}
						onValueChange={(values: string[]) => {
							const value = values[0];
							if (value === "idle" || value === "schedule") {
								setAvailability(value);
							}
						}}
						size="sm"
						value={[availability]}
						variant="outline"
					>
						{AVAILABILITY_OPTIONS.map((option) => (
							<ToggleGroupItem key={option.value} value={option.value}>
								{option.label}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
					<p className="text-muted-foreground text-xs leading-5">
						{availability === "idle"
							? "The node is offered only when it has spare capacity."
							: "The node is offered only during the schedule you publish."}
					</p>
				</fieldset>
				<div className="flex items-center justify-between gap-4 rounded-2xl border border-border/60 bg-muted/25 p-4">
					<div className="min-w-0">
						<p className="font-medium text-sm">Protect active work</p>
						<p className="mt-1 text-muted-foreground text-xs leading-5">
							{onlyWhenIdle
								? "Only accept leases when this node is idle."
								: "Accept leases whenever the provider schedule allows."}
						</p>
					</div>
					<Switch
						aria-label="Only accept leases when idle"
						checked={onlyWhenIdle}
						onCheckedChange={setOnlyWhenIdle}
						size="sm"
					/>
				</div>
				<div className="grid gap-3 sm:grid-cols-2">
					<div className="rounded-2xl bg-muted/45 p-4">
						<p className="text-muted-foreground text-xs">Node</p>
						<p className="mt-1 truncate font-medium text-sm" title={nodeLabel}>
							{nodeLabel}
						</p>
					</div>
					<div className="rounded-2xl bg-muted/45 p-4">
						<p className="text-muted-foreground text-xs">Safe origins</p>
						<p className="mt-1 font-medium text-sm">
							{activeNode.managed
								? "Ryu-managed"
								: origins.length === 0
									? "Private only"
									: `${origins.length} configured`}
						</p>
					</div>
				</div>
			</CardContent>
			<CardFooter appearance="exchange-actions">
				<Button disabled>
					Publish listing
					<HugeiconsIcon className="size-4" icon={ArrowRight01Icon} />
				</Button>
				<span className="text-muted-foreground text-xs">
					Provider enrollment is not enabled.
				</span>
			</CardFooter>
		</Card>
	);
}

function ShareSafety() {
	return (
		<section aria-labelledby="share-safety-heading" className="space-y-3">
			<h2
				className="font-heading font-medium text-lg tracking-tight"
				id="share-safety-heading"
			>
				The host boundary
			</h2>
			<div className="grid gap-3 md:grid-cols-3">
				{[
					["Node token", "Never sent to a renter."],
					["Host files", "Stay on the provider node."],
					["Job output", "Returned only to the lease owner."],
				].map(([title, description]) => (
					<div
						className="rounded-3xl border border-border/60 bg-card p-4"
						key={title}
					>
						<p className="font-medium text-sm">{title}</p>
						<p className="mt-1 text-muted-foreground text-sm leading-5">
							{description}
						</p>
					</div>
				))}
			</div>
		</section>
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
			<header className="flex shrink-0 items-start justify-between gap-4 border-b px-6 py-4 lg:px-8">
				<PageHeader
					subtitle={
						compute
							? "Rent governed capacity for the next run."
							: "Earn from an idle node without giving up control."
					}
					title={compute ? "Compute" : "Share"}
					typography="exchange"
				/>
				<Badge className="mt-1 shrink-0" variant="outline">
					Early access
				</Badge>
			</header>
			<div className="scroll-fade min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6 lg:p-8">
					<ExchangeHero mode={mode} />
					{compute ? (
						<div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(300px,0.85fr)]">
							<ComputeFinder />
							<NodeSummary />
						</div>
					) : (
						<div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(300px,0.85fr)]">
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
