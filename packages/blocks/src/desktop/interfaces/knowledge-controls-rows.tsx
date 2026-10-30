import { Slider } from "@ryu/ui/components/slider.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useId } from "react";

const SLIDER =
	"[&_[data-slot=slider-thumb]]:size-3.5 [&_[data-slot=slider-thumb]]:rounded-full [&_[data-slot=slider-track]]:h-1";

export function Section({
	children,
	onToggle,
	open,
	title,
}: {
	children: ReactNode;
	onToggle: () => void;
	open: boolean;
	title: string;
}) {
	const contentId = useId();
	return (
		<section className="border-border border-t first:border-t-0">
			<h4>
				<button
					aria-controls={contentId}
					aria-expanded={open}
					className="flex h-9 w-full items-center gap-1.5 px-3 text-left font-medium text-foreground text-sm outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
					onClick={onToggle}
					type="button"
				>
					<ChevronRight
						aria-hidden="true"
						className={cn(
							"size-3.5 text-foreground/55 transition-transform duration-150 motion-reduce:transition-none",
							open && "rotate-90"
						)}
					/>
					{title}
				</button>
			</h4>
			{open ? (
				<div className="flex flex-col gap-1 px-3 pt-0.5 pb-3" id={contentId}>
					{children}
				</div>
			) : null}
		</section>
	);
}

export function ToggleRow({
	checked,
	inset = false,
	label,
	name,
	onChange,
}: {
	checked: boolean;
	/** A sub-option of the row above it. */
	inset?: boolean;
	label: string;
	name: string;
	onChange: (checked: boolean) => void;
}) {
	const id = useId();
	return (
		<div
			className={cn(
				"flex h-8 items-center justify-between gap-3",
				inset && "ms-1.5 border-border border-s ps-3"
			)}
		>
			<label className="min-w-0 truncate text-foreground text-sm" htmlFor={id}>
				{label}
			</label>
			<Switch
				aria-label={name}
				checked={checked}
				className="data-unchecked:bg-foreground/20"
				id={id}
				onCheckedChange={(next) => onChange(next)}
				size="sm"
			/>
		</div>
	);
}

export function SliderRow({
	label,
	max,
	min,
	onChange,
	step,
	value,
}: {
	label: string;
	max: number;
	min: number;
	onChange: (value: number) => void;
	step: number;
	value: number;
}) {
	const id = useId();
	return (
		<div className="flex flex-col gap-2 py-1.5">
			<span className="text-foreground text-sm" id={id}>
				{label}
			</span>
			<Slider
				aria-labelledby={id}
				className={SLIDER}
				max={max}
				min={min}
				onValueChange={(next) => {
					const value = Array.isArray(next) ? next[0] : next;
					if (typeof value === "number") {
						onChange(value);
					}
				}}
				step={step}
				value={value}
			/>
		</div>
	);
}
