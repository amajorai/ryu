import { useId } from "react";

const SUN_RAY_PATHS = [
	"M12 1.4v2.4",
	"m20.3 3.7-2.5 2.5",
	"M22.6 12h-2.4",
	"M12 22.6v-2.4",
	"M1.4 12h2.4",
	"m20.3 20.3-2.5-2.5",
	"m3.7 20.3 2.5-2.5",
	"m3.7 3.7 2.5 2.5",
] as const;

interface ClassicThemeIconProps {
	className?: string;
}

/** Sun-to-crescent icon based on the Classic toggle from Toggles.dev. */
export function ClassicThemeIcon({
	className = "size-4",
}: ClassicThemeIconProps) {
	const clipMainId = `ryu-classic-theme-${useId().replaceAll(":", "")}`;

	return (
		<svg
			aria-hidden="true"
			className={className}
			focusable="false"
			height="1em"
			viewBox="0 0 24 24"
			width="1em"
		>
			<defs>
				<clipPath id={clipMainId}>
					<path
						className="classic-theme-icon__clip-shape"
						d="M0 0h25a1 1 0 0010 10v14H0Z"
					/>
				</clipPath>
			</defs>
			<g stroke="currentColor" strokeLinecap="round">
				<circle
					className="classic-theme-icon__circle"
					clipPath={`url(#${clipMainId})`}
					cx={12}
					cy={12}
					fill="currentColor"
					r={5}
				/>
				{SUN_RAY_PATHS.map((d) => (
					<path
						className="classic-theme-icon__ray"
						d={d}
						fill="none"
						key={d}
						paintOrder="stroke markers fill"
						strokeLinejoin="round"
						strokeMiterlimit={0}
						strokeWidth={2}
					/>
				))}
			</g>
		</svg>
	);
}
