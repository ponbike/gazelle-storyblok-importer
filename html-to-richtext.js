import { parse } from "node-html-parser";

const NODE_ELEMENT = 1;
const NODE_TEXT = 3;

const MARK_BY_TAG = {
  strong: "bold",
  b: "bold",
  em: "italic",
  i: "italic",
  u: "underline",
  s: "strike",
  strike: "strike",
  del: "strike",
  code: "code",
};

// Rendered through their children; the element itself carries no richtext meaning.
const TRANSPARENT_TAGS = new Set([
  "span",
  "div",
  "font",
  "section",
  "article",
  "tbody",
  "thead",
  "tfoot",
  "colgroup",
]);

// Carry no richtext content; removing them loses nothing.
const IGNORED_TAGS = new Set(["script", "style", "col", "link", "meta"]);

// Real content that richtext cannot represent, so callers get told what was lost.
const EMBED_TAGS = new Set([
  "iframe",
  "img",
  "video",
  "audio",
  "object",
  "embed",
]);

// \s would also match \u00a0, which is meaningful content here.
const collapseWhitespace = (value) => value.replace(/[ \t\r\n\f]+/g, " ");

const isWhitespaceText = (node) =>
  node.type === "text" && node.text.trim() === "";

const trimInlineRun = (nodes) => {
  const run = [...nodes];

  while (run.length && isWhitespaceText(run[0])) run.shift();
  while (run.length && isWhitespaceText(run.at(-1))) run.pop();
  while (run.length && run.at(-1).type === "hard_break") run.pop();

  if (run.every((node) => node.type === "hard_break")) return [];

  if (run.length) {
    run[0] = { ...run[0], text: run[0].text?.replace(/^ +/, "") };
    if (run[0].text === "") run.shift();
  }
  if (run.length) {
    const last = run.at(-1);
    if (last.type === "text") {
      run[run.length - 1] = { ...last, text: last.text.replace(/ +$/, "") };
      if (run.at(-1).text === "") run.pop();
    }
  }

  return run;
};

const linkMark = (node) => {
  const href = node.getAttribute("href")?.trim();
  if (!href) return null;

  const isEmail = href.toLowerCase().startsWith("mailto:");

  return {
    type: "link",
    attrs: {
      href: isEmail ? href.slice("mailto:".length) : href,
      uuid: null,
      anchor: null,
      target: node.getAttribute("target") ?? "_self",
      linktype: isEmail ? "email" : "url",
    },
  };
};

const paragraphOf = (content) =>
  content.length ? { type: "paragraph", content } : { type: "paragraph" };

const atLeastOneBlock = (blocks) =>
  blocks.length ? blocks : [{ type: "paragraph" }];

const createConverter = (context) => {
  const { warnings, tableMode } = context;

  function* streamChildren(children, marks) {
    for (const child of children) yield* streamNode(child, marks);
  }

  function* streamNode(node, marks) {
    if (node.nodeType === NODE_TEXT) {
      const text = collapseWhitespace(node.text);
      if (text) {
        yield {
          kind: "inline",
          node: { type: "text", text, ...(marks.length ? { marks } : {}) },
        };
      }
      return;
    }

    if (node.nodeType !== NODE_ELEMENT) return;

    const tag = (node.rawTagName ?? "").toLowerCase();

    if (tag === "br") {
      yield { kind: "inline", node: { type: "hard_break" } };
      return;
    }

    if (IGNORED_TAGS.has(tag)) return;

    if (EMBED_TAGS.has(tag)) {
      const src = node.getAttribute("src") ?? node.getAttribute("data-src");
      warnings.dropped.push(src ? `${tag} ${src}` : tag);
      return;
    }

    if (MARK_BY_TAG[tag]) {
      yield* streamChildren(node.childNodes, [
        ...marks,
        { type: MARK_BY_TAG[tag] },
      ]);
      return;
    }

    if (tag === "a") {
      const mark = linkMark(node);
      yield* streamChildren(node.childNodes, mark ? [...marks, mark] : marks);
      return;
    }

    if (tag === "p") {
      yield* blocksOf(node.childNodes, marks).map((block) => ({
        kind: "block",
        node: block,
      }));
      return;
    }

    if (tag === "ul" || tag === "ol") {
      yield { kind: "block", node: listNode(node, tag, marks) };
      return;
    }

    if (tag === "table") {
      yield* tableNodes(node, marks);
      return;
    }

    if (!TRANSPARENT_TAGS.has(tag)) warnings.unmapped.add(tag);

    yield* streamChildren(node.childNodes, marks);
  }

  const blocksOf = (children, marks) => {
    const blocks = [];
    let inline = [];

    const flush = () => {
      const content = trimInlineRun(inline);
      if (content.length) blocks.push({ type: "paragraph", content });
      inline = [];
    };

    for (const item of streamChildren(children, marks)) {
      if (item.kind === "inline") {
        inline.push(item.node);
        continue;
      }
      flush();
      blocks.push(item.node);
    }

    flush();
    return blocks;
  };

  const listNode = (node, tag, marks) => {
    const items = node.childNodes
      .filter(
        (child) =>
          child.nodeType === NODE_ELEMENT &&
          (child.rawTagName ?? "").toLowerCase() === "li"
      )
      .map((child) => ({
        type: "list_item",
        content: atLeastOneBlock(blocksOf(child.childNodes, marks)),
      }));

    return {
      type: tag === "ul" ? "bullet_list" : "ordered_list",
      ...(tag === "ol" ? { attrs: { order: 1 } } : {}),
      content: items,
    };
  };

  const rowCells = (row) =>
    row.childNodes.filter(
      (child) =>
        child.nodeType === NODE_ELEMENT &&
        ["td", "th"].includes((child.rawTagName ?? "").toLowerCase())
    );

  const tableRows = (node) =>
    node.querySelectorAll("tr").filter((row) => rowCells(row).length > 0);

  function* tableNodes(node, marks) {
    const rows = tableRows(node);
    if (rows.length === 0) return;

    if (tableMode === "flat") {
      for (const row of rows) {
        const content = [];
        for (const cell of rowCells(row)) {
          const inline = trimInlineRun([
            ...streamChildren(cell.childNodes, marks),
          ].filter((item) => item.kind === "inline").map((item) => item.node));

          if (!inline.length) continue;
          if (content.length) content.push({ type: "text", text: " | " });
          content.push(...inline);
        }
        if (content.length) yield { kind: "block", node: { type: "paragraph", content } };
      }
      return;
    }

    yield {
      kind: "block",
      node: {
        type: "table",
        content: rows.map((row) => ({
          type: "tableRow",
          content: rowCells(row).map((cell) => ({
            type:
              (cell.rawTagName ?? "").toLowerCase() === "th"
                ? "tableHeader"
                : "tableCell",
            attrs: {
              colspan: Number(cell.getAttribute("colspan") ?? 1),
              rowspan: Number(cell.getAttribute("rowspan") ?? 1),
              colwidth: null,
              backgroundColor: null,
            },
            content: atLeastOneBlock(blocksOf(cell.childNodes, marks)),
          })),
        })),
      },
    };
  }

  return blocksOf;
};

export const htmlToRichtext = (html, { tableMode = "native" } = {}) => {
  const warnings = { unmapped: new Set(), dropped: [] };
  const source = String(html ?? "").trim();

  if (!source) {
    return { doc: { type: "doc", content: [paragraphOf([])] }, warnings };
  }

  const blocksOf = createConverter({ warnings, tableMode });
  const blocks = blocksOf(parse(source).childNodes, []);

  return {
    doc: { type: "doc", content: atLeastOneBlock(blocks) },
    warnings,
  };
};
