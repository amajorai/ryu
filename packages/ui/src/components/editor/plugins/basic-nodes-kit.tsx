"use client";

import { BasicBlocksKit } from "./basic-blocks-kit.tsx";
import { BasicMarksKit } from "./basic-marks-kit.tsx";

export const BasicNodesKit = [...BasicBlocksKit, ...BasicMarksKit];
