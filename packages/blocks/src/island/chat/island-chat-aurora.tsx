import Aurora from "../../web/aurora.tsx";

/** Golden Gate–style aurora peeking up from the bottom of the island chat panel. */
export function IslandChatAurora({ thinking }: { thinking: boolean }) {
	return (
		<div
			aria-hidden
			className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-32 [mask-image:linear-gradient(to_top,black_45%,transparent)]"
		>
			<Aurora
				amplitude={thinking ? 0.3 : 0.18}
				blend={0.55}
				fan={0.5}
				speed={thinking ? 9 : 1}
			/>
		</div>
	);
}
