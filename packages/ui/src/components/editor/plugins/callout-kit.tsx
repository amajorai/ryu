"use client";

import { CalloutPlugin } from "@platejs/callout/react";

import { CalloutElement } from "@ryu/ui/components/editor/ui/callout-node.tsx";

export const CalloutKit = [CalloutPlugin.withComponent(CalloutElement)];
