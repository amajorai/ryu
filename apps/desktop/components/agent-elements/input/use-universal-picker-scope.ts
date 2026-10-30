import type { UseUniversalPickerParams } from "./use-universal-picker-helpers.ts";
import type { useUniversalPickerState } from "./use-universal-picker-state.ts";

/** useUniversalPicker's parameter. */
export interface UseUniversalPickerBaseScope {
	params: UseUniversalPickerParams;
}

/** Every binding useUniversalPicker computes, in render order. */
export type UseUniversalPickerScope = UseUniversalPickerBaseScope &
	ReturnType<typeof useUniversalPickerState>;
