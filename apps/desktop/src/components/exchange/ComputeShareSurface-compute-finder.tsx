import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
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
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import { useState } from "react";

type ComputeWorkload = "any" | "cpu" | "gpu";
type LeaseDuration = "15m" | "1h" | "4h";

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

export function ComputeFinder() {
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
				<div className="rounded-xl bg-muted p-4">
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
