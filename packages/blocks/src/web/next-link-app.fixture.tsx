import AppLink from "next/dist/client/app-dir/link.js";
import { renderToStaticMarkup } from "react-dom/server";
import { nextLinkHref } from "./next-link-href.ts";

export function renderAppLink(href: string, adapted: boolean): string {
	return renderToStaticMarkup(
		<AppLink href={adapted ? nextLinkHref(href) : href} ref={null}>
			Destination
		</AppLink>
	);
}
