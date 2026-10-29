import { Button } from "@ryu/ui/components/button.tsx";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { Menu, Plus } from "lucide-react";
import { PostsFacepile } from "./posts-avatar.tsx";

/** Opens the sidebar when it is folded away at narrow widths. */
export function PostsSidebarToggle({ onOpen }: { onOpen: () => void }) {
	return (
		<button
			aria-label="Open sidebar"
			className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-100 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
			onClick={onOpen}
			type="button"
		>
			<Menu aria-hidden="true" className="size-4" strokeWidth={1.75} />
		</button>
	);
}

export interface PostsHeaderProps {
	description: string;
	members: readonly InterfaceAgent[];
	onNewPost: () => void;
	onOpenSidebar: (() => void) | null;
	title: string;
}

/** The space header: name, one factual line, members, and New post. */
export function PostsHeader({
	description,
	members,
	onNewPost,
	onOpenSidebar,
	title,
}: PostsHeaderProps) {
	return (
		<header className="shrink-0 border-border border-b">
			<div className="mx-auto flex h-16 w-full max-w-[800px] items-center gap-3 px-4 sm:px-8">
				{onOpenSidebar ? <PostsSidebarToggle onOpen={onOpenSidebar} /> : null}
				<div className="min-w-0 flex-1">
					<h1 className="truncate text-foreground text-lg leading-7">
						<span className="font-semibold">{title}</span>
					</h1>
					{description ? (
						<p className="truncate text-[13px] text-muted-foreground leading-5">
							{description}
						</p>
					) : null}
				</div>
				{members.length > 0 ? (
					<span className="hidden md:flex">
						<PostsFacepile
							agents={members}
							label={`${members.length} ${members.length === 1 ? "member" : "members"}: ${members.map((agent) => agent.name).join(", ")}`}
							size={24}
						/>
					</span>
				) : null}
				<Button
					aria-keyshortcuts="C"
					onClick={onNewPost}
					size="sm"
					title="New post (C)"
					type="button"
				>
					<Plus aria-hidden="true" data-icon="inline-start" strokeWidth={2} />
					New post
				</Button>
			</div>
		</header>
	);
}
