import { File, Files, Folder } from "fumadocs-ui/components/files";
import { Step, Steps } from "fumadocs-ui/components/steps";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

import { Architecture } from "@/components/mdx/architecture";
import { AutoCards, DocCard } from "@/components/mdx/doc-cards";
import { Mermaid } from "@/components/mdx/mermaid";
import { Quiz } from "@/components/mdx/quiz";
import { TryInRyu } from "@/components/mdx/try-in-ryu";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Architecture,
    AutoCards,
    DocCard,
    File,
    Files,
    Folder,
    Mermaid,
    Quiz,
    Step,
    Steps,
    TryInRyu,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
