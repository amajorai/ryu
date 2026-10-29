"use client";

import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import get from "lodash/get.js";
import {
	type ComponentProps,
	type ComponentType,
	type CSSProperties,
	createContext,
	type ReactNode,
	useContext,
	useId,
	useLayoutEffect,
	useMemo,
} from "react";
import type {
	LegendPayload,
	TooltipPayloadEntry,
	TooltipValueType,
} from "recharts";
import * as RechartsPrimitive from "recharts";
import {
	isNativeNumber,
	isNativeObjectReceiver,
	isNativeText,
} from "../lib/native-primitive-observation.ts";
import {
	chartColorVariableName,
	safeChartColor,
	sanitizeChartIdentifier,
} from "./chart-safety.ts";

// Format: { THEME_NAME: CSS_SELECTOR }
const THEMES = { light: "", dark: ".dark" } as const;

const INITIAL_DIMENSION = { width: 320, height: 200 } as const;
type TooltipNameType = number | string;

export { chartColorVariableName, safeChartColor } from "./chart-safety.ts";

export type ChartConfig = Record<
	string,
	{
		label?: ReactNode;
		icon?: ComponentType;
	} & (
		| { color?: string; theme?: never }
		| { color?: never; theme: Record<keyof typeof THEMES, string> }
	)
>;

interface ChartContextProps {
	config: ChartConfig;
}

interface ChartColorStyle extends CSSProperties {
	[key: `--color-${string}`]: string;
}
interface ChartSwatchStyle extends CSSProperties {
	"--chart-swatch": string | undefined;
}

const ChartContext = createContext<ChartContextProps | null>(null);

function useChart() {
	const context = useContext(ChartContext);

	if (!context) {
		throw new Error("useChart must be used within a <ChartContainer />");
	}

	return context;
}

function chartColors(config: ChartConfig): ChartColorStyle {
	return Object.fromEntries(
		Object.entries(config).flatMap(([key, item]) => {
			const light = safeChartColor(item.theme?.light ?? item.color);
			const dark = safeChartColor(item.theme?.dark ?? item.color);
			return light && dark
				? [[chartColorVariableName(key), `light-dark(${light}, ${dark})`]]
				: [];
		})
	);
}

function ChartContainer({
	id,
	className,
	children,
	config,
	initialDimension = INITIAL_DIMENSION,
	style,
	...props
}: ComponentProps<"div"> & {
	config: ChartConfig;
	children: ComponentProps<
		typeof RechartsPrimitive.ResponsiveContainer
	>["children"];
	initialDimension?: {
		width: number;
		height: number;
	};
}) {
	const uniqueId = useId();
	const chartId = `chart-${sanitizeChartIdentifier(id ?? uniqueId)}`;
	// Sanitized color variables go on the wrapper during render so server-rendered
	// charts are colored before hydration; config colors win over caller style.
	const chartStyle: ChartColorStyle = { ...style, ...chartColors(config) };

	return (
		<ChartContext.Provider value={{ config }}>
			<div
				className={cn(
					"flex aspect-video justify-center text-xs [color-scheme:light] dark:[color-scheme:dark] [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-sector]:outline-hidden [&_.recharts-surface]:outline-hidden",
					className
				)}
				data-chart={chartId}
				data-slot="chart"
				{...props}
				style={chartStyle}
			>
				<RechartsPrimitive.ResponsiveContainer
					initialDimension={initialDimension}
				>
					{children}
				</RechartsPrimitive.ResponsiveContainer>
			</div>
		</ChartContext.Provider>
	);
}

// Preserve the exported style helper for chart hosts that own their wrapper.
function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
	const colorStyle: ChartColorStyle = chartColors(config);
	useLayoutEffect(() => {
		const element = document.querySelector(
			`[data-chart="${sanitizeChartIdentifier(id)}"]`
		);
		if (!(element instanceof HTMLElement)) {
			return;
		}
		element.classList.add("[color-scheme:light]", "dark:[color-scheme:dark]");
		for (const [name, color] of Object.entries(colorStyle)) {
			element.style.setProperty(name, color);
		}
		return () => {
			for (const name of Object.keys(colorStyle)) {
				element.style.removeProperty(name);
			}
		};
	}, [colorStyle, id]);
	return null;
}

const ChartTooltip = RechartsPrimitive.Tooltip;

function ChartTooltipContent({
	active,
	payload,
	className,
	indicator = "dot",
	hideLabel = false,
	hideIndicator = false,
	label,
	labelFormatter,
	labelClassName,
	formatter,
	color,
	nameKey,
	labelKey,
}: ComponentProps<typeof RechartsPrimitive.Tooltip> &
	ComponentProps<"div"> & {
		hideLabel?: boolean;
		hideIndicator?: boolean;
		indicator?: "line" | "dot" | "dashed";
		nameKey?: string;
		labelKey?: string;
	} & Omit<
		RechartsPrimitive.DefaultTooltipContentProps<
			TooltipValueType,
			TooltipNameType
		>,
		"accessibilityLayer"
	>) {
	const { config } = useChart();

	const tooltipLabel = useMemo(() => {
		if (hideLabel || !payload?.length) {
			return null;
		}

		const [item] = payload;
		const key = `${labelKey ?? item?.dataKey ?? item?.name ?? "value"}`;
		const itemConfig = getPayloadConfigFromPayload(config, item, key);
		const value =
			!labelKey && isNativeText(label)
				? (config[label]?.label ?? label)
				: itemConfig?.label;

		if (labelFormatter) {
			return (
				<div className={cn("font-medium", labelClassName)}>
					{labelFormatter(value, payload)}
				</div>
			);
		}

		if (!value) {
			return null;
		}

		return <div className={cn("font-medium", labelClassName)}>{value}</div>;
	}, [
		label,
		labelFormatter,
		payload,
		hideLabel,
		labelClassName,
		config,
		labelKey,
	]);

	if (!(active && payload?.length)) {
		return null;
	}

	const nestLabel = payload.length === 1 && indicator !== "dot";

	return (
		<div
			className={cn(
				"relative grid min-w-32 items-start gap-1.5 rounded-xl bg-popover/70 px-2.5 py-1.5 text-popover-foreground text-xs backdrop-blur-2xl backdrop-saturate-150 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit]",
				className
			)}
		>
			{nestLabel ? null : tooltipLabel}
			<div className="grid gap-1.5">
				{payload
					.filter((item) => item.type !== "none")
					.map((item, index) => {
						const key = `${nameKey ?? item.name ?? item.dataKey ?? "value"}`;
						const itemConfig = getPayloadConfigFromPayload(config, item, key);
						const indicatorColor = color ?? item.payload?.fill ?? item.color;

						return (
							<div
								className={cn(
									"flex w-full flex-wrap items-stretch gap-2 [&>svg]:h-2.5 [&>svg]:w-2.5 [&>svg]:text-muted-foreground",
									indicator === "dot" && "items-center"
								)}
								key={index}
							>
								{formatter && item?.value !== undefined && item.name ? (
									formatter(item.value, item.name, item, index, item.payload)
								) : (
									<>
										{itemConfig?.icon ? (
											<itemConfig.icon />
										) : (
											!hideIndicator && (
												<div
													className={cn(
														"shrink-0 rounded-[2px] border-(--color-border) bg-(--color-bg)",
														{
															"h-2.5 w-2.5": indicator === "dot",
															"w-1": indicator === "line",
															"w-0 border-[1.5px] border-dashed bg-transparent":
																indicator === "dashed",
															"my-0.5": nestLabel && indicator === "dashed",
														}
													)}
													style={
														// SAFETY: These two authored custom-property slots are sent to
														// native React style.setProperty unchanged; CSSProperties omits
														// them. This does not validate the caller/payload color value.
														{
															"--color-bg": indicatorColor,
															"--color-border": indicatorColor,
														} as CSSProperties
													}
												/>
											)
										)}
										<div
											className={cn(
												"flex flex-1 justify-between leading-none",
												nestLabel ? "items-end" : "items-center"
											)}
										>
											<div className="grid gap-1.5">
												{nestLabel ? tooltipLabel : null}
												<span className="text-muted-foreground">
													{itemConfig?.label ?? item.name}
												</span>
											</div>
											{item.value != null && (
												<span className="font-medium font-mono text-foreground tabular-nums">
													{isNativeNumber(item.value)
														? formatNumber(item.value)
														: String(item.value)}
												</span>
											)}
										</div>
									</>
								)}
							</div>
						);
					})}
			</div>
		</div>
	);
}

const ChartLegend = RechartsPrimitive.Legend;

function ChartLegendContent({
	className,
	hideIcon = false,
	payload,
	verticalAlign = "bottom",
	nameKey,
}: ComponentProps<"div"> & {
	hideIcon?: boolean;
	nameKey?: string;
} & RechartsPrimitive.DefaultLegendContentProps) {
	const { config } = useChart();

	if (!payload?.length) {
		return null;
	}

	return (
		<div
			className={cn(
				"flex items-center justify-center gap-4",
				verticalAlign === "top" ? "pb-3" : "pt-3",
				className
			)}
		>
			{payload
				.filter((item) => item.type !== "none")
				.map((item, index) => {
					const key = `${nameKey ?? item.dataKey ?? "value"}`;
					const itemConfig = getPayloadConfigFromPayload(config, item, key);
					const swatchStyle: ChartSwatchStyle = {
						"--chart-swatch": item.color,
					};

					return (
						<div
							className={cn(
								"flex items-center gap-1.5 [&>svg]:h-3 [&>svg]:w-3 [&>svg]:text-muted-foreground"
							)}
							key={index}
						>
							{itemConfig?.icon && !hideIcon ? (
								<itemConfig.icon />
							) : (
								<div
									className="h-2 w-2 shrink-0 rounded-[2px] bg-(--chart-swatch)"
									style={swatchStyle}
								/>
							)}
							{itemConfig?.label}
						</div>
					);
				})}
		</div>
	);
}

function getPayloadConfigFromPayload(
	config: ChartConfig,
	payload:
		| TooltipPayloadEntry<TooltipValueType, TooltipNameType>
		| LegendPayload
		| undefined,
	key: string
) {
	if (!isNativeObjectReceiver(payload) || payload === null) {
		return undefined;
	}

	// Capture the raw nested receiver once before checking its object brand.
	// Recharts deliberately leaves this payload opaque; no DTO is inferred.
	const rawPayload: unknown =
		"payload" in payload ? payload.payload : undefined;
	const payloadPayload =
		isNativeObjectReceiver(rawPayload) && rawPayload !== null
			? rawPayload
			: undefined;

	let configLabelKey = key;
	let outerMatches = false;

	if (key in payload) {
		const rawLabel: unknown = get(payload, [key]);
		if (isNativeText(rawLabel)) {
			configLabelKey = rawLabel;
			outerMatches = true;
		}
	}
	if (!outerMatches && payloadPayload && key in payloadPayload) {
		const rawNestedLabel: unknown = get(payloadPayload, [key]);
		if (isNativeText(rawNestedLabel)) {
			configLabelKey = rawNestedLabel;
		}
	}

	return configLabelKey in config ? config[configLabelKey] : config[key];
}

export {
	ChartContainer,
	ChartLegend,
	ChartLegendContent,
	ChartStyle,
	ChartTooltip,
	ChartTooltipContent,
};
