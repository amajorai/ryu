"use client";

import { useLocalizedString, useLocalizedText } from "@ryu/i18n/react";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { cn } from "@ryu/ui/lib/utils";
import {
	Flower2,
	Ghost,
	Heart,
	type LucideIcon,
	PartyPopper,
	Rabbit,
	Snowflake,
	Sparkles,
	X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { Season } from "./seasons.ts";
import { chooseLandingSeason } from "./use-landing-season.ts";

interface SeasonOption {
	Icon: LucideIcon;
	label: string;
	season: Season | null;
}

const OPTIONS: readonly SeasonOption[] = [
	{ season: "newyear", label: "New Year", Icon: PartyPopper },
	{ season: "lunarnewyear", label: "Lunar New Year", Icon: Flower2 },
	{ season: "valentines", label: "Valentine's", Icon: Heart },
	{ season: "easter", label: "Easter", Icon: Rabbit },
	{ season: "halloween", label: "Halloween", Icon: Ghost },
	{ season: "christmas", label: "Christmas", Icon: Snowflake },
	{ season: null, label: "No seasonal theme", Icon: X },
];

const BUTTON_CLASS =
	"inline-flex size-7 items-center justify-center rounded-full text-muted-foreground transition-[color,background-color,transform] hover:scale-110 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none motion-reduce:hover:scale-100";

function OptionButton({
	active,
	delay,
	onPick,
	option,
}: {
	active: boolean;
	delay: number;
	onPick: () => void;
	option: SeasonOption;
}) {
	const label = useLocalizedText(option.label, { literal: true });
	const ariaLabel = useLocalizedString(option.label) ?? option.label;
	const { Icon } = option;
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<motion.button
						animate={{ opacity: 1, x: 0 }}
						aria-label={ariaLabel}
						aria-pressed={active}
						className={cn(
							BUTTON_CLASS,
							active
								? "bg-muted text-foreground"
								: "opacity-60 hover:opacity-100"
						)}
						initial={{ opacity: 0, x: 12 }}
						onClick={onPick}
						transition={{ delay }}
						type="button"
					/>
				}
			>
				<Icon aria-hidden="true" className="size-3.5" />
			</TooltipTrigger>
			<TooltipContent side="top">{label}</TooltipContent>
		</Tooltip>
	);
}

/**
 * One icon for the active season; open it to preview another season's theme
 * or turn the theme off. The pick lasts for the tab session.
 */
export function SeasonalPicker({
	className,
	season,
}: {
	className?: string;
	season: Season | null;
}) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const active = season
		? OPTIONS.find((option) => option.season === season)
		: undefined;
	const TriggerIcon = active?.Icon ?? Sparkles;
	const triggerLabel = useLocalizedString("Seasonal theme") ?? "Seasonal theme";
	const activeLabel = useLocalizedText(active?.label ?? "Seasonal theme", {
		literal: true,
	});

	useEffect(() => {
		if (!open) {
			return;
		}
		const onPointerDown = (event: PointerEvent) => {
			if (!ref.current?.contains(event.target as Node)) {
				setOpen(false);
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setOpen(false);
			}
		};
		window.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	return (
		<TooltipProvider delay={0}>
			<div
				className={cn(
					"flex items-center rounded-full bg-background/60 p-0.5 backdrop-blur-sm",
					className
				)}
				data-testid="seasonal-picker"
				ref={ref}
			>
				<AnimatePresence initial={false}>
					{open ? (
						<motion.div
							animate={{ width: "auto", opacity: 1 }}
							className="flex items-center gap-0.5 overflow-hidden pr-0.5"
							exit={{ width: 0, opacity: 0 }}
							initial={{ width: 0, opacity: 0 }}
							transition={{ type: "spring", stiffness: 420, damping: 36 }}
						>
							{OPTIONS.map((option, index) => (
								<OptionButton
									active={option.season === season}
									// Options fan out from the trigger, nearest first.
									delay={(OPTIONS.length - 1 - index) * 0.03}
									key={option.label}
									onPick={() => {
										chooseLandingSeason(option.season);
										setOpen(false);
									}}
									option={option}
								/>
							))}
						</motion.div>
					) : null}
				</AnimatePresence>
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								aria-expanded={open}
								aria-label={triggerLabel}
								className={cn(
									BUTTON_CLASS,
									open ? "text-foreground" : "opacity-70 hover:opacity-100"
								)}
								onClick={() => setOpen((current) => !current)}
								type="button"
							/>
						}
					>
						<motion.span
							animate={{ rotate: open ? 90 : 0 }}
							className="block"
							transition={{ type: "spring", stiffness: 300, damping: 20 }}
						>
							<TriggerIcon aria-hidden="true" className="size-3.5" />
						</motion.span>
					</TooltipTrigger>
					<TooltipContent side="top">{activeLabel}</TooltipContent>
				</Tooltip>
			</div>
		</TooltipProvider>
	);
}
