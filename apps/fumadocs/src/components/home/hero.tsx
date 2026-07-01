"use client";

import { useSearchContext } from "fumadocs-ui/contexts/search";
import {
  ArrowRight,
  BookOpen,
  CircuitBoard,
  Code2,
  Cpu,
  GraduationCap,
  type LucideIcon,
  Monitor,
  PlugZap,
  Rocket,
  Search,
  Shield,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Terminal,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { RyuLogo } from "@/components/ryu-logo";

type Realm = {
  slug: string;
  title: string;
  description: string;
  icon: LucideIcon;
  accent: string;
};

const REALMS: Realm[] = [
  {
    slug: "start-here",
    title: "Start Here",
    description:
      "Install Ryu, understand how the pieces fit together, and send your first message.",
    icon: Rocket,
    accent: "var(--start-here-color)",
  },
  {
    slug: "desktop",
    title: "Desktop",
    description:
      "The flagship app and its companions (Island, extension, Raycast): chat, agents, teams, engines, and more.",
    icon: Monitor,
    accent: "var(--desktop-color)",
  },
  {
    slug: "cli",
    title: "CLI",
    description:
      "The Rust terminal UI: chat, a fuzzy command palette, live list tabs, and GitOps from your shell.",
    icon: Terminal,
    accent: "var(--cli-color)",
  },
  {
    slug: "mobile",
    title: "Mobile",
    description:
      "The Expo app: chat and a drawer of screens over the same Core, through the active node.",
    icon: Smartphone,
    accent: "var(--mobile-color)",
  },
  {
    slug: "hardware",
    title: "Hardware",
    description:
      "ESP32-S3 devices (watch, necklace, desk hub) that capture audio and camera and run all inference on a node: protocol, pairing, ambient capture, firmware, and deployment.",
    icon: CircuitBoard,
    accent: "var(--hardware-color)",
  },
  {
    slug: "skills",
    title: "Skills",
    description:
      "Agent skills: reusable SKILL.md instruction packs that load on demand. The setup-ryu flagship, the shipped catalog, authoring, and publishing.",
    icon: Sparkles,
    accent: "var(--skills-color)",
  },
  {
    slug: "mcp",
    title: "MCP Server",
    description:
      "Connect Claude Desktop or any MCP host to your node: quickstart config, the tool list, remote-node setup, and security.",
    icon: PlugZap,
    accent: "var(--mcp-color)",
  },
  {
    slug: "cookbook",
    title: "Cookbook",
    description:
      "End-to-end recipes: agents, routing, deployments, multi-node, and channel bots.",
    icon: BookOpen,
    accent: "var(--cookbook-color)",
  },
  {
    slug: "academy",
    title: "Academy",
    description:
      "Structured courses from first chat to certified builder, with knowledge checks.",
    icon: GraduationCap,
    accent: "var(--academy-color)",
  },
  {
    slug: "gateway",
    title: "Gateway",
    description:
      "The LLM control plane: routing, firewall, budgets, evals, and audit.",
    icon: Shield,
    accent: "var(--gateway-color)",
  },
  {
    slug: "core",
    title: "Core",
    description:
      "Local backend internals: sessions, memory, RAG, workflows, sandboxes, and MCP.",
    icon: Cpu,
    accent: "var(--core-color)",
  },
  {
    slug: "security",
    title: "Security",
    description:
      "Ryu's security model: trust boundary, sandboxing, command approval and HITL, credential scrubbing, outbound DLP, SSRF protection, and deployment hardening.",
    icon: ShieldCheck,
    accent: "var(--security-color)",
  },
  {
    slug: "develop",
    title: "Develop",
    description:
      "Build on Ryu: TypeScript SDK, Rust SDK, plugin manifests, and the full API reference.",
    icon: Code2,
    accent: "var(--develop-color)",
  },
];

type QuickLink = {
  id: string;
  label: string;
  href: string;
};

const QUICK_LINKS: QuickLink[] = [
  { id: "install", label: "Install", href: "/docs/start-here/getting-started" },
  {
    id: "architecture",
    label: "Architecture",
    href: "/docs/start-here/architecture",
  },
  { id: "cookbook", label: "Cookbook", href: "/docs/cookbook" },
  { id: "api", label: "API reference", href: "/docs/develop/api-reference" },
];

type Stat = {
  id: string;
  value: string;
  label: string;
};

const STATS: Stat[] = [
  { id: "guides", value: "285", label: "hand-written guides" },
  { id: "endpoints", value: "176", label: "API endpoints" },
  { id: "sections", value: "9", label: "documentation sections" },
  { id: "diagrams", value: "36", label: "architecture diagrams" },
];

type Featured = {
  id: string;
  href: string;
  eyebrow: string;
  title: string;
  description: string;
  accent: string;
};

const FEATURED: Featured[] = [
  {
    id: "architecture",
    href: "/docs/start-here/architecture",
    eyebrow: "Start Here",
    title: "The architecture, end to end",
    description:
      "How a request travels App to Gateway to Core to any engine, and why each layer exists.",
    accent: "var(--start-here-color)",
  },
  {
    id: "gateway",
    href: "/docs/gateway",
    eyebrow: "Gateway",
    title: "The control plane: govern every model call",
    description:
      "Routing, firewall, budgets, evals, and audit: what is allowed, shared, and paid for.",
    accent: "var(--gateway-color)",
  },
  {
    id: "workflows",
    href: "/docs/core/workflows",
    eyebrow: "Core",
    title: "Workflows and the DAG engine",
    description:
      "Compose agents, tools, and sub-workflows into durable, resumable runs with retries and HITL gates.",
    accent: "var(--core-color)",
  },
  {
    id: "cookbook",
    href: "/docs/cookbook",
    eyebrow: "Cookbook",
    title: "Recipes: real flows, start to finish",
    description:
      "Watch a price into Slack, give a model a tool, route coding to Claude, ship an SDK agent.",
    accent: "var(--cookbook-color)",
  },
];

/** The centered fake-search button that opens the built-in command palette. */
function SearchTrigger() {
  const { setOpenSearch } = useSearchContext();
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    const platform = navigator.userAgent || navigator.platform || "";
    setIsMac(/Mac|iPhone|iPad|iPod/i.test(platform));
  }, []);

  return (
    <button
      aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
      aria-label="Search the documentation"
      className="group flex w-full items-center gap-3 rounded-xl bg-fd-secondary px-4 py-3.5 text-left shadow-sm transition-colors hover:bg-fd-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
      onClick={() => setOpenSearch(true)}
      type="button"
    >
      <Search
        aria-hidden="true"
        className="size-5 shrink-0 text-fd-muted-foreground transition-colors group-hover:text-fd-foreground"
      />
      <span className="flex-1 text-base text-fd-muted-foreground">
        Search 285 guides and 176 endpoints…
      </span>
      <kbd className="hidden shrink-0 items-center gap-1 rounded-md bg-fd-background px-2 py-1 font-medium font-mono text-fd-muted-foreground text-xs sm:inline-flex">
        {isMac ? "⌘" : "Ctrl"} K
      </kbd>
    </button>
  );
}

function QuickLinks() {
  return (
    <nav aria-label="Common destinations">
      <ul className="flex flex-wrap items-center justify-center gap-2">
        {QUICK_LINKS.map((link) => (
          <li key={link.id}>
            <Link
              className="inline-flex items-center rounded-full bg-fd-secondary px-3.5 py-1.5 font-medium text-fd-muted-foreground text-sm transition-colors hover:bg-fd-accent hover:text-fd-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
              href={link.href}
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function StatStrip() {
  return (
    <dl className="mt-12 flex flex-wrap justify-center gap-x-8 gap-y-6 sm:gap-x-12">
      {STATS.map((stat) => (
        <div className="flex flex-col items-center text-center" key={stat.id}>
          <dt className="font-heading font-medium text-2xl text-fd-foreground tabular-nums sm:text-3xl">
            {stat.value}
          </dt>
          <dd className="mt-1 max-w-[7.5rem] text-fd-muted-foreground text-xs leading-tight sm:text-sm">
            {stat.label}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Hero() {
  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col items-center px-4 pt-16 pb-8 text-center sm:pt-24">
      <span className="inline-flex items-center gap-2 rounded-full bg-fd-secondary px-3 py-1 font-medium text-fd-muted-foreground text-xs">
        <RyuLogo size={14} />
        Ryu Documentation
      </span>

      <h1 className="mt-6 text-balance font-medium font-heading text-4xl text-fd-foreground tracking-tight sm:text-5xl md:text-6xl">
        Find anything in Ryu, in seconds.
      </h1>

      <p className="mt-6 max-w-2xl text-balance text-base text-fd-muted-foreground leading-relaxed sm:text-lg">
        End-to-end infrastructure for AI agents. The engines already exist
        (OpenAI, Claude Code, Gemma, any OpenAI-compatible runtime); Ryu is the
        whole stack around them, so any agent works everywhere, as easily as
        installing an app.
      </p>

      <div className="mt-9 flex w-full max-w-xl flex-col items-center gap-4">
        <SearchTrigger />
        <QuickLinks />
      </div>

      <StatStrip />
    </section>
  );
}

function RealmCard({ realm }: { realm: Realm }) {
  const Icon = realm.icon;
  return (
    <Link
      className="group relative flex flex-col gap-3 rounded-xl bg-fd-secondary p-5 transition-all hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
      href={`/docs/${realm.slug}`}
    >
      <div className="flex items-center justify-between">
        <span
          aria-hidden="true"
          className="flex size-10 items-center justify-center rounded-lg"
          style={{
            backgroundColor: `color-mix(in oklab, ${realm.accent} 16%, transparent)`,
            color: realm.accent,
          }}
        >
          <Icon className="size-5" />
        </span>
        <ArrowRight
          aria-hidden="true"
          className="size-4 text-fd-muted-foreground opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100"
        />
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="font-heading font-medium text-fd-foreground text-lg">
          {realm.title}
        </h3>
        <p className="text-fd-muted-foreground text-sm leading-relaxed">
          {realm.description}
        </p>
      </div>
    </Link>
  );
}

export function Realms() {
  return (
    <section
      aria-labelledby="realms-heading"
      className="mx-auto w-full max-w-4xl px-4 py-12"
    >
      <h2
        className="font-heading font-medium text-fd-foreground text-xl"
        id="realms-heading"
      >
        Explore the docs
      </h2>
      <p className="mt-1 text-fd-muted-foreground text-sm">
        Nine sections, one per surface and plane: get started, the desktop app,
        CLI, mobile, the Gateway control plane, Core internals, the SDK, recipes,
        and the Academy.
      </p>
      <nav
        aria-label="Documentation sections"
        className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        {REALMS.map((realm) => (
          <RealmCard key={realm.slug} realm={realm} />
        ))}
      </nav>
    </section>
  );
}

function FeaturedCard({ item }: { item: Featured }) {
  return (
    <Link
      className="group flex flex-col gap-2 rounded-xl bg-fd-secondary p-5 transition-colors hover:bg-fd-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring sm:flex-row sm:items-center sm:gap-5 sm:p-6"
      href={item.href}
    >
      <span
        aria-hidden="true"
        className="hidden h-12 w-1 shrink-0 rounded-full sm:block"
        style={{
          backgroundColor: `color-mix(in oklab, ${item.accent} 55%, transparent)`,
        }}
      />
      <div className="flex flex-1 flex-col gap-1">
        <span
          className="font-heading font-medium text-xs uppercase tracking-wide"
          style={{ color: item.accent }}
        >
          {item.eyebrow}
        </span>
        <h3 className="font-heading font-medium text-base text-fd-foreground sm:text-lg">
          {item.title}
        </h3>
        <p className="text-fd-muted-foreground text-sm leading-relaxed">
          {item.description}
        </p>
      </div>
      <ArrowRight
        aria-hidden="true"
        className="hidden size-5 shrink-0 text-fd-muted-foreground transition-all group-hover:translate-x-1 group-hover:text-fd-foreground sm:block"
      />
    </Link>
  );
}

export function FeaturedRail() {
  return (
    <section
      aria-labelledby="featured-heading"
      className="mx-auto w-full max-w-4xl px-4 py-12"
    >
      <h2
        className="font-heading font-medium text-fd-foreground text-xl"
        id="featured-heading"
      >
        Featured
      </h2>
      <p className="mt-1 text-fd-muted-foreground text-sm">
        Hand-picked deep pages to get you oriented fast.
      </p>
      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        {FEATURED.map((item) => (
          <FeaturedCard item={item} key={item.id} />
        ))}
      </div>
    </section>
  );
}
