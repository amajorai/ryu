// Registry: maps every component in ./catalog.ts to a real `@ryu/ui` (Base UI)
// component, so agent-rendered UI uses the exact same primitives — and therefore
// the same theme tokens, focus behavior and accessibility — as the rest of the app.
//
// Interactive fields use json-render's `useBoundProp(props.x, bindings?.x)` to get
// a [value, setValue] pair wired to the spec's `{ $bindState: "path" }` bindings.

import {
	type BaseComponentProps,
	type Components,
	defineRegistry,
	useBoundProp,
} from "@json-render/react";
import {
	Alert,
	AlertDescription,
	AlertTitle,
} from "@ryu/ui/components/alert.tsx";
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card.tsx";
import {
	type ChartConfig,
	ChartContainer,
	ChartLegend,
	ChartLegendContent,
	ChartTooltip,
	ChartTooltipContent,
} from "@ryu/ui/components/chart.tsx";
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
import { Separator } from "@ryu/ui/components/separator.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { Slider } from "@ryu/ui/components/slider.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import {
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type ComponentProps,
	type CSSProperties,
	createElement,
	type ReactNode,
	useId,
} from "react";
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	Line,
	LineChart,
	Pie,
	PieChart,
	Sector,
	XAxis,
	YAxis,
} from "recharts";
import { z } from "zod";
import {
	agentUiCatalog,
	CHART_COLORS,
	CHART_MAX_POINTS,
	CHART_MAX_SERIES,
} from "./catalog.ts";
import { agentUiComputedFunctions } from "./computed.ts";
import { useAgentUiSubmissionState } from "./submission-context.tsx";

interface AgentUiClassLookup {
	[value: string]: string | undefined;
}
interface HeadingClassLookup {
	[level: number]: string | undefined;
}
interface AgentUiGeometryStyle extends CSSProperties {
	"--agent-ui-chart-height"?: string;
	"--agent-ui-columns"?: string;
	"--agent-ui-skeleton-height"?: CSSProperties["height"];
	"--agent-ui-skeleton-width"?: CSSProperties["width"];
}

const GAP_CLASS: AgentUiClassLookup = {
	none: "gap-0",
	xs: "gap-1",
	sm: "gap-2",
	md: "gap-3",
	lg: "gap-4",
	xl: "gap-6",
};

const ALIGN_CLASS: AgentUiClassLookup = {
	start: "items-start",
	center: "items-center",
	end: "items-end",
	stretch: "items-stretch",
};

const JUSTIFY_CLASS: AgentUiClassLookup = {
	start: "justify-start",
	center: "justify-center",
	end: "justify-end",
	between: "justify-between",
	around: "justify-around",
};

const TEXT_SIZE_CLASS: AgentUiClassLookup = {
	xs: "text-xs",
	sm: "text-sm",
	base: "text-sm",
	lg: "text-base",
};

const TEXT_WEIGHT_CLASS: AgentUiClassLookup = {
	normal: "font-normal",
	medium: "font-medium",
	semibold: "font-medium",
	bold: "font-medium",
};

const HEADING_CLASS: HeadingClassLookup = {
	1: "text-xl font-medium",
	2: "text-lg font-medium",
	3: "text-base font-medium",
	4: "text-sm font-medium",
};

// Convenience alias so each renderer reads cleanly.
type Render<P> = (ctx: BaseComponentProps<P>) => ReactNode;

// Agent-controlled UI: the spec (including href/src) is supplied by the model, so
// any URL must be scheme-checked before it reaches the DOM. A `javascript:` href on
// an <a> is directly clickable XSS; resolve against the app origin and only allow an
// explicit allowlist, otherwise fall back to an inert "#".
const sanitizeUrl = (
	raw: string | undefined,
	allowed: readonly string[]
): string => {
	if (!raw) {
		return "#";
	}
	try {
		const origin =
			globalThis.window === undefined
				? "http://localhost"
				: window.location.origin;
		const url = new URL(raw, origin);
		return allowed.includes(url.protocol) ? url.toString() : "#";
	} catch {
		return "#";
	}
};

const LINK_SCHEMES = ["http:", "https:", "mailto:"] as const;
const IMAGE_SCHEMES = ["http:", "https:", "data:", "blob:"] as const;

const StackRenderer: Render<{
	direction?: "row" | "column";
	gap?: keyof typeof GAP_CLASS;
	align?: keyof typeof ALIGN_CLASS;
	justify?: keyof typeof JUSTIFY_CLASS;
	wrap?: boolean;
}> = ({ props, children }) => (
	<div
		className={cn(
			"flex",
			props.direction === "row" ? "flex-row" : "flex-col",
			GAP_CLASS[props.gap ?? "md"],
			props.align && ALIGN_CLASS[props.align],
			props.justify && JUSTIFY_CLASS[props.justify],
			props.wrap && "flex-wrap"
		)}
	>
		{children}
	</div>
);

const GridRenderer: Render<{
	columns?: number;
	gap?: keyof typeof GAP_CLASS;
}> = ({ props, children }) => {
	const geometry: AgentUiGeometryStyle = {
		"--agent-ui-columns": `repeat(${props.columns ?? 2}, minmax(0, 1fr))`,
	};
	return (
		<div
			className={cn(
				"grid",
				GAP_CLASS[props.gap ?? "md"],
				"grid-cols-(--agent-ui-columns)"
			)}
			style={geometry}
		>
			{children}
		</div>
	);
};

const CardRenderer: Render<{ title?: string; description?: string }> = ({
	props,
	children,
}) => (
	<Card>
		{(props.title || props.description) && (
			<CardHeader>
				{props.title && <CardTitle>{props.title}</CardTitle>}
				{props.description && (
					<CardDescription>{props.description}</CardDescription>
				)}
			</CardHeader>
		)}
		<CardContent>{children}</CardContent>
	</Card>
);

const SeparatorRenderer: Render<{
	orientation?: "horizontal" | "vertical";
}> = ({ props }) => (
	<Separator orientation={props.orientation ?? "horizontal"} />
);

const HeadingRenderer: Render<{ text: string; level?: number }> = ({
	props,
}) => {
	const level = props.level ?? 2;
	return createElement(
		`h${level}`,
		{ className: HEADING_CLASS[level] ?? HEADING_CLASS[2] },
		props.text
	);
};

const TextRenderer: Render<{
	text: string;
	muted?: boolean;
	size?: keyof typeof TEXT_SIZE_CLASS;
	weight?: keyof typeof TEXT_WEIGHT_CLASS;
}> = ({ props }) => (
	<p
		className={cn(
			"leading-relaxed",
			TEXT_SIZE_CLASS[props.size ?? "sm"],
			props.weight && TEXT_WEIGHT_CLASS[props.weight],
			props.muted ? "text-muted-foreground" : "text-foreground/90"
		)}
	>
		{props.text}
	</p>
);

const LinkRenderer: Render<{ text: string; href: string }> = ({ props }) => (
	<a
		className="text-primary text-sm underline-offset-2 hover:underline"
		href={sanitizeUrl(props.href, LINK_SCHEMES)}
		rel="noopener noreferrer"
		target="_blank"
	>
		{props.text}
	</a>
);

const ImageRenderer: Render<{
	src: string;
	alt?: string;
	rounded?: boolean;
}> = ({ props }) => (
	<img
		alt={props.alt ?? ""}
		className={cn("max-w-full", props.rounded && "rounded-lg")}
		src={sanitizeUrl(props.src, IMAGE_SCHEMES)}
	/>
);

const AvatarRenderer: Render<{
	src?: string;
	alt?: string;
	fallback?: string;
}> = ({ props }) => (
	<Avatar>
		{props.src && (
			<AvatarImage
				alt={props.alt ?? ""}
				src={sanitizeUrl(props.src, IMAGE_SCHEMES)}
			/>
		)}
		<AvatarFallback>{props.fallback ?? "?"}</AvatarFallback>
	</Avatar>
);

const BadgeRenderer: Render<{
	text: string;
	variant?: "default" | "secondary" | "outline" | "destructive";
}> = ({ props }) => (
	<Badge variant={props.variant ?? "default"}>{props.text}</Badge>
);

const AlertRenderer: Render<{
	title?: string;
	description?: string;
	variant?: "default" | "destructive";
}> = ({ props, children }) => (
	<Alert variant={props.variant ?? "default"}>
		{props.title && <AlertTitle>{props.title}</AlertTitle>}
		{props.description && (
			<AlertDescription>{props.description}</AlertDescription>
		)}
		{children}
	</Alert>
);

const TableRenderer: Render<{ columns: string[]; rows: string[][] }> = ({
	props,
}) => (
	<div className="overflow-x-auto rounded-lg border border-border">
		<Table>
			<TableHeader>
				<TableRow>
					{props.columns.map((col) => (
						<TableHead key={col}>{col}</TableHead>
					))}
				</TableRow>
			</TableHeader>
			<TableBody>
				{props.rows.map((row) => {
					const rowKey = row.join("\u0001");
					return (
						<TableRow key={rowKey}>
							{row.map((cell, cellIndex) => (
								<TableCell
									key={`${rowKey}:${props.columns[cellIndex] ?? cellIndex}`}
								>
									{cell}
								</TableCell>
							))}
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	</div>
);

type ChartColor = (typeof CHART_COLORS)[number];
type ChartValueFormat = "number" | "compact" | "percent" | "currency";
interface ChartSeriesProps {
	color?: ChartColor;
	key: string;
	label?: string;
}
type ChartRow = Record<string, string | number | null>;

// Chart data may arrive through `$state`, so re-check it at render time rather
// than trusting the catalog schema: anything that isn't a list of plain rows
// draws an empty chart instead of throwing inside recharts. Raw arrays are
// capped *before* per-entry validation so an oversized state array costs no
// more than the advertised limits, and invalid entries are dropped (not
// blanked) so a list of junk still reaches the empty state.
const chartRowSchema = z.record(
	z.string(),
	z.union([z.string(), z.number(), z.null()])
);
const chartSeriesEntrySchema = z.object({
	key: z.string(),
	label: z.string().optional(),
	color: z.enum(CHART_COLORS).optional(),
});

function parseCapped<T>(
	raw: readonly T[],
	limit: number,
	schema: z.ZodType<T>
): T[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const parsed: T[] = [];
	for (const entry of raw.slice(0, limit)) {
		const result = schema.safeParse(entry);
		if (result.success) {
			parsed.push(result.data);
		}
	}
	return parsed;
}

/** The shared tooltip forwards Recharts formatter values; chart ticks and Stat
 * numbers are members of that same value domain. */
type ChartFormattedValue = Parameters<
	NonNullable<ComponentProps<typeof ChartTooltipContent>["formatter"]>
>[0];

const DEFAULT_CHART_HEIGHT = 240;

function chartColor(series: ChartSeriesProps, index: number): string {
	return `var(--${series.color ?? CHART_COLORS[index % CHART_COLORS.length]})`;
}

function formatChartValue(
	value: ChartFormattedValue | undefined,
	format: ChartValueFormat | undefined,
	currency: string | undefined
): string {
	const formatted = agentUiComputedFunctions.format.run({
		value,
		style: format ?? "number",
		digits: format === "percent" ? 1 : 2,
		currency,
	});
	return isNativeText(formatted) ? formatted : String(value ?? "");
}

const ChartRenderer: Render<{
	type: "bar" | "line" | "area" | "pie";
	data: ChartRow[];
	xKey: string;
	series: ChartSeriesProps[];
	stacked?: boolean;
	height?: number;
	valueFormat?: ChartValueFormat;
	currency?: string;
	showLegend?: boolean;
}> = ({ props }) => {
	const data = parseCapped(props.data, CHART_MAX_POINTS, chartRowSchema);
	const series = parseCapped(
		props.series,
		CHART_MAX_SERIES,
		chartSeriesEntrySchema
	);
	const height = Math.min(
		480,
		Math.max(120, props.height ?? DEFAULT_CHART_HEIGHT)
	);
	const geometry: AgentUiGeometryStyle = {
		"--agent-ui-chart-height": `${height}px`,
	};
	const config: ChartConfig = Object.fromEntries(
		series.map((entry) => [entry.key, { label: entry.label ?? entry.key }])
	);
	const formatValue = (value: ChartFormattedValue | undefined) =>
		formatChartValue(value, props.valueFormat, props.currency);
	const tooltip = (
		<ChartTooltip
			content={
				<ChartTooltipContent
					formatter={(value, name) => (
						<span className="flex w-full justify-between gap-3">
							<span className="text-muted-foreground">
								{config[String(name)]?.label ?? name}
							</span>
							<span className="font-mono tabular-nums">
								{formatValue(value)}
							</span>
						</span>
					)}
					hideLabel={props.type === "pie"}
				/>
			}
		/>
	);
	const legend =
		(props.showLegend ?? series.length > 1) ? (
			<ChartLegend content={<ChartLegendContent />} />
		) : null;
	const className = "aspect-auto h-(--agent-ui-chart-height) w-full";

	// The pie draws its first series; the guard below also narrows it for that branch.
	const [firstSeries] = series;
	if (data.length === 0 || firstSeries === undefined) {
		return (
			<div
				className="flex h-(--agent-ui-chart-height) items-center justify-center rounded-lg border border-border border-dashed text-muted-foreground text-xs"
				style={geometry}
			>
				No data
			</div>
		);
	}

	if (props.type === "pie") {
		const pieColors = new Map<object, string>(
			data.map((row, index) => [
				row,
				`var(--${CHART_COLORS[index % CHART_COLORS.length]})`,
			])
		);
		// Pie legend entries are categories (one per row), not series, so the
		// legend resolves labels through `xKey` against per-category config.
		const pieConfig: ChartConfig = { ...config };
		for (const row of data) {
			const category = String(row[props.xKey] ?? "");
			pieConfig[category] ??= { label: category };
		}
		return (
			<ChartContainer className={className} config={pieConfig} style={geometry}>
				<PieChart accessibilityLayer>
					<ChartTooltip
						content={(tooltipProps) => {
							const color = `var(--${CHART_COLORS[Number(tooltipProps.activeIndex) % CHART_COLORS.length]})`;
							return (
								<ChartTooltipContent
									active={tooltipProps.active}
									formatter={(value, name) => (
										<span className="flex w-full justify-between gap-3">
											<span className="text-muted-foreground">
												{config[String(name)]?.label ?? name}
											</span>
											<span className="font-mono tabular-nums">
												{formatValue(value)}
											</span>
										</span>
									)}
									hideLabel={props.type === "pie"}
									label={tooltipProps.label}
									labelFormatter={tooltipProps.labelFormatter}
									payload={tooltipProps.payload.map((entry) => ({
										...entry,
										color,
										fill: color,
										payload: { ...entry.payload, fill: color },
									}))}
								/>
							);
						}}
					/>
					{legend ? (
						<ChartLegend
							content={(legendProps) => (
								<ChartLegendContent
									nameKey={props.xKey}
									payload={legendProps.payload?.map((entry) => ({
										...entry,
										color: entry.payload
											? (pieColors.get(entry.payload) ?? entry.color)
											: entry.color,
									}))}
									verticalAlign={legendProps.verticalAlign}
								/>
							)}
						/>
					) : null}
					<Pie
						data={data}
						dataKey={firstSeries.key}
						innerRadius="45%"
						nameKey={props.xKey}
						outerRadius="80%"
						paddingAngle={2}
						shape={(sector) => (
							<Sector
								{...sector}
								fill={`var(--${CHART_COLORS[sector.index % CHART_COLORS.length]})`}
							/>
						)}
						strokeWidth={0}
					/>
				</PieChart>
			</ChartContainer>
		);
	}

	const axes = (
		<>
			<CartesianGrid strokeOpacity={0.35} vertical={false} />
			<XAxis
				axisLine={false}
				dataKey={props.xKey}
				minTickGap={24}
				tickLine={false}
				tickMargin={8}
			/>
			<YAxis
				axisLine={false}
				tickFormatter={formatValue}
				tickLine={false}
				width={56}
			/>
		</>
	);
	const stackId = props.stacked ? "stack" : undefined;
	const margin = { left: 4, right: 8, top: 8 };

	if (props.type === "line") {
		return (
			<ChartContainer className={className} config={config} style={geometry}>
				<LineChart accessibilityLayer data={data} margin={margin}>
					{axes}
					{tooltip}
					{legend}
					{series.map((entry, index) => (
						<Line
							dataKey={entry.key}
							dot={data.length <= 24}
							key={entry.key}
							name={entry.key}
							stroke={chartColor(entry, index)}
							strokeWidth={2}
							type="monotone"
						/>
					))}
				</LineChart>
			</ChartContainer>
		);
	}
	if (props.type === "area") {
		return (
			<ChartContainer className={className} config={config} style={geometry}>
				<AreaChart accessibilityLayer data={data} margin={margin}>
					{axes}
					{tooltip}
					{legend}
					{series.map((entry, index) => (
						<Area
							dataKey={entry.key}
							fill={chartColor(entry, index)}
							fillOpacity={0.25}
							key={entry.key}
							name={entry.key}
							stackId={stackId}
							stroke={chartColor(entry, index)}
							strokeWidth={2}
							type="monotone"
						/>
					))}
				</AreaChart>
			</ChartContainer>
		);
	}
	return (
		<ChartContainer className={className} config={config} style={geometry}>
			<BarChart accessibilityLayer data={data} margin={margin}>
				{axes}
				{tooltip}
				{legend}
				{series.map((entry, index) => (
					<Bar
						dataKey={entry.key}
						fill={chartColor(entry, index)}
						key={entry.key}
						name={entry.key}
						radius={props.stacked ? 0 : 4}
						stackId={stackId}
					/>
				))}
			</BarChart>
		</ChartContainer>
	);
};

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

const StatRenderer: Render<{
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

const ProgressRenderer: Render<{ value: number; label?: string }> = ({
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

const SkeletonRenderer: Render<{ width?: string; height?: string }> = ({
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

const ButtonRenderer: Render<{
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

const InputRenderer: Render<{
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

const TextareaRenderer: Render<{
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

const CheckboxRenderer: Render<{ label?: string; checked?: boolean }> = ({
	props,
	bindings,
}) => {
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

const SwitchRenderer: Render<{ label?: string; checked?: boolean }> = ({
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

const SelectRenderer: Render<{
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

const OptionListRenderer: Render<{
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

const SliderRenderer: Render<{
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

const ApprovalCardRenderer: Render<{
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

const LinkPreviewRenderer: Render<{
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

const components = {
	Stack: StackRenderer,
	Grid: GridRenderer,
	Card: CardRenderer,
	Separator: SeparatorRenderer,
	Heading: HeadingRenderer,
	Text: TextRenderer,
	Link: LinkRenderer,
	Image: ImageRenderer,
	Avatar: AvatarRenderer,
	Badge: BadgeRenderer,
	Alert: AlertRenderer,
	Table: TableRenderer,
	Chart: ChartRenderer,
	Stat: StatRenderer,
	Progress: ProgressRenderer,
	Skeleton: SkeletonRenderer,
	Button: ButtonRenderer,
	Input: InputRenderer,
	Textarea: TextareaRenderer,
	Checkbox: CheckboxRenderer,
	Switch: SwitchRenderer,
	Select: SelectRenderer,
	OptionList: OptionListRenderer,
	Slider: SliderRenderer,
	ApprovalCard: ApprovalCardRenderer,
	LinkPreview: LinkPreviewRenderer,
} satisfies Components<typeof agentUiCatalog>;

export const { registry } = defineRegistry(agentUiCatalog, {
	actions: {
		submit: async () => undefined,
	},
	components,
});
