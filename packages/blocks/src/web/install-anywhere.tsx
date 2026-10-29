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
import { MotionConfig, motion } from "motion/react";
import { useState } from "react";
import { landingSurfaceCardFlexClass } from "./landing-card-tones.ts";
import { SectionHeading } from "./sections.tsx";

const PLACES = [
	{
		id: "personal",
		PlaceGlyph: Laptop,
		place: "Your laptop",
		use: "Keep sensitive work local while you get started.",
	},
	{
		id: "work",
		PlaceGlyph: MonitorSmartphone,
		place: "Work machine",
		use: "Run day-to-day agents where your team already works.",
	},
	{
		id: "macmini",
		PlaceGlyph: HardDrive,
		place: "Mac mini",
		use: "Keep a private server running for background work.",
	},
	{
		id: "pi",
		PlaceGlyph: Cpu,
		place: "Raspberry Pi",
		use: "Run lightweight, always-on tasks on small hardware.",
	},
	{
		id: "homeserver",
		PlaceGlyph: Server,
		place: "Home server",
		use: "Keep monitoring and background jobs on your own network.",
	},
	{
		id: "cloud",
		PlaceGlyph: Cloud,
		place: "Cloud",
		use: "Move to managed cloud when the team needs shared production.",
	},
] as const;

export default function InstallAnywhere() {
	const [active, setActive] = useState(0);
	const currentPlace = PLACES[active] ?? PLACES[0];

	return (
		<MotionConfig reducedMotion="user">
			<section className="container mx-auto px-4 py-16 md:py-24">
				<div className="mx-auto max-w-6xl">
					<SectionHeading
						subtitle="Your laptop, your own servers, or managed cloud. The setup stays the same as the work moves."
						title="Run it where the work is"
					/>

					<div className="grid gap-3 lg:grid-cols-[1fr_1fr]">
						<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
							{PLACES.map((p, i) => {
								const isActive = i === active;
								const { PlaceGlyph } = p;
								return (
									<button
										aria-pressed={isActive}
										className={cn(
											"flex flex-col items-start gap-3 rounded-2xl p-3 text-left transition-colors duration-300",
											isActive
												? "bg-foreground/8"
												: "bg-muted/50 hover:bg-muted/70"
										)}
										key={p.id}
										onClick={() => setActive(i)}
										onMouseEnter={() => setActive(i)}
										type="button"
									>
										<PlaceGlyph
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
								key={currentPlace.id}
							>
								{(() => {
									const { PlaceGlyph } = currentPlace;
									return (
										<PlaceGlyph
											className="mb-3 size-6 text-foreground"
											strokeWidth={1.75}
										/>
									);
								})()}
								<h3 className="font-medium text-foreground text-xl tracking-tight">
									{currentPlace.place}
								</h3>
								<p className="mt-2 text-muted-foreground leading-relaxed">
									{currentPlace.use}
								</p>
							</motion.div>

							<p className="text-balance text-muted-foreground/70 text-sm leading-relaxed">
								Use one control layer across personal machines, private servers,
								and managed cloud. Keep the deployment choice yours.
							</p>
						</div>
					</div>
				</div>
			</section>
		</MotionConfig>
	);
}
