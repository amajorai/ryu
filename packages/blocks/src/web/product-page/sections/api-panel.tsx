import { docsHref } from "../../data/resources.tsx";
import { LinkArrow } from "../../link-arrow.tsx";
import type { ProductOpenApi } from "../profile-types.ts";
import { CopyButton } from "./copy-button.tsx";
import { ProductSection, sectionKickerClass } from "./section-shell.tsx";

const rowClass =
	"flex min-w-0 flex-col gap-2 border-border border-b py-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6";
const linkClass =
	"group inline-flex min-h-10 items-center gap-1.5 font-mono text-foreground text-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The service's API reference strip: the base URL to call (copyable), the
 * published OpenAPI document, and the API docs page when the product has one.
 */
export function ProductApiPanel({
	openapi,
	docsPath,
}: {
	openapi: ProductOpenApi;
	docsPath?: string;
}) {
	return (
		<ProductSection testId="product-api">
			<h2 className={sectionKickerClass}>API reference</h2>
			<ul className="mt-6 border-border border-t">
				{openapi.baseUrl ? (
					<li className={rowClass}>
						<span className="text-muted-foreground text-sm">Base URL</span>
						<span className="flex min-w-0 items-center gap-3">
							<code className="truncate font-mono text-foreground text-sm">
								{openapi.baseUrl}
							</code>
							<CopyButton label="Copy URL" text={openapi.baseUrl} />
						</span>
					</li>
				) : null}
				<li className={rowClass}>
					<span className="text-muted-foreground text-sm">
						OpenAPI document
					</span>
					<span className="min-w-0">
						<a className={linkClass} href={openapi.href}>
							<span className="truncate">{openapi.href}</span>
							<LinkArrow className="text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:rtl:-translate-x-0.5" />
						</a>
					</span>
				</li>
				{docsPath ? (
					<li className={rowClass}>
						<span className="text-muted-foreground text-sm">Docs</span>
						<span className="min-w-0">
							<a
								className={linkClass}
								href={docsHref(docsPath)}
								rel="noopener noreferrer"
								target="_blank"
							>
								<span className="truncate">{docsPath}</span>
								<LinkArrow className="text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:rtl:-translate-x-0.5" />
							</a>
						</span>
					</li>
				) : null}
			</ul>
		</ProductSection>
	);
}
