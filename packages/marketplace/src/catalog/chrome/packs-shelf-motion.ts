// packages/marketplace/src/catalog/chrome/packs-shelf-motion.ts
//
// Reading-direction-aware motion for the Packs shelf card stack. The cards run
// along the inline axis, so under a right-to-left layout the fan spreads toward
// the physical left (the translate and rotate signs flip) and ArrowLeft moves
// to the next card while ArrowRight moves back. Up and Down keep their meaning
// in either direction.

export type InlineSign = 1 | -1;

const STEP_BY_KEY: Readonly<Record<string, -1 | 1>> = {
	ArrowDown: 1,
	ArrowLeft: -1,
	ArrowRight: 1,
	ArrowUp: -1,
};

/** The index step for a key in the stack, or `0` when the key does not move. */
export function packStepForKey(key: string, sign: InlineSign): -1 | 0 | 1 {
	const step = STEP_BY_KEY[key] ?? 0;
	const horizontal = key === "ArrowLeft" || key === "ArrowRight";
	if (horizontal && sign === -1) {
		return step === 1 ? -1 : 1;
	}
	return step;
}

/** The CSS transform for one card in the fanned stack. */
export function packStackTransform({
	activeIndex,
	count,
	index,
	isExpanded,
	sign,
}: {
	activeIndex: number;
	count: number;
	index: number;
	isExpanded: boolean;
	sign: InlineSign;
}): string {
	const offset = isExpanded ? index - activeIndex : 0;
	const translate = offset * 3.5 * sign;
	const rotate = ((index - (count - 1) / 2) * 2.5 + offset * 4) * sign;
	const scale = activeIndex === index && isExpanded ? 1.03 : 1;
	return `translateX(${translate}rem) rotate(${rotate}deg) scale(${scale})`;
}
