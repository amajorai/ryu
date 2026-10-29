"use client";

import { useAvatarContributions } from "@ryu/ui/components/avatar-contributions.tsx";
import {
	type AvatarAccessory,
	type AvatarStyle,
	type AvatarStyleSelection,
	resolveAvatarStyle,
} from "@ryu/ui/components/avatar-parts.ts";
import { AvatarShapes } from "@ryu/ui/components/avatar-shapes.tsx";

/* A plugin-contributed avatar style, drawn from its own shapes plus any
   accessories other plugins contributed for its regions. Static SVG, so it is
   cheap to repeat in pickers and lists. */
export function AvatarStyleArt({
	style,
	selection,
	size,
	accessories,
	className,
}: {
	accessories?: readonly AvatarAccessory[];
	className?: string;
	selection: Pick<AvatarStyleSelection, "parts" | "palette" | "seed">;
	size: number;
	style: AvatarStyle;
}) {
	const contributions = useAvatarContributions();
	const resolved = resolveAvatarStyle(
		style,
		selection,
		accessories ?? contributions.accessories
	);
	const [minX, minY, width, height] = style.viewBox;
	return (
		<svg
			aria-hidden="true"
			className={className}
			data-avatar-style={style.id}
			height={size}
			viewBox={`${minX} ${minY} ${width} ${height}`}
			width={size}
		>
			{resolved.behind.map((part) => (
				<AvatarShapes
					key={`${part.region}:${part.id}`}
					palette={resolved.palette}
					partId={part.id}
					shapes={part.shapes}
				/>
			))}
			<AvatarShapes
				palette={resolved.palette}
				partId="base"
				shapes={style.base}
			/>
			{resolved.front.map((part) => (
				<AvatarShapes
					key={`${part.region}:${part.id}`}
					palette={resolved.palette}
					partId={part.id}
					shapes={part.shapes}
				/>
			))}
		</svg>
	);
}
