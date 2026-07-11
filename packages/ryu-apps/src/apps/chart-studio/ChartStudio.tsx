// Chart Studio widget (spec §4.4 app 4, D6). An interactive, inline-SVG chart with a
// legend toggle, a segmented chart-type switch, hover tooltips, and brush-select over
// the x-axis that hands a range back to the model (`callTool('chart__query_range')` or
// `sendFollowUpMessage`). No external chart lib — everything is hand-rolled SVG so the
// single-file CSP bundle (D3: `default-src 'none'`) stays small and self-contained.
//
// Data model:
//   toolInput  = { title, series:[{name,points:[{x,y}]}], chart_type, x_label, y_label, annotations? }
//   toolOutput = { normalized_series, available_types, x_domain, y_domain, summary_stats }
// The widget reads the FULL series (normalized_series, falling back to toolInput.series);
// the model only ever saw summary_stats. UI state (hidden series, chosen type) persists
// through `window.ryu.setWidgetState` keyed host-side by toolCallId (D4).

import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useRyuGlobal } from "../../shared/useRyuGlobal";

type ChartType = "line" | "bar" | "area" | "scatter";

interface DataPoint {
	x: number;
	y: number;
}

interface DataSeries {
	name: string;
	points: DataPoint[];
}

interface Annotation {
	x?: number;
	y?: number;
	label?: string;
}

interface SummaryStats {
	min?: number;
	max?: number;
	mean?: number;
	trend?: string | number;
}

interface WidgetState {
	hiddenSeries?: string[];
	chartType?: ChartType;
}

type ChartModel =
	| { status: "loading" }
	| { status: "empty" }
	| { status: "error"; message: string }
	| {
			status: "ready";
			title: string;
			xLabel: string;
			yLabel: string;
			series: DataSeries[];
			availableTypes: ChartType[];
			defaultType: ChartType;
			xDomain: [number, number];
			yDomain: [number, number];
			summary: SummaryStats | null;
			annotations: Annotation[];
	  };

const CHART_TYPES: ChartType[] = ["line", "bar", "area", "scatter"];
const SERIES_COLORS = [
	"var(--ryu-chart-1)",
	"var(--ryu-chart-2)",
	"var(--ryu-chart-3)",
	"var(--ryu-chart-4)",
	"var(--ryu-chart-5)",
	"var(--ryu-chart-6)",
	"var(--ryu-chart-7)",
	"var(--ryu-chart-8)",
];
const QUERY_RANGE_TOOL = "chart__query_range";
const BRUSH_MIN_PX = 6;
const PAD_LEFT = 52;
const PAD_RIGHT = 16;
const PAD_TOP = 16;
const PAD_BOTTOM = 40;
const INLINE_HEIGHT = 260;
const FULLSCREEN_HEIGHT = 460;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asFiniteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parsePoints(raw: unknown): DataPoint[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const points: DataPoint[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) {
			continue;
		}
		const x = asFiniteNumber(entry.x);
		const y = asFiniteNumber(entry.y);
		if (x === null || y === null) {
			continue;
		}
		points.push({ x, y });
	}
	return points;
}

function parseSeries(raw: unknown): DataSeries[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const series: DataSeries[] = [];
	for (const [index, entry] of raw.entries()) {
		if (!isRecord(entry)) {
			continue;
		}
		const points = parsePoints(entry.points);
		if (points.length === 0) {
			continue;
		}
		const name =
			typeof entry.name === "string" && entry.name.length > 0
				? entry.name
				: `Series ${index + 1}`;
		series.push({ name, points });
	}
	return series;
}

function parseChartTypes(raw: unknown): ChartType[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const seen = new Set<ChartType>();
	for (const entry of raw) {
		if (typeof entry === "string" && CHART_TYPES.includes(entry as ChartType)) {
			seen.add(entry as ChartType);
		}
	}
	return [...seen];
}

function parseDomain(raw: unknown): [number, number] | null {
	if (!Array.isArray(raw) || raw.length < 2) {
		return null;
	}
	const lo = asFiniteNumber(raw[0]);
	const hi = asFiniteNumber(raw[1]);
	if (lo === null || hi === null) {
		return null;
	}
	return lo <= hi ? [lo, hi] : [hi, lo];
}

function computeDomain(
	series: DataSeries[],
	axis: "x" | "y",
): [number, number] {
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const s of series) {
		for (const point of s.points) {
			const value = point[axis];
			if (value < min) {
				min = value;
			}
			if (value > max) {
				max = value;
			}
		}
	}
	if (!(Number.isFinite(min) && Number.isFinite(max))) {
		return [0, 1];
	}
	if (min === max) {
		// A flat axis needs a visible span so points don't collapse onto an edge.
		const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1;
		return [min - pad, max + pad];
	}
	return [min, max];
}

function parseSummary(raw: unknown): SummaryStats | null {
	if (!isRecord(raw)) {
		return null;
	}
	const summary: SummaryStats = {};
	const min = asFiniteNumber(raw.min);
	const max = asFiniteNumber(raw.max);
	const mean = asFiniteNumber(raw.mean);
	if (min !== null) {
		summary.min = min;
	}
	if (max !== null) {
		summary.max = max;
	}
	if (mean !== null) {
		summary.mean = mean;
	}
	if (typeof raw.trend === "string" || typeof raw.trend === "number") {
		summary.trend = raw.trend;
	}
	return Object.keys(summary).length > 0 ? summary : null;
}

function parseAnnotations(raw: unknown): Annotation[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const annotations: Annotation[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) {
			continue;
		}
		const x = asFiniteNumber(entry.x);
		const y = asFiniteNumber(entry.y);
		if (x === null && y === null) {
			continue;
		}
		annotations.push({
			x: x ?? undefined,
			y: y ?? undefined,
			label: typeof entry.label === "string" ? entry.label : undefined,
		});
	}
	return annotations;
}

function parseModel(output: unknown, input: unknown): ChartModel {
	if (output == null && input == null) {
		return { status: "loading" };
	}
	try {
		const out = isRecord(output) ? output : {};
		const inp = isRecord(input) ? input : {};

		const series =
			parseSeries(out.normalized_series).length > 0
				? parseSeries(out.normalized_series)
				: parseSeries(inp.series);
		if (series.length === 0) {
			return { status: "empty" };
		}

		const availableFromOut = parseChartTypes(out.available_types);
		const availableTypes =
			availableFromOut.length > 0 ? availableFromOut : CHART_TYPES;

		const requested =
			typeof inp.chart_type === "string" &&
			CHART_TYPES.includes(inp.chart_type as ChartType)
				? (inp.chart_type as ChartType)
				: null;
		const defaultType: ChartType =
			requested && availableTypes.includes(requested)
				? requested
				: (availableTypes[0] ?? "line");

		return {
			status: "ready",
			title: typeof inp.title === "string" ? inp.title : "Chart",
			xLabel: typeof inp.x_label === "string" ? inp.x_label : "x",
			yLabel: typeof inp.y_label === "string" ? inp.y_label : "y",
			series,
			availableTypes,
			defaultType,
			xDomain: parseDomain(out.x_domain) ?? computeDomain(series, "x"),
			yDomain: parseDomain(out.y_domain) ?? computeDomain(series, "y"),
			summary: parseSummary(out.summary_stats),
			annotations: parseAnnotations(inp.annotations),
		};
	} catch (error) {
		return {
			status: "error",
			message: error instanceof Error ? error.message : "Malformed chart data",
		};
	}
}

function formatNumber(value: number): string {
	if (!Number.isFinite(value)) {
		return "–";
	}
	if (Math.abs(value) >= 1000 || Number.isInteger(value)) {
		return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
	}
	return Number(value.toFixed(3)).toString();
}

function colorFor(index: number): string {
	return SERIES_COLORS[index % SERIES_COLORS.length] ?? "var(--ryu-chart-1)";
}

interface Geometry {
	width: number;
	height: number;
	plotLeft: number;
	plotTop: number;
	plotWidth: number;
	plotHeight: number;
	xToPx: (x: number) => number;
	yToPx: (y: number) => number;
	pxToX: (px: number) => number;
	baselinePx: number;
}

function makeGeometry(
	width: number,
	height: number,
	xDomain: [number, number],
	yDomain: [number, number],
): Geometry {
	const plotLeft = PAD_LEFT;
	const plotTop = PAD_TOP;
	const plotWidth = Math.max(1, width - PAD_LEFT - PAD_RIGHT);
	const plotHeight = Math.max(1, height - PAD_TOP - PAD_BOTTOM);
	const [xMin, xMax] = xDomain;
	const [yMin, yMax] = yDomain;
	const xSpan = xMax - xMin || 1;
	const ySpan = yMax - yMin || 1;
	const xToPx = (x: number) => plotLeft + ((x - xMin) / xSpan) * plotWidth;
	const yToPx = (y: number) => plotTop + (1 - (y - yMin) / ySpan) * plotHeight;
	const pxToX = (px: number) => xMin + ((px - plotLeft) / plotWidth) * xSpan;
	const baseValue = yMin <= 0 && yMax >= 0 ? 0 : yMin;
	return {
		width,
		height,
		plotLeft,
		plotTop,
		plotWidth,
		plotHeight,
		xToPx,
		yToPx,
		pxToX,
		baselinePx: yToPx(baseValue),
	};
}

function buildTicks(min: number, max: number, count: number): number[] {
	if (!(Number.isFinite(min) && Number.isFinite(max)) || max <= min) {
		return [min];
	}
	const step = (max - min) / count;
	const ticks: number[] = [];
	for (let i = 0; i <= count; i++) {
		ticks.push(min + step * i);
	}
	return ticks;
}

function linePath(series: DataSeries, geo: Geometry): string {
	return series.points
		.map((point, index) => {
			const command = index === 0 ? "M" : "L";
			return `${command}${geo.xToPx(point.x)},${geo.yToPx(point.y)}`;
		})
		.join(" ");
}

function areaPath(series: DataSeries, geo: Geometry): string {
	if (series.points.length === 0) {
		return "";
	}
	const top = series.points
		.map(
			(point, index) =>
				`${index === 0 ? "M" : "L"}${geo.xToPx(point.x)},${geo.yToPx(point.y)}`,
		)
		.join(" ");
	const first = series.points[0];
	const last = series.points[series.points.length - 1];
	if (!(first && last)) {
		return "";
	}
	return `${top} L${geo.xToPx(last.x)},${geo.baselinePx} L${geo.xToPx(
		first.x,
	)},${geo.baselinePx} Z`;
}

interface NearestHit {
	seriesName: string;
	color: string;
	x: number;
	y: number;
	px: number;
	py: number;
}

function findNearest(
	series: DataSeries[],
	colors: string[],
	geo: Geometry,
	cursorPx: number,
	cursorPy: number,
): NearestHit | null {
	let best: NearestHit | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const [index, s] of series.entries()) {
		for (const point of s.points) {
			const px = geo.xToPx(point.x);
			const py = geo.yToPx(point.y);
			const distance = (px - cursorPx) ** 2 + (py - cursorPy) ** 2;
			if (distance < bestDistance) {
				bestDistance = distance;
				best = {
					seriesName: s.name,
					color: colors[index] ?? "var(--ryu-chart-1)",
					x: point.x,
					y: point.y,
					px,
					py,
				};
			}
		}
	}
	return best;
}

interface BrushRange {
	xStart: number;
	xEnd: number;
}

type QueryStatus =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "done"; message: string }
	| { kind: "error"; message: string };

export function ChartStudio() {
	const toolOutput = useRyuGlobal("toolOutput");
	const toolInput = useRyuGlobal("toolInput");
	const displayMode = useRyuGlobal("displayMode");
	const widgetState = useRyuGlobal("widgetState") as WidgetState | undefined;

	const model = useMemo(
		() => parseModel(toolOutput, toolInput),
		[toolOutput, toolInput],
	);

	const plotRef = useRef<HTMLDivElement>(null);
	const svgRef = useRef<SVGSVGElement>(null);
	const [containerWidth, setContainerWidth] = useState(560);
	const [hover, setHover] = useState<{ px: number; py: number } | null>(null);
	const [dragStartPx, setDragStartPx] = useState<number | null>(null);
	const [dragCurrentPx, setDragCurrentPx] = useState<number | null>(null);
	const [brush, setBrush] = useState<BrushRange | null>(null);
	const [queryStatus, setQueryStatus] = useState<QueryStatus>({ kind: "idle" });

	useLayoutEffect(() => {
		const el = plotRef.current;
		if (!el || typeof ResizeObserver === "undefined") {
			return;
		}
		const update = () =>
			setContainerWidth(Math.max(280, Math.floor(el.clientWidth)));
		const observer = new ResizeObserver(update);
		observer.observe(el);
		update();
		return () => observer.disconnect();
	}, []);

	const patchState = useCallback(
		(patch: Partial<WidgetState>) => {
			const next: WidgetState = { ...(widgetState ?? {}), ...patch };
			void window.ryu?.setWidgetState(next);
		},
		[widgetState],
	);

	if (model.status === "loading") {
		return (
			<div className="cs-status" role="status">
				<div className="cs-spinner" aria-hidden="true" />
				<p>Waiting for chart data…</p>
			</div>
		);
	}

	if (model.status === "empty") {
		return (
			<div className="cs-status">
				<p className="cs-status-title">No series to plot</p>
				<p className="cs-status-hint">
					The chart tool returned no data points.
				</p>
			</div>
		);
	}

	if (model.status === "error") {
		return (
			<div className="cs-status cs-status-error" role="alert">
				<p className="cs-status-title">Could not render chart</p>
				<p className="cs-status-hint">{model.message}</p>
			</div>
		);
	}

	const chartType: ChartType = widgetState?.chartType ?? model.defaultType;
	const hiddenSeries = new Set(widgetState?.hiddenSeries ?? []);
	const colors = model.series.map((_, index) => colorFor(index));
	const visibleSeries = model.series.filter((s) => !hiddenSeries.has(s.name));
	const visibleColors = model.series
		.map((s, index) => ({ name: s.name, color: colorFor(index) }))
		.filter((item) => !hiddenSeries.has(item.name))
		.map((item) => item.color);

	const height =
		displayMode === "fullscreen" ? FULLSCREEN_HEIGHT : INLINE_HEIGHT;
	const geo = makeGeometry(
		containerWidth,
		height,
		model.xDomain,
		model.yDomain,
	);
	const xTicks = buildTicks(model.xDomain[0], model.xDomain[1], 5);
	const yTicks = buildTicks(model.yDomain[0], model.yDomain[1], 4);

	const nearest =
		hover && dragStartPx === null
			? findNearest(visibleSeries, visibleColors, geo, hover.px, hover.py)
			: null;

	const toggleSeries = (name: string) => {
		const next = new Set(hiddenSeries);
		if (next.has(name)) {
			next.delete(name);
		} else if (next.size < model.series.length - 1) {
			// Never hide the last visible series — an empty plot is a dead end.
			next.add(name);
		}
		patchState({ hiddenSeries: [...next] });
	};

	const selectType = (type: ChartType) => patchState({ chartType: type });

	const localPointer = (
		event: ReactPointerEvent<SVGSVGElement>,
	): { px: number; py: number } => {
		const rect = svgRef.current?.getBoundingClientRect();
		const left = rect?.left ?? 0;
		const top = rect?.top ?? 0;
		return { px: event.clientX - left, py: event.clientY - top };
	};

	const clampToPlot = (px: number) =>
		Math.min(geo.plotLeft + geo.plotWidth, Math.max(geo.plotLeft, px));

	const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
		const { px } = localPointer(event);
		if (px < geo.plotLeft || px > geo.plotLeft + geo.plotWidth) {
			return;
		}
		svgRef.current?.setPointerCapture(event.pointerId);
		const clamped = clampToPlot(px);
		setDragStartPx(clamped);
		setDragCurrentPx(clamped);
		setHover(null);
	};

	const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
		const { px, py } = localPointer(event);
		if (dragStartPx !== null) {
			setDragCurrentPx(clampToPlot(px));
			return;
		}
		setHover({ px, py });
	};

	const finishDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
		if (dragStartPx === null || dragCurrentPx === null) {
			return;
		}
		try {
			svgRef.current?.releasePointerCapture(event.pointerId);
		} catch {
			// Capture may already be released; ignore.
		}
		const lo = Math.min(dragStartPx, dragCurrentPx);
		const hi = Math.max(dragStartPx, dragCurrentPx);
		setDragStartPx(null);
		setDragCurrentPx(null);
		if (hi - lo < BRUSH_MIN_PX) {
			setBrush(null);
			return;
		}
		const xStart = geo.pxToX(lo);
		const xEnd = geo.pxToX(hi);
		setBrush({ xStart, xEnd });
		setQueryStatus({ kind: "idle" });
	};

	const onPointerLeave = () => {
		if (dragStartPx === null) {
			setHover(null);
		}
	};

	const clearBrush = () => {
		setBrush(null);
		setQueryStatus({ kind: "idle" });
	};

	const runQueryRange = async () => {
		if (!brush) {
			return;
		}
		setQueryStatus({ kind: "loading" });
		try {
			const result = await window.ryu?.callTool(QUERY_RANGE_TOOL, {
				x_start: brush.xStart,
				x_end: brush.xEnd,
			});
			let count: number | null = null;
			if (isRecord(result)) {
				if (Array.isArray(result.points)) {
					count = result.points.length;
				} else if (Array.isArray(result.normalized_series)) {
					count = result.normalized_series.length;
				}
			}
			setQueryStatus({
				kind: "done",
				message:
					count === null
						? "Range data loaded."
						: `Loaded ${count} item${count === 1 ? "" : "s"} for the range.`,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Query failed.";
			setQueryStatus({ kind: "error", message });
		}
	};

	const askAboutRange = async () => {
		if (!brush) {
			return;
		}
		const prompt = `In the "${model.title}" chart, focus on ${model.xLabel} from ${formatNumber(
			brush.xStart,
		)} to ${formatNumber(brush.xEnd)}. What stands out in that range?`;
		try {
			await window.ryu?.sendFollowUpMessage({ prompt });
			setQueryStatus({ kind: "done", message: "Sent to the conversation." });
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Could not send message.";
			setQueryStatus({ kind: "error", message });
		}
	};

	const toggleFullscreen = () => {
		const mode = displayMode === "fullscreen" ? "inline" : "fullscreen";
		void window.ryu?.requestDisplayMode({ mode });
	};

	const dragRect =
		dragStartPx !== null && dragCurrentPx !== null
			? {
					x: Math.min(dragStartPx, dragCurrentPx),
					width: Math.abs(dragCurrentPx - dragStartPx),
				}
			: null;

	return (
		<div className="cs-root">
			<header className="cs-header">
				<div className="cs-titles">
					<h1 className="cs-title">{model.title}</h1>
					{model.summary ? (
						<p className="cs-subtitle">
							{model.summary.min !== undefined
								? `min ${formatNumber(model.summary.min)}`
								: null}
							{model.summary.max !== undefined
								? ` · max ${formatNumber(model.summary.max)}`
								: null}
							{model.summary.mean !== undefined
								? ` · mean ${formatNumber(model.summary.mean)}`
								: null}
							{model.summary.trend !== undefined
								? ` · trend ${model.summary.trend}`
								: null}
						</p>
					) : null}
				</div>
				<div className="cs-toolbar">
					<fieldset aria-label="Chart type" className="cs-segment">
						{model.availableTypes.map((type) => (
							<button
								aria-pressed={chartType === type}
								className="cs-segment-btn"
								key={type}
								onClick={() => selectType(type)}
								type="button"
							>
								{type}
							</button>
						))}
					</fieldset>
					<button
						className="cs-icon-btn"
						onClick={toggleFullscreen}
						title={
							displayMode === "fullscreen" ? "Exit fullscreen" : "Fullscreen"
						}
						type="button"
					>
						{displayMode === "fullscreen" ? "Exit" : "Expand"}
					</button>
				</div>
			</header>

			<div className="cs-plot" ref={plotRef}>
				<svg
					aria-label={`${chartType} chart: ${model.title}`}
					className="cs-svg"
					height={height}
					onPointerDown={onPointerDown}
					onPointerLeave={onPointerLeave}
					onPointerMove={onPointerMove}
					onPointerUp={finishDrag}
					ref={svgRef}
					role="img"
					width={containerWidth}
				>
					<title>{`${chartType} chart: ${model.title}`}</title>

					{yTicks.map((tick) => {
						const y = geo.yToPx(tick);
						return (
							<g key={`y-${tick}`}>
								<line
									className="cs-grid"
									x1={geo.plotLeft}
									x2={geo.plotLeft + geo.plotWidth}
									y1={y}
									y2={y}
								/>
								<text className="cs-axis-label" x={geo.plotLeft - 8} y={y + 4}>
									{formatNumber(tick)}
								</text>
							</g>
						);
					})}

					{xTicks.map((tick) => {
						const x = geo.xToPx(tick);
						return (
							<text
								className="cs-axis-label cs-axis-x"
								key={`x-${tick}`}
								x={x}
								y={geo.plotTop + geo.plotHeight + 20}
							>
								{formatNumber(tick)}
							</text>
						);
					})}

					<text
						className="cs-axis-title"
						x={geo.plotLeft + geo.plotWidth / 2}
						y={height - 4}
					>
						{model.xLabel}
					</text>
					<text
						className="cs-axis-title"
						transform={`rotate(-90 12 ${geo.plotTop + geo.plotHeight / 2})`}
						x={12}
						y={geo.plotTop + geo.plotHeight / 2}
					>
						{model.yLabel}
					</text>

					{model.annotations.map((annotation) => {
						if (annotation.x === undefined) {
							return null;
						}
						const x = geo.xToPx(annotation.x);
						return (
							<g
								key={`ann-${annotation.x}-${annotation.y ?? ""}-${annotation.label ?? ""}`}
							>
								<line
									className="cs-annotation"
									x1={x}
									x2={x}
									y1={geo.plotTop}
									y2={geo.plotTop + geo.plotHeight}
								/>
								{annotation.label ? (
									<text
										className="cs-annotation-label"
										x={x + 4}
										y={geo.plotTop + 12}
									>
										{annotation.label}
									</text>
								) : null}
							</g>
						);
					})}

					<ChartMarks
						chartType={chartType}
						colors={colors}
						geo={geo}
						hiddenSeries={hiddenSeries}
						series={model.series}
					/>

					{dragRect ? (
						<rect
							className="cs-brush"
							height={geo.plotHeight}
							width={dragRect.width}
							x={dragRect.x}
							y={geo.plotTop}
						/>
					) : null}

					{nearest ? (
						<g className="cs-hover">
							<line
								className="cs-hover-guide"
								x1={nearest.px}
								x2={nearest.px}
								y1={geo.plotTop}
								y2={geo.plotTop + geo.plotHeight}
							/>
							<circle
								cx={nearest.px}
								cy={nearest.py}
								fill={nearest.color}
								r={4.5}
								stroke="var(--ryu-bg)"
								strokeWidth={2}
							/>
						</g>
					) : null}
				</svg>

				{nearest ? (
					<div
						className="cs-tooltip"
						style={{
							left: `${Math.min(nearest.px + 12, containerWidth - 140)}px`,
							top: `${Math.max(nearest.py - 12, 0)}px`,
						}}
					>
						<span className="cs-tooltip-name">
							<span
								className="cs-swatch"
								style={{ background: nearest.color }}
							/>
							{nearest.seriesName}
						</span>
						<span className="cs-tooltip-value">
							{model.xLabel} {formatNumber(nearest.x)} · {model.yLabel}{" "}
							{formatNumber(nearest.y)}
						</span>
					</div>
				) : null}
			</div>

			{brush ? (
				<fieldset className="cs-brush-bar">
					<span className="cs-brush-label">
						{model.xLabel} {formatNumber(brush.xStart)} –{" "}
						{formatNumber(brush.xEnd)}
					</span>
					<div className="cs-brush-actions">
						<button
							className="cs-btn cs-btn-primary"
							disabled={queryStatus.kind === "loading"}
							onClick={runQueryRange}
							type="button"
						>
							{queryStatus.kind === "loading" ? "Querying…" : "Query range"}
						</button>
						<button className="cs-btn" onClick={askAboutRange} type="button">
							Ask about range
						</button>
						<button
							className="cs-btn cs-btn-ghost"
							onClick={clearBrush}
							type="button"
						>
							Clear
						</button>
					</div>
					{queryStatus.kind === "done" ? (
						<span className="cs-brush-status">{queryStatus.message}</span>
					) : null}
					{queryStatus.kind === "error" ? (
						<span className="cs-brush-status cs-brush-status-error">
							{queryStatus.message}
						</span>
					) : null}
				</fieldset>
			) : (
				<p className="cs-hint">Drag across the plot to select an x-range.</p>
			)}

			<fieldset aria-label="Series" className="cs-legend">
				{model.series.map((s, index) => {
					const hidden = hiddenSeries.has(s.name);
					return (
						<button
							aria-pressed={!hidden}
							className={
								hidden ? "cs-legend-item cs-legend-off" : "cs-legend-item"
							}
							key={s.name}
							onClick={() => toggleSeries(s.name)}
							type="button"
						>
							<span
								className="cs-swatch"
								style={{ background: colorFor(index) }}
							/>
							{s.name}
						</button>
					);
				})}
			</fieldset>
		</div>
	);
}

interface ChartMarksProps {
	chartType: ChartType;
	series: DataSeries[];
	colors: string[];
	hiddenSeries: Set<string>;
	geo: Geometry;
}

function ChartMarks({
	chartType,
	series,
	colors,
	hiddenSeries,
	geo,
}: ChartMarksProps) {
	const visible = series
		.map((s, index) => ({ series: s, color: colors[index] }))
		.filter((item) => !hiddenSeries.has(item.series.name));

	if (chartType === "bar") {
		const maxLen = Math.max(
			1,
			...visible.map((item) => item.series.points.length),
		);
		const slot = geo.plotWidth / maxLen;
		const groupWidth = Math.min(slot * 0.7, 48);
		const barWidth = Math.max(1.5, groupWidth / Math.max(1, visible.length));
		return (
			<g>
				{visible.map((item, seriesIndex) =>
					item.series.points.map((point) => {
						const center = geo.xToPx(point.x);
						const x = center - groupWidth / 2 + seriesIndex * barWidth;
						const y = geo.yToPx(point.y);
						const top = Math.min(y, geo.baselinePx);
						const barHeight = Math.abs(geo.baselinePx - y);
						return (
							<rect
								fill={item.color}
								height={Math.max(0.5, barHeight)}
								key={`${item.series.name}-${point.x}`}
								rx={1.5}
								width={barWidth}
								x={x}
								y={top}
							/>
						);
					}),
				)}
			</g>
		);
	}

	if (chartType === "scatter") {
		return (
			<g>
				{visible.map((item) =>
					item.series.points.map((point) => (
						<circle
							cx={geo.xToPx(point.x)}
							cy={geo.yToPx(point.y)}
							fill={item.color}
							fillOpacity={0.75}
							key={`${item.series.name}-${point.x}-${point.y}`}
							r={3.5}
						/>
					)),
				)}
			</g>
		);
	}

	if (chartType === "area") {
		return (
			<g>
				{visible.map((item) => (
					<g key={item.series.name}>
						<path
							d={areaPath(item.series, geo)}
							fill={item.color}
							fillOpacity={0.18}
							stroke="none"
						/>
						<path
							d={linePath(item.series, geo)}
							fill="none"
							stroke={item.color}
							strokeWidth={2}
						/>
					</g>
				))}
			</g>
		);
	}

	return (
		<g>
			{visible.map((item) => (
				<path
					d={linePath(item.series, geo)}
					fill="none"
					key={item.series.name}
					stroke={item.color}
					strokeLinejoin="round"
					strokeWidth={2}
				/>
			))}
		</g>
	);
}
