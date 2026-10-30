import { motion } from "motion/react";
import { type ComponentProps, lazy, Suspense } from "react";
import { TownOverlay } from "./town-overlay.tsx";
import type { TownSceneProps } from "./town-scene.tsx";

export const loadScene = () => import("./town-scene.tsx");
const TownScene = lazy(loadScene);

/**
 * The diorama and its DOM layer (tags, bubbles, act props), fading in once
 * the scene has drawn. `scene` is null until the scene can load.
 */
export function TownStageLayers({
	drawn,
	overlay,
	reduced,
	scene,
}: {
	drawn: boolean;
	overlay: ComponentProps<typeof TownOverlay>;
	reduced: boolean;
	scene: TownSceneProps | null;
}) {
	return (
		<>
			<motion.div
				animate={{ opacity: drawn ? 1 : 0 }}
				aria-hidden="true"
				className="absolute inset-0"
				initial={false}
				transition={{ duration: reduced ? 0 : 0.32, ease: "easeOut" }}
			>
				{scene ? (
					<Suspense fallback={null}>
						<TownScene {...scene} />
					</Suspense>
				) : null}
			</motion.div>
			{scene ? (
				<motion.div
					animate={{ opacity: drawn ? 1 : 0 }}
					className="pointer-events-none absolute inset-0 z-10"
					inert={!drawn}
					initial={false}
					transition={{ duration: reduced ? 0 : 0.32, ease: "easeOut" }}
				>
					<TownOverlay {...overlay} />
				</motion.div>
			) : null}
		</>
	);
}
