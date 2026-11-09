// apps/desktop/src/components/memory/MemoryDreamSchedule.tsx
//
// The Dream screen's automatic review settings: the on/off switch and the
// quiet hours it waits out. On a node bound to an organization Core never runs
// the automatic review (an unattended run has no verified person whose memory
// it could read), so the switch is shown off and disabled with the reason.

import { Clock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Card, CardContent } from "@ryu/ui/components/card.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import type { DreamSettings } from "@/src/lib/api/memory-dream.ts";
import { formatLocalDateTime } from "@/src/lib/locale-format.ts";

function formatHour(hour: number): string {
	return formatLocalDateTime(new Date(2020, 0, 1, hour), { hour: "numeric" });
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function QuietHourSelect({
	disabled,
	id,
	label,
	onChange,
	value,
}: {
	disabled: boolean;
	id: string;
	label: string;
	onChange: (hour: number) => void;
	value: number;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={id}>{label}</Label>
			<Select
				items={HOURS.map((hour) => ({
					label: formatHour(hour),
					value: String(hour),
				}))}
				onValueChange={(next) => {
					if (next !== null) {
						onChange(Number(next));
					}
				}}
				value={String(value)}
			>
				<SelectTrigger disabled={disabled} id={id}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{HOURS.map((hour) => (
						<SelectItem key={hour} value={String(hour)}>
							{formatHour(hour)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

export function MemoryDreamSchedule({
	disabled,
	managed,
	onChange,
	settings,
}: {
	/** The settings could not be read or saved; leave them untouched. */
	disabled: boolean;
	/** The node is bound to an organization, so automatic review never runs. */
	managed: boolean;
	onChange: (patch: Partial<DreamSettings>) => void;
	settings: DreamSettings;
}) {
	const automatic = settings.automatic && !managed;
	const quietHoursDisabled = disabled || !automatic;
	return (
		<Card
			appearance="dream-highlight"
			data-testid="dream-schedule"
			elevation="flat"
		>
			<CardContent layout="summary-actions" topSpacing="generous">
				<div className="flex items-start gap-3">
					<div className="rounded-full bg-primary/10 p-2 text-primary">
						<HugeiconsIcon className="size-4" icon={Clock01Icon} />
					</div>
					<div>
						<Label htmlFor="dream-automatic">Automatic review</Label>
						{managed ? (
							<p
								className="mt-1 text-muted-foreground text-xs"
								data-testid="dream-automatic-managed"
							>
								Automatic review doesn't run on a node shared with your
								organization, because Dream can't tell whose chats to review
								without you. Use Run Dream now instead.
							</p>
						) : (
							<p className="mt-1 text-muted-foreground text-xs">
								Let Dream prepare proposals on its own. You still decide what
								enters Memory.
							</p>
						)}
					</div>
				</div>
				<Switch
					checked={automatic}
					disabled={disabled || managed}
					id="dream-automatic"
					onCheckedChange={(next) => onChange({ automatic: next })}
				/>
			</CardContent>
			{managed ? null : (
				<CardContent layout="stack">
					<div className="grid gap-3 sm:grid-cols-2">
						<QuietHourSelect
							disabled={quietHoursDisabled}
							id="dream-quiet-start"
							label="Quiet hours start"
							onChange={(hour) => onChange({ quietHoursStart: hour })}
							value={settings.quietHoursStart}
						/>
						<QuietHourSelect
							disabled={quietHoursDisabled}
							id="dream-quiet-end"
							label="Quiet hours end"
							onChange={(hour) => onChange({ quietHoursEnd: hour })}
							value={settings.quietHoursEnd}
						/>
					</div>
					<p className="text-muted-foreground text-xs">
						Automatic review doesn't start during these hours, in the node's
						local time. Choose the same hour twice to let it run at any time.
					</p>
				</CardContent>
			)}
		</Card>
	);
}
