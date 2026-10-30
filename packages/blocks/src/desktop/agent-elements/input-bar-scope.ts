import type { useComposerAutoGrow } from "./input-bar-auto-grow.ts";
import type { useInputBarBars } from "./input-bar-bars.tsx";
import type { getInputBarEditor } from "./input-bar-editor.tsx";
import type { useInputBarKeyboard } from "./input-bar-keyboard.tsx";
import type { useInputBarState } from "./input-bar-state.tsx";
import type { getInputBarSurface } from "./input-bar-surface.tsx";
import type { InputBarProps } from "./input-bar-types.ts";

/** The props after InputBar's parameter defaults are applied. */
export type InputBarBaseScope = Omit<
	InputBarProps,
	"attachedImages" | "attachedFiles" | "enableImagePreview" | "suggestions"
> &
	Required<
		Pick<
			InputBarProps,
			"attachedImages" | "attachedFiles" | "enableImagePreview" | "suggestions"
		>
	>;

/** Every binding InputBar computes, in render order. */
export type InputBarScope = InputBarBaseScope &
	ReturnType<typeof useInputBarState> &
	ReturnType<typeof useComposerAutoGrow> &
	ReturnType<typeof useInputBarBars> &
	ReturnType<typeof useInputBarKeyboard> &
	ReturnType<typeof getInputBarEditor> &
	ReturnType<typeof getInputBarSurface>;
