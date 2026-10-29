// Development twin of ./jsx-runtime.ts (Bun uses it outside production builds).

import { Fragment, jsxDEV as reactJsxDev } from "react/jsx-dev-runtime";
import { translateProps } from "./translate.ts";

export type * from "../../node_modules/@opentui/react/jsx-namespace.d.ts";

type JsxDevArguments = Parameters<typeof reactJsxDev>;

export function jsxDEV(
	...[type, props, key, isStatic, source, self]: JsxDevArguments
) {
	return reactJsxDev(type, translateProps(props), key, isStatic, source, self);
}

export { Fragment };
