import { useLiteralMessages } from "@ryu/i18n/react";

/** What the Cinema search grid shows when a query matches no titles. */
export function CinemaInterfaceSearchEmpty({ query }: { query: string }) {
	const tl = useLiteralMessages();
	return (
		<div className="flex flex-col gap-3 text-sm leading-6">
			<p className="text-foreground">
				{tl("Your search for “{query}” did not have any matches.", {
					query,
				})}
			</p>
			<div className="text-muted-foreground">
				<p>Suggestions:</p>
				<ul className="list-disc pl-5">
					<li>Try different keywords</li>
					<li>Search for an agent, project, or team name</li>
					<li>Try a word from the latest message</li>
				</ul>
			</div>
		</div>
	);
}
