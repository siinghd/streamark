/**
 * Streamark Incremental Tokenizer
 *
 * Key optimizations:
 * 1. Only processes new content (no re-parsing)
 * 2. Maintains state across chunks for continuation
 * 3. Uses content-addressed IDs for React reconciliation
 * 4. Handles incomplete syntax gracefully
 */

import { Token, TokenType, ParseState, StreamarkOptions, StreamarkInstance } from './types';
import { hashString } from './utils';

const DEFAULT_OPTIONS: StreamarkOptions = {
  sanitize: true,
  gfm: true,
  breaks: false,
  batchUpdates: true,
  batchDelayMs: 16,
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
};

// Regex patterns - compiled once
const PATTERNS = {
  // Block patterns
  heading: /^(#{1,6})\s+(.*)$/,
  codeBlockStart: /^(`{3,}|~{3,})(\w*)\s*$/,
  codeBlockEnd: /^(`{3,}|~{3,})\s*$/,
  hr: /^(?:[-*_]\s*){3,}$/,
  blockquote: /^>\s?(.*)/,
  ulItem: /^([ \t]*)([-*+])\s+(.*)/,
  olItem: /^([ \t]*)(\d+)[.)]\s+(.*)/,
  checkbox: /^\[([ xX])\]\s+(.*)/,

  // Inline patterns
  bold: /\*\*([^*]+)\*\*|__([^_]+)__/g,
  italic: /(?<!\*)\*([^*]+)\*(?!\*)|(?<!_)_([^_]+)_(?!_)/g,
  strikethrough: /~~([^~]+)~~/g,
  code: /`([^`]+)`/g,
  link: /\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
  image: /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,

  // Incomplete patterns for speculative parsing
  incompleteCodeBlock: /^(`{1,2}|~{1,2})$/,
  incompleteBold: /\*\*[^*]*$|__[^_]*$/,
  incompleteItalic: /(?<!\*)\*[^*]*$|(?<!_)_[^_]*$/,
  incompleteLink: /\[[^\]]*$|\]\([^)]*$/,
};

export function createTokenizer(options: StreamarkOptions = {}): StreamarkInstance {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Parser state
  let state: ParseState = createInitialState();
  let tokens: Token[] = [];
  let buffer = '';

  function createInitialState(): ParseState {
    return {
      inCodeBlock: false,
      codeBlockLang: '',
      codeBlockFence: '',
      inBlockquote: false,
      blockquoteDepth: 0,
      inList: false,
      listDepth: 0,
      listOrdered: false,
      pendingText: '',
      pendingTokenType: null,
      position: 0,
      line: 1,
      column: 0,
      nextId: 1,
    };
  }

  function createToken(type: TokenType, raw: string, extra: Partial<Token> = {}): Token {
    const id = hashString(`${type}:${state.position}:${raw}`);
    return {
      type,
      id,
      start: state.position,
      end: state.position + raw.length,
      raw,
      ...extra,
    };
  }

  function parseInline(text: string): Token[] {
    const inlineTokens: Token[] = [];
    let remaining = text;
    let pos = 0;

    while (remaining.length > 0) {
      let matched = false;

      // Try image first (before link, since image starts with !)
      const imageMatch = remaining.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/);
      if (imageMatch) {
        const href = sanitizeUrl(imageMatch[2], opts.allowedSchemes!);
        inlineTokens.push(createToken(TokenType.Image, imageMatch[0], {
          alt: imageMatch[1],
          href,
          title: imageMatch[3],
        }));
        remaining = remaining.slice(imageMatch[0].length);
        pos += imageMatch[0].length;
        matched = true;
        continue;
      }

      // Try link
      const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/);
      if (linkMatch) {
        const href = sanitizeUrl(linkMatch[2], opts.allowedSchemes!);
        inlineTokens.push(createToken(TokenType.Link, linkMatch[0], {
          href,
          title: linkMatch[3],
          children: [createToken(TokenType.Text, linkMatch[1])],
        }));
        remaining = remaining.slice(linkMatch[0].length);
        pos += linkMatch[0].length;
        matched = true;
        continue;
      }

      // Try bold
      const boldMatch = remaining.match(/^\*\*([^*]+)\*\*|^__([^_]+)__/);
      if (boldMatch) {
        const content = boldMatch[1] || boldMatch[2];
        inlineTokens.push(createToken(TokenType.Bold, boldMatch[0], {
          children: parseInline(content),
        }));
        remaining = remaining.slice(boldMatch[0].length);
        pos += boldMatch[0].length;
        matched = true;
        continue;
      }

      // Try strikethrough (before italic to avoid conflicts)
      const strikeMatch = remaining.match(/^~~([^~]+)~~/);
      if (strikeMatch) {
        inlineTokens.push(createToken(TokenType.Strikethrough, strikeMatch[0], {
          children: parseInline(strikeMatch[1]),
        }));
        remaining = remaining.slice(strikeMatch[0].length);
        pos += strikeMatch[0].length;
        matched = true;
        continue;
      }

      // Try italic
      const italicMatch = remaining.match(/^\*([^*]+)\*|^_([^_]+)_/);
      if (italicMatch && !remaining.startsWith('**') && !remaining.startsWith('__')) {
        const content = italicMatch[1] || italicMatch[2];
        inlineTokens.push(createToken(TokenType.Italic, italicMatch[0], {
          children: parseInline(content),
        }));
        remaining = remaining.slice(italicMatch[0].length);
        pos += italicMatch[0].length;
        matched = true;
        continue;
      }

      // Try inline code
      const codeMatch = remaining.match(/^`([^`]+)`/);
      if (codeMatch) {
        inlineTokens.push(createToken(TokenType.Code, codeMatch[0], {
          children: [createToken(TokenType.Text, codeMatch[1])],
        }));
        remaining = remaining.slice(codeMatch[0].length);
        pos += codeMatch[0].length;
        matched = true;
        continue;
      }

      // No match - consume character as text
      if (!matched) {
        // Collect consecutive plain text
        let textEnd = 1;
        while (textEnd < remaining.length) {
          const char = remaining[textEnd];
          if (char === '*' || char === '_' || char === '`' || char === '[' || char === '!' || char === '~') {
            break;
          }
          textEnd++;
        }
        const textContent = remaining.slice(0, textEnd);
        inlineTokens.push(createToken(TokenType.Text, textContent));
        remaining = remaining.slice(textEnd);
        pos += textEnd;
      }
    }

    return inlineTokens;
  }

  function parseLine(line: string): Token | null {
    // Code block handling
    if (state.inCodeBlock) {
      const endMatch = line.match(PATTERNS.codeBlockEnd);
      if (endMatch && endMatch[1].startsWith(state.codeBlockFence[0]) && endMatch[1].length >= state.codeBlockFence.length) {
        state.inCodeBlock = false;
        state.codeBlockFence = '';
        state.codeBlockLang = '';
        // Close the code block - don't emit token, the block is already emitted
        return null;
      }
      // Continue code block - append to last code block token
      const lastToken = tokens[tokens.length - 1];
      if (lastToken && lastToken.type === TokenType.CodeBlock) {
        lastToken.raw += line + '\n';
        lastToken.end = state.position + line.length + 1;
        // Re-hash for updated content
        lastToken.id = hashString(`${lastToken.type}:${lastToken.start}:${lastToken.raw}`);
      }
      return null;
    }

    // Check for code block start
    const codeBlockMatch = line.match(PATTERNS.codeBlockStart);
    if (codeBlockMatch) {
      state.inCodeBlock = true;
      state.codeBlockFence = codeBlockMatch[1];
      state.codeBlockLang = codeBlockMatch[2] || '';
      return createToken(TokenType.CodeBlock, '', {
        lang: state.codeBlockLang,
      });
    }

    // Horizontal rule
    if (PATTERNS.hr.test(line.trim())) {
      return createToken(TokenType.HorizontalRule, line);
    }

    // Heading
    const headingMatch = line.match(PATTERNS.heading);
    if (headingMatch) {
      const depth = headingMatch[1].length;
      const content = headingMatch[2];
      return createToken(TokenType.Heading, line, {
        depth,
        children: parseInline(content),
      });
    }

    // Blockquote
    const blockquoteMatch = line.match(PATTERNS.blockquote);
    if (blockquoteMatch) {
      return createToken(TokenType.Blockquote, line, {
        children: parseInline(blockquoteMatch[1]),
      });
    }

    // Unordered list item
    const ulMatch = line.match(PATTERNS.ulItem);
    if (ulMatch) {
      const content = ulMatch[3];
      const checkboxMatch = content.match(PATTERNS.checkbox);
      if (checkboxMatch) {
        return createToken(TokenType.ListItem, line, {
          ordered: false,
          checked: checkboxMatch[1].toLowerCase() === 'x',
          children: parseInline(checkboxMatch[2]),
        });
      }
      return createToken(TokenType.ListItem, line, {
        ordered: false,
        children: parseInline(content),
      });
    }

    // Ordered list item
    const olMatch = line.match(PATTERNS.olItem);
    if (olMatch) {
      return createToken(TokenType.ListItem, line, {
        ordered: true,
        listStart: parseInt(olMatch[2], 10),
        children: parseInline(olMatch[3]),
      });
    }

    // Empty line
    if (line.trim() === '') {
      return null;
    }

    // Default: paragraph
    return createToken(TokenType.Paragraph, line, {
      children: parseInline(line),
    });
  }

  function write(chunk: string): Token[] {
    const newTokens: Token[] = [];
    buffer += chunk;

    // Split into lines, keeping partial line in buffer
    const lines = buffer.split('\n');

    // If buffer doesn't end with newline, last element is partial
    const hasPartial = !buffer.endsWith('\n') && !state.inCodeBlock;
    const completeLines = hasPartial ? lines.slice(0, -1) : lines;
    buffer = hasPartial ? lines[lines.length - 1] : '';

    // Handle incomplete markdown syntax at end
    if (hasPartial && lines.length === 1) {
      // Check if we have potentially incomplete syntax
      const partial = lines[0];
      if (PATTERNS.incompleteCodeBlock.test(partial) ||
          PATTERNS.incompleteBold.test(partial) ||
          PATTERNS.incompleteLink.test(partial)) {
        // Keep in buffer, wait for more data
        return newTokens;
      }
    }

    // Process complete lines
    for (const line of completeLines) {
      const token = parseLine(line);
      if (token) {
        tokens.push(token);
        newTokens.push(token);
        opts.onToken?.(token);
      }
      state.position += line.length + 1; // +1 for newline
      state.line++;
    }

    return newTokens;
  }

  function end(): Token[] {
    const finalTokens: Token[] = [];

    // Process any remaining buffer
    if (buffer.length > 0) {
      const token = parseLine(buffer);
      if (token) {
        tokens.push(token);
        finalTokens.push(token);
        opts.onToken?.(token);
      }
      buffer = '';
    }

    // Close any open code blocks
    if (state.inCodeBlock) {
      state.inCodeBlock = false;
      state.codeBlockFence = '';
      state.codeBlockLang = '';
    }

    opts.onComplete?.(tokens);
    return finalTokens;
  }

  function getTokens(): Token[] {
    return tokens;
  }

  function reset(): void {
    state = createInitialState();
    tokens = [];
    buffer = '';
  }

  function getState(): ParseState {
    return { ...state };
  }

  return {
    write,
    end,
    getTokens,
    reset,
    getState,
  };
}

// URL sanitization for security
function sanitizeUrl(url: string, allowedSchemes: string[]): string {
  try {
    const parsed = new URL(url, 'https://example.com');
    const scheme = parsed.protocol.replace(':', '');
    if (allowedSchemes.includes(scheme)) {
      return url;
    }
    return '';
  } catch {
    // Relative URL - allow it
    if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../') || url.startsWith('#')) {
      return url;
    }
    return '';
  }
}
