// The CLI's automatic JSX runtime. tsconfig maps `@opentui/react/jsx-runtime`
// here, so every component keeps its `@jsxImportSource @opentui/react` pragma
// and still renders literal copy in the user's language.

import {
	Fragment,
	jsx as reactJsx,
	jsxs as reactJsxs,
} from "react/jsx-runtime";
import { translateProps } from "./translate.ts";

export type * from "../../node_modules/@opentui/react/jsx-namespace.d.ts";

type JsxArguments = Parameters<typeof reactJsx>;

export function jsx(...[type, props, key]: JsxArguments) {
	return reactJsx(type, translateProps(props), key);
}

export function jsxs(...[type, props, key]: JsxArguments) {
	return reactJsxs(type, translateProps(props), key);
}

export { Fragment };
