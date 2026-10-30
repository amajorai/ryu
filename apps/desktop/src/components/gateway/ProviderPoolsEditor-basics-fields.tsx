import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { type Pool, strategyLabel } from "./ProviderPoolsEditor-options.ts";

export function ProviderPoolBasicsFields({
	disabled,
	editing,
	name,
	setName,
	controlsDisabled,
	strategyOptions,
	strategy,
	setStrategy,
	stickyLimit,
	setStickyLimit,
	cooldownWaitMs,
	setCooldownWaitMs,
}: {
	disabled: boolean;
	editing: string | null;
	name: string;
	setName: (name: string) => void;
	controlsDisabled: boolean;
	strategyOptions: { value: Pool["strategy"]; label: string }[];
	strategy: Pool["strategy"];
	setStrategy: (strategy: Pool["strategy"]) => void;
	stickyLimit: number;
	setStickyLimit: (stickyLimit: number) => void;
	cooldownWaitMs: number;
	setCooldownWaitMs: (cooldownWaitMs: number) => void;
}) {
	return (
		<div className="grid gap-3 sm:grid-cols-2">
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="provider-pool-name">Pool name</Label>
				<Input
					disabled={disabled || editing !== ""}
					id="provider-pool-name"
					onChange={(event) => setName(event.target.value)}
					value={name}
				/>
			</div>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="provider-pool-strategy">Routing strategy</Label>
				<Select
					disabled={controlsDisabled}
					items={strategyOptions}
					onValueChange={(value) => {
						const option = strategyOptions.find((item) => item.value === value);
						if (option) {
							setStrategy(option.value);
						}
					}}
					value={strategy}
				>
					<SelectTrigger id="provider-pool-strategy">
						<SelectValue>{strategyLabel(strategy)}</SelectValue>
					</SelectTrigger>
					<SelectContent
						align="start"
						alignItemWithTrigger={false}
						className="min-w-52"
					>
						{strategyOptions.map((item) => (
							<SelectItem key={item.value} value={item.value}>
								{item.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			{strategy === "round_robin" ? (
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="provider-pool-sticky-limit">
						New sessions per member
					</Label>
					<Input
						disabled={controlsDisabled}
						id="provider-pool-sticky-limit"
						max={100}
						min={1}
						onChange={(event) => setStickyLimit(Number(event.target.value))}
						type="number"
						value={stickyLimit}
					/>
					<p className="text-muted-foreground text-xs">
						Assign this many new sessions before rotating. Existing sessions
						stay on their member.
					</p>
				</div>
			) : null}
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="provider-pool-cooldown-wait">Cooldown wait (ms)</Label>
				<Input
					disabled={controlsDisabled}
					id="provider-pool-cooldown-wait"
					max={30_000}
					min={0}
					onChange={(event) => setCooldownWaitMs(Number(event.target.value))}
					step={100}
					type="number"
					value={cooldownWaitMs}
				/>
				<p className="text-muted-foreground text-xs">
					Wait briefly for a known cooldown when every member is unavailable.
					Zero fails immediately; cancelling the request cancels its wait.
				</p>
			</div>
		</div>
	);
}
