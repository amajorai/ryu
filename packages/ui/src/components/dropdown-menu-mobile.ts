import type { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { ReactNode } from "react";
import { z } from "zod";

type SubmenuProps = MenuPrimitive.SubmenuTrigger.Props;
type SubmenuRender = Extract<
	SubmenuProps["render"],
	(...args: never[]) => ReactNode
>;
type SubmenuStyle = Extract<
	SubmenuProps["style"],
	(...args: never[]) => import("react").CSSProperties | undefined
>;
type SubmenuChildren = MenuPrimitive.SubmenuRoot.Props["children"];
type SubmenuChildRenderer = Extract<
	SubmenuChildren,
	(...args: never[]) => ReactNode
>;

const childRendererSchema = z.custom<SubmenuChildRenderer>(
	(value) => z.function().safeParse(value).success
);
const renderCallbackSchema = z.custom<SubmenuRender>(
	(value) => z.function().safeParse(value).success
);
const styleCallbackSchema = z.custom<SubmenuStyle>(
	(value) => z.function().safeParse(value).success
);

function isChildRenderer(
	children: SubmenuChildren
): children is SubmenuChildRenderer {
	return childRendererSchema.safeParse(children).success;
}

function isRenderCallback(
	render: SubmenuProps["render"]
): render is SubmenuRender {
	return renderCallbackSchema.safeParse(render).success;
}
function isStyleCallback(style: SubmenuProps["style"]): style is SubmenuStyle {
	return styleCallbackSchema.safeParse(style).success;
}

/** Mobile submenus are drawer pages, so their child renderers receive no payload. */
export function renderMobileSubmenuChildren(
	children: SubmenuChildren
): ReactNode {
	if (isChildRenderer(children)) {
		return children({ payload: undefined });
	}
	return children;
}

/**
 * Run a mobile submenu trigger's caller `onClick` and report whether the drawer
 * should open the submenu page.
 *
 * Base UI activates a non-native item from the keyboard by calling `onClick`
 * with the Enter (or composite Space) keydown it has already default-prevented,
 * so `defaultPrevented` alone cannot tell a keyboard press from a caller's veto.
 * Only a `preventDefault()` the caller adds to a pointer click vetoes the page.
 */
export function activateMobileSubmenuTrigger<
	ActivationEvent extends { readonly defaultPrevented: boolean },
>(
	event: ActivationEvent,
	onClick: ((event: ActivationEvent) => void) | undefined
): boolean {
	const preventedBeforeCaller = event.defaultPrevented;
	onClick?.(event);
	return preventedBeforeCaller || !event.defaultPrevented;
}

/** Forward SDK-owned render/style props while translating Item state into Submenu state. */
export function mobileSubmenuItemProps(
	{ render, style }: Pick<SubmenuProps, "render" | "style">,
	open: boolean
): Pick<MenuPrimitive.Item.Props, "render" | "style"> {
	return {
		render: isRenderCallback(render)
			? (elementProps, state) => render(elementProps, { ...state, open })
			: render,
		style: isStyleCallback(style)
			? (state) => style({ ...state, open })
			: style,
	};
}
