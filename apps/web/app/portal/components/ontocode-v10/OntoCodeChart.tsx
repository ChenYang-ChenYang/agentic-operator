"use client";
// OntoCode v10 · 服务端聚合图表（ontocode-chart/v1）的内联 SVG 渲染。
//
// 诚实规则是结构性的：spec 一律先过 OntoCodeChartSpecSchema——不合规就明说
// 「未通过校验」，绝不猜着画；rows 由服务端确定性聚合算出（computedBy:
// "server" 是字面量），组件只负责呈现，永远带上数据来源与截断声明。
// 颜色只用本树自己的 CSS token；多色系列用透明度派生，不引入新色值。
import React from "react";
import {
  OntoCodeChartSpecSchema,
  type OntoCodeChartSpec,
} from "@agentic/contracts";
import styles from "./workbench.module.css";

/* 命名常量——SVG 里不留裸魔数。 */
const BAR_CHART_WIDTH = 520;
const BAR_LABEL_WIDTH = 150;
const BAR_VALUE_WIDTH = 86;
const BAR_HEIGHT = 16;
const BAR_GAP = 10;
const BAR_MIN_VISIBLE_WIDTH = 2;
const BAR_FILL_OPACITY = 0.85;
const SVG_TEXT_SIZE = 11.5;
const MAX_SVG_LABEL_CHARS = 18;

const DONUT_SIZE = 168;
const DONUT_RADIUS = 58;
const DONUT_STROKE = 26;

/** 双 token 交替 + 透明度阶梯派生色阶——不发明新十六进制颜色。 */
const SERIES_TOKENS = ["var(--oc-green)", "var(--oc-purple)"] as const;
const SERIES_OPACITY_STEPS = [0.95, 0.7, 0.45, 0.25] as const;

function seriesColor(index: number): { token: string; opacity: number } {
  return {
    token: SERIES_TOKENS[index % SERIES_TOKENS.length]!,
    opacity:
      SERIES_OPACITY_STEPS[
        Math.floor(index / SERIES_TOKENS.length) % SERIES_OPACITY_STEPS.length
      ]!,
  };
}

function formatValue(value: number, unit: string | undefined): string {
  const number = Number.isInteger(value)
    ? value.toLocaleString("en-US")
    : String(Math.round(value * 100) / 100);
  return unit ? `${number} ${unit}` : number;
}

function clipLabel(label: string): string {
  return label.length > MAX_SVG_LABEL_CHARS
    ? `${label.slice(0, MAX_SVG_LABEL_CHARS)}…`
    : label;
}

function ChartFrame(props: {
  spec: OntoCodeChartSpec;
  children: React.ReactNode;
}) {
  const { spec } = props;
  return (
    <div className={styles.chartCard}>
      <div className={styles.chartTitle}>
        {spec.title}
        {spec.unit ? (
          <span className={styles.chartUnit}>单位：{spec.unit}</span>
        ) : null}
      </div>
      {props.children}
      {spec.note ? <div className={styles.chartNote}>{spec.note}</div> : null}
      {spec.truncated ? (
        <div className={styles.chartTruncated}>
          已截断，仅显示前 {spec.rows.length} 项
        </div>
      ) : null}
      <div className={styles.chartSource}>
        数据来源：服务端聚合 {spec.source.aggregate}
      </div>
    </div>
  );
}

function BarChart({ spec }: { spec: OntoCodeChartSpec }) {
  const max = Math.max(...spec.rows.map((row) => row.value));
  const barArea = BAR_CHART_WIDTH - BAR_LABEL_WIDTH - BAR_VALUE_WIDTH;
  const height =
    spec.rows.length * BAR_HEIGHT + (spec.rows.length - 1) * BAR_GAP;
  return (
    <svg
      className={styles.chartSvg}
      viewBox={`0 0 ${BAR_CHART_WIDTH} ${height}`}
      role="img"
      aria-label={spec.title}
    >
      {spec.rows.map((row, index) => {
        const y = index * (BAR_HEIGHT + BAR_GAP);
        const width =
          row.value > 0
            ? Math.max(BAR_MIN_VISIBLE_WIDTH, (row.value / max) * barArea)
            : 0;
        return (
          <g key={`${row.label}-${index}`}>
            <title>{`${row.label}：${formatValue(row.value, spec.unit)}`}</title>
            <text
              x={BAR_LABEL_WIDTH - 8}
              y={y + BAR_HEIGHT / 2}
              textAnchor="end"
              dominantBaseline="central"
              fontSize={SVG_TEXT_SIZE}
              fill="var(--oc-t2)"
            >
              {clipLabel(row.label)}
            </text>
            <rect
              x={BAR_LABEL_WIDTH}
              y={y}
              width={width}
              height={BAR_HEIGHT}
              rx={3}
              fill="var(--oc-green)"
              fillOpacity={BAR_FILL_OPACITY}
            />
            <text
              x={BAR_LABEL_WIDTH + width + 6}
              y={y + BAR_HEIGHT / 2}
              textAnchor="start"
              dominantBaseline="central"
              fontSize={SVG_TEXT_SIZE}
              fill="var(--oc-t1)"
            >
              {formatValue(row.value, spec.unit)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function DonutChart({ spec }: { spec: OntoCodeChartSpec }) {
  const sum = spec.rows.reduce((acc, row) => acc + row.value, 0);
  const total = spec.total ?? sum;
  const center = DONUT_SIZE / 2;
  const circumference = 2 * Math.PI * DONUT_RADIUS;
  let offset = 0;
  const slices = spec.rows.map((row, index) => {
    const fraction = row.value / sum;
    const length = fraction * circumference;
    const slice = { row, index, length, offset };
    offset += length;
    return slice;
  });
  return (
    <div className={styles.chartDonutWrap}>
      <svg
        className={styles.chartSvg}
        viewBox={`0 0 ${DONUT_SIZE} ${DONUT_SIZE}`}
        width={DONUT_SIZE}
        role="img"
        aria-label={spec.title}
      >
        <g transform={`rotate(-90 ${center} ${center})`}>
          {slices.map((slice) => {
            const color = seriesColor(slice.index);
            return (
              <circle
                key={`${slice.row.label}-${slice.index}`}
                cx={center}
                cy={center}
                r={DONUT_RADIUS}
                fill="none"
                stroke={color.token}
                strokeOpacity={color.opacity}
                strokeWidth={DONUT_STROKE}
                strokeDasharray={`${slice.length} ${circumference - slice.length}`}
                strokeDashoffset={-slice.offset}
              />
            );
          })}
        </g>
        <text
          x={center}
          y={center - 8}
          textAnchor="middle"
          fontSize={SVG_TEXT_SIZE}
          fill="var(--oc-t3)"
        >
          合计
        </text>
        <text
          x={center}
          y={center + 10}
          textAnchor="middle"
          fontSize={15}
          fontWeight={600}
          fill="var(--oc-t1)"
        >
          {formatValue(total, spec.unit)}
        </text>
      </svg>
      <div className={styles.chartLegend}>
        {spec.rows.map((row, index) => {
          const color = seriesColor(index);
          const share = sum > 0 ? Math.round((row.value / sum) * 100) : 0;
          return (
            <div key={`${row.label}-${index}`} className={styles.chartLegendRow}>
              <span
                className={styles.chartSwatch}
                style={{ background: color.token, opacity: color.opacity }}
              />
              <span>{row.label}</span>
              <span className={styles.chartLegendValue}>
                {formatValue(row.value, spec.unit)} · {share}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 数值全为 0 时的可读兜底：不画看不见的图形，按列表如实列出。 */
function ZeroRowsFallback({ spec }: { spec: OntoCodeChartSpec }) {
  return (
    <div className={styles.chartFallbackTable}>
      <div className={styles.chartNote}>该图表的数值当前全部为 0，按列表呈现。</div>
      {spec.rows.map((row, index) => (
        <div key={`${row.label}-${index}`} className={styles.chartFallbackRow}>
          <span>{row.label}</span>
          <span>{formatValue(row.value, spec.unit)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * spec 是未校验输入（直播帧或落库消息里的 JSON）。校验只在这一处发生——
 * 直播与最终消息共用同一渲染与同一门槛。
 */
export function OntoCodeChart({ spec }: { spec: unknown }) {
  const parsed = OntoCodeChartSpecSchema.safeParse(spec);
  if (!parsed.success) {
    return (
      <div className={styles.chartCard}>
        <div className={styles.chartInvalid}>
          图表数据未通过校验——不渲染猜测图形；完整结论以正文为准。
        </div>
      </div>
    );
  }
  const chart = parsed.data;
  const sum = chart.rows.reduce((acc, row) => acc + row.value, 0);
  return (
    <ChartFrame spec={chart}>
      {sum <= 0 ? (
        <ZeroRowsFallback spec={chart} />
      ) : chart.kind === "bar" ? (
        <BarChart spec={chart} />
      ) : (
        <DonutChart spec={chart} />
      )}
    </ChartFrame>
  );
}
