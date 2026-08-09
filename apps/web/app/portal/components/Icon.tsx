import type { CSSProperties } from "react";

/**
 * 27 monoline 16px-viewBox icons ported verbatim from v1_1 components.jsx:6-76.
 *
 * The icon set is intentionally narrow — every glyph the v1_1 prototype
 * uses, nothing extra. Adding an icon: drop a new case below, then add the
 * name to the `IconName` union.
 *
 * Server-component-safe: pure SVG, no hooks. Stroke + fill follow
 * `currentColor` so callers control the tint via the `color` style prop.
 */

export type IconName =
  | "dashboard"
  | "agent"
  | "workflow"
  | "run"
  | "event"
  | "task"
  | "logs"
  | "deploy"
  | "settings"
  | "search"
  | "plus"
  | "chevron-down"
  | "chevron-right"
  | "chevron-left"
  | "external"
  | "filter"
  | "play"
  | "pause"
  | "replay"
  | "x"
  | "check"
  | "alert"
  | "info"
  | "spark"
  | "human"
  | "dot"
  | "git"
  | "code"
  | "trash"
  | "library"
  | "upload"
  | "tenant"
  | "moon"
  | "sun";

export interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  style?: CSSProperties;
}

export function Icon({ name, size = 14, color, style }: IconProps) {
  const s: CSSProperties = {
    width: size,
    height: size,
    color: color || "currentColor",
    display: "inline-block",
    verticalAlign: "middle",
    ...style,
  };
  const common = {
    fill: "none" as const,
    stroke: "currentColor" as const,
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (name) {
    case "library":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <path d="M8 2 L14 5 L8 8 L2 5 Z" />
            <path d="M2 8 L8 11 L14 8" />
            <path d="M2 11 L8 14 L14 11" />
          </g>
        </svg>
      );
    case "dashboard":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <rect x="2" y="2" width="5" height="5" />
            <rect x="9" y="2" width="5" height="5" />
            <rect x="2" y="9" width="5" height="5" />
            <rect x="9" y="9" width="5" height="5" />
          </g>
        </svg>
      );
    case "agent":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <circle cx="8" cy="6" r="2.4" />
            <path d="M3 13.5c.7-2 2.7-3.3 5-3.3s4.3 1.3 5 3.3" />
          </g>
        </svg>
      );
    case "workflow":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <circle cx="3" cy="4" r="1.5" />
            <circle cx="3" cy="12" r="1.5" />
            <circle cx="13" cy="8" r="1.5" />
            <path d="M4.5 4 H8 a2 2 0 0 1 2 2 v1 M4.5 12 H8 a2 2 0 0 0 2 -2 V9" />
          </g>
        </svg>
      );
    case "run":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <path d="M5 3.5v9l7-4.5z" fill="currentColor" />
          </g>
        </svg>
      );
    case "event":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <path d="M9 2 L4 9 H7 L6 14 L12 7 H9 Z" fill="currentColor" />
          </g>
        </svg>
      );
    case "task":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <rect x="3" y="3" width="10" height="10" rx="1" />
            <path d="M5.5 8 l1.5 1.5 L10.5 6" />
          </g>
        </svg>
      );
    case "logs":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <path d="M3 3 H13 M3 6.5 H13 M3 10 H10 M3 13.5 H8" />
          </g>
        </svg>
      );
    case "deploy":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <path d="M8 2 L13 5 V11 L8 14 L3 11 V5 Z" />
            <path d="M8 8 L13 5 M8 8 L3 5 M8 8 V14" />
          </g>
        </svg>
      );
    case "settings":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <circle cx="8" cy="8" r="2" />
            <path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4" />
          </g>
        </svg>
      );
    case "search":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <circle cx="7" cy="7" r="4" />
            <path d="M10 10 l3.5 3.5" />
          </g>
        </svg>
      );
    case "plus":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <path d="M8 3.5v9M3.5 8h9" />
          </g>
        </svg>
      );
    case "chevron-down":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <path d="M4 6 L8 10 L12 6" />
          </g>
        </svg>
      );
    case "chevron-right":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <path d="M6 4 L10 8 L6 12" />
          </g>
        </svg>
      );
    case "chevron-left":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <path d="M10 4 L6 8 L10 12" />
          </g>
        </svg>
      );
    case "external":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <path d="M9 3 H13 V7" />
            <path d="M13 3 L7.5 8.5" />
            <path d="M11 9 V13 H3 V5 H7" />
          </g>
        </svg>
      );
    case "filter":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <path d="M2.5 3.5 H13.5 L9.5 8.5 V12 L6.5 13.5 V8.5 Z" />
          </g>
        </svg>
      );
    case "play":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <path d="M5 3 L13 8 L5 13 Z" fill="currentColor" />
          </g>
        </svg>
      );
    case "pause":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <rect x="4" y="3" width="3" height="10" fill="currentColor" />
            <rect x="9" y="3" width="3" height="10" fill="currentColor" />
          </g>
        </svg>
      );
    case "replay":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <path d="M3 8 a5 5 0 1 0 1.8 -3.85" />
            <path d="M3 3 V5 H5" />
          </g>
        </svg>
      );
    case "x":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <path d="M4 4 L12 12 M12 4 L4 12" />
          </g>
        </svg>
      );
    case "check":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <path d="M3 8.5 L6.5 12 L13 4.5" />
          </g>
        </svg>
      );
    case "alert":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <path d="M8 2 L14 13 H2 Z" />
            <path d="M8 6 V9 M8 11 V11.5" strokeLinecap="round" />
          </g>
        </svg>
      );
    case "info":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <circle cx="8" cy="8" r="6" />
            <path d="M8 7v4" />
            <path d="M8 4.5h.01" strokeWidth="2" />
          </g>
        </svg>
      );
    case "spark":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <path
              d="M8 1.5 L9.2 6.8 L14.5 8 L9.2 9.2 L8 14.5 L6.8 9.2 L1.5 8 L6.8 6.8 Z"
              fill="currentColor"
            />
          </g>
        </svg>
      );
    case "human":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <circle cx="8" cy="5" r="2.4" />
            <path d="M3 14 c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5" />
          </g>
        </svg>
      );
    case "dot":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="3" fill="currentColor" />
        </svg>
      );
    case "git":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <circle cx="4" cy="3" r="1.5" />
            <circle cx="4" cy="13" r="1.5" />
            <circle cx="12" cy="8" r="1.5" />
            <path d="M4 4.5 V11.5 M4 8 H10.5" />
          </g>
        </svg>
      );
    case "code":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <path d="M5 4 L1.5 8 L5 12 M11 4 L14.5 8 L11 12" />
          </g>
        </svg>
      );
    case "upload":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <path d="M8 2 V11 M4.5 5.5 L8 2 L11.5 5.5" />
            <path d="M2.5 13 H13.5" />
          </g>
        </svg>
      );
    case "trash":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <path d="M3 4 H13 M6.5 4 V2.5 H9.5 V4 M4.5 4 L5 13.2 H11 L11.5 4 M6.7 6.5 V11 M9.3 6.5 V11" />
          </g>
        </svg>
      );
    case "tenant":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <rect x="2.5" y="6" width="11" height="7.5" />
            <path d="M5 6 V3 H11 V6 M5.5 9 H6.5 M9.5 9 H10.5 M5.5 11.5 H6.5 M9.5 11.5 H10.5" />
          </g>
        </svg>
      );
    case "moon":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <path
              d="M13 9.5 A6 6 0 1 1 6.5 3 a4.5 4.5 0 0 0 6.5 6.5 Z"
              fill="currentColor"
            />
          </g>
        </svg>
      );
    case "sun":
      return (
        <svg style={s} viewBox="0 0 16 16" aria-hidden="true">
          <g {...common}>
            <circle cx="8" cy="8" r="3" />
            <path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.05 1.05M11.55 11.55l1.05 1.05M12.6 3.4l-1.05 1.05M4.45 11.55L3.4 12.6" />
          </g>
        </svg>
      );
    default:
      return null;
  }
}
