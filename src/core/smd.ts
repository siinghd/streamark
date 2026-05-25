/**
 * Streamark Markdown Parser (SMD)
 *
 * A high-performance streaming markdown parser optimized for LLM output.
 *
 * Key features:
 * - Character-by-character state machine (truly incremental)
 * - Speculative rendering (shows formatting before closing markers)
 * - Auto-completion for incomplete markdown
 * - Typed arrays for memory efficiency
 * - GFM support (tables, strikethrough, task lists)
 * - Zero dependencies
 *
 * Architecture:
 * 1. Character processor - handles escape sequences, tracks position
 * 2. Block parser - headings, code blocks, lists, tables, blockquotes
 * 3. Inline parser - bold, italic, strikethrough, code, links, images
 * 4. Renderer abstraction - DOM, HTML string, or React tokens
 */

// =============================================================================
// Token Types
// =============================================================================

export const enum Token {
  // Document root
  DOCUMENT = 0,

  // Block elements
  PARAGRAPH = 1,
  HEADING_1 = 2,
  HEADING_2 = 3,
  HEADING_3 = 4,
  HEADING_4 = 5,
  HEADING_5 = 6,
  HEADING_6 = 7,
  CODE_BLOCK = 8,
  BLOCKQUOTE = 9,
  LIST_UL = 10,
  LIST_OL = 11,
  LIST_ITEM = 12,
  TABLE = 13,
  TABLE_HEAD = 14,
  TABLE_BODY = 15,
  TABLE_ROW = 16,
  TABLE_CELL_H = 17,
  TABLE_CELL_D = 18,
  HR = 19,

  // Inline elements
  TEXT = 20,
  BOLD = 21,
  ITALIC = 22,
  BOLD_ITALIC = 23,
  STRIKE = 24,
  CODE = 25,
  LINK = 26,
  IMAGE = 27,
  BR = 28,
  CHECKBOX = 29,
}

// =============================================================================
// Character Codes (for fast comparison)
// =============================================================================

const CH = {
  NUL: 0,
  TAB: 9,
  LF: 10,      // \n
  CR: 13,      // \r
  SPACE: 32,
  BANG: 33,    // !
  QUOTE: 34,   // "
  HASH: 35,    // #
  DOLLAR: 36,  // $
  PERCENT: 37, // %
  AMP: 38,     // &
  APOS: 39,    // '
  LPAREN: 40,  // (
  RPAREN: 41,  // )
  STAR: 42,    // *
  PLUS: 43,    // +
  COMMA: 44,   // ,
  MINUS: 45,   // -
  DOT: 46,     // .
  SLASH: 47,   // /
  ZERO: 48,    // 0
  NINE: 57,    // 9
  COLON: 58,   // :
  SEMI: 59,    // ;
  LT: 60,      // <
  EQ: 61,      // =
  GT: 62,      // >
  QUEST: 63,   // ?
  AT: 64,      // @
  LBRACKET: 91,  // [
  BACKSLASH: 92, // \
  RBRACKET: 93,  // ]
  CARET: 94,     // ^
  UNDERSCORE: 95, // _
  BACKTICK: 96,  // `
  a: 97,
  h: 104,  // for URL detection
  z: 122,
  A: 65,
  H: 72,   // for URL detection
  Z: 90,
  LBRACE: 123,  // {
  PIPE: 124,    // |
  RBRACE: 125,  // }
  TILDE: 126,   // ~
} as const;

// =============================================================================
// Renderer Interface
// =============================================================================

export interface Renderer {
  // Lifecycle
  start(): void;
  end(): void;

  // Block elements
  openBlock(token: Token, attrs?: BlockAttrs): void;
  closeBlock(token: Token): void;

  // Inline elements
  openInline(token: Token, attrs?: InlineAttrs): void;
  closeInline(token: Token): void;

  // Content
  text(content: string): void;

  // Self-closing
  selfClosing(token: Token, attrs?: InlineAttrs): void;
}

export interface BlockAttrs {
  level?: number;      // Heading level
  lang?: string;       // Code block language
  start?: number;      // Ordered list start
  align?: Align;       // Table cell alignment
  checked?: boolean;   // Checkbox state
}

export interface InlineAttrs {
  href?: string;
  title?: string;
  alt?: string;
  src?: string;
}

export type Align = 'left' | 'center' | 'right' | null;

// =============================================================================
// Parser State
// =============================================================================

const MAX_STACK = 32;

interface ParserState {
  // Token stack
  stack: Uint8Array;
  depth: number;

  // Position tracking
  pos: number;
  line: number;
  col: number;

  // Pending buffer for lookahead
  pending: string;

  // Line state
  lineStart: boolean;
  lineContent: string;
  blankLines: number;

  // Code fence state
  inCodeFence: boolean;
  fenceChar: number;
  fenceLen: number;
  codeLang: string;

  // Table state
  inTable: boolean;
  tablePhase: number; // 0=detecting, 1=header, 2=separator, 3=body
  tableCols: number;
  tableAligns: Align[];
  tableRow: string[];

  // List state
  listStack: ListInfo[];

  // Link/image parsing
  linkPhase: number; // 0=none, 1=text, 2=href, 3=title
  linkText: string;
  linkHref: string;
  linkTitle: string;
  isImage: boolean;

  // Inline state
  inlineStack: Token[];

  // Previous line for setext headings
  prevLine: string;
  prevLineProcessed: boolean;

  // Indented code block tracking
  inIndentedCode: boolean;

  // Hard line break tracking
  lastCharWasBackslash: boolean;
}

interface ListInfo {
  indent: number;
  ordered: boolean;
  start: number;
  token: Token;
}

// =============================================================================
// Parser Implementation
// =============================================================================

export function createParser(renderer: Renderer) {
  // Initialize state
  const state: ParserState = {
    stack: new Uint8Array(MAX_STACK),
    depth: 0,
    pos: 0,
    line: 1,
    col: 0,
    pending: '',
    lineStart: true,
    lineContent: '',
    blankLines: 0,
    inCodeFence: false,
    fenceChar: 0,
    fenceLen: 0,
    codeLang: '',
    inTable: false,
    tablePhase: 0,
    tableCols: 0,
    tableAligns: [],
    tableRow: [],
    listStack: [],
    linkPhase: 0,
    linkText: '',
    linkHref: '',
    linkTitle: '',
    isImage: false,
    inlineStack: [],
    prevLine: '',
    prevLineProcessed: false,
    inIndentedCode: false,
    lastCharWasBackslash: false,
  };

  // Helper functions
  function currentToken(): Token {
    return state.depth > 0 ? state.stack[state.depth - 1] : Token.DOCUMENT;
  }

  function hasToken(token: Token): boolean {
    for (let i = 0; i < state.depth; i++) {
      if (state.stack[i] === token) return true;
    }
    return false;
  }

  function push(token: Token, attrs?: BlockAttrs | InlineAttrs): void {
    if (state.depth >= MAX_STACK) return;
    state.stack[state.depth++] = token;

    if (token >= Token.TEXT) {
      renderer.openInline(token, attrs as InlineAttrs);
    } else {
      renderer.openBlock(token, attrs as BlockAttrs);
    }
  }

  function pop(): Token | null {
    if (state.depth === 0) return null;
    const token = state.stack[--state.depth];

    if (token >= Token.TEXT) {
      renderer.closeInline(token);
    } else {
      renderer.closeBlock(token);
    }
    return token;
  }

  function popTo(token: Token): void {
    while (state.depth > 0 && state.stack[state.depth - 1] !== token) {
      pop();
    }
    if (state.depth > 0) pop();
  }

  function popInline(): void {
    while (state.depth > 0 && state.stack[state.depth - 1] >= Token.TEXT) {
      pop();
    }
  }

  function popBlock(): void {
    while (state.depth > 0 && state.stack[state.depth - 1] < Token.TEXT) {
      pop();
    }
  }

  function flushPending(): void {
    if (state.pending) {
      renderer.text(state.pending);
      state.pending = '';
    }
  }

  function addText(char: string): void {
    state.pending += char;
  }

  function ensureParagraph(): void {
    if (currentToken() === Token.DOCUMENT ||
        currentToken() === Token.BLOCKQUOTE ||
        currentToken() === Token.LIST_ITEM) {
      push(Token.PARAGRAPH);
    }
  }

  function isHr(line: string): boolean {
    const trimmed = line.replace(/\s/g, '');
    if (trimmed.length < 3) return false;
    const ch = trimmed.charCodeAt(0);
    if (ch !== CH.MINUS && ch !== CH.STAR && ch !== CH.UNDERSCORE) return false;
    return [...trimmed].every(c => c.charCodeAt(0) === ch);
  }

  function processPrevLine(): void {
    if (!state.prevLine || state.prevLineProcessed) return;
    state.prevLineProcessed = true;

    const prevTrimmed = state.prevLine;
    const prevCode = prevTrimmed.charCodeAt(0) || 0;

    // Process as a regular line (not setext)
    if (prevTrimmed.trim() === '') {
      state.blankLines++;
      if (currentToken() === Token.PARAGRAPH) {
        popInline();
        pop();
      }
    } else {
      processRegularLine(prevTrimmed, prevCode);
    }
  }

  function closeBlockquoteIfNeeded(): void {
    // Close blockquote if we had a blank line and this isn't a blockquote continuation
    if (currentToken() === Token.BLOCKQUOTE && state.blankLines > 0) {
      pop();
    }
  }

  function processRegularLine(line: string, code: number): void {
    // Heading: # ## ### etc
    if (code === CH.HASH) {
      let level = 1;
      while (level < line.length && line.charCodeAt(level) === CH.HASH) {
        level++;
      }
      if (level <= 6 && line.charCodeAt(level) === CH.SPACE) {
        popInline();
        if (currentToken() === Token.PARAGRAPH) pop();
        closeTable();
        closeLists();
        closeBlockquoteIfNeeded();
        push(Token.HEADING_1 + level - 1 as Token, { level });
        parseInline(line.slice(level + 1));
        pop();
        return;
      }
    }

    // Code fence: ``` or ~~~
    if (code === CH.BACKTICK || code === CH.TILDE) {
      let count = 1;
      while (count < line.length && line.charCodeAt(count) === code) {
        count++;
      }
      if (count >= 3) {
        const lang = line.slice(count).trim();
        state.inCodeFence = true;
        state.fenceChar = code;
        state.fenceLen = count;
        state.codeLang = lang;
        popInline();
        if (currentToken() === Token.PARAGRAPH) pop();
        closeTable();
        closeLists();
        closeBlockquoteIfNeeded();
        push(Token.CODE_BLOCK, { lang: lang || undefined });
        return;
      }
    }

    // Horizontal rule: --- or *** or ___
    if ((code === CH.MINUS || code === CH.STAR || code === CH.UNDERSCORE)) {
      if (isHr(line)) {
        popInline();
        if (currentToken() === Token.PARAGRAPH) pop();
        closeTable();
        closeLists();
        closeBlockquoteIfNeeded();
        renderer.selfClosing(Token.HR);
        return;
      }
    }

    // Blockquote: >
    if (code === CH.GT) {
      const content = line.slice(1).replace(/^\s/, '');
      popInline();
      if (currentToken() === Token.PARAGRAPH) pop();
      closeTable();
      closeLists();
      if (currentToken() !== Token.BLOCKQUOTE) {
        push(Token.BLOCKQUOTE);
      }
      if (content) {
        push(Token.PARAGRAPH);
        parseInline(content);
      }
      return;
    }

    // List items (with indentation support)
    const listResult = tryParseListItem(line);
    if (listResult) return;

    // Indented code block (4 spaces or 1 tab)
    if ((line.startsWith('    ') || line.startsWith('\t')) && !isInList()) {
      const content = line.startsWith('\t') ? line.slice(1) : line.slice(4);
      if (!state.inIndentedCode) {
        popInline();
        if (currentToken() === Token.PARAGRAPH) pop();
        state.inIndentedCode = true;
        push(Token.CODE_BLOCK);
      }
      renderer.text(content + '\n');
      return;
    } else if (state.inIndentedCode) {
      // End indented code block
      state.inIndentedCode = false;
      popTo(Token.CODE_BLOCK);
    }

    // Table: |
    if (code === CH.PIPE) {
      parseTableLine(line);
      return;
    }

    // Check if current line continues a table
    if (state.inTable && code !== CH.PIPE) {
      // End table
      closeTable();
    }

    // Close lists if we're back to non-list content
    if (state.listStack.length > 0 && !line.startsWith(' ') && !line.startsWith('\t')) {
      closeLists();
    }

    // Regular paragraph
    if (currentToken() !== Token.PARAGRAPH) {
      popInline();
      closeBlockquoteIfNeeded();
      push(Token.PARAGRAPH);
    } else {
      // Check if previous line ended with backslash (hard break)
      if (state.lastCharWasBackslash) {
        renderer.selfClosing(Token.BR);
        state.lastCharWasBackslash = false;
      } else {
        addText(' ');
      }
    }

    parseInline(line);
  }

  function isInList(): boolean {
    return state.listStack.length > 0 || currentToken() === Token.LIST_ITEM;
  }

  function closeLists(): void {
    while (state.listStack.length > 0) {
      if (currentToken() === Token.LIST_ITEM) pop();
      if (currentToken() === Token.LIST_UL || currentToken() === Token.LIST_OL) pop();
      state.listStack.pop();
    }
  }

  function tryParseListItem(line: string): boolean {
    // Calculate indent
    let indent = 0;
    while (indent < line.length && (line.charCodeAt(indent) === CH.SPACE || line.charCodeAt(indent) === CH.TAB)) {
      indent += line.charCodeAt(indent) === CH.TAB ? 4 : 1;
    }

    const trimmed = line.slice(indent);
    const code = trimmed.charCodeAt(0);

    // Unordered list: - * +
    if ((code === CH.MINUS || code === CH.STAR || code === CH.PLUS) &&
        trimmed.charCodeAt(1) === CH.SPACE) {
      return parseListItemWithIndent(trimmed.slice(2), false, 0, indent);
    }

    // Ordered list: 1. 2) etc
    if (code >= CH.ZERO && code <= CH.NINE) {
      let i = 1;
      while (i < trimmed.length && trimmed.charCodeAt(i) >= CH.ZERO && trimmed.charCodeAt(i) <= CH.NINE) {
        i++;
      }
      const marker = trimmed.charCodeAt(i);
      if ((marker === CH.DOT || marker === CH.RPAREN) && trimmed.charCodeAt(i + 1) === CH.SPACE) {
        const start = parseInt(trimmed.slice(0, i), 10);
        return parseListItemWithIndent(trimmed.slice(i + 2), true, start, indent);
      }
    }

    return false;
  }

  function parseListItemWithIndent(content: string, ordered: boolean, start: number, indent: number): boolean {
    content = content.trimStart();

    popInline();
    if (currentToken() === Token.PARAGRAPH) pop();
    closeTable();
    closeBlockquoteIfNeeded();

    const listType = ordered ? Token.LIST_OL : Token.LIST_UL;

    // Handle nested lists
    if (state.listStack.length > 0) {
      const lastList = state.listStack[state.listStack.length - 1];

      if (indent > lastList.indent) {
        // Nested list - close current list item, start new list
        if (currentToken() === Token.LIST_ITEM) {
          // Don't close, nest inside
        }
        push(listType, ordered ? { start } : undefined);
        state.listStack.push({ indent, ordered, start, token: listType });
      } else if (indent < lastList.indent) {
        // Dedent - close nested lists
        while (state.listStack.length > 0 && state.listStack[state.listStack.length - 1].indent > indent) {
          if (currentToken() === Token.LIST_ITEM) pop();
          if (currentToken() === Token.LIST_UL || currentToken() === Token.LIST_OL) pop();
          state.listStack.pop();
        }
        if (currentToken() === Token.LIST_ITEM) pop();
      } else {
        // Same level - close previous item
        if (currentToken() === Token.LIST_ITEM) pop();
      }
    } else {
      // Start new list
      push(listType, ordered ? { start } : undefined);
      state.listStack.push({ indent, ordered, start, token: listType });
    }

    push(Token.LIST_ITEM);

    // Check for checkbox: [ ] or [x]
    if (content.startsWith('[ ] ') || content.startsWith('[x] ') || content.startsWith('[X] ')) {
      const checked = content[1].toLowerCase() === 'x';
      renderer.selfClosing(Token.CHECKBOX, { checked } as unknown as InlineAttrs);
      content = content.slice(4);
    }

    parseInline(content);
    return true;
  }

  // ==========================================================================
  // Block Parsing (main entry point)
  // ==========================================================================

  function parseLineStart(_char: string, _code: number): boolean {
    const line = state.lineContent;
    const code = line.charCodeAt(0) || 0;
    const trimmed = line.trim();

    // Code fence - handle first before any other processing
    if (state.inCodeFence) {
      // Check for closing fence
      if (code === state.fenceChar) {
        let count = 1;
        let i = 1;
        while (i < line.length && line.charCodeAt(i) === state.fenceChar) {
          count++;
          i++;
        }
        // Rest of line must be empty or whitespace
        const rest = line.slice(i).trim();
        if (count >= state.fenceLen && rest === '') {
          state.inCodeFence = false;
          popTo(Token.CODE_BLOCK);
          return true;
        }
      }
      // Inside code block - emit as-is
      renderer.text(line + '\n');
      return true;
    }

    // Empty line - process any pending line first
    if (trimmed === '') {
      // Process pending setext line as paragraph
      if (state.prevLine) {
        const prevCode = state.prevLine.charCodeAt(0) || 0;
        processRegularLine(state.prevLine, prevCode);
        state.prevLine = '';
      }

      state.blankLines++;
      // Close paragraph on blank line
      if (currentToken() === Token.PARAGRAPH) {
        popInline();
        pop();
      }
      // Close indented code on blank line
      if (state.inIndentedCode) {
        state.inIndentedCode = false;
        popTo(Token.CODE_BLOCK);
      }
      return true;
    }

    // Check if current line is a setext underline
    if (state.prevLine && /^=+$/.test(trimmed)) {
      // H1 setext
      popInline();
      if (currentToken() === Token.PARAGRAPH) pop();
      closeLists();
      push(Token.HEADING_1, { level: 1 });
      parseInline(state.prevLine.trim());
      pop();
      state.prevLine = '';
      return true;
    }

    if (state.prevLine && /^-+$/.test(trimmed) && trimmed.length >= 2) {
      // H2 setext (not HR which requires 3+ chars)
      popInline();
      if (currentToken() === Token.PARAGRAPH) pop();
      closeLists();
      push(Token.HEADING_2, { level: 2 });
      parseInline(state.prevLine.trim());
      pop();
      state.prevLine = '';
      return true;
    }

    // Process any pending line
    if (state.prevLine) {
      const prevCode = state.prevLine.charCodeAt(0) || 0;
      processRegularLine(state.prevLine, prevCode);
      state.prevLine = '';
    }

    // Check if this line could be followed by a setext underline
    // Only plain text lines (not starting with special chars) can be setext headings
    const isPlainText = !isSpecialLineStart(line, code);

    if (isPlainText && !state.inTable && state.listStack.length === 0) {
      // Buffer this line to check for setext on next line
      state.prevLine = line;
      state.blankLines = 0;  // Reset after buffering
      return true;
    }

    // Use processRegularLine for actual parsing
    processRegularLine(line, code);

    // Reset blank line counter after processing
    state.blankLines = 0;
    return true;
  }

  function isSpecialLineStart(line: string, code: number): boolean {
    // Check if line starts with a markdown block element marker
    if (code === CH.HASH) return true;  // Heading
    if (code === CH.GT) return true;    // Blockquote
    if (code === CH.BACKTICK || code === CH.TILDE) return true;  // Code fence
    if (code === CH.PIPE) return true;  // Table
    if (code === CH.SPACE || code === CH.TAB) return true;  // Indented

    // List markers
    if ((code === CH.MINUS || code === CH.STAR || code === CH.PLUS) &&
        line.charCodeAt(1) === CH.SPACE) return true;

    // Ordered list
    if (code >= CH.ZERO && code <= CH.NINE) {
      let i = 1;
      while (i < line.length && line.charCodeAt(i) >= CH.ZERO && line.charCodeAt(i) <= CH.NINE) {
        i++;
      }
      const marker = line.charCodeAt(i);
      if ((marker === CH.DOT || marker === CH.RPAREN) && line.charCodeAt(i + 1) === CH.SPACE) {
        return true;
      }
    }

    // HR check
    if ((code === CH.MINUS || code === CH.STAR || code === CH.UNDERSCORE) && isHr(line)) {
      return true;
    }

    return false;
  }

  function parseTableLine(line: string): boolean {
    // Split by |, handling escaped pipes
    const cells = splitTableRow(line);

    if (!state.inTable) {
      // First line - could be header
      state.inTable = true;
      state.tablePhase = 1; // Expecting header
      state.tableRow = cells;
      state.tableCols = cells.length;
      return true;
    }

    if (state.tablePhase === 1) {
      // Should be separator row
      if (isTableSeparator(cells)) {
        state.tableAligns = parseTableAligns(cells);
        state.tablePhase = 2;

        // Now render the header
        push(Token.TABLE);
        push(Token.TABLE_HEAD);
        push(Token.TABLE_ROW);
        for (let i = 0; i < state.tableRow.length; i++) {
          push(Token.TABLE_CELL_H, { align: state.tableAligns[i] });
          parseInline(state.tableRow[i].trim());
          pop();
        }
        pop(); // TABLE_ROW
        pop(); // TABLE_HEAD
        push(Token.TABLE_BODY);
        return true;
      } else {
        // Not a table - render as paragraph
        state.inTable = false;
        state.tablePhase = 0;
        push(Token.PARAGRAPH);
        parseInline(state.tableRow.join(' | '));
        addText(' ');
        parseInline(line);
        return true;
      }
    }

    // Body row
    push(Token.TABLE_ROW);
    for (let i = 0; i < cells.length; i++) {
      push(Token.TABLE_CELL_D, { align: state.tableAligns[i] || null });
      parseInline(cells[i].trim());
      pop();
    }
    pop(); // TABLE_ROW
    return true;
  }

  function closeTable(): void {
    if (state.inTable) {
      if (state.tablePhase >= 2) {
        pop(); // TABLE_BODY
        pop(); // TABLE
      }
      state.inTable = false;
      state.tablePhase = 0;
      state.tableRow = [];
      state.tableAligns = [];
    }
  }

  function splitTableRow(line: string): string[] {
    const cells: string[] = [];
    let cell = '';
    let escaped = false;

    // Skip leading |
    let start = line.charCodeAt(0) === CH.PIPE ? 1 : 0;

    for (let i = start; i < line.length; i++) {
      const ch = line[i];
      if (escaped) {
        cell += ch;
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
        cell += ch;
      } else if (ch === '|') {
        cells.push(cell);
        cell = '';
      } else {
        cell += ch;
      }
    }

    // Add last cell if not empty
    if (cell.trim()) {
      cells.push(cell);
    }

    return cells;
  }

  function isTableSeparator(cells: string[]): boolean {
    return cells.every(cell => /^[\s:-]+$/.test(cell) && cell.includes('-'));
  }

  function parseTableAligns(cells: string[]): Align[] {
    return cells.map(cell => {
      const trimmed = cell.trim();
      const left = trimmed.startsWith(':');
      const right = trimmed.endsWith(':');
      if (left && right) return 'center';
      if (right) return 'right';
      if (left) return 'left';
      return null;
    });
  }

  // ==========================================================================
  // Inline Parsing
  // ==========================================================================

  function parseInline(text: string): void {
    let i = 0;

    while (i < text.length) {
      const ch = text[i];
      const code = text.charCodeAt(i);
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      const prev = i > 0 ? text.charCodeAt(i - 1) : 0;

      // Escape sequence
      if (code === CH.BACKSLASH && i + 1 < text.length) {
        flushPending();
        addText(text[i + 1]);
        i += 2;
        continue;
      }

      // Bold/Italic with * or _
      if (code === CH.STAR || code === CH.UNDERSCORE) {
        // Underscore special case: don't trigger inside words
        // e.g., snake_case_variable should not be italic
        if (code === CH.UNDERSCORE) {
          const isWordChar = (c: number) =>
            (c >= CH.a && c <= CH.z) || (c >= CH.A && c <= CH.Z) || (c >= CH.ZERO && c <= CH.NINE);
          // If both prev and next are word chars, treat as literal underscore
          if (isWordChar(prev) && isWordChar(next)) {
            addText(ch);
            i++;
            continue;
          }
        }

        // Count consecutive markers
        let count = 1;
        while (i + count < text.length && text.charCodeAt(i + count) === code) {
          count++;
        }

        flushPending();

        if (count >= 3) {
          // Bold italic
          if (hasToken(Token.BOLD_ITALIC)) {
            popTo(Token.BOLD_ITALIC);
          } else {
            push(Token.BOLD_ITALIC);
          }
          i += 3;
        } else if (count === 2) {
          // Bold
          if (hasToken(Token.BOLD)) {
            popTo(Token.BOLD);
          } else {
            push(Token.BOLD);
          }
          i += 2;
        } else {
          // Italic
          if (hasToken(Token.ITALIC)) {
            popTo(Token.ITALIC);
          } else {
            push(Token.ITALIC);
          }
          i += 1;
        }
        continue;
      }

      // Strikethrough ~~
      if (code === CH.TILDE && next === CH.TILDE) {
        flushPending();
        if (hasToken(Token.STRIKE)) {
          popTo(Token.STRIKE);
        } else {
          push(Token.STRIKE);
        }
        i += 2;
        continue;
      }

      // Inline code `
      if (code === CH.BACKTICK) {
        // Count backticks
        let count = 1;
        while (i + count < text.length && text.charCodeAt(i + count) === CH.BACKTICK) {
          count++;
        }

        // Find closing backticks
        const closePattern = '`'.repeat(count);
        const closeIdx = text.indexOf(closePattern, i + count);

        if (closeIdx !== -1) {
          flushPending();
          push(Token.CODE);
          let codeContent = text.slice(i + count, closeIdx);
          // Trim single space from start/end if present
          if (codeContent.startsWith(' ') && codeContent.endsWith(' ') && codeContent.length > 2) {
            codeContent = codeContent.slice(1, -1);
          }
          renderer.text(codeContent);
          pop();
          i = closeIdx + count;
        } else {
          // No closing - treat as text
          addText(ch);
          i++;
        }
        continue;
      }

      // Image ![alt](src)
      if (code === CH.BANG && next === CH.LBRACKET) {
        const result = parseLink(text, i + 1, true);
        if (result) {
          flushPending();
          renderer.selfClosing(Token.IMAGE, {
            src: result.href,
            alt: result.text,
            title: result.title,
          });
          i = result.end;
          continue;
        }
      }

      // Link [text](href)
      if (code === CH.LBRACKET) {
        const result = parseLink(text, i, false);
        if (result) {
          flushPending();
          push(Token.LINK, { href: result.href, title: result.title });
          parseInline(result.text);
          pop();
          i = result.end;
          continue;
        }
      }

      // Auto-link <url> or <email>
      if (code === CH.LT) {
        const closeIdx = text.indexOf('>', i + 1);
        if (closeIdx !== -1) {
          const content = text.slice(i + 1, closeIdx);
          if (content.includes('@') || content.startsWith('http://') || content.startsWith('https://')) {
            flushPending();
            const href = content.includes('@') && !content.startsWith('mailto:')
              ? 'mailto:' + content
              : content;
            push(Token.LINK, { href });
            renderer.text(content);
            pop();
            i = closeIdx + 1;
            continue;
          }
        }
      }

      // Hard line break with backslash
      if (code === CH.BACKSLASH && next === CH.LF) {
        flushPending();
        renderer.selfClosing(Token.BR);
        i += 2;
        continue;
      }

      // Auto-link bare URLs (http:// or https://)
      if (code === CH.h || code === CH.H) {
        // Check for http:// or https://
        const rest = text.slice(i);
        const urlMatch = rest.match(/^https?:\/\/[^\s<>\[\]()'"]+/i);
        if (urlMatch) {
          flushPending();
          const url = urlMatch[0];
          // Remove trailing punctuation that's likely not part of URL
          let cleanUrl = url.replace(/[.,;:!?)]+$/, '');
          push(Token.LINK, { href: cleanUrl });
          renderer.text(cleanUrl);
          pop();
          i += cleanUrl.length;
          continue;
        }
      }

      // Hard line break (two trailing spaces)
      if (code === CH.SPACE && next === CH.SPACE) {
        // Check if there are only spaces until end of line or newline
        let j = i + 2;
        while (j < text.length && text.charCodeAt(j) === CH.SPACE) {
          j++;
        }
        if (j >= text.length || text.charCodeAt(j) === CH.LF) {
          flushPending();
          renderer.selfClosing(Token.BR);
          i = j;
          if (i < text.length && text.charCodeAt(i) === CH.LF) {
            i++; // Skip the newline
          }
          continue;
        }
      }

      // Regular character
      addText(ch);
      i++;
    }

    // Check if ending with backslash (potential hard break on next line)
    if (state.pending.endsWith('\\')) {
      state.pending = state.pending.slice(0, -1);
      state.lastCharWasBackslash = true;
    } else {
      state.lastCharWasBackslash = false;
    }

    flushPending();
  }

  interface LinkResult {
    text: string;
    href: string;
    title: string;
    end: number;
  }

  function parseLink(text: string, start: number, isImage: boolean): LinkResult | null {
    // Find [text]
    let i = isImage ? start + 1 : start + 1; // Skip [ or ![
    let depth = 1;
    let textEnd = -1;

    while (i < text.length && depth > 0) {
      const ch = text.charCodeAt(i);
      if (ch === CH.BACKSLASH && i + 1 < text.length) {
        i += 2;
        continue;
      }
      if (ch === CH.LBRACKET) depth++;
      if (ch === CH.RBRACKET) depth--;
      if (depth === 0) textEnd = i;
      i++;
    }

    if (textEnd === -1) return null;

    // Expect (
    if (i >= text.length || text.charCodeAt(i) !== CH.LPAREN) return null;
    i++; // Skip (

    // Parse href
    let href = '';
    let title = '';

    // Skip whitespace
    while (i < text.length && (text.charCodeAt(i) === CH.SPACE || text.charCodeAt(i) === CH.TAB)) {
      i++;
    }

    // Handle <url>
    if (text.charCodeAt(i) === CH.LT) {
      i++;
      const closeAngle = text.indexOf('>', i);
      if (closeAngle === -1) return null;
      href = text.slice(i, closeAngle);
      i = closeAngle + 1;
    } else {
      // Regular URL
      const hrefStart = i;
      let parenDepth = 1;
      while (i < text.length) {
        const ch = text.charCodeAt(i);
        if (ch === CH.LPAREN) parenDepth++;
        if (ch === CH.RPAREN) {
          parenDepth--;
          if (parenDepth === 0) break;
        }
        if (ch === CH.SPACE || ch === CH.TAB) break;
        i++;
      }
      href = text.slice(hrefStart, i);
    }

    // Skip whitespace
    while (i < text.length && (text.charCodeAt(i) === CH.SPACE || text.charCodeAt(i) === CH.TAB)) {
      i++;
    }

    // Optional title
    const titleChar = text.charCodeAt(i);
    if (titleChar === CH.QUOTE || titleChar === CH.APOS) {
      i++;
      const titleEnd = text.indexOf(String.fromCharCode(titleChar), i);
      if (titleEnd !== -1) {
        title = text.slice(i, titleEnd);
        i = titleEnd + 1;
      }
    }

    // Skip whitespace
    while (i < text.length && (text.charCodeAt(i) === CH.SPACE || text.charCodeAt(i) === CH.TAB)) {
      i++;
    }

    // Expect )
    if (i >= text.length || text.charCodeAt(i) !== CH.RPAREN) return null;
    i++; // Skip )

    // start points to '[' for both images and links
    const linkText = text.slice(start + 1, textEnd);

    return {
      text: linkText,
      href,
      title,
      end: i,
    };
  }

  // ==========================================================================
  // Main API
  // ==========================================================================

  function write(chunk: string): void {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      const code = chunk.charCodeAt(i);

      state.pos++;
      state.col++;

      if (code === CH.LF) {
        // End of line - process it
        if (state.lineContent || state.lineStart) {
          parseLineStart(state.lineContent[0] || '', state.lineContent.charCodeAt(0) || 0);
        }
        state.lineContent = '';
        state.lineStart = true;
        state.line++;
        state.col = 0;
      } else if (code === CH.CR) {
        // Ignore CR
        continue;
      } else {
        state.lineContent += ch;
        state.lineStart = false;
      }
    }
  }

  function end(): void {
    // Process remaining line
    if (state.lineContent) {
      parseLineStart(state.lineContent[0] || '', state.lineContent.charCodeAt(0) || 0);
    }

    // Process any pending setext line
    if (state.prevLine) {
      const prevCode = state.prevLine.charCodeAt(0) || 0;
      processRegularLine(state.prevLine, prevCode);
      state.prevLine = '';
    }

    // Close table if open
    closeTable();

    // Close lists
    closeLists();

    // Close all open tokens
    while (state.depth > 0) {
      pop();
    }

    renderer.end();
  }

  function reset(): void {
    state.stack.fill(0);
    state.depth = 0;
    state.pos = 0;
    state.line = 1;
    state.col = 0;
    state.pending = '';
    state.lineStart = true;
    state.lineContent = '';
    state.blankLines = 0;
    state.inCodeFence = false;
    state.fenceChar = 0;
    state.fenceLen = 0;
    state.codeLang = '';
    state.inTable = false;
    state.tablePhase = 0;
    state.tableCols = 0;
    state.tableAligns = [];
    state.tableRow = [];
    state.listStack = [];
    state.linkPhase = 0;
    state.linkText = '';
    state.linkHref = '';
    state.linkTitle = '';
    state.isImage = false;
    state.inlineStack = [];
    state.prevLine = '';
    state.prevLineProcessed = false;
    state.inIndentedCode = false;
    state.lastCharWasBackslash = false;
  }

  // Start document
  renderer.start();

  return {
    write,
    end,
    reset,
    getState: () => ({ ...state }),
  };
}

// =============================================================================
// Auto-completion for streaming
// =============================================================================

export function autoComplete(content: string): string {
  let suffix = '';

  // Check for unclosed code fence
  const fenceMatch = content.match(/^(`{3,}|~{3,})(\w*)\s*$/m);
  if (fenceMatch) {
    // Count opening and closing fences
    const fenceChar = fenceMatch[1][0];
    const fenceLen = fenceMatch[1].length;
    const openPattern = new RegExp(`^${fenceChar}{${fenceLen},}`, 'gm');
    const opens = (content.match(openPattern) || []).length;
    const closePattern = new RegExp(`^${fenceChar}{${fenceLen},}\\s*$`, 'gm');
    const closes = (content.match(closePattern) || []).length;

    if (opens > closes) {
      suffix += '\n' + fenceChar.repeat(fenceLen);
    }
  }

  // Check last line for unclosed inline elements
  const lines = content.split('\n');
  const lastLine = lines[lines.length - 1] || '';

  // Bold **
  if ((lastLine.match(/\*\*/g) || []).length % 2 === 1) {
    suffix = '**' + suffix;
  }
  // Italic *
  else if ((lastLine.match(/(?<!\*)\*(?!\*)/g) || []).length % 2 === 1) {
    suffix = '*' + suffix;
  }

  // Strikethrough ~~
  if ((lastLine.match(/~~/g) || []).length % 2 === 1) {
    suffix = '~~' + suffix;
  }

  // Inline code `
  if ((lastLine.match(/`/g) || []).length % 2 === 1) {
    suffix = '`' + suffix;
  }

  // Unclosed link [
  const openBrackets = (lastLine.match(/\[/g) || []).length;
  const closeBrackets = (lastLine.match(/\]/g) || []).length;
  if (openBrackets > closeBrackets) {
    suffix = '](#)' + suffix;
  }

  // Unclosed link URL ](
  if (/\]\([^)]*$/.test(lastLine)) {
    suffix = ')' + suffix;
  }

  return suffix;
}

// =============================================================================
// HTML Renderer
// =============================================================================

export function createHtmlRenderer(): Renderer & { getHtml(): string } {
  let html = '';

  const TAG_MAP: Record<Token, [string, string]> = {
    [Token.DOCUMENT]: ['', ''],
    [Token.PARAGRAPH]: ['<p>', '</p>'],
    [Token.HEADING_1]: ['<h1>', '</h1>'],
    [Token.HEADING_2]: ['<h2>', '</h2>'],
    [Token.HEADING_3]: ['<h3>', '</h3>'],
    [Token.HEADING_4]: ['<h4>', '</h4>'],
    [Token.HEADING_5]: ['<h5>', '</h5>'],
    [Token.HEADING_6]: ['<h6>', '</h6>'],
    [Token.CODE_BLOCK]: ['<pre><code>', '</code></pre>'],
    [Token.BLOCKQUOTE]: ['<blockquote>', '</blockquote>'],
    [Token.LIST_UL]: ['<ul>', '</ul>'],
    [Token.LIST_OL]: ['<ol>', '</ol>'],
    [Token.LIST_ITEM]: ['<li>', '</li>'],
    [Token.TABLE]: ['<table>', '</table>'],
    [Token.TABLE_HEAD]: ['<thead>', '</thead>'],
    [Token.TABLE_BODY]: ['<tbody>', '</tbody>'],
    [Token.TABLE_ROW]: ['<tr>', '</tr>'],
    [Token.TABLE_CELL_H]: ['<th>', '</th>'],
    [Token.TABLE_CELL_D]: ['<td>', '</td>'],
    [Token.HR]: ['<hr>', ''],
    [Token.TEXT]: ['', ''],
    [Token.BOLD]: ['<strong>', '</strong>'],
    [Token.ITALIC]: ['<em>', '</em>'],
    [Token.BOLD_ITALIC]: ['<strong><em>', '</em></strong>'],
    [Token.STRIKE]: ['<del>', '</del>'],
    [Token.CODE]: ['<code>', '</code>'],
    [Token.LINK]: ['<a>', '</a>'],
    [Token.IMAGE]: ['<img', '>'],
    [Token.BR]: ['<br>', ''],
    [Token.CHECKBOX]: ['<input type="checkbox"', '>'],
  };

  function escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return {
    start() {
      html = '';
    },

    end() {
      // Nothing to do
    },

    openBlock(token: Token, attrs?: BlockAttrs) {
      let tag = TAG_MAP[token]?.[0] || '';

      if (token === Token.CODE_BLOCK && attrs?.lang) {
        tag = `<pre><code class="language-${escapeHtml(attrs.lang)}">`;
      }
      if (token === Token.LIST_OL && attrs?.start && attrs.start !== 1) {
        tag = `<ol start="${attrs.start}">`;
      }
      if ((token === Token.TABLE_CELL_H || token === Token.TABLE_CELL_D) && attrs?.align) {
        const tagName = token === Token.TABLE_CELL_H ? 'th' : 'td';
        tag = `<${tagName} style="text-align:${attrs.align}">`;
      }

      html += tag;
    },

    closeBlock(token: Token) {
      html += TAG_MAP[token]?.[1] || '';
    },

    openInline(token: Token, attrs?: InlineAttrs) {
      let tag = TAG_MAP[token]?.[0] || '';

      if (token === Token.LINK && attrs?.href) {
        const title = attrs.title ? ` title="${escapeHtml(attrs.title)}"` : '';
        tag = `<a href="${escapeHtml(attrs.href)}"${title} target="_blank" rel="noopener noreferrer">`;
      }

      html += tag;
    },

    closeInline(token: Token) {
      html += TAG_MAP[token]?.[1] || '';
    },

    text(content: string) {
      html += escapeHtml(content);
    },

    selfClosing(token: Token, attrs?: InlineAttrs) {
      if (token === Token.HR) {
        html += '<hr>';
      } else if (token === Token.BR) {
        html += '<br>';
      } else if (token === Token.IMAGE && attrs?.src) {
        const alt = attrs.alt ? ` alt="${escapeHtml(attrs.alt)}"` : '';
        const title = attrs.title ? ` title="${escapeHtml(attrs.title)}"` : '';
        html += `<img src="${escapeHtml(attrs.src)}"${alt}${title} loading="lazy">`;
      } else if (token === Token.CHECKBOX) {
        const checked = (attrs as unknown as BlockAttrs)?.checked ? ' checked' : '';
        html += `<input type="checkbox"${checked} disabled>`;
      }
    },

    getHtml() {
      return html;
    },
  };
}

// =============================================================================
// Convenience function
// =============================================================================

export function parse(markdown: string, streaming: boolean = false): string {
  const renderer = createHtmlRenderer();
  const parser = createParser(renderer);

  // Auto-complete if streaming
  const content = streaming ? markdown + autoComplete(markdown) : markdown;

  parser.write(content);
  parser.end();

  return renderer.getHtml();
}

// =============================================================================
// Streaming Parser Class
// =============================================================================

export class StreamingParser {
  private renderer = createHtmlRenderer();
  private parser = createParser(this.renderer);
  private content = '';

  write(chunk: string): string {
    this.content += chunk;

    // Reset and re-parse with auto-completion
    this.parser.reset();
    this.renderer.start();

    const completed = this.content + autoComplete(this.content);
    this.parser.write(completed);
    this.parser.end();

    return this.renderer.getHtml();
  }

  end(): string {
    this.parser.reset();
    this.renderer.start();
    this.parser.write(this.content);
    this.parser.end();
    return this.renderer.getHtml();
  }

  getHtml(): string {
    return this.renderer.getHtml();
  }

  getContent(): string {
    return this.content;
  }

  reset(): void {
    this.content = '';
    this.parser.reset();
    this.renderer.start();
  }
}
