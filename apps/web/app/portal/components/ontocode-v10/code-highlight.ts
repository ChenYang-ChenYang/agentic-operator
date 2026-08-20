// OntoCode v10 · 右栏代码查看器的轻量着色器。
//
// 为什么不用 Monaco：右栏这条链上 Monaco 的 web worker 起不来（实测控制台
// "Could not create web worker(s)" + "You must define MonacoEnvironment.getWorker"），
// worker 不在，模型既不 tokenize 也不布局，lines-content 停在 2^24px、一行都
// 不渲染。配 worker 要动全局构建配置并波及另外四处既有调用，代价远大于收益：
// 右栏要的是「把生成的 agent 代码看清楚」，不是一个完整 IDE。
//
// 所以这里只做扫描器该做的事：把源码切成带类别的片段，交给 React 渲染 <span>。
// 不解析语法树、不做类型推断——它们对「读懂一份生成代码」没有额外价值。

export type TokenKind =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "type"
  | "property";

export interface CodeToken {
  kind: TokenKind;
  text: string;
}

/** TS/JS 关键字。故意不含类型名，类型走 TYPE_WORDS 以便配不同颜色。 */
const KEYWORDS = new Set([
  "abstract", "as", "async", "await", "break", "case", "catch", "class",
  "const", "continue", "debugger", "default", "delete", "do", "else", "enum",
  "export", "extends", "false", "finally", "for", "from", "function", "get",
  "if", "implements", "import", "in", "instanceof", "interface", "let", "new",
  "null", "of", "private", "protected", "public", "readonly", "return",
  "satisfies", "set", "static", "super", "switch", "this", "throw", "true",
  "try", "type", "typeof", "undefined", "var", "void", "while", "yield",
]);

const TYPE_WORDS = new Set([
  "any", "bigint", "boolean", "never", "number", "object", "string", "symbol",
  "unknown", "Array", "Promise", "Record", "Partial", "Readonly", "Map", "Set",
  "Date", "Error", "JSON", "Math", "Object",
]);

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

/**
 * 把一段源码扫描成 token 序列。JSON 走同一条路径——它的字符串/数字/字面量
 * 规则是 JS 的子集，`true/false/null` 也在 KEYWORDS 里，着色结果正确。
 */
export function tokenizeCode(source: string, language: string): CodeToken[] {
  if (language === "plaintext" || language === "markdown") {
    return source ? [{ kind: "plain", text: source }] : [];
  }
  const tokens: CodeToken[] = [];
  let plain = "";
  const flush = () => {
    if (plain) {
      tokens.push({ kind: "plain", text: plain });
      plain = "";
    }
  };
  const push = (kind: TokenKind, text: string) => {
    flush();
    tokens.push({ kind, text });
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];

    // 行注释
    if (ch === "/" && next === "/") {
      let end = source.indexOf("\n", i);
      if (end < 0) end = source.length;
      push("comment", source.slice(i, end));
      i = end;
      continue;
    }
    // 块注释
    if (ch === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close < 0 ? source.length : close + 2;
      push("comment", source.slice(i, end));
      i = end;
      continue;
    }
    // 字符串与模板串。模板串里的 ${} 不单独着色——嵌套表达式的收益不抵复杂度。
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < source.length) {
        const c = source[j]!;
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === ch) {
          j += 1;
          break;
        }
        // 非模板串不跨行：未闭合时就地收尾，避免把整份文件染成字符串。
        if (c === "\n" && ch !== "`") break;
        j += 1;
      }
      // `"foo":` 是对象键，不是值。同色会让 JSON 的键值层次消失（活库里 spec/
      // 回执全是 JSON，读的就是这层结构），所以键单独着色。
      let k = j;
      while (k < source.length && (source[k] === " " || source[k] === "\t")) k += 1;
      push(source[k] === ":" ? "property" : "string", source.slice(i, j));
      i = j;
      continue;
    }
    // 数字
    if (DIGIT.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9a-fA-FxXoObB._]/.test(source[j]!)) j += 1;
      push("number", source.slice(i, j));
      i = j;
      continue;
    }
    // 标识符 / 关键字 / 类型 / 对象属性名
    if (IDENT_START.test(ch)) {
      let j = i;
      while (j < source.length && IDENT_PART.test(source[j]!)) j += 1;
      const word = source.slice(i, j);
      if (KEYWORDS.has(word)) push("keyword", word);
      else if (TYPE_WORDS.has(word)) push("type", word);
      else {
        // `foo:` 形态按属性名着色，让 JSON 与对象字面量读起来有层次。
        let k = j;
        while (k < source.length && (source[k] === " " || source[k] === "\t")) k += 1;
        if (source[k] === ":") push("property", word);
        else plain += word;
      }
      i = j;
      continue;
    }
    plain += ch;
    i += 1;
  }
  flush();
  return tokens;
}

/**
 * 活库里 61 个 JSON 产物**没有一个**是格式化的：spec.json 72-87KB、执行回执最大
 * 1.18MB，全部零换行。原样渲染就是一条无限长的横线、行号只有 1 行，FDE 没法在
 * spec 里读工具绑定与事件契约，也没法在回执里查失败原因。
 *
 * 这里只做「重新缩进」——`JSON.parse` 后 `JSON.stringify(…, 2)`，数据本身不变。
 * 解析失败就原样返回：产物可能是被截断的或非标准的，谎称美化过更糟。
 */
export function prettyPrintIfJson(
  content: string,
  language: string,
): { text: string; pretty: boolean } {
  if (language !== "json") return { text: content, pretty: false };
  // 已经有换行的就是格式化过的，别去动它的既有排版。
  if (content.includes("\n")) return { text: content, pretty: false };
  try {
    const formatted = JSON.stringify(JSON.parse(content), null, 2);
    if (typeof formatted !== "string" || formatted === content) {
      return { text: content, pretty: false };
    }
    return { text: formatted, pretty: true };
  } catch {
    return { text: content, pretty: false };
  }
}

/** 按行切分并保留行号，供渲染带行号的代码块。 */
export function splitLines(source: string): string[] {
  const body = source.endsWith("\n") ? source.slice(0, -1) : source;
  return body.split("\n");
}
