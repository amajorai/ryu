import { FileTree, useFileTree } from "@pierre/trees/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@ryu/ui/components/resizable.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { type ComponentType, useEffect, useMemo, useState } from "react";
import type { CatalogMarkdownProps } from "./host.tsx";
import { formatCount, isMarkdownFile } from "./skills-catalog-section-model.ts";
import type { SkillDetail } from "./types.ts";

export function SkillFilesPanel({
	selectedId,
	detail,
	loading,
	Markdown,
}: {
	selectedId: string | null;
	detail: SkillDetail | null;
	loading: boolean;
	Markdown: ComponentType<CatalogMarkdownProps>;
}) {
	const tl = useLiteralMessages();
	const files = detail?.files ?? [];
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const paths = useMemo(() => files.map((file) => file.path), [files]);
	const selectedFile =
		files.find((file) => file.path === selectedPath) ?? files[0] ?? null;

	useEffect(() => {
		setSelectedPath(files[0]?.path ?? null);
	}, [files]);

	if (!selectedId) {
		return <div className="border-l" />;
	}
	if (loading && !detail) {
		return (
			<div className="flex h-full items-center justify-center border-l text-muted-foreground">
				<Spinner className="size-5" />
			</div>
		);
	}
	if (files.length === 0) {
		return (
			<div className="flex h-full items-center justify-center border-l text-muted-foreground text-sm">
				No bundled files.
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-col border-l">
			<div className="border-b px-3 py-2">
				<h3 className="font-medium text-sm">
					{tl("Files ({count})", { count: formatCount(files.length) ?? "—" })}
				</h3>
			</div>
			{/* File navigator (tree + flat list) vs. content are a resizable vertical
			    split — drag the handle to give either side more room. */}
			<ResizablePanelGroup className="min-h-0 flex-1" orientation="vertical">
				<ResizablePanel defaultSize={45} id="nav" minSize={20}>
					<div className="flex h-full min-h-0 flex-col">
						<div className="min-h-0 flex-1 overflow-auto">
							<SkillFileTree
								onSelect={setSelectedPath}
								paths={paths}
								selectedPath={selectedFile?.path ?? null}
							/>
						</div>
						<div className="max-h-40 shrink-0 overflow-auto border-t p-2">
							<div className="flex flex-col gap-1">
								{files.map((file) => {
									const active = file.path === selectedFile?.path;
									return (
										<button
											className={`truncate rounded-lg px-2 py-1.5 text-left font-mono text-xs transition-colors ${
												active
													? "bg-accent text-foreground"
													: "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
											}`}
											key={file.path}
											onClick={() => setSelectedPath(file.path)}
											type="button"
										>
											{file.path}
										</button>
									);
								})}
							</div>
						</div>
					</div>
				</ResizablePanel>
				<ResizableHandle withHandle />
				<ResizablePanel defaultSize={55} id="content" minSize={25}>
					<SkillFileContent
						file={selectedFile}
						Markdown={Markdown}
						readme={detail?.readme ?? null}
					/>
				</ResizablePanel>
			</ResizablePanelGroup>
		</div>
	);
}

function SkillFileTree({
	paths,
	selectedPath,
	onSelect,
}: {
	paths: string[];
	selectedPath: string | null;
	onSelect: (path: string) => void;
}) {
	const { model } = useFileTree({
		flattenEmptyDirectories: true,
		initialExpansion: "open",
		initialSelectedPaths: selectedPath ? [selectedPath] : [],
		onSelectionChange: (selectedPaths) => {
			const [path] = selectedPaths;
			if (path && paths.includes(path)) {
				onSelect(path);
			}
		},
		paths,
		search: true,
	});

	return <FileTree className="h-full w-full" model={model} />;
}

function SkillFileContent({
	file,
	readme,
	Markdown,
}: {
	file: SkillDetail["files"][number] | null;
	readme: string | null;
	Markdown: ComponentType<CatalogMarkdownProps>;
}) {
	if (!file) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground text-sm">
				Select a file.
			</div>
		);
	}

	const content =
		file.contents ||
		(file.path.toLowerCase().endsWith("skill.md") ? readme : null) ||
		"";
	const hasContent = content.trim().length > 0;

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="truncate border-b px-3 py-2 font-mono text-muted-foreground text-xs">
				{file.path}
			</div>
			{hasContent && isMarkdownFile(file.path) ? (
				<div className="scroll-fade prose prose-sm dark:prose-invert min-h-0 max-w-none flex-1 overflow-auto p-3 text-sm">
					<Markdown className="[&_ol]:pl-10 [&_ul]:pl-9" content={content} />
				</div>
			) : (
				<pre className="scroll-fade min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs leading-relaxed">
					{content || "This file is empty."}
				</pre>
			)}
		</div>
	);
}
