import { cn } from "@ryu/ui/lib/utils";
import {
	ArrowUpRight,
	Blocks,
	Bot,
	Cloud,
	Code2,
	Cpu,
	GitBranch,
	Globe2,
	Layers3,
	Link2,
	type LucideIcon,
	MonitorSmartphone,
	Network,
	ScanSearch,
	Settings2,
	ShieldCheck,
	Smartphone,
	Terminal,
	Workflow,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { docsHref } from "./data/resources.tsx";
import { landingSurfaceCardFlexXlClass } from "./landing-card-tones.ts";
import { landingSubheadlineClass } from "./landing-typography.ts";
import { SectionTitle } from "./section-title.tsx";

interface PlatformLayer {
	description: string;
	group: "Infra" | "Platform" | "Interfaces / surfaces";
	href: string;
	icon: LucideIcon;
	id: string;
	name: string;
	positioning: string;
	verb: string;
}

const PLATFORM_LAYERS: readonly PlatformLayer[] = [
	{
		description: "Deploy Ryu in the cloud.",
		group: "Infra",
		href: "/platform#infra",
		icon: Cloud,
		id: "deploy",
		name: "Deploy",
		positioning: "Deploy Ryu in the cloud.",
		verb: "Cloud",
	},
	{
		description: "Add Ryu capabilities to an existing product.",
		group: "Platform",
		href: "/products/sdk",
		icon: Code2,
		id: "sdk",
		name: "SDK",
		positioning: "Add Ryu capabilities to an existing product.",
		verb: "Integrate",
	},
	{
		description: "Run models, agents, tools, memory and workflows.",
		group: "Platform",
		href: "/products/core",
		icon: Cpu,
		id: "core",
		name: "Core",
		positioning: "Run models, agents, tools, memory and workflows.",
		verb: "Run",
	},
	{
		description: "Secure model access, spending and providers.",
		group: "Platform",
		href: "/products/gateway",
		icon: ShieldCheck,
		id: "gateway",
		name: "Gateway",
		positioning: "Secure model access, spending and providers.",
		verb: "Secure",
	},
	{
		description: "Chat with Ryu through the Bot interface.",
		group: "Interfaces / surfaces",
		href: "/bot",
		icon: Bot,
		id: "bot",
		name: "Bot",
		positioning: "Chat with Ryu through the Bot interface.",
		verb: "Chat",
	},
	{
		description: "Configure Ryu from the control panel.",
		group: "Interfaces / surfaces",
		href: "/console",
		icon: Settings2,
		id: "console",
		name: "Console",
		positioning: "Configure Ryu from the control panel.",
		verb: "Configure",
	},
	{
		description: "Use ready-made applications for business workflows.",
		group: "Interfaces / surfaces",
		href: "/marketplace",
		icon: Workflow,
		id: "apps",
		name: "Apps",
		positioning: "Use ready-made applications for business workflows.",
		verb: "Use",
	},
];

const PRIMITIVES = [
	"Models",
	"Agents",
	"Tools",
	"Memory",
	"RAG",
	"Workflows",
	"Policies",
	"Servers",
	"Surfaces",
	"Apps",
] as const;

interface IntegrationPath {
	description: string;
	href: string;
	icon: LucideIcon;
	label: string;
	token: string;
}

const INTEGRATION_PATHS: readonly IntegrationPath[] = [
	{
		description:
			"Point OpenAI, Anthropic, Gemini, or a raw HTTP client at one governed endpoint.",
		href: "/products/gateway",
		icon: Network,
		label: "Gateway endpoint",
		token: "/v1",
	},
	{
		description:
			"Author typed agents, workflows, tools, and skills, or embed chat in your own UI.",
		href: docsHref("/docs/extend/develop/sdk"),
		icon: Blocks,
		label: "SDK",
		token: "@ryuhq/sdk",
	},
	{
		description:
			"Expose a Core server to MCP hosts or bring external MCP servers into the tool catalog.",
		href: docsHref("/docs/extend/integrate/mcp-integration"),
		icon: Link2,
		label: "MCP",
		token: "ryu-mcp",
	},
	{
		description:
			"Drive agent subprocesses with ACP or connect remote agents with A2A.",
		href: docsHref("/docs/extend/integrate/acp-integration"),
		icon: Bot,
		label: "ACP + A2A",
		token: "agent protocols",
	},
	{
		description:
			"Package capabilities as Apps, sandboxed iframe widgets, standalone companions, or plugins from a starter project.",
		href: docsHref("/docs/extend/develop/extensions/ryu-apps"),
		icon: Workflow,
		label: "Apps + widgets",
		token: "manifest.json · create-ryu-app",
	},
	{
		description:
			"Run the same work from Desktop, mobile, browser, terminal, or a website's local server.",
		href: docsHref("/docs/surfaces"),
		icon: MonitorSmartphone,
		label: "Every surface",
		token: "local → cloud",
	},
	{
		description:
			"Run saved agents and allowlisted tools inside a GitHub workflow.",
		href: docsHref("/docs/ci/github-actions"),
		icon: GitBranch,
		label: "GitHub Actions",
		token: "amajorai/ryu@v1",
	},
	{
		description:
			"Use a managed Ryu or provider subscription, bring provider keys, or self-host the server in your environment.",
		href: "/platform#infra",
		icon: Globe2,
		label: "Managed or self-hosted",
		token: "BYOK · BYOS",
	},
];

interface Capability {
	description: string;
	href: string;
	icon: LucideIcon;
	name: string;
}

const CAPABILITIES: readonly Capability[] = [
	{
		description:
			"Local GGUF, safetensors, and MLX models, hosted providers, BYOK, routing, fallback, and caching.",
		href: "/products/core",
		icon: Cpu,
		name: "Models + providers",
	},
	{
		description:
			"Agents, sub-agents, teams, workflows, sessions, durable runs, and human approvals.",
		href: docsHref("/docs/core/workflows"),
		icon: Bot,
		name: "Agents + orchestration",
	},
	{
		description:
			"Spaces, long-term memory, embeddings, retrieval, conversation search, and RAG.",
		href: docsHref("/docs/core/memory"),
		icon: Layers3,
		name: "Knowledge + memory",
	},
	{
		description:
			"Vision models, OCR, document parsing, image and media workflows, voice, and transcription.",
		href: docsHref("/docs/core/mcp-registry"),
		icon: ScanSearch,
		name: "Multimodal + OCR",
	},
	{
		description:
			"Train LoRA or QLoRA adapters locally or remotely, then merge the result into a model you can run.",
		href: docsHref("/docs/apps/finetune"),
		icon: Terminal,
		name: "Fine-tuning",
	},
	{
		description:
			"Permissions, firewall, DLP, budgets, rate limits, approvals, evals, and an audit trail.",
		href: "/products/gateway",
		icon: ShieldCheck,
		name: "Governance + spend",
	},
	{
		description:
			"Browser-local models, in-page tools, and an explicit path to a visitor's own Ryu server.",
		href: docsHref("/docs/surfaces/browser-extension"),
		icon: Globe2,
		name: "Browser + local AI",
	},
	{
		description:
			"On-device mobile models plus native notifications, files, camera, haptics, and background status.",
		href: docsHref("/docs/surfaces/mobile"),
		icon: Smartphone,
		name: "Mobile + device AI",
	},
];

interface ShowcaseItem {
	description: string;
	external?: boolean;
	href: string;
	icon: LucideIcon;
	label: string;
	name: string;
}

const SHOWCASE: readonly ShowcaseItem[] = [
	{
		description:
			"An external product using @ryuhq/client to route text generation through Ryu Core.",
		external: true,
		href: "https://github.com/amajorai/updatenight",
		icon: Code2,
		label: "External app",
		name: "Update Night",
	},
	{
		description:
			"Ryu's own app catalog: focused workflows backed by sidecars, companions, and shared platform seams.",
		href: docsHref("/docs/apps"),
		icon: Workflow,
		label: "Ryu-built software",
		name: "Ryu Apps",
	},
	{
		description:
			"A website or browser extension can run a small model locally or call a server the visitor controls.",
		href: docsHref("/docs/surfaces/browser-extension"),
		icon: MonitorSmartphone,
		label: "Web + browser",
		name: "Local AI in the tab",
	},
	{
		description:
			"Agents and allowlisted tools become steps in a repeatable CI workflow with the same Core contract.",
		href: docsHref("/docs/ci/github-actions"),
		icon: GitBranch,
		label: "Automation",
		name: "Ryu in GitHub",
	},
];

function PlatformLayerCard({ layer }: { layer: PlatformLayer }) {
	const Icon = layer.icon;
	return (
		<li className="relative">
			<Link
				className="group flex items-start gap-3 rounded-xl bg-muted/50 p-3.5 transition-colors hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
				href={layer.href as Route}
			>
				<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-foreground/65 shadow-sm">
					<Icon aria-hidden="true" className="size-4" />
				</span>
				<span className="min-w-0 flex-1">
					<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
						<span className="font-medium text-foreground text-sm">
							{layer.name}
						</span>
						<span className="text-[10px] text-muted-foreground uppercase tracking-wider">
							{layer.group} · {layer.verb}
						</span>
					</span>
					<span className="mt-1 block text-muted-foreground text-xs leading-relaxed">
						{layer.description}
					</span>
				</span>
				<ArrowUpRight
					aria-hidden="true"
					className="mt-0.5 size-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
				/>
			</Link>
		</li>
	);
}

function PlatformHierarchy() {
	return (
		<div
			className="rounded-[1.75rem] bg-muted/30 p-4 sm:p-6"
			data-testid="platform-hierarchy"
		>
			<div className="flex items-center justify-between gap-3">
				<p className="font-medium text-muted-foreground text-xs uppercase tracking-[0.18em]">
					Product hierarchy
				</p>
				<span className="text-[10px] text-muted-foreground/70">
					Deploy = Cloud
				</span>
			</div>

			<div className="mt-6">
				<div className="mx-auto max-w-xs rounded-2xl bg-foreground px-4 py-4 text-background shadow-lg">
					<p className="text-[10px] text-background/55 uppercase tracking-[0.18em]">
						Ryu
					</p>
					<p className="mt-1 font-medium text-lg tracking-tight">
						AI deployment platform
					</p>
				</div>
				<div className="relative sm:pl-5">
					<ul className="space-y-2">
						{PLATFORM_LAYERS.map((layer) => (
							<PlatformLayerCard key={layer.id} layer={layer} />
						))}
					</ul>
				</div>
			</div>

			<ul aria-label="Ryu primitives" className="mt-6 flex flex-wrap gap-1.5">
				{PRIMITIVES.map((primitive) => (
					<li key={primitive}>
						<span className="rounded-full bg-background px-2.5 py-1 text-[10px] text-muted-foreground">
							{primitive}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

function RoleDistinction() {
	return (
		<div className="rounded-[1.75rem] bg-muted/30 p-4 sm:p-6">
			<p className="font-medium text-muted-foreground text-xs uppercase tracking-[0.18em]">
				The distinction is simple
			</p>
			<h3 className="mt-3 max-w-sm text-balance font-medium text-2xl text-foreground tracking-tight">
				Three layers, one system.
			</h3>
			<p className="mt-3 max-w-md text-muted-foreground text-sm leading-relaxed">
				Deploy to Cloud. Integrate with SDK, run with Core, secure with Gateway.
				Use Bot, Console, or Apps as the interface.
			</p>
			<dl className="mt-7 grid gap-2 sm:grid-cols-2">
				{PLATFORM_LAYERS.map((layer) => (
					<div className="rounded-xl bg-background/70 p-3" key={layer.id}>
						<dt className="text-[10px] text-muted-foreground uppercase tracking-wider">
							{layer.group} · {layer.name} = {layer.verb}
						</dt>
						<dd className="mt-1 text-foreground/80 text-xs leading-relaxed">
							{layer.positioning}
						</dd>
					</div>
				))}
			</dl>
			<div className="mt-7 rounded-xl bg-background/70 p-4">
				<p className="text-[10px] text-muted-foreground uppercase tracking-wider">
					The invariant
				</p>
				<p className="mt-2 text-foreground text-sm leading-relaxed">
					Core runs the platform. Gateway secures model access and spending.
				</p>
			</div>
		</div>
	);
}

function IntegrationCard({ path }: { path: IntegrationPath }) {
	const Icon = path.icon;
	return (
		<li className={cn(landingSurfaceCardFlexXlClass, "group")}>
			<div className="flex items-start justify-between gap-3">
				<span className="flex size-9 items-center justify-center rounded-lg bg-background text-foreground/65 shadow-sm">
					<Icon aria-hidden="true" className="size-4" />
				</span>
				<span className="rounded-full bg-background px-2 py-1 text-[10px] text-muted-foreground">
					{path.token}
				</span>
			</div>
			<div className="mt-6 flex-1">
				<h3 className="font-medium text-base text-foreground">{path.label}</h3>
				<p className="mt-2 text-muted-foreground text-sm leading-relaxed">
					{path.description}
				</p>
			</div>
			<Link
				className="mt-5 inline-flex items-center gap-1.5 font-medium text-foreground text-xs underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				href={path.href as Route}
			>
				Explore path
				<ArrowUpRight aria-hidden="true" className="size-3.5" />
			</Link>
		</li>
	);
}

function CapabilityCard({ capability }: { capability: Capability }) {
	const Icon = capability.icon;
	return (
		<li>
			<Link
				className="group flex h-full items-start gap-3 rounded-xl bg-muted/40 p-4 transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
				href={capability.href as Route}
			>
				<Icon
					aria-hidden="true"
					className="mt-0.5 size-4 shrink-0 text-foreground/65"
				/>
				<span className="min-w-0 flex-1">
					<span className="font-medium text-foreground text-sm">
						{capability.name}
					</span>
					<span className="mt-1 block text-muted-foreground text-xs leading-relaxed">
						{capability.description}
					</span>
				</span>
				<ArrowUpRight
					aria-hidden="true"
					className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
				/>
			</Link>
		</li>
	);
}

function ShowcaseCard({ item }: { item: ShowcaseItem }) {
	const Icon = item.icon;
	const content = (
		<>
			<div className="flex items-start justify-between gap-3">
				<span className="flex size-9 items-center justify-center rounded-lg bg-background text-foreground/65 shadow-sm">
					<Icon aria-hidden="true" className="size-4" />
				</span>
				<ArrowUpRight
					aria-hidden="true"
					className="size-4 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
				/>
			</div>
			<p className="mt-6 text-[10px] text-muted-foreground uppercase tracking-[0.16em]">
				{item.label}
			</p>
			<h3 className="mt-2 font-medium text-foreground text-lg tracking-tight">
				{item.name}
			</h3>
			<p className="mt-2 text-muted-foreground text-sm leading-relaxed">
				{item.description}
			</p>
		</>
	);

	return (
		<li>
			{item.external ? (
				<a
					className="group block h-full rounded-2xl bg-muted/50 p-5 transition-colors hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
					href={item.href}
					rel="noopener noreferrer"
					target="_blank"
				>
					{content}
				</a>
			) : (
				<Link
					className="group block h-full rounded-2xl bg-muted/50 p-5 transition-colors hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
					href={item.href as Route}
				>
					{content}
				</Link>
			)}
		</li>
	);
}

function PlatformStoryHeading() {
	return (
		<div className="max-w-3xl">
			<p className="font-medium text-muted-foreground text-xs uppercase tracking-[0.18em]">
				The platform map
			</p>
			<h2 className="mt-4 text-balance font-medium text-4xl text-foreground leading-tight tracking-[-0.04em] md:text-5xl">
				Ryu connects deployment, platform, and interfaces.
			</h2>
			<p className={cn(landingSubheadlineClass, "max-w-2xl")}>
				Deploy to Cloud. Integrate with SDK, run with Core, secure with Gateway,
				and use Bot, Console, or Apps as the interface.
			</p>
		</div>
	);
}

export function PlatformStory({ compact = false }: { compact?: boolean }) {
	if (compact) {
		return (
			<section data-testid="platform-story-compact" id="platform-story">
				<div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
					<div className="max-w-2xl">
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-[0.18em]">
							The platform underneath
						</p>
						<h2 className="mt-4 text-balance font-medium text-4xl text-foreground leading-tight tracking-[-0.04em] md:text-5xl">
							Platform, interfaces, and Cloud.
						</h2>
						<p className="mt-5 max-w-xl text-muted-foreground leading-relaxed">
							Use Bot, Console, or Apps as interfaces. Build with SDK, Core, and
							Gateway.
						</p>
					</div>

					<div className="mt-10 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
						{PLATFORM_LAYERS.map((layer) => (
							<Link
								className="group flex items-center gap-3 rounded-xl bg-muted/50 p-3.5 transition-colors hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
								href={layer.href as Route}
								key={layer.id}
							>
								<span className="font-medium text-foreground text-sm">
									{layer.name}
								</span>
								<span className="text-[10px] text-muted-foreground uppercase tracking-wider">
									{layer.group} · {layer.verb}
								</span>
								<ArrowUpRight
									aria-hidden="true"
									className="ml-auto size-3.5 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
								/>
							</Link>
						))}
					</div>

					<Link
						className="mt-8 inline-flex items-center gap-2 font-medium text-foreground text-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						href="/platform"
					>
						See the full platform map
						<ArrowUpRight aria-hidden="true" className="size-4" />
					</Link>
				</div>
			</section>
		);
	}

	return (
		<div data-testid="platform-story-full">
			<section
				className="container mx-auto px-4 py-20 md:py-28"
				id="platform-map"
			>
				<div className="mx-auto max-w-6xl">
					<PlatformStoryHeading />
					<div className="mt-12 grid gap-3 lg:grid-cols-2">
						<PlatformHierarchy />
						<RoleDistinction />
					</div>
				</div>
			</section>

			<section id="integration-gallery">
				<div className="container mx-auto px-4 py-20 md:py-28">
					<div className="mx-auto max-w-6xl">
						<SectionTitle title="Use Ryu from the seam you already have." />
						<p className={cn(landingSubheadlineClass, "max-w-2xl")}>
							One endpoint for an existing product. A typed SDK for a new
							extension. A protocol bridge for another agent. A managed or
							self-hosted server when you need the runtime itself.
						</p>
						<ul className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
							{INTEGRATION_PATHS.map((path) => (
								<IntegrationCard key={path.label} path={path} />
							))}
						</ul>
					</div>
				</div>
			</section>

			<section
				className="container mx-auto px-4 py-20 md:py-28"
				id="capabilities"
			>
				<div className="mx-auto max-w-6xl">
					<SectionTitle title="The capability surface is bigger than chat." />
					<p className={cn(landingSubheadlineClass, "max-w-2xl")}>
						Use the same platform for inference, perception, knowledge,
						orchestration, and the controls that make AI safe to run.
					</p>
					<ul className="mt-10 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
						{CAPABILITIES.map((capability) => (
							<CapabilityCard capability={capability} key={capability.name} />
						))}
					</ul>
				</div>
			</section>

			<section id="built-with-ryu">
				<div className="container mx-auto px-4 py-20 md:py-28">
					<div className="mx-auto max-w-6xl">
						<div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
							<div className="max-w-2xl">
								<SectionTitle title="Built with Ryu" />
								<p className="mt-4 text-muted-foreground leading-relaxed">
									The gallery starts with Ryu's own surfaces and one outside
									product. As more teams ship on the platform, this is where
									their work belongs.
								</p>
							</div>
							<Link
								className="inline-flex items-center gap-2 font-medium text-foreground text-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								href={docsHref("/docs/showcase") as Route}
							>
								Read the showcase guide
								<ArrowUpRight aria-hidden="true" className="size-4" />
							</Link>
						</div>
						<ul className="mt-10 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
							{SHOWCASE.map((item) => (
								<ShowcaseCard item={item} key={item.name} />
							))}
						</ul>
					</div>
				</div>
			</section>
		</div>
	);
}
