"use client";

import {
	UserMultiple02Icon,
	ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Label } from "@ryu/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ryu/ui/components/radio-group";
import { z } from "zod";

const spaceVisibilitySchema = z.enum(["org", "private"]);

/** The user-facing sharing choices for a Space and its inherited pages. */
export type SpaceVisibility = "org" | "private";

const SPACE_VISIBILITY_OPTIONS: readonly {
	blurb: string;
	icon: typeof ViewOffSlashIcon;
	label: string;
	value: SpaceVisibility;
}[] = [
	{
		value: "private",
		label: "Private",
		blurb: "Only you can see this space and its pages.",
		icon: ViewOffSlashIcon,
	},
	{
		value: "org",
		label: "Team",
		blurb: "Everyone on this shared node can see this space and its pages.",
		icon: UserMultiple02Icon,
	},
];

/** Shared visibility choice used by the create dialog and future Space settings. */
export function SpaceVisibilityChoice({
	disabled,
	idPrefix,
	onVisibilityChange,
	visibility,
}: {
	disabled?: boolean;
	idPrefix: string;
	onVisibilityChange: (visibility: SpaceVisibility) => void;
	visibility: SpaceVisibility;
}) {
	return (
		<RadioGroup
			aria-label="Space visibility"
			disabled={disabled}
			onValueChange={(next) => {
				const parsed = spaceVisibilitySchema.safeParse(next);
				if (parsed.success) {
					onVisibilityChange(parsed.data);
				}
			}}
			value={visibility}
		>
			{SPACE_VISIBILITY_OPTIONS.map((option) => {
				const id = `${idPrefix}-${option.value}`;
				return (
					<div className="flex items-start gap-2.5" key={option.value}>
						<RadioGroupItem className="mt-0.5" id={id} value={option.value} />
						<HugeiconsIcon
							className="mt-0.5 size-4 shrink-0 text-muted-foreground"
							icon={option.icon}
						/>
						<div className="flex flex-col gap-0.5">
							<Label htmlFor={id} variant="choice">
								{option.label}
							</Label>
							<p className="text-muted-foreground text-xs">{option.blurb}</p>
						</div>
					</div>
				);
			})}
		</RadioGroup>
	);
}
