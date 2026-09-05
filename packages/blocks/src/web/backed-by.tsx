import { cn } from "@ryu/ui/lib/utils";
import Image from "next/image";

const BLOCK71_HREF = "https://block71.co";

const linkClass =
	"inline-flex items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground";

export default function BackedBy({ className }: { className?: string }) {
	return (
		<div
			className={cn(
				"flex flex-wrap items-center gap-x-2.5 gap-y-2 text-muted-foreground text-sm",
				className
			)}
		>
			<span>Backed by</span>
			<a
				className={linkClass}
				href={BLOCK71_HREF}
				rel="noopener noreferrer"
				target="_blank"
			>
				<Image
					alt=""
					className="size-6"
					height={24}
					src="/block71.png"
					width={24}
				/>
				<span className="font-medium text-foreground">BLOCK71</span>
			</a>
		</div>
	);
}
