import type { ReactNode } from "react";

export type AmpMessageRole = "user" | "assistant" | "system" | "tool" | "other";

export interface AmpTranscriptMessage {
  readonly role: AmpMessageRole;
  readonly label: string;
  readonly body: string;
}

export interface AmpTranscriptDocument {
  readonly title?: string;
  readonly messages: readonly AmpTranscriptMessage[];
}

interface MarkdownBlock {
  readonly kind: "paragraph" | "heading" | "code" | "list" | "quote" | "rule";
  readonly text?: string;
  readonly level?: number;
  readonly language?: string;
  readonly items?: readonly string[];
  readonly ordered?: boolean;
}

function roleFor(label: string): AmpMessageRole {
  const normalized = label.trim().toLowerCase();
  if (normalized === "user") return "user";
  if (normalized === "assistant") return "assistant";
  if (normalized === "system") return "system";
  if (normalized === "tool" || normalized.startsWith("tool ")) return "tool";
  return "other";
}

function displayLabel(role: AmpMessageRole, label: string): string {
  if (role === "user") return "You";
  if (role === "assistant") return "Amp";
  if (role === "system") return "System";
  if (role === "tool") return "Tool";
  return label.trim() || "Thread";
}

function stripFrontMatter(markdown: string): string {
  return markdown.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/u, "");
}

/** Extract Amp's `## User` / `## Assistant` sections from its Markdown export. */
export function parseAmpTranscript(markdown: string): AmpTranscriptDocument {
  const lines = stripFrontMatter(markdown.replace(/\r\n/gu, "\n")).split("\n");
  let title: string | undefined;
  let current: { readonly role: AmpMessageRole; readonly label: string; readonly lines: string[] } | undefined;
  const messages: AmpTranscriptMessage[] = [];
  const preamble: string[] = [];

  const flush = () => {
    if (!current) return;
    const body = current.lines.join("\n").trim().replace(/^(?:YOU|AMP|ASSISTANT|SYSTEM|TOOL)\s*(?:\n|$)/iu, "").trim();
    if (body) {
      const firstLine = body.split("\n").find((line) => line.trim())?.trim() ?? "";
      const toolResult = current.role === "user" && /^\*\*Tool Result:\*\*/iu.test(firstLine);
      const toolUse = current.role === "assistant" && /^\*\*Tool Use:\*\*/iu.test(firstLine);
      const role = toolResult || toolUse ? "tool" : current.role;
      const label = toolResult ? "Tool result" : toolUse ? "Tool use" : displayLabel(role, current.label);
      messages.push({ role, label, body });
    }
    current = undefined;
  };

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (heading?.[1] === "#" && !title) {
      title = heading[2];
      continue;
    }
    if (heading?.[1] === "##") {
      flush();
      const label = heading[2]!;
      const role = roleFor(label);
      current = { role, label, lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
    else preamble.push(line);
  }
  flush();

  const intro = preamble.join("\n").trim();
  if (intro) messages.unshift({ role: "system", label: "Context", body: intro });
  if (messages.length === 0) {
    const body = lines.join("\n").trim();
    if (body) messages.push({ role: "other", label: "Output", body });
  }

  return { ...(title ? { title } : {}), messages };
}

function isRule(line: string): boolean {
  return /^\s*(?:\*\s*){3,}$|^\s*(?:-\s*){3,}$|^\s*(?:_\s*){3,}$/u.test(line);
}

function parseBlocks(markdown: string): readonly MarkdownBlock[] {
  const lines = markdown.split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = /^\s*```\s*([^\s]*)\s*$/u.exec(line);
    if (fence) {
      const language = fence[1] || undefined;
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/u.test(lines[index]!)) {
        code.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", text: code.join("\n"), ...(language ? { language } : {}) });
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2] });
      index += 1;
      continue;
    }

    if (isRule(line)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    const listItem = /^\s*([-+*]|\d+[.)])\s+(.+)$/u.exec(line);
    if (listItem) {
      const ordered = /^\d/u.test(listItem[1]!);
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^\s*([-+*]|\d+[.)])\s+(.+)$/u.exec(lines[index]!);
        if (!item || /^\d/u.test(item[1]!) !== ordered) break;
        items.push(item[2]!);
        index += 1;
      }
      blocks.push({ kind: "list", items, ordered });
      continue;
    }

    if (/^\s*>\s?/u.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/u.test(lines[index]!)) {
        quote.push(lines[index]!.replace(/^\s*>\s?/u, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", text: quote.join("\n") });
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index]!.trim()) {
      const next = lines[index]!;
      if (/^\s*```|^(?:#{1,6})\s+|^\s*([-+*]|\d+[.)])\s+|^\s*>\s?|^\s*\|/u.test(next) || isRule(next)) break;
      paragraph.push(next);
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
  }

  return blocks;
}

function inlineMarkdown(value: string, keyPrefix: string): ReactNode[] {
  const pattern = /(`[^`]+`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*]+)\*|_([^_]+)_)/gu;
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(value))) {
    if (match.index > last) nodes.push(value.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("`")) nodes.push(<code key={`${keyPrefix}-code-${key}`}>{token.slice(1, -1)}</code>);
    else if (match[2] && match[3]) {
      nodes.push(<a key={`${keyPrefix}-link-${key}`} href={match[3]} target="_blank" rel="noreferrer">{match[2]}</a>);
    } else if (match[4] || match[5]) nodes.push(<strong key={`${keyPrefix}-strong-${key}`}>{match[4] ?? match[5]}</strong>);
    else if (match[6]) nodes.push(<del key={`${keyPrefix}-del-${key}`}>{match[6]}</del>);
    else nodes.push(<em key={`${keyPrefix}-em-${key}`}>{match[7] ?? match[8]}</em>);
    last = match.index + token.length;
    key += 1;
  }
  if (last < value.length) nodes.push(value.slice(last));
  return nodes;
}

function MarkdownBlockView({ block, index }: { readonly block: MarkdownBlock; readonly index: number }) {
  const key = `block-${index}`;
  if (block.kind === "code") {
    return <pre className="amp-code-block"><code>{block.text}</code></pre>;
  }
  if (block.kind === "heading") {
    const Heading = block.level === 1 ? "h3" : block.level === 2 ? "h4" : "h5";
    return <Heading>{inlineMarkdown(block.text ?? "", key)}</Heading>;
  }
  if (block.kind === "rule") return <hr />;
  if (block.kind === "quote") return <blockquote>{inlineMarkdown(block.text ?? "", key)}</blockquote>;
  if (block.kind === "list") {
    const List = block.ordered ? "ol" : "ul";
    return <List>{block.items?.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{inlineMarkdown(item, `${key}-${itemIndex}`)}</li>)}</List>;
  }
  return <p>{inlineMarkdown(block.text ?? "", key)}</p>;
}

function MessageMark({ role }: { readonly role: AmpMessageRole }) {
  return <span className="amp-message-mark">{role === "user" ? "You" : role === "assistant" ? "Amp" : role === "tool" ? "Tool" : "·"}</span>;
}

function MessageBody({ body }: { readonly body: string }) {
  return (
    <div className="amp-message-body">
      {parseBlocks(body).map((block, blockIndex) => <MarkdownBlockView block={block} index={blockIndex} key={blockIndex} />)}
    </div>
  );
}

function toolPreview(body: string): string | undefined {
  const marker = /^\*\*Tool (?:Use|Result):\*\*\s*(?:`([^`]+)`|([^\n]+))/imu.exec(body);
  const value = marker?.[1] ?? marker?.[2]?.trim();
  return value ? value.slice(0, 96) : undefined;
}

function MessageHeader({ message }: { readonly message: AmpTranscriptMessage }) {
  return <header><MessageMark role={message.role} /><strong>{message.label}</strong></header>;
}

export function AmpTranscript({ markdown }: { readonly markdown: string }) {
  const document = parseAmpTranscript(markdown);
  return (
    <div className="amp-transcript">
      {document.title ? <div className="amp-transcript-title"><span>THREAD</span><strong>{document.title}</strong></div> : null}
      <div className="amp-message-list">
        {document.messages.map((message, messageIndex) => (
          message.role === "tool" ? (
            <details className="amp-message amp-message-tool" key={`${message.role}-${messageIndex}`}>
              <summary>
                <span className="amp-message-chevron" aria-hidden="true">›</span>
                <MessageMark role={message.role} />
                <strong>{message.label}</strong>
                {toolPreview(message.body) ? <code className="amp-tool-preview">{toolPreview(message.body)}</code> : null}
              </summary>
              <MessageBody body={message.body} />
            </details>
          ) : (
            <article className={`amp-message amp-message-${message.role}`} key={`${message.role}-${messageIndex}`}>
              <MessageHeader message={message} />
              <MessageBody body={message.body} />
            </article>
          )
        ))}
      </div>
    </div>
  );
}
