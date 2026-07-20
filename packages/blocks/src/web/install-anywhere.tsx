"use client";

import { cn } from "@ryu/ui/lib/utils";
import {
	Cloud,
	Cpu,
	HardDrive,
	Laptop,
	MonitorSmartphone,
	Server,
} from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import { landingSurfaceCardFlexClass } from "./landing-card-tones.ts";
import { SectionHeading } from "./sections.tsx";

const PLACES = [
	{
		id: "personal",
		Icon: Laptop,
		place: "Personal machine",
		use: "Your everyday private, local agent.",
	},
	{
		id: "work",
		Icon: MonitorSmartphone,
		place: "Work laptop",
		use: "Day-to-day work agents, right where you already work.",
	},
	{
		id: "macmini",
		Icon: HardDrive,
		place: "Mac mini",
		use: "24/7 always-on agents that never sleep.",
	},
	{
		id: "pi",
		Icon: Cpu,
		place: "Raspberry Pi",
		use: "Lightweight always-on tasks on tiny hardware.",
	},
	{
		id: "homeserver",
		Icon: Server,
		place: "Home server",
		use: "Monitoring and background jobs running quietly.",
	},
	{
		id: "cloud",
		Icon: Cloud,
		place: "Cloud",
		use: "Production for enterprises, startups, and SMEs.",
	},
] as const;

export default function InstallAnywhere() {
	const [active, setActive] = useState(0);

	return (
		<section className="container mx-auto px-4 py-16 md:py-24">
			<div className="mx-auto max-w-6xl">
				<SectionHeading
					eyebrow="Install anywhere"
					subtitle="Ryu runs wherever the work is. You don't use one agent, you run many, each living where it belongs."
					title="Where will your agents live?"
				/>

				<div className="grid gap-3 lg:grid-cols-[1fr_1fr]">
					<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
						{PLACES.map((p, i) => {
							const isActive = i === active;
							const { Icon } = p;
							return (
								<button
									className={cn(
										"flex flex-col items-start gap-3 rounded-2xl p-3 text-left transition-all duration-300",
										isActive
											? "bg-foreground/8"
											: "bg-muted/50 hover:bg-muted/70"
									)}
									key={p.id}
									onClick={() => setActive(i)}
									onMouseEnter={() => setActive(i)}
									type="button"
								>
									<Icon
										className={cn(
											"size-6 transition-colors",
											isActive ? "text-foreground" : "text-foreground/55"
										)}
										strokeWidth={1.5}
									/>
									<span
										className={cn(
											"font-medium text-sm transition-colors",
											isActive ? "text-foreground" : "text-foreground/70"
										)}
									>
										{p.place}
									</span>
								</button>
							);
						})}
					</div>

					<div className={cn(landingSurfaceCardFlexClass, "justify-between")}>
						<motion.div
							animate={{ opacity: 1, y: 0 }}
							initial={{ opacity: 0, y: 8 }}
							key={PLACES[active].id}
						>
							{(() => {
								const { Icon } = PLACES[active];
								return (
									<Icon
										className="mb-3 size-6 text-foreground"
										strokeWidth={1.75}
									/>
								);
							})()}
							<h3 className="font-medium text-foreground text-xl tracking-tight">
								{PLACES[active].place}
							</h3>
							<p className="mt-2 text-muted-foreground leading-relaxed">
								{PLACES[active].use}
							</p>
						</motion.div>

						<p className="text-balance text-muted-foreground/70 text-sm italic leading-relaxed">
							“I use Ryu everywhere: to monitor servers, on my Pi, on my Mac
							mini, on personal. They all serve different purposes. I don't use
							one agent, they all live where they need to work.”
						</p>
					</div>
				</div>
			</div>
		</section>
	);
}
