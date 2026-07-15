import { ImageResponse } from "@takumi-rs/image-response";

export const OG_SIZE = { width: 1200, height: 630 } as const;

const INK = "#0a0a0a";
const MUTED = "#737373";
const SUBTLE = "#525252";
const HAIRLINE = "#e5e5e5";

const GHOST_PATH =
  "M12,24c9.2,0,12.9-4.8,12.4-14.6C24.1,0.3,12.8-3.7,8.8,5.4c-2.2,5.7,1.1,7.9-2.9,12.6c-0.9,1.1-1.8,2-2.7,3.1c-1.2,1.3,0.7,2.2,1.9,2.2C7.4,23.3,9.7,24,12,24z";
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 28 28"><path d="${GHOST_PATH}" fill="none" stroke="${INK}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><ellipse cx="15" cy="10" rx="1.5" ry="3" fill="${INK}"/><ellipse cx="19" cy="10" rx="1.5" ry="3" fill="${INK}"/></svg>`;
const LOGO_DATA_URI = `data:image/svg+xml;utf8,${encodeURIComponent(LOGO_SVG)}`;

export interface OgCardParams {
  domain: string;
  eyebrow?: string;
  subtitle?: string;
  title: string;
}

const titleFontSize = (title: string): number => {
  const len = title.length;
  if (len <= 32) {
    return 76;
  }
  if (len <= 60) {
    return 62;
  }
  if (len <= 100) {
    return 50;
  }
  return 40;
};

const OgCard = ({ title, eyebrow, subtitle, domain }: OgCardParams) => (
  <div
    style={{
      width: "100%",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
      backgroundColor: "#ffffff",
      padding: "80px",
      fontFamily: "Inter",
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: "18px" }}>
      {/* biome-ignore lint/performance/noImgElement: Takumi renders to an image, not the DOM. */}
      <img alt="" height={56} src={LOGO_DATA_URI} width={56} />
      <span
        style={{
          fontSize: "34px",
          fontWeight: 700,
          letterSpacing: "-1px",
          color: INK,
        }}
      >
        Ryu
      </span>
    </div>

    <div style={{ display: "flex", flexDirection: "column", gap: "22px" }}>
      {eyebrow ? (
        <span
          style={{
            fontSize: "24px",
            fontWeight: 600,
            letterSpacing: "3px",
            textTransform: "uppercase",
            color: MUTED,
          }}
        >
          {eyebrow}
        </span>
      ) : null}
      <span
        style={{
          fontSize: `${titleFontSize(title)}px`,
          fontWeight: 700,
          lineHeight: 1.05,
          letterSpacing: "-2px",
          color: INK,
          maxWidth: "1040px",
        }}
      >
        {title}
      </span>
      {subtitle ? (
        <span
          style={{
            fontSize: "30px",
            fontWeight: 400,
            lineHeight: 1.3,
            color: SUBTLE,
            maxWidth: "960px",
          }}
        >
          {subtitle}
        </span>
      ) : null}
    </div>

    <div
      style={{
        display: "flex",
        alignItems: "center",
        borderTop: `1px solid ${HAIRLINE}`,
        paddingTop: "28px",
      }}
    >
      <span style={{ fontSize: "26px", fontWeight: 400, color: MUTED }}>
        {domain}
      </span>
    </div>
  </div>
);

export const renderOgCard = (params: OgCardParams): ImageResponse =>
  new ImageResponse(<OgCard {...params} />, {
    ...OG_SIZE,
    headers: {
      "Cache-Control": "public, immutable, max-age=31536000",
    },
  });
