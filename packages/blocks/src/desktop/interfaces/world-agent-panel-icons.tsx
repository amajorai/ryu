/** Stardew's red close "X", as pixels. */
export function CloseIcon() {
	return (
		<svg
			aria-hidden="true"
			height="14"
			shapeRendering="crispEdges"
			viewBox="0 0 7 7"
			width="14"
		>
			<path
				d="M0 0h2v1h1v1h1v-1h1v-1h2v2h-1v1h-1v1h1v1h1v2h-2v-1h-1v-1h-1v1h-1v1h-2v-2h1v-1h1v-1h-1v-1h-1z"
				fill="#7a1410"
			/>
			<path
				d="M1 1h1v1h1v1h1v-1h1v-1h1v1h-1v1h-1v1h1v1h1v1h-1v-1h-1v-1h-1v1h-1v1h-1v-1h1v-1h1v-1h-1v-1h-1z"
				fill="#e2453a"
			/>
		</svg>
	);
}

/**
 * Beside each dialogue choice: a small tan diamond, swapped for the
 * pointing glove Stardew shows beside the hovered or focused choice.
 */
export function ChoicePointer() {
	return (
		<span aria-hidden="true" className="flex w-[18px] shrink-0 justify-center">
			<svg
				className="group-hover:hidden group-focus-visible:hidden"
				height="8"
				shapeRendering="crispEdges"
				viewBox="0 0 4 4"
				width="8"
			>
				<path d="M1 0h2v1h1v2h-1v1h-2v-1h-1v-2h1z" fill="#c99a5a" />
				<path d="M1 1h1v1h-1z" fill="#f7d798" />
			</svg>
			<ChoiceGlove />
		</span>
	);
}

/** The pointing glove. */
function ChoiceGlove() {
	return (
		<svg
			className="hidden group-hover:block group-focus-visible:block"
			height="14"
			shapeRendering="crispEdges"
			viewBox="0 0 9 7"
			width="18"
		>
			<path
				d="M0 1h5v-1h2v1h1v1h1v3h-1v1h-1v1h-5v-1h-1v-1h-1z"
				fill="#5b2a0b"
			/>
			<path d="M1 2h5v-1h1v1h1v3h-1v1h-4v-1h-2z" fill="#fff4d6" />
			<path d="M3 4h4v1h-4z" fill="#e2b36e" />
		</svg>
	);
}

/** Animated Stardew "..." for a villager who is busy. */
export function WorkingDots() {
	return (
		<span aria-hidden="true" className="inline-flex items-end gap-[3px]">
			{[0, 1, 2].map((dot) => (
				<span
					className="size-[4px] bg-[#3d1f0d] motion-safe:animate-pulse"
					key={dot}
					style={{ animationDelay: `${dot * 0.25}s` }}
				/>
			))}
		</span>
	);
}
