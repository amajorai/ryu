"use client";

import { Reveal } from "./reveal.tsx";

// The diagram geometry is generated. See tools/gen-architecture-diagram.mjs.
// The same geometry produces .github/architecture-{light,dark}.svg for the READMEs,
// so this React diagram and the README image never drift. Colors are theme tokens
// (--foreground / --background / --card / --muted / --border) so it themes for free.

const SURFACES = [
	"Desktop",
	"Mobile",
	"CLI",
	"Extension",
	"Bots",
	"Web",
] as const;
const ENGINES = [
	"OpenAI",
	"Claude Code",
	"Pi",
	"OpenClaw",
	"Hermes",
	"llama.cpp",
] as const;
const GATEWAY_PILLS = [
	"Routing",
	"Firewall",
	"PII / DLP",
	"Budgets",
	"Evals",
	"Audit",
] as const;
const CORE_PILLS = [
	"Sessions",
	"Memory",
	"Tools",
	"Workflows",
	"Sub-agents",
	"Sidecars",
] as const;

export default function Architecture() {
	return (
		<section className="container mx-auto px-4 py-20 md:py-28">
			<div className="mx-auto max-w-5xl">
				<div className="mb-12 text-center">
					<h2 className="mx-auto max-w-2xl text-balance font-medium text-3xl text-foreground tracking-tight md:text-4xl">
						Run the cheap path first. Escalate only when it matters.
					</h2>
					<p className="mx-auto mt-4 max-w-xl text-muted-foreground md:text-lg">
						Most teams pay twice: once for model calls, then again for the
						engineering work to make agents usable. Ryu gives you one layer for
						local models, cloud models, tools, memory, budgets, and audit.
					</p>
				</div>

				{/* Desktop / tablet: the full diagram */}
				<Reveal>
					<div className="hidden md:block">
						<ArchitectureDiagram />
					</div>
				</Reveal>

				{/* Mobile: a stacked flow of the same layers */}
				<div className="md:hidden">
					<ArchitectureStacked />
				</div>
			</div>
		</section>
	);
}

function ArchitectureDiagram() {
	return (
		<svg
			aria-label="Ryu architecture: any surface routes through the Gateway, into Core, out to any engine, and back"
			className="h-auto w-full"
			role="img"
			viewBox="0 0 1180 530"
		>
			<path
				d="M148 120 L262 265"
				fill="none"
				stroke="var(--border)"
				strokeDasharray="0.1 7"
				strokeLinecap="round"
				strokeWidth={2}
			/>
			<path
				d="M148 175 L262 265"
				fill="none"
				stroke="var(--border)"
				strokeDasharray="0.1 7"
				strokeLinecap="round"
				strokeWidth={2}
			/>
			<path
				d="M148 230 L262 265"
				fill="none"
				stroke="var(--border)"
				strokeDasharray="0.1 7"
				strokeLinecap="round"
				strokeWidth={2}
			/>
			<path
				d="M148 285 L262 265"
				fill="none"
				stroke="var(--border)"
				strokeDasharray="0.1 7"
				strokeLinecap="round"
				strokeWidth={2}
			/>
			<path
				d="M148 340 L262 265"
				fill="none"
				stroke="var(--border)"
				strokeDasharray="0.1 7"
				strokeLinecap="round"
				strokeWidth={2}
			/>
			<path
				d="M148 395 L262 265"
				fill="none"
				stroke="var(--border)"
				strokeDasharray="0.1 7"
				strokeLinecap="round"
				strokeWidth={2}
			/>
			<path
				d="M554 265 L626 265"
				fill="none"
				stroke="var(--border)"
				strokeDasharray="0.1 7"
				strokeLinecap="round"
				strokeWidth={2}
			/>
			<path
				d="M918 265 L964 120"
				fill="none"
				stroke="var(--border)"
				strokeDasharray="0.1 7"
				strokeLinecap="round"
				strokeWidth={2}
			/>
			<path
				d="M918 265 L964 175"
				fill="none"
				stroke="var(--border)"
				strokeDasharray="0.1 7"
				strokeLinecap="round"
				strokeWidth={2}
			/>
			<path
				d="M918 265 L964 230"
				fill="none"
				stroke="var(--border)"
				strokeDasharray="0.1 7"
				strokeLinecap="round"
				strokeWidth={2}
			/>
			<path
				d="M918 265 L964 285"
				fill="none"
				stroke="var(--border)"
				strokeDasharray="0.1 7"
				strokeLinecap="round"
				strokeWidth={2}
			/>
			<path
				d="M918 265 L964 340"
				fill="none"
				stroke="var(--border)"
				strokeDasharray="0.1 7"
				strokeLinecap="round"
				strokeWidth={2}
			/>
			<path
				d="M918 265 L964 395"
				fill="none"
				stroke="var(--border)"
				strokeDasharray="0.1 7"
				strokeLinecap="round"
				strokeWidth={2}
			/>
			<text
				fill="var(--muted-foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={11}
				fontWeight={700}
				letterSpacing={1.4}
				textAnchor="start"
				x={34}
				y={84}
			>
				SURFACES
			</text>
			<text
				fill="var(--muted-foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={11}
				fontWeight={700}
				letterSpacing={1.4}
				textAnchor="end"
				x={1146}
				y={84}
			>
				ANY ENGINE
			</text>
			<g
				fill="none"
				stroke="var(--foreground)"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.7}
				transform="translate(32 110) scale(0.8333333333333334)"
			>
				<rect height={12} rx={1.6} width={18} x={3} y={4} />
				<path d="M9 20h6M12 16v4" />
			</g>
			<text
				fill="var(--foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={14}
				fontWeight={600}
				textAnchor="start"
				x={62}
				y={124.5}
			>
				Desktop
			</text>
			<g
				fill="none"
				stroke="var(--foreground)"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.7}
				transform="translate(32 165) scale(0.8333333333333334)"
			>
				<rect height={18} rx={2} width={10} x={7} y={3} />
				<path d="M11 18h2" />
			</g>
			<text
				fill="var(--foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={14}
				fontWeight={600}
				textAnchor="start"
				x={62}
				y={179.5}
			>
				Mobile
			</text>
			<g
				fill="none"
				stroke="var(--foreground)"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.7}
				transform="translate(32 220) scale(0.8333333333333334)"
			>
				<rect height={16} rx={2} width={18} x={3} y={4} />
				<path d="M7 9l3 3l-3 3M13 15h4" />
			</g>
			<text
				fill="var(--foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={14}
				fontWeight={600}
				textAnchor="start"
				x={62}
				y={234.5}
			>
				CLI
			</text>
			<g
				fill="none"
				stroke="var(--foreground)"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.7}
				transform="translate(32 275) scale(0.8333333333333334)"
			>
				<path d="M9 4a1.6 1.6 0 0 1 3.2 0V6h3v3h1.8a1.6 1.6 0 0 1 0 3.2H15v4H4V12H2.2a1.6 1.6 0 0 1 0-3.2H4V6h5z" />
			</g>
			<text
				fill="var(--foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={14}
				fontWeight={600}
				textAnchor="start"
				x={62}
				y={289.5}
			>
				Extension
			</text>
			<g
				fill="none"
				stroke="var(--foreground)"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.7}
				transform="translate(32 330) scale(0.8333333333333334)"
			>
				<rect height={11} rx={3} width={16} x={4} y={6} />
				<path d="M9 17l-1 3l4-3M9 11h.01M15 11h.01" />
			</g>
			<text
				fill="var(--foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={14}
				fontWeight={600}
				textAnchor="start"
				x={62}
				y={344.5}
			>
				Bots
			</text>
			<g
				fill="none"
				stroke="var(--foreground)"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.7}
				transform="translate(32 385) scale(0.8333333333333334)"
			>
				<circle cx={12} cy={12} r={8.5} />
				<path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.3 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.3-3.6-8.5S9.6 5.8 12 3.5z" />
			</g>
			<text
				fill="var(--foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={14}
				fontWeight={600}
				textAnchor="start"
				x={62}
				y={399.5}
			>
				Web
			</text>
			<g
				fill="none"
				stroke="var(--foreground)"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.7}
				transform="translate(1128 110) scale(0.8333333333333334)"
			>
				<rect height={12} rx={2} width={12} x={6} y={6} />
				<path d="M9.5 10.5h5v5h-5zM12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.5 12V8.5M5.5 12v3.5" />
			</g>
			<text
				fill="var(--foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={14}
				fontWeight={600}
				textAnchor="end"
				x={1118}
				y={124.5}
			>
				OpenAI
			</text>
			<g
				fill="none"
				stroke="var(--foreground)"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.7}
				transform="translate(1128 165) scale(0.8333333333333334)"
			>
				<rect height={12} rx={2} width={12} x={6} y={6} />
				<path d="M9.5 10.5h5v5h-5zM12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.5 12V8.5M5.5 12v3.5" />
			</g>
			<text
				fill="var(--foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={14}
				fontWeight={600}
				textAnchor="end"
				x={1118}
				y={179.5}
			>
				Claude Code
			</text>
			<g
				fill="none"
				stroke="var(--foreground)"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.7}
				transform="translate(1128 220) scale(0.8333333333333334)"
			>
				<rect height={12} rx={2} width={12} x={6} y={6} />
				<path d="M9.5 10.5h5v5h-5zM12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.5 12V8.5M5.5 12v3.5" />
			</g>
			<text
				fill="var(--foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={14}
				fontWeight={600}
				textAnchor="end"
				x={1118}
				y={234.5}
			>
				Pi
			</text>
			<g
				fill="none"
				stroke="var(--foreground)"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.7}
				transform="translate(1128 275) scale(0.8333333333333334)"
			>
				<rect height={12} rx={2} width={12} x={6} y={6} />
				<path d="M9.5 10.5h5v5h-5zM12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.5 12V8.5M5.5 12v3.5" />
			</g>
			<text
				fill="var(--foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={14}
				fontWeight={600}
				textAnchor="end"
				x={1118}
				y={289.5}
			>
				OpenClaw
			</text>
			<g
				fill="none"
				stroke="var(--foreground)"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.7}
				transform="translate(1128 330) scale(0.8333333333333334)"
			>
				<rect height={12} rx={2} width={12} x={6} y={6} />
				<path d="M9.5 10.5h5v5h-5zM12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.5 12V8.5M5.5 12v3.5" />
			</g>
			<text
				fill="var(--foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={14}
				fontWeight={600}
				textAnchor="end"
				x={1118}
				y={344.5}
			>
				Hermes
			</text>
			<g
				fill="none"
				stroke="var(--foreground)"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.7}
				transform="translate(1128 385) scale(0.8333333333333334)"
			>
				<rect height={12} rx={2} width={12} x={6} y={6} />
				<path d="M9.5 10.5h5v5h-5zM12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.5 12V8.5M5.5 12v3.5" />
			</g>
			<text
				fill="var(--foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={14}
				fontWeight={600}
				textAnchor="end"
				x={1118}
				y={399.5}
			>
				llama.cpp
			</text>
			<rect
				fill="var(--foreground)"
				height={322}
				rx={18}
				stroke="none"
				strokeWidth={0}
				width={286}
				x={268}
				y={104}
			/>
			<g
				fill="none"
				stroke="var(--background)"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.7}
				transform="translate(293 135) scale(1.0833333333333333)"
			>
				<path d="M12 3l7 2.6v5.2c0 4.6-3 7.8-7 9.2c-4-1.4-7-4.6-7-9.2V5.6z" />
				<path d="M9 12l2 2l4-4" />
			</g>
			<text
				fill="var(--background)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={10.5}
				fontWeight={700}
				letterSpacing={1.4}
				textAnchor="start"
				x={328}
				y={139}
			>
				CONTROL
			</text>
			<text
				fill="var(--background)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={21}
				fontWeight={700}
				textAnchor="start"
				x={328}
				y={158}
			>
				Ryu Gateway
			</text>
			<rect
				fill="none"
				height={24}
				rx={12}
				stroke="var(--background)"
				strokeWidth={1.2}
				width={78}
				x={456}
				y={126}
			/>
			<text
				fill="var(--background)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={11}
				fontWeight={600}
				textAnchor="middle"
				x={495}
				y={142}
			>
				the moat
			</text>
			<text
				fill="var(--background)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={12.5}
				fontWeight={500}
				textAnchor="start"
				x={292}
				y={194}
			>
				decides what&apos;s allowed, shared, measured &amp; paid for
			</text>
			<rect
				fill="var(--background)"
				height={36}
				rx={9}
				width={115}
				x={290}
				y={246}
			/>
			<text
				fill="var(--foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={13.5}
				fontWeight={600}
				textAnchor="middle"
				x={347.5}
				y={268.5}
			>
				Routing
			</text>
			<rect
				fill="var(--background)"
				height={36}
				rx={9}
				width={115}
				x={417}
				y={246}
			/>
			<text
				fill="var(--foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={13.5}
				fontWeight={600}
				textAnchor="middle"
				x={474.5}
				y={268.5}
			>
				Firewall
			</text>
			<rect
				fill="var(--background)"
				height={36}
				rx={9}
				width={115}
				x={290}
				y={296}
			/>
			<text
				fill="var(--foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={13.5}
				fontWeight={600}
				textAnchor="middle"
				x={347.5}
				y={318.5}
			>
				PII / DLP
			</text>
			<rect
				fill="var(--background)"
				height={36}
				rx={9}
				width={115}
				x={417}
				y={296}
			/>
			<text
				fill="var(--foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={13.5}
				fontWeight={600}
				textAnchor="middle"
				x={474.5}
				y={318.5}
			>
				Budgets
			</text>
			<rect
				fill="var(--background)"
				height={36}
				rx={9}
				width={115}
				x={290}
				y={346}
			/>
			<text
				fill="var(--foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={13.5}
				fontWeight={600}
				textAnchor="middle"
				x={347.5}
				y={368.5}
			>
				Evals
			</text>
			<rect
				fill="var(--background)"
				height={36}
				rx={9}
				width={115}
				x={417}
				y={346}
			/>
			<text
				fill="var(--foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={13.5}
				fontWeight={600}
				textAnchor="middle"
				x={474.5}
				y={368.5}
			>
				Audit
			</text>
			<rect
				fill="var(--card)"
				height={322}
				rx={18}
				stroke="var(--border)"
				strokeWidth={1.6}
				width={286}
				x={626}
				y={104}
			/>
			<g
				fill="none"
				stroke="var(--foreground)"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.7}
				transform="translate(651 135) scale(1.0833333333333333)"
			>
				<circle cx={12} cy={12} r={2.6} />
				<circle cx={12} cy={4.2} r={1.8} />
				<circle cx={5.2} cy={17} r={1.8} />
				<circle cx={18.8} cy={17} r={1.8} />
				<path d="M12 6v3.4M10 13.6l-3.4 2M14 13.6l3.4 2" />
			</g>
			<text
				fill="var(--muted-foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={10.5}
				fontWeight={700}
				letterSpacing={1.4}
				textAnchor="start"
				x={686}
				y={139}
			>
				ORCHESTRATION
			</text>
			<text
				fill="var(--foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={21}
				fontWeight={700}
				textAnchor="start"
				x={686}
				y={158}
			>
				Ryu Core
			</text>
			<text
				fill="var(--muted-foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={12.5}
				fontWeight={500}
				textAnchor="start"
				x={650}
				y={194}
			>
				decides what runs, then calls the Gateway
			</text>
			<rect
				fill="var(--muted)"
				height={36}
				rx={9}
				width={115}
				x={648}
				y={246}
			/>
			<text
				fill="var(--foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={13.5}
				fontWeight={600}
				textAnchor="middle"
				x={705.5}
				y={268.5}
			>
				Sessions
			</text>
			<rect
				fill="var(--muted)"
				height={36}
				rx={9}
				width={115}
				x={775}
				y={246}
			/>
			<text
				fill="var(--foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={13.5}
				fontWeight={600}
				textAnchor="middle"
				x={832.5}
				y={268.5}
			>
				Memory
			</text>
			<rect
				fill="var(--muted)"
				height={36}
				rx={9}
				width={115}
				x={648}
				y={296}
			/>
			<text
				fill="var(--foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={13.5}
				fontWeight={600}
				textAnchor="middle"
				x={705.5}
				y={318.5}
			>
				Tools
			</text>
			<rect
				fill="var(--muted)"
				height={36}
				rx={9}
				width={115}
				x={775}
				y={296}
			/>
			<text
				fill="var(--foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={13.5}
				fontWeight={600}
				textAnchor="middle"
				x={832.5}
				y={318.5}
			>
				Workflows
			</text>
			<rect
				fill="var(--muted)"
				height={36}
				rx={9}
				width={115}
				x={648}
				y={346}
			/>
			<text
				fill="var(--foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={13.5}
				fontWeight={600}
				textAnchor="middle"
				x={705.5}
				y={368.5}
			>
				Sub-agents
			</text>
			<rect
				fill="var(--muted)"
				height={36}
				rx={9}
				width={115}
				x={775}
				y={346}
			/>
			<text
				fill="var(--foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={13.5}
				fontWeight={600}
				textAnchor="middle"
				x={832.5}
				y={368.5}
			>
				Sidecars
			</text>
			<text
				fill="var(--muted-foreground)"
				fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
				fontSize={13}
				fontWeight={500}
				textAnchor="middle"
				x={590}
				y={514}
			>
				A request flows from any surface → Gateway → Core → engine, and back.
				One layer owns every concern.
			</text>
		</svg>
	);
}

function FlowConnector() {
	return <div aria-hidden className="mx-auto my-2 h-6 w-px bg-border" />;
}

function RailRow({
	label,
	items,
}: {
	label: string;
	items: readonly string[];
}) {
	return (
		<div className="rounded-2xl bg-muted/50 p-4">
			<p className="mb-2 font-medium text-[10px] text-muted-foreground uppercase tracking-widest">
				{label}
			</p>
			<div className="flex flex-wrap gap-1.5">
				{items.map((item) => (
					<span
						className="rounded-md bg-foreground/6 px-2.5 py-1 font-medium text-foreground/70 text-xs"
						key={item}
					>
						{item}
					</span>
				))}
			</div>
		</div>
	);
}

export function ArchitectureStacked() {
	return (
		<div className="mx-auto flex max-w-sm flex-col">
			<RailRow items={SURFACES} label="Surfaces" />
			<FlowConnector />

			<div className="rounded-2xl bg-foreground p-5 text-background">
				<div className="flex items-start justify-between gap-2">
					<div>
						<p className="font-semibold text-[10px] text-background/60 uppercase tracking-widest">
							Control
						</p>
						<h3 className="font-medium text-lg tracking-tight">Ryu Gateway</h3>
					</div>
					<span className="rounded-full border border-background/40 px-2 py-0.5 font-medium text-[10px] text-background/70">
						the moat
					</span>
				</div>
				<p className="mt-1 text-background/65 text-xs">
					decides what&apos;s allowed, shared, measured &amp; paid for
				</p>
				<div className="mt-3 grid grid-cols-2 gap-1.5">
					{GATEWAY_PILLS.map((pill) => (
						<span
							className="rounded-md bg-background px-2 py-1.5 text-center font-medium text-[11px] text-foreground"
							key={pill}
						>
							{pill}
						</span>
					))}
				</div>
			</div>

			<FlowConnector />

			<div className="rounded-2xl border bg-card p-5">
				<p className="font-semibold text-[10px] text-muted-foreground uppercase tracking-widest">
					Orchestration
				</p>
				<h3 className="font-medium text-foreground text-lg tracking-tight">
					Ryu Core
				</h3>
				<p className="mt-1 text-muted-foreground text-xs">
					decides what runs, then calls the Gateway
				</p>
				<div className="mt-3 grid grid-cols-2 gap-1.5">
					{CORE_PILLS.map((pill) => (
						<span
							className="rounded-md bg-muted px-2 py-1.5 text-center font-medium text-[11px] text-foreground"
							key={pill}
						>
							{pill}
						</span>
					))}
				</div>
			</div>

			<FlowConnector />
			<RailRow items={ENGINES} label="Any engine" />

			<p className="mt-6 text-center text-muted-foreground/70 text-xs leading-relaxed">
				A request flows from any surface → Gateway → Core → engine, and back.
				One layer owns every concern.
			</p>
		</div>
	);
}
