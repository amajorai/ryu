import { PageHeader } from "@ryu/ui/components/page-header";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils.ts";

const COLOR_THEMES = [
	{ value: "default", label: "Blue", color: "oklch(0.6321 0.2018 254.09)" },
	{ value: "red", label: "Red", color: "hsl(0 84.2% 60.2%)" },
	{ value: "orange", label: "Orange", color: "hsl(20.5 90.2% 48.2%)" },
	{ value: "yellow", label: "Yellow", color: "hsl(47.9 95.8% 31.2%)" },
	{ value: "green", label: "Green", color: "hsl(142.1 76.2% 36.3%)" },
	{ value: "blue", label: "Indigo", color: "hsl(221.2 83.2% 53.3%)" },
	{ value: "violet", label: "Violet", color: "hsl(262.1 83.3% 57.8%)" },
	{ value: "rose", label: "Rose", color: "hsl(346.8 77.2% 49.8%)" },
	{ value: "zinc", label: "Zinc", color: "oklch(0.205 0 0)" },
];

interface ColorStepProps {
	onChange: (value: string) => void;
	value: string;
}

export function ColorStep({ value, onChange }: ColorStepProps) {
	const apply = (theme: string) => {
		document.documentElement.setAttribute("data-color-theme", theme);
		localStorage.setItem("ryu_color_theme", theme);
		onChange(theme);
	};

	return (
		<div
			className="flex flex-col items-center gap-8"
			data-tauri-drag-region="false"
		>
			<PageHeader
				animate
				subtitle="Personalize your workspace. You can change this anytime in settings."
				subtitleDelay={0.3}
				title="Pick an accent color"
				titleDelay={0.2}
			/>

			<motion.div
				animate={{ opacity: 1, y: 0 }}
				className="grid grid-cols-9 gap-3"
				initial={{ opacity: 0, y: 20 }}
				transition={{ delay: 0.4, duration: 0.5 }}
			>
				{COLOR_THEMES.map(({ value: v, label, color }) => (
					<Tooltip key={v}>
						<TooltipTrigger
							render={
								<button
									aria-label={`Select ${label} color`}
									className={cn(
										"size-12 rounded-xl border-2 transition-all hover:scale-110",
										value === v
											? "border-ring ring-2 ring-ring ring-offset-2 ring-offset-background"
											: "border-border hover:border-ring/50"
									)}
									onClick={() => apply(v)}
									style={{ backgroundColor: color }}
									type="button"
								/>
							}
						/>
						<TooltipContent>{label}</TooltipContent>
					</Tooltip>
				))}
			</motion.div>
		</div>
	);
}
