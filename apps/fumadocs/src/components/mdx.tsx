import { Step, Steps } from "fumadocs-ui/components/steps";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

import { AutoCards, DocCard } from "@/components/mdx/doc-cards";
import { Mermaid } from "@/components/mdx/mermaid";
import { Quiz } from "@/components/mdx/quiz";
import { TryInRyu } from "@/components/mdx/try-in-ryu";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    AutoCards,
    DocCard,
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
