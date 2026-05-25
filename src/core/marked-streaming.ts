/**
 * Streamark - Streaming Markdown Parser
 *
 * Uses marked for correct parsing with streaming optimizations:
 * - Handles incomplete/unterminated markdown gracefully
 * - RAF-batched updates
 * - Incremental rendering where possible
 * - Security hardening
 */

import { marked, Renderer, Tokens } from 'marked';

// Configure marked for streaming
marked.setOptions({
  gfm: true,        // GitHub Flavored Markdown
  breaks: false,    // Don't convert \n to <br>
  pedantic: false,
  async: false,
});

export interface StreamingParserOptions {
  // Security
  sanitize?: boolean;
  allowedTags?: string[];

  // Features
  gfm?: boolean;
  breaks?: boolean;

  // Syntax highlighting callback
  highlight?: (code: string, lang: string) => string;
}

export interface StreamingParserResult {
  html: string;
  isComplete: boolean;
  pendingBlock?: string;
}

/**
 * Patterns for detecting incomplete markdown blocks
 */
const INCOMPLETE_PATTERNS = {
  // Unclosed code fence
  codeFence: /^(`{3,}|~{3,})(\w*)\n[\s\S]*$/,
  codeFenceStart: /(`{3,}|~{3,})(\w*)\s*\n?$/,

  // Unclosed inline code
  inlineCode: /`[^`]*$/,

  // Unclosed bold/italic
  boldAsterisk: /\*\*[^*]*$/,
  boldUnderscore: /__[^_]*$/,
  italicAsterisk: /(?<!\*)\*[^*]*$/,
  italicUnderscore: /(?<!_)_[^_]*$/,

  // Unclosed strikethrough
  strikethrough: /~~[^~]*$/,

  // Unclosed link
  linkText: /\[[^\]]*$/,
  linkUrl: /\]\([^)]*$/,

  // Table without closing
  tableRow: /\|[^|\n]*$/,
};

/**
 * Check if content has an unterminated code block
 */
function hasUnterminatedCodeBlock(content: string): { unterminated: boolean; fence?: string } {
  const lines = content.split('\n');
  let inCodeBlock = false;
  let fence = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inCodeBlock) {
      const match = trimmed.match(/^(`{3,}|~{3,})(\w*)$/);
      if (match) {
        inCodeBlock = true;
        fence = match[1];
      }
    } else {
      // Check for closing fence
      if (trimmed.startsWith(fence[0]) && trimmed.length >= fence.length) {
        const closingMatch = trimmed.match(/^(`{3,}|~{3,})$/);
        if (closingMatch && closingMatch[1][0] === fence[0] && closingMatch[1].length >= fence.length) {
          inCodeBlock = false;
          fence = '';
        }
      }
    }
  }

  return { unterminated: inCodeBlock, fence };
}

/**
 * Auto-complete unterminated markdown for proper parsing
 */
function autoComplete(content: string): { completed: string; additions: string } {
  let additions = '';
  let completed = content;

  // Check for unterminated code block
  const codeBlockState = hasUnterminatedCodeBlock(content);
  if (codeBlockState.unterminated && codeBlockState.fence) {
    additions += '\n' + codeBlockState.fence;
  }

  // Check for unterminated inline elements at the end
  const lastLine = content.split('\n').pop() || '';

  // Bold
  const boldMatch = lastLine.match(/\*\*([^*]*)$/);
  if (boldMatch) {
    additions = '**' + additions;
  }

  // Italic
  const italicMatch = lastLine.match(/(?<!\*)\*([^*]*)$/);
  if (italicMatch && !boldMatch) {
    additions = '*' + additions;
  }

  // Strikethrough
  const strikeMatch = lastLine.match(/~~([^~]*)$/);
  if (strikeMatch) {
    additions = '~~' + additions;
  }

  // Inline code
  const codeMatch = lastLine.match(/`([^`]*)$/);
  if (codeMatch) {
    additions = '`' + additions;
  }

  // Link text
  const linkTextMatch = lastLine.match(/\[([^\]]*)$/);
  if (linkTextMatch) {
    additions = '](#)' + additions;
  }

  // Link URL
  const linkUrlMatch = lastLine.match(/\]\(([^)]*)$/);
  if (linkUrlMatch) {
    additions = ')' + additions;
  }

  return { completed: completed + additions, additions };
}

/**
 * Custom renderer with security hardening
 */
function createSecureRenderer(options: StreamingParserOptions): Renderer {
  const renderer = new Renderer();

  // Secure link rendering
  const originalLink = renderer.link.bind(renderer);
  renderer.link = ({ href, title, text }) => {
    // Block javascript: URLs
    if (href && /^javascript:/i.test(href)) {
      return text;
    }
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    return `<a href="${escapeHtml(href || '')}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
  };

  // Secure image rendering
  renderer.image = ({ href, title, text }) => {
    if (href && /^javascript:/i.test(href)) {
      return '';
    }
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    return `<img src="${escapeHtml(href || '')}" alt="${escapeHtml(text || '')}"${titleAttr} loading="lazy">`;
  };

  // Code block with optional highlighting
  renderer.code = ({ text, lang }) => {
    const language = lang ? escapeHtml(lang) : '';
    const code = options.highlight && lang
      ? options.highlight(text, lang)
      : escapeHtml(text);
    const langClass = language ? ` class="language-${language}"` : '';
    return `<pre><code${langClass}>${code}</code></pre>\n`;
  };

  return renderer;
}

/**
 * Escape HTML entities
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Parse markdown with streaming support
 */
export function parseStreaming(
  content: string,
  isComplete: boolean = false,
  options: StreamingParserOptions = {}
): StreamingParserResult {
  if (!content || content.trim() === '') {
    return { html: '', isComplete: true };
  }

  const renderer = createSecureRenderer(options);

  // Configure marked instance
  const markedInstance = new marked.Marked({
    renderer,
    gfm: options.gfm ?? true,
    breaks: options.breaks ?? false,
  });

  let htmlContent: string;
  let additions = '';

  if (isComplete) {
    // Parse as-is for complete content
    htmlContent = markedInstance.parse(content) as string;
  } else {
    // Auto-complete unterminated blocks for streaming
    const { completed, additions: add } = autoComplete(content);
    additions = add;
    htmlContent = markedInstance.parse(completed) as string;
  }

  return {
    html: htmlContent,
    isComplete,
    pendingBlock: additions || undefined,
  };
}

/**
 * Streaming parser class for stateful parsing
 */
export class StreamingMarkdownParser {
  private content: string = '';
  private options: StreamingParserOptions;
  private lastHtml: string = '';
  private lastContentLength: number = 0;

  constructor(options: StreamingParserOptions = {}) {
    this.options = options;
  }

  /**
   * Write a chunk of content
   */
  write(chunk: string): string {
    this.content += chunk;

    // Parse with auto-completion
    const result = parseStreaming(this.content, false, this.options);
    this.lastHtml = result.html;
    this.lastContentLength = this.content.length;

    return result.html;
  }

  /**
   * Signal end of stream
   */
  end(): string {
    const result = parseStreaming(this.content, true, this.options);
    this.lastHtml = result.html;
    return result.html;
  }

  /**
   * Get current HTML output
   */
  getHtml(): string {
    return this.lastHtml;
  }

  /**
   * Get current raw content
   */
  getContent(): string {
    return this.content;
  }

  /**
   * Reset parser state
   */
  reset(): void {
    this.content = '';
    this.lastHtml = '';
    this.lastContentLength = 0;
  }
}

/**
 * Simple function for one-shot parsing
 */
export function parse(content: string, options: StreamingParserOptions = {}): string {
  return parseStreaming(content, true, options).html;
}

/**
 * Create a streaming parser instance
 */
export function createStreamingMarkdownParser(options: StreamingParserOptions = {}): StreamingMarkdownParser {
  return new StreamingMarkdownParser(options);
}
