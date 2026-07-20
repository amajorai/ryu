import { cn } from "@ryu/ui/lib/utils";
import {
	BarChart3,
	BookOpen,
	Boxes,
	Brain,
	Briefcase,
	Bug,
	Calculator,
	CalendarClock,
	Code,
	FileEdit,
	FileText,
	GraduationCap,
	Headphones,
	HeartHandshake,
	HeartPulse,
	Home,
	Landmark,
	Languages,
	LifeBuoy,
	type LucideIcon,
	Megaphone,
	Microscope,
	Palette,
	Pencil,
	PenLine,
	Receipt,
	Rocket,
	Scale,
	Server,
	Settings,
	ShieldCheck,
	ShoppingCart,
	Sparkles,
	TrendingUp,
	Umbrella,
	UserPlus,
	Users,
} from "lucide-react";
import type { SolutionUseCase } from "./data/solutions.ts";
import { landingSurfaceCardXlClass } from "./landing-card-tones.ts";
import { Reveal } from "./reveal.tsx";

/* ------------------------------------------------------------------ */
/* Icon resolver (keeps the JSON data layer icon-free)                */
/* ------------------------------------------------------------------ */

const ICONS: Record<string, LucideIcon> = {
	BarChart3,
	BookOpen,
	Boxes,
	Brain,
	Briefcase,
	Bug,
	Calculator,
	CalendarClock,
	Code,
	FileEdit,
	FileText,
	GraduationCap,
	Headphones,
	HeartHandshake,
	HeartPulse,
	Home,
	Landmark,
	Languages,
	LifeBuoy,
	Megaphone,
	Microscope,
	Palette,
	Pencil,
	PenLine,
	Receipt,
	Rocket,
	Scale,
	Server,
	Settings,
	ShieldCheck,
	ShoppingCart,
	TrendingUp,
	Umbrella,
	UserPlus,
	Users,
};

export function iconFor(key: string): LucideIcon {
	return ICONS[key] ?? Sparkles;
}

/* ------------------------------------------------------------------ */
/* Use cases (what a role does with Ryu)                              */
/* ------------------------------------------------------------------ */

export function UseCases({ items }: { items: SolutionUseCase[] }) {
	return (
		<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
			{items.map((item, i) => (
				<Reveal delay={(i % 3) * 0.06} key={item.title}>
					<div
						className={cn(
							landingSurfaceCardXlClass,
							"flex h-full flex-col gap-2"
						)}
					>
						<h3 className="font-semibold text-base text-foreground">
							{item.title}
						</h3>
						<p className="text-muted-foreground text-sm leading-relaxed">
							{item.description}
						</p>
					</div>
				</Reveal>
			))}
		</div>
	);
}

/* ------------------------------------------------------------------ */
/* Example prompts                                                     */
/* ------------------------------------------------------------------ */

export function ExamplePrompts({ items }: { items: string[] }) {
	return (
		<ul className="space-y-3">
			{items.map((prompt) => (
				<li
					className="flex items-start gap-3 rounded-xl border border-border/60 bg-muted/30 px-4 py-3.5 text-foreground/90 text-sm leading-relaxed"
					key={prompt}
				>
					<span className="mt-0.5 select-none font-medium text-muted-foreground/50 text-xs">
						›
					</span>
					<span>{prompt}</span>
				</li>
			))}
		</ul>
	);
}
