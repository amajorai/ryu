import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
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
import { Switch } from "@ryu/ui/components/switch.tsx";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import { useMemo, useState } from "react";
import { shareOriginsForNode } from "@/src/lib/api/node-share.ts";
import { isLocalNode, useNodeStore } from "@/src/store/useNodeStore.ts";

type ShareOffer = "compute" | "agent";
type ShareAvailability = "idle" | "schedule";

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

export function ShareBuilder() {
	const tl = useLiteralMessages();
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
				<div className="flex items-center justify-between gap-4 rounded-xl bg-muted p-4">
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
					<div className="rounded-xl bg-muted p-4">
						<p className="text-muted-foreground text-xs">Node</p>
						<p className="mt-1 truncate font-medium text-sm" title={nodeLabel}>
							{nodeLabel}
						</p>
					</div>
					<div className="rounded-xl bg-muted p-4">
						<p className="text-muted-foreground text-xs">Safe origins</p>
						<p className="mt-1 font-medium text-sm">
							{activeNode.managed
								? "Ryu-managed"
								: origins.length === 0
									? "Private only"
									: tl("{length} configured", {
											length: String(origins.length),
										})}
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
