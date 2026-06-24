// The Ryu architecture diagram for the docs.
// Geometry is generated (see tools/gen-architecture-diagram.mjs). The same
// geometry produces .github/architecture-{light,dark}.svg for the READMEs and the
// landing-page diagram, so all three never drift. Colors are fumadocs theme tokens
// (--color-fd-*) so it themes with light/dark for free. No client JS: pure CSS toggles
// the desktop diagram vs the mobile stacked flow.

const SURFACES = ["Desktop", "Mobile", "CLI", "Extension", "Bots", "Web"];
const ENGINES = [
  "OpenAI",
  "Claude Code",
  "Pi",
  "OpenClaw",
  "Hermes",
  "llama.cpp",
];
const GATEWAY_PILLS = [
  "Routing",
  "Firewall",
  "PII / DLP",
  "Budgets",
  "Evals",
  "Audit",
];
const CORE_PILLS = [
  "Sessions",
  "Memory",
  "Tools",
  "Workflows",
  "Sub-agents",
  "Sidecars",
];

export function Architecture() {
  return (
    <div className="my-6">
      {/* Desktop / tablet: the full diagram */}
      <div className="hidden md:block">
        <svg
          aria-label="Ryu architecture: any surface routes through the Gateway, into Core, out to any engine, and back"
          className="h-auto w-full"
          role="img"
          viewBox="0 0 1180 530"
        >
          <path
            d="M148 120 L262 265"
            stroke="var(--color-fd-border)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray="0.1 7"
            fill="none"
          />
          <path
            d="M148 175 L262 265"
            stroke="var(--color-fd-border)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray="0.1 7"
            fill="none"
          />
          <path
            d="M148 230 L262 265"
            stroke="var(--color-fd-border)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray="0.1 7"
            fill="none"
          />
          <path
            d="M148 285 L262 265"
            stroke="var(--color-fd-border)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray="0.1 7"
            fill="none"
          />
          <path
            d="M148 340 L262 265"
            stroke="var(--color-fd-border)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray="0.1 7"
            fill="none"
          />
          <path
            d="M148 395 L262 265"
            stroke="var(--color-fd-border)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray="0.1 7"
            fill="none"
          />
          <path
            d="M554 265 L626 265"
            stroke="var(--color-fd-border)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray="0.1 7"
            fill="none"
          />
          <path
            d="M918 265 L964 120"
            stroke="var(--color-fd-border)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray="0.1 7"
            fill="none"
          />
          <path
            d="M918 265 L964 175"
            stroke="var(--color-fd-border)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray="0.1 7"
            fill="none"
          />
          <path
            d="M918 265 L964 230"
            stroke="var(--color-fd-border)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray="0.1 7"
            fill="none"
          />
          <path
            d="M918 265 L964 285"
            stroke="var(--color-fd-border)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray="0.1 7"
            fill="none"
          />
          <path
            d="M918 265 L964 340"
            stroke="var(--color-fd-border)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray="0.1 7"
            fill="none"
          />
          <path
            d="M918 265 L964 395"
            stroke="var(--color-fd-border)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray="0.1 7"
            fill="none"
          />
          <text
            x={34}
            y={84}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={11}
            fontWeight={500}
            fill="var(--color-fd-muted-foreground)"
            letterSpacing={1.4}
            textAnchor="start"
          >
            SURFACES
          </text>
          <text
            x={1146}
            y={84}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={11}
            fontWeight={500}
            fill="var(--color-fd-muted-foreground)"
            letterSpacing={1.4}
            textAnchor="end"
          >
            ANY ENGINE
          </text>
          <g
            transform="translate(32 110) scale(0.8333333333333334)"
            fill="none"
            stroke="var(--color-fd-foreground)"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x={3} y={4} width={18} height={12} rx={1.6} />
            <path d="M9 20h6M12 16v4" />
          </g>
          <text
            x={62}
            y={124.5}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={14}
            fontWeight={500}
            fill="var(--color-fd-foreground)"
            textAnchor="start"
          >
            Desktop
          </text>
          <g
            transform="translate(32 165) scale(0.8333333333333334)"
            fill="none"
            stroke="var(--color-fd-foreground)"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x={7} y={3} width={10} height={18} rx={2} />
            <path d="M11 18h2" />
          </g>
          <text
            x={62}
            y={179.5}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={14}
            fontWeight={500}
            fill="var(--color-fd-foreground)"
            textAnchor="start"
          >
            Mobile
          </text>
          <g
            transform="translate(32 220) scale(0.8333333333333334)"
            fill="none"
            stroke="var(--color-fd-foreground)"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x={3} y={4} width={18} height={16} rx={2} />
            <path d="M7 9l3 3l-3 3M13 15h4" />
          </g>
          <text
            x={62}
            y={234.5}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={14}
            fontWeight={500}
            fill="var(--color-fd-foreground)"
            textAnchor="start"
          >
            CLI
          </text>
          <g
            transform="translate(32 275) scale(0.8333333333333334)"
            fill="none"
            stroke="var(--color-fd-foreground)"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 4a1.6 1.6 0 0 1 3.2 0V6h3v3h1.8a1.6 1.6 0 0 1 0 3.2H15v4H4V12H2.2a1.6 1.6 0 0 1 0-3.2H4V6h5z" />
          </g>
          <text
            x={62}
            y={289.5}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={14}
            fontWeight={500}
            fill="var(--color-fd-foreground)"
            textAnchor="start"
          >
            Extension
          </text>
          <g
            transform="translate(32 330) scale(0.8333333333333334)"
            fill="none"
            stroke="var(--color-fd-foreground)"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x={4} y={6} width={16} height={11} rx={3} />
            <path d="M9 17l-1 3l4-3M9 11h.01M15 11h.01" />
          </g>
          <text
            x={62}
            y={344.5}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={14}
            fontWeight={500}
            fill="var(--color-fd-foreground)"
            textAnchor="start"
          >
            Bots
          </text>
          <g
            transform="translate(32 385) scale(0.8333333333333334)"
            fill="none"
            stroke="var(--color-fd-foreground)"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx={12} cy={12} r={8.5} />
            <path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.3 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.3-3.6-8.5S9.6 5.8 12 3.5z" />
          </g>
          <text
            x={62}
            y={399.5}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={14}
            fontWeight={500}
            fill="var(--color-fd-foreground)"
            textAnchor="start"
          >
            Web
          </text>
          <g
            transform="translate(1128 110) scale(0.8333333333333334)"
            fill="none"
            stroke="var(--color-fd-foreground)"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x={6} y={6} width={12} height={12} rx={2} />
            <path d="M9.5 10.5h5v5h-5zM12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.5 12V8.5M5.5 12v3.5" />
          </g>
          <text
            x={1118}
            y={124.5}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={14}
            fontWeight={500}
            fill="var(--color-fd-foreground)"
            textAnchor="end"
          >
            OpenAI
          </text>
          <g
            transform="translate(1128 165) scale(0.8333333333333334)"
            fill="none"
            stroke="var(--color-fd-foreground)"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x={6} y={6} width={12} height={12} rx={2} />
            <path d="M9.5 10.5h5v5h-5zM12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.5 12V8.5M5.5 12v3.5" />
          </g>
          <text
            x={1118}
            y={179.5}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={14}
            fontWeight={500}
            fill="var(--color-fd-foreground)"
            textAnchor="end"
          >
            Claude Code
          </text>
          <g
            transform="translate(1128 220) scale(0.8333333333333334)"
            fill="none"
            stroke="var(--color-fd-foreground)"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x={6} y={6} width={12} height={12} rx={2} />
            <path d="M9.5 10.5h5v5h-5zM12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.5 12V8.5M5.5 12v3.5" />
          </g>
          <text
            x={1118}
            y={234.5}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={14}
            fontWeight={500}
            fill="var(--color-fd-foreground)"
            textAnchor="end"
          >
            Pi
          </text>
          <g
            transform="translate(1128 275) scale(0.8333333333333334)"
            fill="none"
            stroke="var(--color-fd-foreground)"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x={6} y={6} width={12} height={12} rx={2} />
            <path d="M9.5 10.5h5v5h-5zM12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.5 12V8.5M5.5 12v3.5" />
          </g>
          <text
            x={1118}
            y={289.5}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={14}
            fontWeight={500}
            fill="var(--color-fd-foreground)"
            textAnchor="end"
          >
            OpenClaw
          </text>
          <g
            transform="translate(1128 330) scale(0.8333333333333334)"
            fill="none"
            stroke="var(--color-fd-foreground)"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x={6} y={6} width={12} height={12} rx={2} />
            <path d="M9.5 10.5h5v5h-5zM12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.5 12V8.5M5.5 12v3.5" />
          </g>
          <text
            x={1118}
            y={344.5}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={14}
            fontWeight={500}
            fill="var(--color-fd-foreground)"
            textAnchor="end"
          >
            Hermes
          </text>
          <g
            transform="translate(1128 385) scale(0.8333333333333334)"
            fill="none"
            stroke="var(--color-fd-foreground)"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x={6} y={6} width={12} height={12} rx={2} />
            <path d="M9.5 10.5h5v5h-5zM12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.5 12V8.5M5.5 12v3.5" />
          </g>
          <text
            x={1118}
            y={399.5}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={14}
            fontWeight={500}
            fill="var(--color-fd-foreground)"
            textAnchor="end"
          >
            llama.cpp
          </text>
          <rect
            x={268}
            y={104}
            width={286}
            height={322}
            rx={18}
            fill="var(--color-fd-foreground)"
            stroke="none"
            strokeWidth={0}
          />
          <g
            transform="translate(293 135) scale(1.0833333333333333)"
            fill="none"
            stroke="var(--color-fd-background)"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 3l7 2.6v5.2c0 4.6-3 7.8-7 9.2c-4-1.4-7-4.6-7-9.2V5.6z" />
            <path d="M9 12l2 2l4-4" />
          </g>
          <text
            x={328}
            y={139}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={10.5}
            fontWeight={500}
            fill="var(--color-fd-background)"
            letterSpacing={1.4}
            textAnchor="start"
          >
            CONTROL
          </text>
          <text
            x={328}
            y={158}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={21}
            fontWeight={500}
            fill="var(--color-fd-background)"
            textAnchor="start"
          >
            Ryu Gateway
          </text>
          <rect
            x={456}
            y={126}
            width={78}
            height={24}
            rx={12}
            fill="none"
            stroke="var(--color-fd-background)"
            strokeWidth={1.2}
          />
          <text
            x={495}
            y={142}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={11}
            fontWeight={500}
            fill="var(--color-fd-background)"
            textAnchor="middle"
          >
            the moat
          </text>
          <text
            x={292}
            y={194}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={12.5}
            fontWeight={500}
            fill="var(--color-fd-background)"
            textAnchor="start"
          >
            decides what&apos;s allowed, shared, measured &amp; paid for
          </text>
          <rect
            x={290}
            y={246}
            width={115}
            height={36}
            rx={9}
            fill="var(--color-fd-background)"
          />
          <text
            x={347.5}
            y={268.5}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={13.5}
            fontWeight={500}
            fill="var(--color-fd-foreground)"
            textAnchor="middle"
          >
            Routing
          </text>
          <rect
            x={417}
            y={246}
            width={115}
            height={36}
            rx={9}
            fill="var(--color-fd-background)"
          />
          <text
            x={474.5}
            y={268.5}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={13.5}
            fontWeight={500}
            fill="var(--color-fd-foreground)"
            textAnchor="middle"
          >
            Firewall
          </text>
          <rect
            x={290}
            y={296}
            width={115}
            height={36}
            rx={9}
            fill="var(--color-fd-background)"
          />
          <text
            x={347.5}
            y={318.5}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={13.5}
            fontWeight={500}
            fill="var(--color-fd-foreground)"
            textAnchor="middle"
          >
            PII / DLP
          </text>
          <rect
            x={417}
            y={296}
            width={115}
            height={36}
            rx={9}
            fill="var(--color-fd-background)"
          />
          <text
            x={474.5}
            y={318.5}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={13.5}
            fontWeight={500}
            fill="var(--color-fd-foreground)"
            textAnchor="middle"
          >
            Budgets
          </text>
          <rect
            x={290}
            y={346}
            width={115}
            height={36}
            rx={9}
            fill="var(--color-fd-background)"
          />
          <text
            x={347.5}
            y={368.5}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={13.5}
            fontWeight={500}
            fill="var(--color-fd-foreground)"
            textAnchor="middle"
          >
            Evals
          </text>
          <rect
            x={417}
            y={346}
            width={115}
            height={36}
            rx={9}
            fill="var(--color-fd-background)"
          />
          <text
            x={474.5}
            y={368.5}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={13.5}
            fontWeight={500}
            fill="var(--color-fd-foreground)"
            textAnchor="middle"
          >
            Audit
          </text>
          <rect
            x={626}
            y={104}
            width={286}
            height={322}
            rx={18}
            fill="var(--color-fd-card)"
            stroke="var(--color-fd-border)"
            strokeWidth={1.6}
          />
          <g
            transform="translate(651 135) scale(1.0833333333333333)"
            fill="none"
            stroke="var(--color-fd-foreground)"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx={12} cy={12} r={2.6} />
            <circle cx={12} cy={4.2} r={1.8} />
            <circle cx={5.2} cy={17} r={1.8} />
            <circle cx={18.8} cy={17} r={1.8} />
            <path d="M12 6v3.4M10 13.6l-3.4 2M14 13.6l3.4 2" />
          </g>
          <text
            x={686}
            y={139}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={10.5}
            fontWeight={500}
            fill="var(--color-fd-muted-foreground)"
            letterSpacing={1.4}
            textAnchor="start"
          >
            ORCHESTRATION
          </text>
          <text
            x={686}
            y={158}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={21}
            fontWeight={500}
            fill="var(--color-fd-foreground)"
            textAnchor="start"
          >
            Ryu Core
          </text>
          <text
            x={650}
            y={194}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={12.5}
            fontWeight={500}
            fill="var(--color-fd-muted-foreground)"
            textAnchor="start"
          >
            decides what runs, then calls the Gateway
          </text>
          <rect
            x={648}
            y={246}
            width={115}
            height={36}
            rx={9}
            fill="var(--color-fd-muted)"
          />
          <text
            x={705.5}
            y={268.5}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={13.5}
            fontWeight={500}
            fill="var(--color-fd-foreground)"
            textAnchor="middle"
          >
            Sessions
          </text>
          <rect
            x={775}
            y={246}
            width={115}
            height={36}
            rx={9}
            fill="var(--color-fd-muted)"
          />
          <text
            x={832.5}
            y={268.5}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={13.5}
            fontWeight={500}
            fill="var(--color-fd-foreground)"
            textAnchor="middle"
          >
            Memory
          </text>
          <rect
            x={648}
            y={296}
            width={115}
            height={36}
            rx={9}
            fill="var(--color-fd-muted)"
          />
          <text
            x={705.5}
            y={318.5}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={13.5}
            fontWeight={500}
            fill="var(--color-fd-foreground)"
            textAnchor="middle"
          >
            Tools
          </text>
          <rect
            x={775}
            y={296}
            width={115}
            height={36}
            rx={9}
            fill="var(--color-fd-muted)"
          />
          <text
            x={832.5}
            y={318.5}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={13.5}
            fontWeight={500}
            fill="var(--color-fd-foreground)"
            textAnchor="middle"
          >
            Workflows
          </text>
          <rect
            x={648}
            y={346}
            width={115}
            height={36}
            rx={9}
            fill="var(--color-fd-muted)"
          />
          <text
            x={705.5}
            y={368.5}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={13.5}
            fontWeight={500}
            fill="var(--color-fd-foreground)"
            textAnchor="middle"
          >
            Sub-agents
          </text>
          <rect
            x={775}
            y={346}
            width={115}
            height={36}
            rx={9}
            fill="var(--color-fd-muted)"
          />
          <text
            x={832.5}
            y={368.5}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={13.5}
            fontWeight={500}
            fill="var(--color-fd-foreground)"
            textAnchor="middle"
          >
            Sidecars
          </text>
          <text
            x={590}
            y={514}
            fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
            fontSize={13}
            fontWeight={500}
            fill="var(--color-fd-muted-foreground)"
            textAnchor="middle"
          >
            A request flows from any surface → Gateway → Core → engine, and
            back. One layer owns every concern.
          </text>{" "}
        </svg>
      </div>

      {/* Mobile: a stacked flow of the same layers */}
      <div className="mx-auto flex max-w-sm flex-col md:hidden">
        <RailRow items={SURFACES} label="Surfaces" />
        <FlowConnector />

        <div className="rounded-2xl bg-fd-foreground p-5 text-fd-background">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-medium text-[10px] text-fd-background/60 uppercase tracking-widest">
                Control
              </p>
              <h3 className="font-medium text-lg tracking-tight">
                Ryu Gateway
              </h3>
            </div>
            <span className="rounded-full bg-fd-background/15 px-2 py-0.5 font-medium text-[10px] text-fd-background/70">
              the moat
            </span>
          </div>
          <p className="mt-1 text-fd-background/65 text-xs">
            decides what&apos;s allowed, shared, measured &amp; paid for
          </p>
          <div className="mt-3 grid grid-cols-2 gap-1.5">
            {GATEWAY_PILLS.map((pill) => (
              <span
                className="rounded-md bg-fd-background px-2 py-1.5 text-center font-medium text-[11px] text-fd-foreground"
                key={pill}
              >
                {pill}
              </span>
            ))}
          </div>
        </div>

        <FlowConnector />

        <div className="rounded-2xl bg-fd-secondary p-5">
          <p className="font-medium text-[10px] text-fd-muted-foreground uppercase tracking-widest">
            Orchestration
          </p>
          <h3 className="font-medium text-fd-foreground text-lg tracking-tight">
            Ryu Core
          </h3>
          <p className="mt-1 text-fd-muted-foreground text-xs">
            decides what runs, then calls the Gateway
          </p>
          <div className="mt-3 grid grid-cols-2 gap-1.5">
            {CORE_PILLS.map((pill) => (
              <span
                className="rounded-md bg-fd-background px-2 py-1.5 text-center font-medium text-[11px] text-fd-foreground"
                key={pill}
              >
                {pill}
              </span>
            ))}
          </div>
        </div>

        <FlowConnector />
        <RailRow items={ENGINES} label="Any engine" />

        <p className="mt-6 text-center text-fd-muted-foreground/70 text-xs leading-relaxed">
          A request flows from any surface → Gateway → Core → engine, and back.
          One layer owns every concern.
        </p>
      </div>
    </div>
  );
}

function FlowConnector() {
  return <div aria-hidden className="mx-auto my-2 h-6 w-px bg-fd-border" />;
}

function RailRow({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="rounded-2xl bg-fd-secondary p-4">
      <p className="mb-2 font-medium text-[10px] text-fd-muted-foreground uppercase tracking-widest">
        {label}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span
            className="rounded-md bg-fd-foreground/[0.06] px-2.5 py-1 font-medium text-fd-foreground/70 text-xs"
            key={item}
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}
