// The loading stand-in for the code-split Store, Library and Memory pages. It
// holds the routed-page geometry (a PageHeader-height title row over a few
// row skeletons) so nothing shifts when the chunk lands. JSX-free like the rest
// of the route table.

import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { createElement, type ReactNode, Suspense } from "react";

function PageSkeleton() {
	return createElement(
		"div",
		{
			"aria-busy": true,
			className: "mx-auto flex w-full max-w-4xl flex-col gap-4 px-6 pt-6",
			"data-slot": "route-page-skeleton",
		},
		createElement(Skeleton, { className: "h-7 w-40", radius: "row" }),
		createElement(Skeleton, { className: "h-9 w-full", radius: "row" }),
		createElement(Skeleton, { className: "h-10 w-full", radius: "row" }),
		createElement(Skeleton, { className: "h-10 w-full", radius: "row" }),
		createElement(Skeleton, { className: "h-10 w-full", radius: "row" })
	);
}

/** Wrap a lazily loaded page in a Suspense boundary with the page skeleton. */
export function withPageSkeleton(page: ReactNode): ReactNode {
	return createElement(
		Suspense,
		{ fallback: createElement(PageSkeleton) },
		page
	);
}
