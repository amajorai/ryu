import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfacePort } from "@ryuhq/protocol/interfaces";
import { Orbit, SquarePen } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { WebGLSupport } from "./planets-hooks.ts";
import { GLASS } from "./planets-parts.tsx";

/** The empty sky and the no-WebGL notice, over the scene. */
export function PlanetsNotices({
	isEmpty,
	loading,
	port,
	reduced,
	webgl,
}: {
	isEmpty: boolean;
	loading: boolean;
	port: InterfacePort;
	reduced: boolean;
	webgl: WebGLSupport | null;
}) {
	return (
		<AnimatePresence>
			{isEmpty ? (
				<motion.div
					animate={{ opacity: 1, transform: "translateY(0px)" }}
					className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center p-6 sm:bottom-6"
					initial={
						reduced ? false : { opacity: 0, transform: "translateY(8px)" }
					}
					key="empty"
				>
					<div
						className={cn(
							"pointer-events-auto flex max-w-sm flex-col items-center gap-3 rounded-3xl px-6 py-6 text-center",
							GLASS
						)}
					>
						<span
							aria-hidden="true"
							className="flex size-11 items-center justify-center rounded-2xl bg-primary/12 text-primary"
						>
							<Orbit className="size-5" />
						</span>
						<div className="flex flex-col gap-1">
							<h2 className="font-heading font-semibold text-base text-foreground">
								No planets yet
							</h2>
							<p className="text-pretty text-muted-foreground text-sm leading-relaxed">
								Each agent orbits you as its own planet, with its threads as
								moons. Add an agent or start a thread to fill the sky.
							</p>
						</div>
						<Button
							className="mt-1"
							onClick={() => port.startThread({})}
							size="sm"
							type="button"
						>
							<SquarePen aria-hidden="true" data-icon="inline-start" />
							Start a thread
						</Button>
					</div>
				</motion.div>
			) : null}
			{!loading && webgl?.supported === false ? (
				<motion.p
					animate={{ opacity: 1 }}
					className={cn(
						"absolute inset-x-0 bottom-24 z-20 mx-auto w-fit max-w-sm rounded-2xl px-4 py-3 text-center text-muted-foreground text-sm",
						GLASS
					)}
					initial={reduced ? false : { opacity: 0 }}
					key="no-webgl"
				>
					The 3D view needs WebGL, which is off here. Your planets are still
					listed above.
				</motion.p>
			) : null}
		</AnimatePresence>
	);
}
