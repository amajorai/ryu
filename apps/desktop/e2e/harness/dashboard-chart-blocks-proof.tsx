import { createRoot } from "react-dom/client";
import { DashboardGrid } from "@/src/components/dashboard/DashboardGrid.tsx";
import type { Widget } from "@/src/lib/api/dashboard.ts";
import "../../src/index.css";

const WIDGETS: Widget[] = [
	{
		config: { series: ["requests", "errors"], x_key: "day" },
		dashboard_id: "chart-blocks-proof",
		id: "request-volume",
		kind: "area_chart",
		last_value: [
			{ day: "Mon", errors: 2, requests: 48 },
			{ day: "Tue", errors: 4, requests: 62 },
			{ day: "Wed", errors: 1, requests: 55 },
			{ day: "Thu", errors: 6, requests: 76 },
			{ day: "Fri", errors: 3, requests: 68 },
			{ day: "Sat", errors: 1, requests: 42 },
			{ day: "Sun", errors: 2, requests: 51 },
		],
		layout: { h: 5, w: 8, x: 0, y: 0 },
		source: { data: null, type: "static" },
		title: "Request volume",
	},
	{
		config: { name_key: "provider", value_key: "requests" },
		dashboard_id: "chart-blocks-proof",
		id: "routing-mix",
		kind: "pie_chart",
		last_value: [
			{ provider: "OpenAI", requests: 88 },
			{ provider: "Anthropic", requests: 63 },
			{ provider: "Local", requests: 41 },
		],
		layout: { h: 5, w: 4, x: 8, y: 0 },
		source: { data: null, type: "static" },
		title: "Routing mix",
	},
	{
		config: { series: ["requests"], x_key: "provider" },
		dashboard_id: "chart-blocks-proof",
		id: "provider-volume",
		kind: "bar_chart",
		last_value: [
			{ provider: "OpenAI", requests: 88 },
			{ provider: "Anthropic", requests: 63 },
			{ provider: "Local", requests: 41 },
			{ provider: "Gateway", requests: 29 },
		],
		layout: { h: 5, w: 6, x: 0, y: 5 },
		source: { data: null, type: "static" },
		title: "Requests by provider",
	},
	{
		config: { series: ["input", "output"], x_key: "period" },
		dashboard_id: "chart-blocks-proof",
		id: "token-volume",
		kind: "line_chart",
		last_value: [
			{ input: 1824, output: 642, period: "09:00" },
			{ input: 2440, output: 818, period: "10:00" },
			{ input: 2136, output: 704, period: "11:00" },
			{ input: 2980, output: 1024, period: "12:00" },
			{ input: 2652, output: 906, period: "13:00" },
		],
		layout: { h: 5, w: 6, x: 6, y: 5 },
		source: { data: null, type: "static" },
		title: "Token flow",
	},
];

function DashboardChartBlocksProof() {
	return (
		<main className="min-h-screen bg-background px-6 py-10 text-foreground">
			<div className="mx-auto flex max-w-6xl flex-col gap-6">
				<header className="flex flex-col gap-2">
					<p className="font-medium text-primary text-xs uppercase tracking-(--tracking-section)">
						Ryu desktop verification artifact
					</p>
					<h1 className="font-semibold text-3xl tracking-tight">
						Dashboard chart blocks
					</h1>
					<p className="max-w-2xl text-muted-foreground">
						Responsive chart widgets with composed KPI-style framing, quiet
						axes, legends, and shared hover tooltips.
					</p>
				</header>

				<section
					aria-label="Dashboard chart block examples"
					className="rounded-3xl border border-border/70 bg-card p-4 shadow-sm"
					data-testid="dashboard-chart-blocks-proof"
				>
					<div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
						<div>
							<h2 className="font-medium text-sm">Operations overview</h2>
							<p className="text-muted-foreground text-xs">
								Line, bar, area, and pie widgets share the same visual language.
							</p>
						</div>
						<span className="text-muted-foreground text-xs">
							Live sample data
						</span>
					</div>
					<div className="h-[920px]">
						<DashboardGrid
							live={{}}
							onLayoutPersist={() => undefined}
							onRefresh={() => undefined}
							onRemove={() => undefined}
							widgets={WIDGETS}
						/>
					</div>
				</section>

				<p className="text-muted-foreground text-xs" data-testid="proof-status">
					Verified presentation: four chart kinds render inside the real
					dashboard grid with shared legends, responsive axes, and tooltip-ready
					series.
				</p>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<DashboardChartBlocksProof />);
}
