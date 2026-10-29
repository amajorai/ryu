import { cn } from "@ryu/ui/lib/utils";
import { type KitchenPalette, pickById } from "./kitchen-palette.ts";

/**
 * Which dish a ticket plates as, and a small top-down drawing of it. The
 * 3D plate on the pass and the glyph on the ticket pick the same dish and
 * food colour from the thread id, so a ticket and its plate match at a
 * glance. Colours come from the Kitchen palette (the art file).
 */

export type DishKind = "bowl" | "burger" | "salad";
const DISH_KINDS: readonly DishKind[] = ["bowl", "burger", "salad"];

export function dishKind(id: string): DishKind {
	return pickById(DISH_KINDS, id) ?? "bowl";
}

export function dishFood(palette: KitchenPalette, id: string): string {
	return pickById(palette.food, id, 3) ?? palette.flame;
}

/** The second food colour (leaves, lettuce, garnish). */
export function dishGarnish(palette: KitchenPalette, id: string): string {
	return palette.food[2] ?? dishFood(palette, id);
}

const SALAD_LEAVES = [0, 1, 2, 3, 4].map((index) => {
	const angle = (index / 5) * Math.PI * 2 - Math.PI / 2;
	return {
		index,
		x: 8 + Math.cos(angle) * 3,
		y: 8 + Math.sin(angle) * 3,
	};
});

/**
 * The dish from above, 16px by default, on a plate ringed in the ready
 * colour like its glow on the pass.
 */
export function DishGlyph({
	className,
	id,
	palette,
	size = 16,
}: {
	className?: string;
	id: string;
	palette: KitchenPalette;
	size?: number;
}) {
	const kind = dishKind(id);
	const food = dishFood(palette, id);
	const garnish = dishGarnish(palette, id);
	return (
		<svg
			aria-hidden="true"
			className={cn("block shrink-0", className)}
			height={size}
			viewBox="0 0 16 16"
			width={size}
		>
			<circle
				className="stroke-success"
				cx="8"
				cy="8"
				fill={palette.plate}
				r="7.25"
				strokeWidth="1.5"
			/>
			{kind === "bowl" ? (
				<>
					<circle
						className="stroke-foreground/20"
						cx="8"
						cy="8"
						fill={palette.plate}
						r="4.75"
						strokeWidth="1"
					/>
					<circle cx="8" cy="8" fill={food} r="3.5" />
					<circle cx="9.25" cy="7" fill={garnish} r="1.1" />
				</>
			) : null}
			{kind === "burger" ? (
				<>
					<circle cx="8" cy="8" fill={garnish} r="4.9" />
					<circle
						className="stroke-foreground/20"
						cx="8"
						cy="8"
						fill={palette.wood}
						r="4.1"
						strokeWidth="1"
					/>
				</>
			) : null}
			{kind === "salad"
				? SALAD_LEAVES.map((leaf) => (
						<circle
							cx={leaf.x}
							cy={leaf.y}
							fill={leaf.index % 2 === 0 ? garnish : food}
							key={`leaf-${leaf.index.toString()}`}
							r="2.1"
						/>
					))
				: null}
			{kind === "salad" ? <circle cx="8" cy="8" fill={food} r="1.8" /> : null}
		</svg>
	);
}
