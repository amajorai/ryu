import { createContext } from "react";

/**
 * Whether the act layer is on: the petitions then carry no last-update
 * ages (the act layer's own cards and timers say how long things waited).
 */
export const TownActMode = createContext(false);
