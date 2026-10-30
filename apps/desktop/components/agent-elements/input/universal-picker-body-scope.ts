import type { LiteralMessage } from "@ryu/i18n/react";
import type { useUniversalPickerFilters } from "./universal-picker-filters.ts";
import type { getUniversalPickerRows } from "./universal-picker-row-renderers.tsx";
import type { UniversalPickerData } from "./universal-picker-types.ts";

export interface UniversalPickerBodyProps {
	close: () => void;
	data: UniversalPickerData;
	mode?: "agents" | "models" | "all";
}

/** The props after UniversalPickerBody's parameter defaults are applied, plus its translator. */
export type UniversalPickerBodyBaseScope = Omit<
	UniversalPickerBodyProps,
	"mode"
> &
	Required<Pick<UniversalPickerBodyProps, "mode">> & { tl: LiteralMessage };

/** Every binding UniversalPickerBody computes, in render order. */
export type UniversalPickerBodyScope = UniversalPickerBodyBaseScope &
	ReturnType<typeof useUniversalPickerFilters> &
	ReturnType<typeof getUniversalPickerRows>;
