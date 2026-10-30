import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { Fish, Plus } from "lucide-react";
import { motion } from "motion/react";
import { GLASS } from "./aquarium-parts.tsx";

/** The empty tank: no agents yet, with a way to start the first thread. */
export function AquariumEmptyTank({
	onStart,
	reduced,
}: {
	onStart: () => void;
	reduced: boolean;
}) {
	return (
		<motion.div
			animate={{ opacity: 1, transform: "translateY(0px)" }}
			className="absolute inset-0 z-10 flex items-center justify-center p-6"
			initial={reduced ? false : { opacity: 0, transform: "translateY(8px)" }}
		>
			<div
				className={cn(
					"flex max-w-sm flex-col items-center gap-3 rounded-3xl px-6 py-6 text-center",
					GLASS
				)}
			>
				<span
					aria-hidden="true"
					className="flex size-11 items-center justify-center rounded-2xl bg-primary/12 text-primary"
				>
					<Fish className="size-5" />
				</span>
				<div className="flex flex-col gap-1">
					<h2 className="font-heading font-semibold text-base text-foreground">
						The tank is empty
					</h2>
					<p className="text-pretty text-muted-foreground text-sm leading-relaxed">
						Each agent swims here as its own creature. Start a thread and they
						will drop in.
					</p>
				</div>
				<Button className="mt-1" onClick={onStart} size="sm" type="button">
					<Plus aria-hidden="true" data-icon="inline-start" />
					Start a thread
				</Button>
			</div>
		</motion.div>
	);
}

/** Shown over the water when the 3D reef cannot draw (no WebGL). */
export function AquariumNoWebGL({ reduced }: { reduced: boolean }) {
	return (
		<motion.div
			animate={{ opacity: 1 }}
			className="pointer-events-none absolute inset-x-0 top-1/3 z-10 flex justify-center px-6"
			initial={reduced ? false : { opacity: 0 }}
		>
			<p
				className={cn(
					"max-w-sm rounded-2xl px-4 py-3 text-center text-muted-foreground text-sm",
					GLASS
				)}
			>
				The 3D reef needs WebGL, which is off here. Your agents are listed
				below; pick one to see its threads.
			</p>
		</motion.div>
	);
}
