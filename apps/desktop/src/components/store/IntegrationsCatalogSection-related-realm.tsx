import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import type {
	StoreSearchRealm,
	useStoreSearch,
} from "@/src/hooks/useStoreSearch.ts";

/** One "related X" block: the realm's top hits for the brand + a jump to its tab. */
export function RelatedRealmSection({
	group,
	brandName,
	onOpenRealm,
}: {
	group: ReturnType<typeof useStoreSearch>["groups"][number];
	brandName: string;
	onOpenRealm: (realm: StoreSearchRealm, query: string) => void;
}) {
	const tl = useLiteralMessages();
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center justify-between">
				<span className="text-detail text-muted-foreground">
					{tl("Related {label}", { label: group.label })}
				</span>
				<Button
					onClick={() => onOpenRealm(group.realm, brandName)}
					size="micro"
					variant="ghost"
				>
					See all
					<HugeiconsIcon className="size-3.5" icon={ArrowRight01Icon} />
				</Button>
			</div>
			<div className="flex flex-col gap-0.5">
				{group.items.map((item) => (
					<button
						className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-(--duration-fast) hover:bg-muted hover:duration-0"
						key={item.id}
						onClick={() => onOpenRealm(group.realm, brandName)}
						type="button"
					>
						<span className="min-w-0 flex-1">
							<span
								className="block truncate font-medium text-sm"
								title={item.name}
							>
								{item.name}
							</span>
							{item.description ? (
								<span
									className="block truncate text-muted-foreground text-xs"
									title={item.description}
								>
									{item.description}
								</span>
							) : null}
						</span>
						{item.tag ? (
							<span className="shrink-0 text-muted-foreground/70 text-xs">
								{item.tag}
							</span>
						) : null}
					</button>
				))}
			</div>
		</div>
	);
}
