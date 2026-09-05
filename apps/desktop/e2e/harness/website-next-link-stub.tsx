import type { AnchorHTMLAttributes, ReactNode } from "react";

export default function Link({
	children,
	...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
	children?: ReactNode;
}) {
	return <a {...props}>{children}</a>;
}
