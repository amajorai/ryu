import { type AnchorHTMLAttributes, forwardRef, type ReactNode } from "react";

const Link = forwardRef<
	HTMLAnchorElement,
	AnchorHTMLAttributes<HTMLAnchorElement> & {
		children?: ReactNode;
		href: string;
	}
>(({ children, href, ...props }, ref) => (
	<a href={href} ref={ref} {...props}>
		{children}
	</a>
));

Link.displayName = "Link";

export default Link;
