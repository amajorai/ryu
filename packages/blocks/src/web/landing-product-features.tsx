"use client";

import {
	ArrowLeft01Icon,
	ArrowRight01Icon,
	SquareLock01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Carousel,
	type CarouselApi,
	CarouselContent,
	CarouselItem,
} from "@ryu/ui/components/carousel.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { landingSurfaceCardFlexXlClass } from "./landing-card-tones.ts";
import { SectionTitle } from "./section-title.tsx";
import { sectionSubtitleClass } from "./sections.tsx";

function MeetingNotesViz() {
	const bars = [6, 12, 18, 10, 16, 8, 14, 20, 9, 13, 7, 15, 11, 19, 8, 14];
	const lines = [
		"Zoom call detected",
		"Transcribing live…",
		"3 action items",
		"Summary saved to notes",
	];
	return (
		<div className="relative flex h-36 flex-col justify-center gap-5">
			<div className="flex items-center gap-2">
				<svg
					className="h-5 w-5 flex-shrink-0 animate-node-pulse text-foreground/60"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<title>Microphone capturing a meeting</title>
					<path
						d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zM19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8"
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
					/>
				</svg>
				<div className="flex h-8 flex-1 items-center gap-0.5">
					{bars.map((h, i) => (
						<span
							className="w-1 flex-1 animate-node-pulse rounded-full bg-foreground/40"
							// biome-ignore lint/suspicious/noArrayIndexKey: static waveform
							key={i}
							style={{ height: `${h * 1.4}px`, animationDelay: `${i * 0.1}s` }}
						/>
					))}
				</div>
			</div>
			<div className="flex flex-col gap-2.5">
				{lines.map((line, i) => (
					<div
						className="flex animate-chunk-appear items-center gap-2"
						key={line}
						style={{ animationDelay: `${i * 0.5}s` }}
					>
						<span className="h-1.5 w-1.5 rounded-full bg-foreground/60" />
						<span className="text-foreground/50 text-xs">{line}</span>
					</div>
				))}
			</div>
		</div>
	);
}

function MonitorViz() {
	const [price, setPrice] = useState(129);
	useEffect(() => {
		const interval = setInterval(() => {
			setPrice((prev) => (prev <= 89 ? 129 : prev - 8));
		}, 600);
		return () => clearInterval(interval);
	}, []);
	const dropped = price <= 97;
	return (
		<div className="flex h-36 flex-col gap-3">
			<div className="flex items-center gap-2">
				<span className="h-1.5 w-1.5 animate-node-pulse rounded-full bg-foreground/60" />
				<span className="truncate font-mono text-foreground/50 text-xs">
					store.com/item
				</span>
			</div>
			<div className="flex items-baseline gap-2">
				<span className="font-medium text-2xl text-foreground tabular-nums">
					${price}
				</span>
				<span className="text-foreground/30 text-xs line-through">$129</span>
			</div>
			<div
				className="flex items-center gap-2 transition-opacity duration-300"
				style={{ opacity: dropped ? 1 : 0.25 }}
			>
				<span className="h-1.5 w-1.5 rounded-full bg-foreground/60" />
				<span className="text-foreground/50 text-xs">
					{dropped ? "Price dropped. Alert sent." : "Watching for change…"}
				</span>
			</div>
		</div>
	);
}

function ConnectViz() {
	const apps = ["Gmail", "Slack", "Notion", "GitHub", "Stripe"];
	return (
		<div className="flex h-36 flex-col justify-center gap-2">
			{apps.map((app, i) => (
				<div
					className="flex animate-chunk-appear items-center gap-2"
					key={app}
					style={{ animationDelay: `${i * 0.18}s` }}
				>
					<span className="flex-shrink-0 rounded bg-foreground/8 px-1.5 py-0.5 text-foreground/70 text-xs">
						{app}
					</span>
					<div className="relative h-px flex-1 bg-border">
						<div
							className="absolute h-1.5 w-1.5 animate-flow-right rounded-full bg-foreground/60"
							style={{ animationDelay: `${i * 0.18}s`, top: "-2px" }}
						/>
					</div>
					<HugeiconsIcon
						className="h-3.5 w-3.5 flex-shrink-0 text-foreground/40"
						icon={SquareLock01Icon}
					/>
				</div>
			))}
		</div>
	);
}

function PagesViz() {
	const lines = [
		{ width: "85%", delay: "0s" },
		{ width: "70%", delay: "0.15s" },
		{ width: "90%", delay: "0.3s" },
		{ width: "55%", delay: "0.45s" },
	];
	return (
		<div className="flex h-36 flex-col gap-3 rounded-lg border border-border/60 bg-background/50 p-4">
			<div className="font-medium text-foreground/80 text-sm">Q3 planning</div>
			<div className="flex flex-col gap-2">
				{lines.map((line, i) => (
					<div
						className="h-2 animate-chunk-appear rounded-full bg-foreground/15"
						// biome-ignore lint/suspicious/noArrayIndexKey: static lines
						key={i}
						style={{ width: line.width, animationDelay: line.delay }}
					/>
				))}
			</div>
		</div>
	);
}

function DatabasesViz() {
	const rows = [
		["Lead", "Stage", "Owner"],
		["Acme Co", "Qualified", "Sam"],
		["Northwind", "Proposal", "Alex"],
	];
	return (
		<div className="flex h-36 flex-col overflow-hidden rounded-lg border border-border/60 bg-background/50 text-xs">
			{rows.map((row, i) => (
				<div
					className={`grid grid-cols-3 gap-2 px-3 py-2 ${i === 0 ? "bg-foreground/5 font-medium text-foreground/70" : "text-foreground/50"}`}
					key={row.join("-")}
				>
					{row.map((cell) => (
						<span className="truncate" key={cell}>
							{cell}
						</span>
					))}
				</div>
			))}
		</div>
	);
}

function QuestsViz() {
	const quests = [
		"Follow up with design",
		"Review contract draft",
		"Ship onboarding flow",
	];
	return (
		<div className="flex h-36 flex-col justify-center gap-2.5">
			{quests.map((quest, i) => (
				<div
					className="flex animate-chunk-appear items-center gap-2.5 rounded-md bg-foreground/5 px-3 py-2"
					key={quest}
					style={{ animationDelay: `${i * 0.2}s` }}
				>
					<span className="h-3.5 w-3.5 rounded border border-foreground/30" />
					<span className="text-foreground/60 text-xs">{quest}</span>
				</div>
			))}
		</div>
	);
}

function InboxViz() {
	const messages = [
		{ from: "support@acme.io", subject: "Re: onboarding" },
		{ from: "ops@client.com", subject: "Weekly digest" },
		{ from: "alerts@ryu", subject: "Monitor triggered" },
	];
	return (
		<div className="flex h-36 flex-col justify-center gap-2">
			{messages.map((msg, i) => (
				<div
					className="flex animate-chunk-appear flex-col gap-0.5 rounded-md border border-border/50 px-3 py-2"
					key={msg.from}
					style={{ animationDelay: `${i * 0.2}s` }}
				>
					<span className="truncate font-mono text-[10px] text-foreground/40">
						{msg.from}
					</span>
					<span className="truncate text-foreground/70 text-xs">
						{msg.subject}
					</span>
				</div>
			))}
		</div>
	);
}

function ChannelsViz() {
	const channels = ["Telegram", "Slack", "Discord", "WhatsApp"];
	return (
		<div className="flex h-36 flex-wrap content-center gap-2">
			{channels.map((channel, i) => (
				<span
					className="inline-flex animate-tool-float items-center rounded-full bg-foreground/8 px-3 py-1.5 text-foreground/70 text-xs"
					key={channel}
					style={{ animationDelay: `${i * 0.25}s` }}
				>
					{channel}
				</span>
			))}
		</div>
	);
}

const featureCards: {
	viz: ReactNode;
	title: string;
	description: string;
}[] = [
	{
		viz: <MeetingNotesViz />,
		title: "Meeting Notes",
		description:
			"Auto-detects your calls, transcribes live, and writes the summary and action items — on-device.",
	},
	{
		viz: <MonitorViz />,
		title: "Website Monitors",
		description:
			"Watch any page for price, stock, content, keyword, or uptime changes — alerts across desktop, mobile, and bots.",
	},
	{
		viz: <ConnectViz />,
		title: "App Connections",
		description:
			"Authenticate Gmail, Slack, Notion, GitHub, and hundreds more through Composio. Agents act, never just chat.",
	},
	{
		viz: <PagesViz />,
		title: "Pages",
		description:
			"Notion-style docs inside every Space. Write, link, and let agents read the same surface you do.",
	},
	{
		viz: <DatabasesViz />,
		title: "Databases",
		description:
			"Structured tables for leads, inventory, and ops data — queryable by agents and editable by your team.",
	},
	{
		viz: <QuestsViz />,
		title: "Quests",
		description:
			"Todos auto-detected from chat, email, and meetings — one inbox for what agents and humans should do next.",
	},
	{
		viz: <InboxViz />,
		title: "Agent Inboxes",
		description:
			"Dedicated email addresses per agent. Receive, triage, and reply without wiring SMTP yourself.",
	},
	{
		viz: <ChannelsViz />,
		title: "Channel Bots",
		description:
			"Route the same Core sessions to Telegram, Slack, Discord, and WhatsApp — one brain, every channel.",
	},
];

export default function LandingProductFeatures() {
	const [api, setApi] = useState<CarouselApi>();
	const [canScrollPrev, setCanScrollPrev] = useState(false);
	const [canScrollNext, setCanScrollNext] = useState(false);

	useEffect(() => {
		if (!api) {
			return;
		}

		const onSelect = () => {
			setCanScrollPrev(api.canScrollPrev());
			setCanScrollNext(api.canScrollNext());
		};

		onSelect();
		api.on("reInit", onSelect);
		api.on("select", onSelect);

		return () => {
			api.off("select", onSelect);
		};
	}, [api]);

	return (
		<section className="container mx-auto px-4 py-16">
			<div className="mx-auto mb-10 max-w-4xl">
				<SectionTitle
					className="max-w-lg"
					title="Features that ship ready to use"
				/>
				<p className={`mt-4 max-w-xl ${sectionSubtitleClass}`}>
					Meeting notes, monitors, pages, databases, and more — product surfaces
					beyond the agent engine.
				</p>
			</div>

			<div className="mx-auto max-w-6xl">
				<Carousel
					className="w-full"
					opts={{ align: "start", loop: true }}
					setApi={setApi}
				>
					<CarouselContent className="-ml-4">
						{featureCards.map((card) => (
							<CarouselItem
								className="pl-4 md:basis-1/2 lg:basis-1/3"
								key={card.title}
							>
								<div className={cn(landingSurfaceCardFlexXlClass, "min-h-80")}>
									{card.viz}
									<div>
										<h3 className="mb-1 font-semibold text-foreground text-lg">
											{card.title}
										</h3>
										<p className="text-muted-foreground text-sm">
											{card.description}
										</p>
									</div>
								</div>
							</CarouselItem>
						))}
					</CarouselContent>
				</Carousel>

				<div className="mt-8 flex justify-center gap-2">
					<Button
						aria-label="Previous features"
						disabled={!canScrollPrev}
						onClick={() => api?.scrollPrev()}
						size="icon-sm"
						variant="outline"
					>
						<HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
					</Button>
					<Button
						aria-label="Next features"
						disabled={!canScrollNext}
						onClick={() => api?.scrollNext()}
						size="icon-sm"
						variant="outline"
					>
						<HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} />
					</Button>
				</div>
			</div>
		</section>
	);
}
