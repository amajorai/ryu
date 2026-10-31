import { createContext } from "react";

/** Whether a reply's Markdown may load its images (false: show the alt text). */
export const MarkdownResponseImages = createContext(true);
