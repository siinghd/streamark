/**
 * Streamark HTML Renderer
 * Converts tokens to HTML string efficiently
 */

import { Token, TokenType } from './types';
import { escapeHtml, sanitizeHtml } from './utils';

export interface RenderOptions {
  sanitize?: boolean;
  highlight?: (code: string, lang: string) => string;
  linkTarget?: string;
  className?: string;
}

const DEFAULT_OPTIONS: RenderOptions = {
  sanitize: true,
  linkTarget: '_blank',
};

/**
 * Render tokens to HTML string
 */
export function renderToHtml(tokens: Token[], options: RenderOptions = {}): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const parts: string[] = [];

  for (const token of tokens) {
    parts.push(renderToken(token, opts));
  }

  return parts.join('');
}

/**
 * Render a single token to HTML
 */
export function renderToken(token: Token, options: RenderOptions = {}): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  switch (token.type) {
    case TokenType.Paragraph:
      return `<p>${renderChildren(token, opts)}</p>\n`;

    case TokenType.Heading:
      const level = token.depth || 1;
      return `<h${level}>${renderChildren(token, opts)}</h${level}>\n`;

    case TokenType.CodeBlock:
      const lang = token.lang ? ` class="language-${escapeHtml(token.lang)}"` : '';
      const code = token.raw;
      const highlighted = opts.highlight && token.lang
        ? opts.highlight(code, token.lang)
        : escapeHtml(code);
      return `<pre><code${lang}>${highlighted}</code></pre>\n`;

    case TokenType.Blockquote:
      return `<blockquote>${renderChildren(token, opts)}</blockquote>\n`;

    case TokenType.List:
      const listTag = token.ordered ? 'ol' : 'ul';
      const startAttr = token.ordered && token.listStart !== 1
        ? ` start="${token.listStart}"`
        : '';
      return `<${listTag}${startAttr}>\n${renderChildren(token, opts)}</${listTag}>\n`;

    case TokenType.ListItem:
      if (token.checked !== undefined) {
        const checked = token.checked ? ' checked' : '';
        return `<li><input type="checkbox"${checked} disabled> ${renderChildren(token, opts)}</li>\n`;
      }
      return `<li>${renderChildren(token, opts)}</li>\n`;

    case TokenType.HorizontalRule:
      return '<hr>\n';

    case TokenType.Table:
      return `<table>\n${renderChildren(token, opts)}</table>\n`;

    case TokenType.TableRow:
      return `<tr>${renderChildren(token, opts)}</tr>\n`;

    case TokenType.TableCell:
      const cellTag = token.header ? 'th' : 'td';
      return `<${cellTag}>${renderChildren(token, opts)}</${cellTag}>`;

    case TokenType.Text:
      return opts.sanitize ? escapeHtml(token.raw) : token.raw;

    case TokenType.Bold:
      return `<strong>${renderChildren(token, opts)}</strong>`;

    case TokenType.Italic:
      return `<em>${renderChildren(token, opts)}</em>`;

    case TokenType.Strikethrough:
      return `<del>${renderChildren(token, opts)}</del>`;

    case TokenType.Code:
      return `<code>${renderChildren(token, opts)}</code>`;

    case TokenType.Link:
      const href = opts.sanitize ? escapeHtml(token.href || '') : token.href || '';
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      const target = opts.linkTarget ? ` target="${opts.linkTarget}" rel="noopener noreferrer"` : '';
      return `<a href="${href}"${title}${target}>${renderChildren(token, opts)}</a>`;

    case TokenType.Image:
      const imgSrc = opts.sanitize ? escapeHtml(token.href || '') : token.href || '';
      const alt = escapeHtml(token.alt || '');
      const imgTitle = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      return `<img src="${imgSrc}" alt="${alt}"${imgTitle}>`;

    case TokenType.LineBreak:
      return '<br>\n';

    case TokenType.Html:
      return opts.sanitize ? sanitizeHtml(token.raw) : token.raw;

    case TokenType.Pending:
      // Render pending content as plain text
      return escapeHtml(token.raw);

    default:
      return '';
  }
}

function renderChildren(token: Token, options: RenderOptions): string {
  if (!token.children || token.children.length === 0) {
    return '';
  }
  return token.children.map(child => renderToken(child, options)).join('');
}

/**
 * Incremental renderer - only renders new/changed tokens
 */
export class IncrementalRenderer {
  private rendered: Map<number, string> = new Map();
  private options: RenderOptions;

  constructor(options: RenderOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Render tokens, reusing cached results for unchanged tokens
   */
  render(tokens: Token[]): string {
    const parts: string[] = [];

    for (const token of tokens) {
      let html = this.rendered.get(token.id);

      if (!html) {
        html = renderToken(token, this.options);
        this.rendered.set(token.id, html);
      }

      parts.push(html);
    }

    return parts.join('');
  }

  /**
   * Update a specific token's rendered output
   */
  update(token: Token): string {
    const html = renderToken(token, this.options);
    this.rendered.set(token.id, html);
    return html;
  }

  /**
   * Clear the render cache
   */
  clear(): void {
    this.rendered.clear();
  }

  /**
   * Get cache statistics
   */
  getStats(): { cached: number; totalSize: number } {
    let totalSize = 0;
    for (const html of this.rendered.values()) {
      totalSize += html.length;
    }
    return { cached: this.rendered.size, totalSize };
  }
}
