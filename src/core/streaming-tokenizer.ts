/**
 * Streamark v2 - Character-Level Streaming Tokenizer
 *
 * Key improvements over v1:
 * 1. Character-by-character processing (not line-based)
 * 2. Speculative/optimistic rendering - show partial formatting
 * 3. Typed arrays for reduced GC pressure
 * 4. Append-only updates - never invalidate rendered content
 * 5. State machine design like thetarnav/streaming-markdown
 */

// Token types as const enum for performance
export const enum TokenType {
  Root = 0,
  Paragraph = 1,
  Text = 2,
  Bold = 3,
  Italic = 4,
  BoldItalic = 5,
  Code = 6,
  CodeBlock = 7,
  Heading1 = 8,
  Heading2 = 9,
  Heading3 = 10,
  Heading4 = 11,
  Heading5 = 12,
  Heading6 = 13,
  Blockquote = 14,
  Link = 15,
  Image = 16,
  ListItem = 17,
  HorizontalRule = 18,
  LineBreak = 19,
  Strikethrough = 20,
}

// Character codes for fast comparison
const CHAR = {
  NEWLINE: 10,      // \n
  SPACE: 32,        // ' '
  HASH: 35,         // #
  ASTERISK: 42,     // *
  PLUS: 43,         // +
  MINUS: 45,        // -
  DOT: 46,          // .
  SLASH: 47,        // /
  ZERO: 48,         // 0
  NINE: 57,         // 9
  COLON: 58,        // :
  LT: 60,           // <
  GT: 62,           // >
  QUESTION: 63,     // ?
  BACKSLASH: 92,    // \
  UNDERSCORE: 95,   // _
  BACKTICK: 96,     // `
  OPEN_BRACKET: 91, // [
  CLOSE_BRACKET: 93,// ]
  OPEN_PAREN: 40,   // (
  CLOSE_PAREN: 41,  // )
  BANG: 33,         // !
  TILDE: 126,       // ~
} as const;

// Parser state stored in typed arrays for memory efficiency
const MAX_DEPTH = 32;

export interface StreamingToken {
  type: TokenType;
  start: number;
  text: string;
  pending: boolean;  // Is this token speculatively rendered?
  attrs?: {
    href?: string;
    title?: string;
    alt?: string;
    lang?: string;
    level?: number;
  };
}

export interface Renderer {
  openToken(type: TokenType, attrs?: StreamingToken['attrs']): void;
  appendText(text: string): void;
  closeToken(type: TokenType): void;
  updatePending(type: TokenType, finalized: boolean): void;
}

export interface StreamingParser {
  write(chunk: string): void;
  end(): void;
  reset(): void;
  getTokens(): StreamingToken[];
}

export function createStreamingParser(renderer: Renderer): StreamingParser {
  // Token stack using typed array
  const tokenStack = new Uint8Array(MAX_DEPTH);
  let stackDepth = 0;

  // Parser state
  let pos = 0;
  let lineStart = true;
  let pending = '';
  let escaped = false;

  // Code block state
  let inCodeBlock = false;
  let codeBlockFence = '';
  let codeBlockLang = '';

  // Link parsing state
  let inLinkText = false;
  let linkText = '';
  let inLinkUrl = false;
  let linkUrl = '';

  // Collected tokens for React integration
  const tokens: StreamingToken[] = [];

  function pushToken(type: TokenType, attrs?: StreamingToken['attrs']): void {
    if (stackDepth < MAX_DEPTH) {
      tokenStack[stackDepth++] = type;
      renderer.openToken(type, attrs);
      tokens.push({
        type,
        start: pos,
        text: '',
        pending: true,
        attrs,
      });
    }
  }

  function popToken(): TokenType | null {
    if (stackDepth > 0) {
      const type = tokenStack[--stackDepth];
      renderer.closeToken(type);
      // Mark token as finalized
      const token = tokens.find(t => t.type === type && t.pending);
      if (token) {
        token.pending = false;
        renderer.updatePending(type, true);
      }
      return type;
    }
    return null;
  }

  function currentToken(): TokenType {
    return stackDepth > 0 ? tokenStack[stackDepth - 1] : TokenType.Root;
  }

  function hasToken(type: TokenType): boolean {
    for (let i = 0; i < stackDepth; i++) {
      if (tokenStack[i] === type) return true;
    }
    return false;
  }

  function closeTokensTo(type: TokenType): void {
    while (stackDepth > 0 && tokenStack[stackDepth - 1] !== type) {
      popToken();
    }
    if (stackDepth > 0) {
      popToken();
    }
  }

  function emitText(text: string): void {
    if (text.length > 0) {
      renderer.appendText(text);
      const lastToken = tokens[tokens.length - 1];
      if (lastToken) {
        lastToken.text += text;
      }
    }
  }

  function processChar(char: string, code: number): void {
    // Handle escape sequences
    if (escaped) {
      emitText(char);
      escaped = false;
      return;
    }

    if (code === CHAR.BACKSLASH) {
      escaped = true;
      return;
    }

    // Inside code block - pass through except for fence
    if (inCodeBlock) {
      if (lineStart && char === codeBlockFence[0]) {
        pending += char;
        if (pending.length >= codeBlockFence.length &&
            pending.startsWith(codeBlockFence)) {
          // End code block
          inCodeBlock = false;
          closeTokensTo(TokenType.CodeBlock);
          pending = '';
          lineStart = false;
          return;
        }
      } else {
        if (pending) {
          emitText(pending);
          pending = '';
        }
        emitText(char);
        lineStart = code === CHAR.NEWLINE;
      }
      return;
    }

    // Handle newlines
    if (code === CHAR.NEWLINE) {
      if (pending) {
        emitText(pending);
        pending = '';
      }
      // Close paragraph-level tokens but keep block tokens
      while (stackDepth > 0 && tokenStack[stackDepth - 1] === TokenType.Paragraph) {
        popToken();
      }
      emitText('\n');
      lineStart = true;
      return;
    }

    // Line start parsing
    if (lineStart) {
      lineStart = false;

      // Headers
      if (code === CHAR.HASH) {
        pending += char;
        return;
      }

      // Process pending hashes
      if (pending.length > 0 && pending[0] === '#') {
        if (code === CHAR.SPACE && pending.length <= 6) {
          const level = pending.length;
          const headingType = (TokenType.Heading1 + level - 1) as TokenType;
          pushToken(headingType, { level });
          pending = '';
          return;
        } else if (code !== CHAR.HASH) {
          // Not a heading, emit as text
          emitText(pending);
          pending = '';
        }
      }

      // Code fence
      if (code === CHAR.BACKTICK || code === CHAR.TILDE) {
        pending += char;
        return;
      }

      // Check for code fence completion
      if (pending.length >= 3 &&
          (pending[0] === '`' || pending[0] === '~') &&
          pending.split('').every(c => c === pending[0])) {
        if (code === CHAR.SPACE || code === CHAR.NEWLINE || /[a-zA-Z]/.test(char)) {
          codeBlockFence = pending;
          codeBlockLang = '';
          if (/[a-zA-Z]/.test(char)) {
            codeBlockLang = char;
            // Continue collecting language
            pending = '';
            inCodeBlock = true;
            pushToken(TokenType.CodeBlock, { lang: codeBlockLang });
            return;
          }
          pending = '';
          inCodeBlock = true;
          pushToken(TokenType.CodeBlock);
          return;
        }
      }

      // Blockquote
      if (code === CHAR.GT) {
        pushToken(TokenType.Blockquote);
        return;
      }

      // List items
      if (code === CHAR.MINUS || code === CHAR.ASTERISK || code === CHAR.PLUS) {
        pending += char;
        return;
      }

      // Check for list item
      if (pending.length === 1 &&
          (pending[0] === '-' || pending[0] === '*' || pending[0] === '+')) {
        if (code === CHAR.SPACE) {
          pushToken(TokenType.ListItem);
          pending = '';
          return;
        } else {
          emitText(pending);
          pending = '';
        }
      }

      // Horizontal rule check
      if (pending.length >= 3 &&
          pending.split('').every(c => c === '-' || c === '*' || c === '_')) {
        if (code === CHAR.SPACE || code === CHAR.NEWLINE) {
          pushToken(TokenType.HorizontalRule);
          popToken();
          pending = '';
          return;
        }
      }
    }

    // Emit any remaining pending chars
    if (pending && !/^[`~#\-*+_>]/.test(pending)) {
      emitText(pending);
      pending = '';
    }

    // Inline formatting

    // Bold/Italic with asterisk
    if (code === CHAR.ASTERISK) {
      pending += char;
      return;
    }

    // Process asterisk sequences
    if (pending.startsWith('*')) {
      if (pending === '**') {
        if (hasToken(TokenType.Bold)) {
          closeTokensTo(TokenType.Bold);
        } else {
          // Speculative bold - render immediately
          pushToken(TokenType.Bold);
        }
        pending = '';
        return;
      } else if (pending === '*' && code !== CHAR.ASTERISK) {
        if (hasToken(TokenType.Italic)) {
          closeTokensTo(TokenType.Italic);
        } else {
          pushToken(TokenType.Italic);
        }
        pending = '';
      } else if (pending === '***') {
        if (hasToken(TokenType.BoldItalic)) {
          closeTokensTo(TokenType.BoldItalic);
        } else {
          pushToken(TokenType.BoldItalic);
        }
        pending = '';
        return;
      }
    }

    // Strikethrough
    if (code === CHAR.TILDE) {
      pending += char;
      return;
    }

    if (pending === '~~') {
      if (hasToken(TokenType.Strikethrough)) {
        closeTokensTo(TokenType.Strikethrough);
      } else {
        pushToken(TokenType.Strikethrough);
      }
      pending = '';
      return;
    }

    // Inline code
    if (code === CHAR.BACKTICK) {
      if (hasToken(TokenType.Code)) {
        closeTokensTo(TokenType.Code);
      } else {
        pushToken(TokenType.Code);
      }
      return;
    }

    // Links: [text](url)
    if (code === CHAR.OPEN_BRACKET) {
      inLinkText = true;
      linkText = '';
      return;
    }

    if (inLinkText) {
      if (code === CHAR.CLOSE_BRACKET) {
        inLinkText = false;
        // Expect ( next
        pending = ']';
        return;
      }
      linkText += char;
      return;
    }

    if (pending === ']' && code === CHAR.OPEN_PAREN) {
      inLinkUrl = true;
      linkUrl = '';
      pending = '';
      return;
    } else if (pending === ']') {
      // Not a link, emit [text]
      emitText('[' + linkText + ']');
      pending = '';
    }

    if (inLinkUrl) {
      if (code === CHAR.CLOSE_PAREN) {
        inLinkUrl = false;
        pushToken(TokenType.Link, { href: linkUrl });
        emitText(linkText);
        popToken();
        linkText = '';
        linkUrl = '';
        return;
      }
      linkUrl += char;
      return;
    }

    // Images: ![alt](url)
    if (code === CHAR.BANG) {
      pending += char;
      return;
    }

    if (pending === '!' && code === CHAR.OPEN_BRACKET) {
      pending = '![';
      return;
    }

    // Emit remaining pending
    if (pending) {
      emitText(pending);
      pending = '';
    }

    // Regular text - ensure we're in a paragraph
    if (currentToken() === TokenType.Root) {
      pushToken(TokenType.Paragraph);
    }

    emitText(char);
  }

  function write(chunk: string): void {
    for (let i = 0; i < chunk.length; i++) {
      const char = chunk[i];
      const code = chunk.charCodeAt(i);
      processChar(char, code);
      pos++;
    }
  }

  function end(): void {
    // Emit any pending content
    if (pending) {
      emitText(pending);
      pending = '';
    }

    // Close all open tokens
    while (stackDepth > 0) {
      popToken();
    }
  }

  function reset(): void {
    stackDepth = 0;
    pos = 0;
    lineStart = true;
    pending = '';
    escaped = false;
    inCodeBlock = false;
    codeBlockFence = '';
    codeBlockLang = '';
    inLinkText = false;
    linkText = '';
    inLinkUrl = false;
    linkUrl = '';
    tokens.length = 0;
  }

  function getTokens(): StreamingToken[] {
    return tokens;
  }

  return { write, end, reset, getTokens };
}

/**
 * Direct DOM Renderer - Bypasses React for maximum performance
 * Appends directly to a container element
 */
export function createDOMRenderer(container: HTMLElement): Renderer {
  const elementStack: HTMLElement[] = [container];

  function currentElement(): HTMLElement {
    return elementStack[elementStack.length - 1];
  }

  const TAG_MAP: Record<TokenType, string> = {
    [TokenType.Root]: 'div',
    [TokenType.Paragraph]: 'p',
    [TokenType.Text]: 'span',
    [TokenType.Bold]: 'strong',
    [TokenType.Italic]: 'em',
    [TokenType.BoldItalic]: 'strong', // Will nest em inside
    [TokenType.Code]: 'code',
    [TokenType.CodeBlock]: 'pre',
    [TokenType.Heading1]: 'h1',
    [TokenType.Heading2]: 'h2',
    [TokenType.Heading3]: 'h3',
    [TokenType.Heading4]: 'h4',
    [TokenType.Heading5]: 'h5',
    [TokenType.Heading6]: 'h6',
    [TokenType.Blockquote]: 'blockquote',
    [TokenType.Link]: 'a',
    [TokenType.Image]: 'img',
    [TokenType.ListItem]: 'li',
    [TokenType.HorizontalRule]: 'hr',
    [TokenType.LineBreak]: 'br',
    [TokenType.Strikethrough]: 'del',
  };

  return {
    openToken(type: TokenType, attrs?: StreamingToken['attrs']): void {
      const tag = TAG_MAP[type] || 'span';
      const el = document.createElement(tag);

      if (type === TokenType.Link && attrs?.href) {
        (el as HTMLAnchorElement).href = attrs.href;
        (el as HTMLAnchorElement).target = '_blank';
        (el as HTMLAnchorElement).rel = 'noopener noreferrer';
      }

      if (type === TokenType.Image && attrs?.href) {
        (el as HTMLImageElement).src = attrs.href;
        if (attrs.alt) (el as HTMLImageElement).alt = attrs.alt;
      }

      if (type === TokenType.CodeBlock && attrs?.lang) {
        el.className = `language-${attrs.lang}`;
      }

      // Mark as pending with CSS class
      el.classList.add('streaming-pending');

      currentElement().appendChild(el);
      elementStack.push(el);
    },

    appendText(text: string): void {
      const textNode = document.createTextNode(text);
      currentElement().appendChild(textNode);
    },

    closeToken(_type: TokenType): void {
      if (elementStack.length > 1) {
        const el = elementStack.pop()!;
        el.classList.remove('streaming-pending');
      }
    },

    updatePending(_type: TokenType, finalized: boolean): void {
      const el = currentElement();
      if (finalized) {
        el.classList.remove('streaming-pending');
      }
    },
  };
}

/**
 * React-compatible token collector renderer
 */
export function createTokenCollector(): Renderer & { getHTML(): string } {
  let html = '';
  const stack: TokenType[] = [];

  const TAG_MAP: Record<TokenType, [string, string]> = {
    [TokenType.Root]: ['', ''],
    [TokenType.Paragraph]: ['<p>', '</p>'],
    [TokenType.Text]: ['', ''],
    [TokenType.Bold]: ['<strong>', '</strong>'],
    [TokenType.Italic]: ['<em>', '</em>'],
    [TokenType.BoldItalic]: ['<strong><em>', '</em></strong>'],
    [TokenType.Code]: ['<code>', '</code>'],
    [TokenType.CodeBlock]: ['<pre><code>', '</code></pre>'],
    [TokenType.Heading1]: ['<h1>', '</h1>'],
    [TokenType.Heading2]: ['<h2>', '</h2>'],
    [TokenType.Heading3]: ['<h3>', '</h3>'],
    [TokenType.Heading4]: ['<h4>', '</h4>'],
    [TokenType.Heading5]: ['<h5>', '</h5>'],
    [TokenType.Heading6]: ['<h6>', '</h6>'],
    [TokenType.Blockquote]: ['<blockquote>', '</blockquote>'],
    [TokenType.Link]: ['<a>', '</a>'],
    [TokenType.Image]: ['<img', '>'],
    [TokenType.ListItem]: ['<li>', '</li>'],
    [TokenType.HorizontalRule]: ['<hr>', ''],
    [TokenType.LineBreak]: ['<br>', ''],
    [TokenType.Strikethrough]: ['<del>', '</del>'],
  };

  function escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return {
    openToken(type: TokenType, attrs?: StreamingToken['attrs']): void {
      stack.push(type);
      let tag = TAG_MAP[type]?.[0] || '';

      if (type === TokenType.Link && attrs?.href) {
        tag = `<a href="${escapeHtml(attrs.href)}" target="_blank" rel="noopener noreferrer">`;
      }
      if (type === TokenType.Image && attrs?.href) {
        tag = `<img src="${escapeHtml(attrs.href)}" alt="${escapeHtml(attrs.alt || '')}"`;
      }
      if (type === TokenType.CodeBlock && attrs?.lang) {
        tag = `<pre><code class="language-${escapeHtml(attrs.lang)}">`;
      }

      html += tag;
    },

    appendText(text: string): void {
      html += escapeHtml(text);
    },

    closeToken(type: TokenType): void {
      stack.pop();
      html += TAG_MAP[type]?.[1] || '';
    },

    updatePending(): void {
      // No-op for HTML collector
    },

    getHTML(): string {
      return html;
    },
  };
}
