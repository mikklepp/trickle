import { parse, HTMLElement, Node, NodeType, TextNode } from "node-html-parser";

const SKIP_TAGS = new Set(["script", "style", "head", "noscript", "template", "iframe", "svg"]);
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "div",
  "dl",
  "fieldset",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "thead",
  "tfoot",
  "tr",
  "ul",
]);
const LINEBREAK_TAGS = new Set(["br", "li", "td", "th", "dt", "dd"]);

function isElement(node: Node): node is HTMLElement {
  return node.nodeType === NodeType.ELEMENT_NODE;
}

function isText(node: Node): node is TextNode {
  return node.nodeType === NodeType.TEXT_NODE;
}

function renderNode(node: Node, out: string[]): void {
  if (isText(node)) {
    out.push(node.text);
    return;
  }

  if (!isElement(node)) return;

  const tag = node.rawTagName?.toLowerCase() ?? "";

  if (SKIP_TAGS.has(tag)) return;

  if (tag === "br") {
    out.push("\n");
    return;
  }

  if (tag === "hr") {
    out.push("\n---\n");
    return;
  }

  if (tag === "a") {
    const innerParts: string[] = [];
    for (const child of node.childNodes) renderNode(child, innerParts);
    const inner = innerParts.join("").replace(/\s+/g, " ").trim();
    const rawHref = node.getAttribute("href")?.trim() ?? "";
    if (!rawHref) {
      out.push(inner);
      return;
    }
    const hrefDisplay = rawHref.replace(/^mailto:/i, "").replace(/^tel:/i, "");
    if (
      !inner ||
      inner.toLowerCase() === rawHref.toLowerCase() ||
      inner.toLowerCase() === hrefDisplay.toLowerCase()
    ) {
      out.push(inner || hrefDisplay);
    } else {
      out.push(`${inner} (${hrefDisplay})`);
    }
    return;
  }

  const isBlock = BLOCK_TAGS.has(tag);
  const isLineBreak = LINEBREAK_TAGS.has(tag);

  if (isBlock) out.push("\n\n");
  if (tag === "li") out.push("- ");

  for (const child of node.childNodes) renderNode(child, out);

  if (isBlock) out.push("\n\n");
  else if (isLineBreak) out.push("\n");
}

export function htmlToPlainText(html: string): string {
  if (!html) return "";

  const root = parse(html, {
    blockTextElements: {
      script: false,
      noscript: false,
      style: false,
      pre: true,
    },
  });

  const out: string[] = [];
  for (const child of root.childNodes) renderNode(child, out);

  return out
    .join("")
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").replace(/\s+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
