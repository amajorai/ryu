import { cn } from "@ryu/ui/lib/utils.ts";
import Image, { type ImageProps } from "next/image";

/**
 * An image with an optional dark-mode counterpart. Without `darkSrc` it is a
 * plain `next/image`; with one, both render and the theme's `dark` class shows
 * exactly one, so the swap follows the site theme with no client script.
 * `priority` preloads only the dark image, the site's default theme; the light
 * one loads lazily, which still loads at once when it is the visible one.
 */
export function ThemedImage({
	className,
	darkSrc,
	priority,
	...props
}: ImageProps & { darkSrc?: string | null }) {
	if (!darkSrc) {
		return <Image className={className} priority={priority} {...props} />;
	}
	return (
		<>
			<Image
				className={cn(className, "dark:hidden")}
				loading="lazy"
				{...props}
			/>
			<Image
				className={cn(className, "hidden dark:block")}
				priority={priority}
				{...props}
				// Marks the dark copy so text exports of the page skip it.
				data-theme-variant="dark"
				src={darkSrc}
			/>
		</>
	);
}
