"use client";
// OntoCode v10 · 右栏：代码/结构化产物的查看器。
//
// 为什么不是一个 <pre>：活库里一份 agent.ts 是 46-54KB（约 1300-1800 行）。裸
// <pre> 没有行号、没有高亮、拿不走全文，FDE 只能靠肉眼在无标记的长文里找 tool
// 调用与 emit —— 这正是「生成的 agents 代码无法更好地查看」。
//
// 为什么不用 Monaco：本仓虽然装了它，但在右栏这条链上它的 web worker 起不来
// （实测控制台 "Could not create web worker(s)" + "You must define
// MonacoEnvironment.getWorker"），worker 不在就既不 tokenize 也不布局，
// lines-content 停在 2^24px、一行都不渲染。配 worker 要动全局构建配置并波及另外
// 四处既有调用；而右栏要的是「把生成的 agent 代码看清楚」，不是完整 IDE。
// 所以这里用自绘的轻量着色（code-highlight.ts，零依赖零 worker），对 46-54KB
// 的一份 agent.ts 完全够用，且 SSR 下就能出结果。

import React, { useCallback, useMemo, useRef, useState } from "react";
import styles from "./workbench.module.css";
import {
  prettyPrintIfJson,
  splitLines,
  tokenizeCode,
  type CodeToken,
} from "./code-highlight";

/** content-type → 着色语言。认不出的一律当纯文本，不猜。 */
export function editorLanguageFor(
  contentType: string | null | undefined,
  logicalName?: string | null,
): string {
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("typescript")) return "typescript";
  if (type.includes("javascript")) return "javascript";
  if (type.includes("json")) return "json";
  if (type.includes("yaml") || type.includes("yml")) return "yaml";
  if (type.includes("markdown")) return "markdown";
  const name = (logicalName ?? "").toLowerCase();
  if (name.endsWith(".ts") || name.endsWith(".tsx")) return "typescript";
  if (name.endsWith(".js") || name.endsWith(".mjs")) return "javascript";
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return "yaml";
  if (name.endsWith(".md")) return "markdown";
  return "plaintext";
}

/** 行数按真实换行算；末尾换行不计一行空行。 */
export function lineCount(content: string): number {
  if (content === "") return 0;
  const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
  return trimmed.split("\n").length;
}

/** 人读的体积，用于让 FDE 一眼知道这份产物有多大。 */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 下载用的文件名：用逻辑名末段，避免把内部路径写进用户磁盘。 */
export function downloadFileName(logicalName: string): string {
  const parts = logicalName.split("/").filter(Boolean);
  return parts[parts.length - 1] || "artifact.txt";
}

/** token 类别 → CSS 类。plain 不加类，省掉整份文件里最常见的那批 span 属性。 */
function tokenClass(token: CodeToken): string | undefined {
  switch (token.kind) {
    case "comment":
      return styles.cvComment;
    case "string":
      return styles.cvString;
    case "number":
      return styles.cvNumber;
    case "keyword":
      return styles.cvKeyword;
    case "type":
      return styles.cvType;
    case "property":
      return styles.cvProperty;
    default:
      return undefined;
  }
}

export interface CodeViewerProps {
  content: string;
  contentType?: string | null;
  logicalName: string;
  /** 关掉编辑器只看纯文本（测试与低性能环境）。 */
  plainTextOnly?: boolean;
}

/**
 * 超过这个行数就不逐行着色了。着色是 O(n) 的纯扫描，但把上万个 <span> 交给
 * React 渲染会拖慢右栏；这种体量的产物直接给纯文本，滚动依旧顺畅。
 * 活库最大的一份 agent.ts 是 1,800 行左右，远在阈值内。
 */
const MAX_HIGHLIGHT_LINES = 4000;

export function CodeViewer(props: CodeViewerProps) {
  const [copied, setCopied] = useState(false);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const language = useMemo(
    () => editorLanguageFor(props.contentType, props.logicalName),
    [props.contentType, props.logicalName],
  );
  // 展示用文本：紧凑 JSON 先重新缩进，否则整份产物是一条无限长的横线。
  // 复制/下载仍用原文（props.content），交出去的必须是存储里那一份。
  const display = useMemo(
    () => prettyPrintIfJson(props.content, language),
    [props.content, language],
  );
  const lines = useMemo(() => lineCount(display.text), [display.text]);
  const bytes = useMemo(
    () =>
      typeof TextEncoder === "undefined"
        ? props.content.length
        : new TextEncoder().encode(props.content).length,
    [props.content],
  );

  // 逐行着色：先按行切，再对每行扫描。按行切保证行号与内容永远对齐，也让
  // 跨行的模板串/块注释不会把后面的行吞掉。
  const highlighted = useMemo(() => {
    if (props.plainTextOnly) return null;
    if (lines > MAX_HIGHLIGHT_LINES) return null;
    return splitLines(display.text).map((line) => tokenizeCode(line, language));
  }, [display.text, props.plainTextOnly, language, lines]);

  React.useEffect(() => () => {
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
  }, []);

  const onCopy = useCallback(() => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(props.content);
        setCopied(true);
        if (copyResetRef.current) clearTimeout(copyResetRef.current);
        copyResetRef.current = setTimeout(() => setCopied(false), 1600);
      } catch {
        // 剪贴板可能被浏览器策略拒绝；保持沉默好过谎报已复制。
        setCopied(false);
      }
    })();
  }, [props.content]);

  const onDownload = useCallback(() => {
    const blob = new Blob([props.content], {
      type: props.contentType || "text/plain",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = downloadFileName(props.logicalName);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, [props.content, props.contentType, props.logicalName]);

  return (
    <div className={styles.cvWrap}>
      <div className={styles.cvBar}>
        <span className={styles.cvMeta}>{language}</span>
        <span className={styles.cvMeta}>{lines} 行</span>
        <span className={styles.cvMeta}>{humanSize(bytes)}</span>
        {display.pretty ? (
          // 说清楚屏幕上的排版不是存储里的原样，避免被当成产物本身的格式。
          <span className={styles.cvMeta} title="存储的是紧凑 JSON，这里重新缩进以便阅读；复制与下载仍是原文">
            已缩进显示
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className={styles.btn}
          onClick={onCopy}
          aria-label="复制全文"
        >
          {copied ? "已复制" : "复制"}
        </button>
        <button
          type="button"
          className={styles.btn}
          onClick={onDownload}
          aria-label="下载文件"
        >
          下载
        </button>
      </div>
      <div className={styles.cvEditor}>
        {highlighted === null ? (
          <pre className={styles.codeBoxFlush}>{display.text}</pre>
        ) : (
          <pre className={styles.cvCode}>
            <code>
              {highlighted.map((tokens, index) => (
                <span className={styles.cvLine} key={index}>
                  <span className={styles.cvGutter} aria-hidden="true">
                    {index + 1}
                  </span>
                  <span className={styles.cvLineText}>
                    {tokens.map((token, ti) => (
                      <span key={ti} className={tokenClass(token)}>
                        {token.text}
                      </span>
                    ))}
                    {"\n"}
                  </span>
                </span>
              ))}
            </code>
          </pre>
        )}
      </div>
    </div>
  );
}
