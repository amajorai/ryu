import { useLiteralMessages } from "@ryu/i18n/react";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Infobox
// ---------------------------------------------------------------------------

export function Infobox({
	caption,
	children,
	image,
	imageCaption,
	kind,
}: {
	caption: string;
	children: ReactNode;
	image?: ReactNode;
	imageCaption?: string;
	/** The band under the title ("Agent", "Team", "Thread"). */
	kind: string;
}) {
	const tl = useLiteralMessages();
	return (
		<aside
			aria-label={tl("{caption} summary", { caption })}
			className="@2xl/article:float-right mb-4 @2xl/article:ml-6 @2xl/article:w-72 w-full border border-border bg-muted/40 p-1 text-[13px] leading-5"
		>
			<table className="w-full border-collapse">
				<caption className="px-2 pt-1 pb-1 text-center font-semibold text-base leading-6">
					{caption}
				</caption>
				<tbody>
					<tr>
						<th
							className="bg-muted px-2 py-0.5 text-center font-semibold"
							colSpan={2}
							scope="colgroup"
						>
							{kind}
						</th>
					</tr>
					{image ? (
						<tr>
							<td className="px-2 pt-2 pb-1 text-center" colSpan={2}>
								<span className="inline-flex">{image}</span>
								{imageCaption ? (
									<span className="mt-1 block text-pretty text-muted-foreground">
										{imageCaption}
									</span>
								) : null}
							</td>
						</tr>
					) : null}
					{children}
				</tbody>
			</table>
		</aside>
	);
}

export function InfoboxHeader({ children }: { children: ReactNode }) {
	return (
		<tr>
			<th
				className="bg-muted px-2 py-0.5 text-center font-semibold"
				colSpan={2}
				scope="colgroup"
			>
				{children}
			</th>
		</tr>
	);
}

export function InfoboxRow({
	children,
	label,
}: {
	children: ReactNode;
	label: string;
}) {
	return (
		<tr className="align-top">
			<th className="w-[38%] px-2 py-1 text-left font-semibold" scope="row">
				{label}
			</th>
			<td className="px-2 py-1">{children}</td>
		</tr>
	);
}
