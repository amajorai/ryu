import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";

/** The narrow-width navigation drawer and its scrim. */
export function CommunityNavDrawer({
	nav,
	navOpen,
	onClose,
	reduceMotion,
}: {
	nav: ReactNode;
	navOpen: boolean;
	onClose: () => void;
	reduceMotion: boolean;
}) {
	return (
		<AnimatePresence>
			{navOpen ? (
				<>
					<motion.button
						animate={{ opacity: 1 }}
						aria-label="Close navigation"
						className="absolute inset-0 z-20 @[860px]/community:hidden bg-foreground/20"
						exit={{ opacity: 0 }}
						initial={reduceMotion ? false : { opacity: 0 }}
						key="scrim"
						onClick={onClose}
						tabIndex={-1}
						transition={{ duration: 0.15 }}
						type="button"
					/>
					<motion.div
						animate={{ x: 0 }}
						className="absolute inset-y-0 left-0 z-30 flex @[860px]/community:hidden w-[272px] max-w-[85%] flex-col border-border border-r bg-background shadow-lg"
						data-testid="community-nav-drawer"
						exit={reduceMotion ? { opacity: 0 } : { x: "-100%" }}
						initial={reduceMotion ? false : { x: "-100%" }}
						key="drawer"
						transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
					>
						{nav}
					</motion.div>
				</>
			) : null}
		</AnimatePresence>
	);
}
