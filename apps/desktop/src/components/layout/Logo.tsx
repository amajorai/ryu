import { Logo as OrbLogo } from "@ryu/ui/components/logo";

export function Logo({
	variant,
}: {
	variant?: "default" | "outline" | "skeleton" | "shimmer";
}) {
	return (
		<div className="flex items-center gap-2">
			<OrbLogo size="32px" variant={variant} />
		</div>
	);
}
