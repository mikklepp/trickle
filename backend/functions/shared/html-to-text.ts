const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  laquo: "\u00ab",
  raquo: "\u00bb",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  bull: "\u2022",
  middot: "\u00b7",
  iexcl: "\u00a1",
  cent: "\u00a2",
  pound: "\u00a3",
  curren: "\u00a4",
  yen: "\u00a5",
  brvbar: "\u00a6",
  sect: "\u00a7",
  uml: "\u00a8",
  ordf: "\u00aa",
  not: "\u00ac",
  shy: "\u00ad",
  macr: "\u00af",
  deg: "\u00b0",
  plusmn: "\u00b1",
  sup2: "\u00b2",
  sup3: "\u00b3",
  acute: "\u00b4",
  micro: "\u00b5",
  para: "\u00b6",
  cedil: "\u00b8",
  sup1: "\u00b9",
  ordm: "\u00ba",
  frac14: "\u00bc",
  frac12: "\u00bd",
  frac34: "\u00be",
  iquest: "\u00bf",
  Agrave: "\u00c0",
  Aacute: "\u00c1",
  Acirc: "\u00c2",
  Atilde: "\u00c3",
  Auml: "\u00c4",
  Aring: "\u00c5",
  AElig: "\u00c6",
  Ccedil: "\u00c7",
  Egrave: "\u00c8",
  Eacute: "\u00c9",
  Ecirc: "\u00ca",
  Euml: "\u00cb",
  Igrave: "\u00cc",
  Iacute: "\u00cd",
  Icirc: "\u00ce",
  Iuml: "\u00cf",
  ETH: "\u00d0",
  Ntilde: "\u00d1",
  Ograve: "\u00d2",
  Oacute: "\u00d3",
  Ocirc: "\u00d4",
  Otilde: "\u00d5",
  Ouml: "\u00d6",
  times: "\u00d7",
  Oslash: "\u00d8",
  Ugrave: "\u00d9",
  Uacute: "\u00da",
  Ucirc: "\u00db",
  Uuml: "\u00dc",
  Yacute: "\u00dd",
  THORN: "\u00de",
  szlig: "\u00df",
  agrave: "\u00e0",
  aacute: "\u00e1",
  acirc: "\u00e2",
  atilde: "\u00e3",
  auml: "\u00e4",
  aring: "\u00e5",
  aelig: "\u00e6",
  ccedil: "\u00e7",
  egrave: "\u00e8",
  eacute: "\u00e9",
  ecirc: "\u00ea",
  euml: "\u00eb",
  igrave: "\u00ec",
  iacute: "\u00ed",
  icirc: "\u00ee",
  iuml: "\u00ef",
  eth: "\u00f0",
  ntilde: "\u00f1",
  ograve: "\u00f2",
  oacute: "\u00f3",
  ocirc: "\u00f4",
  otilde: "\u00f5",
  ouml: "\u00f6",
  divide: "\u00f7",
  oslash: "\u00f8",
  ugrave: "\u00f9",
  uacute: "\u00fa",
  ucirc: "\u00fb",
  uuml: "\u00fc",
  yacute: "\u00fd",
  thorn: "\u00fe",
  yuml: "\u00ff",
  OElig: "\u0152",
  oelig: "\u0153",
  Scaron: "\u0160",
  scaron: "\u0161",
  Yuml: "\u0178",
  euro: "\u20ac",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  zwnj: "",
  zwj: "",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]+);/gi, (match, body) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

export function htmlToPlainText(html: string): string {
  if (!html) return "";

  let text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  text = text.replace(
    /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, dq, sq, bare, inner) => {
      const href = (dq ?? sq ?? bare ?? "").trim();
      const innerText = inner.replace(/<[^>]+>/g, "").trim();
      if (!href) return innerText;
      const hrefDisplay = href.replace(/^mailto:/i, "").replace(/^tel:/i, "");
      if (!innerText) return hrefDisplay;
      if (innerText.toLowerCase() === href.toLowerCase()) return innerText;
      if (innerText.toLowerCase() === hrefDisplay.toLowerCase()) return innerText;
      return `${innerText} (${hrefDisplay})`;
    }
  );

  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|blockquote|pre|ul|ol|table)>/gi, "\n\n")
    .replace(/<\/(li|td|th|dt|dd)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<hr\s*\/?>/gi, "\n---\n");

  text = text.replace(/<[^>]+>/g, "");

  text = decodeEntities(text);

  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").replace(/\s+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}
