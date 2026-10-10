import { Fragment, memo, type ReactNode } from 'react';

/**
 * A small Markdown renderer for agents' messages. It builds React elements and never
 * inserts HTML, so text an agent wrote cannot run in the page that holds alpd's token.
 * Covers what agents write: headings, paragraphs, lists, quotes, fenced code, tables,
 * rules, and inline code, bold, italic, strike and http links.
 */

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; text: string }
  | { type: 'list'; ordered: boolean; start: number; items: string[] }
  | { type: 'table'; head: string[]; rows: string[][] }
  | { type: 'rule' };

const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());

export function blocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      index++;
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) body.push(lines[index++]);
      index++;
      out.push({ type: 'code', lang: fence[2], text: body.join('\n') });
      continue;
    }
    if (!line.trim()) { index++; continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { out.push({ type: 'heading', level: heading[1].length, text: heading[2] }); index++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push({ type: 'rule' }); index++; continue; }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) body.push(lines[index++].replace(/^\s*>\s?/, ''));
      out.push({ type: 'quote', text: body.join('\n') });
      continue;
    }
    if (line.includes('|') && index + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[index + 1])) {
      const head = cells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(cells(lines[index++]));
      out.push({ type: 'table', head, rows });
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]);
      const items: string[] = [];
      while (index < lines.length) {
        const next = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index]);
        if (next && next[1].length <= item[1].length) { items.push(next[3]); index++; continue; }
        // Indented lines continue the item, nested lists included.
        if (lines[index].trim() && /^\s+/.test(lines[index]) && items.length) { items[items.length - 1] += `\n${lines[index].trim()}`; index++; continue; }
        break;
      }
      out.push({ type: 'list', ordered, start: ordered ? parseInt(item[2], 10) : 1, items });
      continue;
    }
    const body: string[] = [];
    while (index < lines.length && lines[index].trim() && !/^(#{1,6}\s|\s*```|\s*~~~|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[index])) body.push(lines[index++]);
    if (!body.length) body.push(lines[index++]);
    out.push({ type: 'paragraph', text: body.join('\n') });
  }
  return out;
}

const INLINE = /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>)]+)/g;

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index! > last) out.push(text.slice(last, match.index));
    if (match[1]) out.push(<code key={key++}>{match[2]}</code>);
    else if (match[3] || match[4]) out.push(<strong key={key++}>{inline(match[3] ?? match[4])}</strong>);
    else if (match[5]) out.push(<del key={key++}>{inline(match[5])}</del>);
    else if (match[6] || match[7]) out.push(<em key={key++}>{inline(match[6] ?? match[7])}</em>);
    else if (match[8]) out.push(<a key={key++} href={match[9]} target="_blank" rel="noopener noreferrer">{inline(match[8])}</a>);
    else if (match[10]) out.push(<a key={key++} href={match[10]} target="_blank" rel="noopener noreferrer">{match[10]}</a>);
    last = match.index! + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  // Line breaks inside a paragraph are kept, as agents mean them.
  return out.flatMap((node, index): ReactNode[] => typeof node === 'string' ? node.split('\n').flatMap((part, at): ReactNode[] => at ? [<br key={`b${index}-${at}`} />, part] : [part]) : [node]);
}

function Heading({ level, children }: { level: number; children: ReactNode }) {
  const Tag = (`h${Math.min(level + 2, 6)}`) as 'h3';
  return <Tag>{children}</Tag>;
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="md">{blocks(text).map((block, index) => {
    switch (block.type) {
      case 'heading': return <Heading key={index} level={block.level}>{inline(block.text)}</Heading>;
      case 'paragraph': return <p key={index}>{inline(block.text)}</p>;
      case 'code': return <pre key={index} className="code" data-lang={block.lang || undefined}><code>{block.text}</code></pre>;
      case 'quote': return <blockquote key={index}><Markdown text={block.text} /></blockquote>;
      case 'rule': return <hr key={index} />;
      case 'list': {
        const items = block.items.map((item, at) => <li key={at}>{item.includes('\n') ? <Markdown text={item} /> : inline(item)}</li>);
        return block.ordered ? <ol key={index} start={block.start}>{items}</ol> : <ul key={index}>{items}</ul>;
      }
      case 'table': return (
        <div key={index} className="table-wrap"><table>
          <thead><tr>{block.head.map((cell, at) => <th key={at}>{inline(cell)}</th>)}</tr></thead>
          <tbody>{block.rows.map((row, at) => <tr key={at}>{row.map((cell, column) => <td key={column}>{inline(cell)}</td>)}</tr>)}</tbody>
        </table></div>
      );
    }
    return <Fragment key={index} />;
  })}</div>;
});
