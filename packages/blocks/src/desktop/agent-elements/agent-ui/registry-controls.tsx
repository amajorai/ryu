import { useBoundProp } from "@json-render/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { Progress } from "@ryu/ui/components/progress.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { Slider } from "@ryu/ui/components/slider.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type CSSProperties, useId } from "react";
import { z } from "zod";
import { formatChartValue } from "./registry-chart.tsx";
import {
	type AgentUiClassLookup,
	type AgentUiGeometryStyle,
	IMAGE_SCHEMES,
	LINK_SCHEMES,
	type Render,
	sanitizeUrl,
} from "./registry-shared.ts";
import { useAgentUiSubmissionState } from "./submission-context.tsx";

const TREND_CLASS: AgentUiClassLookup = {
	up: "text-status-success",
	down: "text-status-destructive",
	neutral: "text-muted-foreground",
};
const TREND_GLYPH: AgentUiClassLookup = { up: "↑", down: "↓", neutral: "→" };
// The arrow and color are decorative; this text carries the direction for
// assistive technology, since a free-form delta may not state it.
const TREND_LABEL: AgentUiClassLookup = {
	up: "Up",
	down: "Down",
	neutral: "No change",
};

export const StatRenderer: Render<{
	label: string;
	value: string | number;
	delta?: string;
	trend?: "up" | "down" | "neutral";
	description?: string;
}> = ({ props }) => (
	<div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-card p-3">
		<span className="truncate text-muted-foreground text-xs">
			{props.label}
		</span>
		<span className="truncate font-medium text-foreground text-xl tabular-nums">
			{isNativeNumber(props.value)
				? formatChartValue(props.value, "number", undefined)
				: (props.value ?? "—")}
		</span>
		{props.delta && (
			<span className={cn("text-xs", TREND_CLASS[props.trend ?? "neutral"])}>
				{props.trend && (
					<>
						<span aria-hidden className="mr-0.5">
							{TREND_GLYPH[props.trend]}
						</span>
						<span className="sr-only">{TREND_LABEL[props.trend]}: </span>
					</>
				)}
				{props.delta}
			</span>
		)}
		{props.description && (
			<span className="text-muted-foreground text-xs">{props.description}</span>
		)}
	</div>
);

export const ProgressRenderer: Render<{ value: number; label?: string }> = ({
	props,
}) => (
	<div className="flex flex-col gap-1.5">
		{props.label && (
			<span className="text-muted-foreground text-xs">{props.label}</span>
		)}
		<Progress value={props.value} />
	</div>
);

function cssLengthVariable(
	value: CSSProperties["width"]
): CSSProperties["width"] {
	const number = z.number().safeParse(value);
	return number.success ? `${number.data}px` : value;
}

export const SkeletonRenderer: Render<{ width?: string; height?: string }> = ({
	props,
}) => {
	const dimensions: AgentUiGeometryStyle = {
		"--agent-ui-skeleton-width": cssLengthVariable(props.width ?? "100%"),
		"--agent-ui-skeleton-height": cssLengthVariable(props.height ?? "1rem"),
	};
	return (
		<Skeleton
			className="h-(--agent-ui-skeleton-height) w-(--agent-ui-skeleton-width)"
			style={dimensions}
		/>
	);
};

export const ButtonRenderer: Render<{
	label: string;
	variant?:
		| "default"
		| "secondary"
		| "outline"
		| "ghost"
		| "destructive"
		| "link";
	size?: "sm" | "default" | "lg";
	disabled?: boolean;
}> = ({ props, emit }) => {
	const { pending, submitted } = useAgentUiSubmissionState();
	return (
		<Button
			disabled={props.disabled || pending || submitted}
			onClick={() => emit("press")}
			size={props.size ?? "default"}
			variant={props.variant ?? "default"}
		>
			{props.label}
		</Button>
	);
};

export const InputRenderer: Render<{
	placeholder?: string;
	value?: string;
	label?: string;
	type?: "text" | "email" | "password" | "number";
}> = ({ props, bindings }) => {
	const [value, setValue] = useBoundProp(props.value, bindings?.value);
	const fieldId = useId();
	return (
		<div className="flex flex-col gap-1.5">
			{props.label && <Label htmlFor={fieldId}>{props.label}</Label>}
			<Input
				aria-label={props.label ? undefined : props.placeholder}
				id={fieldId}
				onChange={(event) => setValue(event.target.value)}
				placeholder={props.placeholder}
				type={props.type ?? "text"}
				value={value ?? ""}
			/>
		</div>
	);
};

export const TextareaRenderer: Render<{
	placeholder?: string;
	value?: string;
	label?: string;
	rows?: number;
}> = ({ props, bindings }) => {
	const [value, setValue] = useBoundProp(props.value, bindings?.value);
	const fieldId = useId();
	return (
		<div className="flex flex-col gap-1.5">
			{props.label && <Label htmlFor={fieldId}>{props.label}</Label>}
			<Textarea
				aria-label={props.label ? undefined : props.placeholder}
				id={fieldId}
				onChange={(event) => setValue(event.target.value)}
				placeholder={props.placeholder}
				rows={props.rows}
				value={value ?? ""}
			/>
		</div>
	);
};

export const CheckboxRenderer: Render<{
	label?: string;
	checked?: boolean;
}> = ({ props, bindings }) => {
	const [checked, setChecked] = useBoundProp(props.checked, bindings?.checked);
	return (
		<Label>
			<Checkbox
				checked={checked ?? false}
				onCheckedChange={(next) => setChecked(Boolean(next))}
			/>
			{props.label && <span className="text-sm">{props.label}</span>}
		</Label>
	);
};

export const SwitchRenderer: Render<{ label?: string; checked?: boolean }> = ({
	props,
	bindings,
}) => {
	const [checked, setChecked] = useBoundProp(props.checked, bindings?.checked);
	return (
		<Label>
			<Switch
				checked={checked ?? false}
				onCheckedChange={(next) => setChecked(Boolean(next))}
			/>
			{props.label && <span className="text-sm">{props.label}</span>}
		</Label>
	);
};

export const SelectRenderer: Render<{
	placeholder?: string;
	value?: string;
	options: { label: string; value: string; description?: string }[];
}> = ({ props, bindings }) => {
	const [value, setValue] = useBoundProp(props.value, bindings?.value);
	const options = props.options ?? [];
	return (
		<Select
			items={options}
			onValueChange={(next) => setValue(next ?? "")}
			value={value ?? ""}
		>
			<SelectTrigger aria-label={props.placeholder} className="w-full">
				<SelectValue placeholder={props.placeholder} />
			</SelectTrigger>
			<SelectContent>
				{options.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
};

export const OptionListRenderer: Render<{
	label?: string;
	value?: string;
	options: { label: string; value: string; description?: string }[];
}> = ({ props, bindings }) => {
	const [value, setValue] = useBoundProp(props.value, bindings?.value);
	return (
		<fieldset className="flex flex-col gap-2">
			{props.label && (
				<legend className="font-medium text-sm">{props.label}</legend>
			)}
			<div
				aria-label={props.label}
				className="flex flex-col gap-1"
				role="radiogroup"
			>
				{props.options.map((option) => {
					const selected = value === option.value;
					return (
						<button
							aria-checked={selected}
							className={cn(
								"rounded-lg border px-3 py-2 text-left transition-colors",
								selected
									? "border-primary bg-primary/10"
									: "border-border hover:bg-muted/60"
							)}
							key={option.value}
							onClick={() => setValue(option.value)}
							role="radio"
							type="button"
						>
							<span className="block text-sm">{option.label}</span>
							{option.description && (
								<span className="mt-0.5 block text-muted-foreground text-xs">
									{option.description}
								</span>
							)}
						</button>
					);
				})}
			</div>
		</fieldset>
	);
};

export const SliderRenderer: Render<{
	label?: string;
	value?: number;
	min?: number;
	max?: number;
	step?: number;
}> = ({ props, bindings }) => {
	const [value, setValue] = useBoundProp(props.value, bindings?.value);
	const min = props.min ?? 0;
	const max = props.max ?? 100;
	const current = Math.min(max, Math.max(min, value ?? min));
	return (
		<div className="flex flex-col gap-2">
			{props.label && (
				<div className="flex items-center justify-between gap-2">
					<Label>{props.label}</Label>
					<span className="text-muted-foreground text-xs">{current}</span>
				</div>
			)}
			<Slider
				max={max}
				min={min}
				onValueChange={(next) => {
					const nextValue = Array.isArray(next) ? next[0] : next;
					setValue(nextValue ?? min);
				}}
				step={props.step ?? 1}
				value={[current]}
			/>
		</div>
	);
};

export const ApprovalCardRenderer: Render<{
	title: string;
	description?: string;
	approveLabel?: string;
	rejectLabel?: string;
}> = ({ props, emit }) => {
	const { pending, submitted } = useAgentUiSubmissionState();
	const disabled = pending || submitted;
	return (
		<Card>
			<CardHeader>
				<CardTitle>{props.title}</CardTitle>
				{props.description && (
					<CardDescription>{props.description}</CardDescription>
				)}
			</CardHeader>
			<CardContent layout="actions">
				<Button
					disabled={disabled}
					onClick={() => emit("approve")}
					type="button"
				>
					{props.approveLabel ?? "Approve"}
				</Button>
				<Button
					disabled={disabled}
					onClick={() => emit("reject")}
					type="button"
					variant="outline"
				>
					{props.rejectLabel ?? "Reject"}
				</Button>
			</CardContent>
		</Card>
	);
};

export const LinkPreviewRenderer: Render<{
	title: string;
	href: string;
	description?: string;
	imageSrc?: string;
}> = ({ props }) => (
	<a
		className="flex overflow-hidden rounded-lg border border-border bg-card transition-colors hover:bg-muted/40"
		href={sanitizeUrl(props.href, LINK_SCHEMES)}
		rel="noopener noreferrer"
		target="_blank"
	>
		{props.imageSrc && (
			<img
				alt=""
				className="h-20 w-20 shrink-0 object-cover"
				src={sanitizeUrl(props.imageSrc, IMAGE_SCHEMES)}
			/>
		)}
		<span className="flex min-w-0 flex-col justify-center gap-1 p-3">
			<span className="font-medium text-sm">{props.title}</span>
			{props.description && (
				<span className="line-clamp-2 text-muted-foreground text-xs">
					{props.description}
				</span>
			)}
		</span>
	</a>
);
