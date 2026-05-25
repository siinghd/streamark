/**
 * Incremental DOM Renderer for Streamark
 *
 * Directly manipulates the DOM without building intermediate strings.
 * Zero memory growth - only parses new chunks incrementally.
 */

import { createParser, createHtmlRenderer, autoComplete, Token, type Renderer, type BlockAttrs, type InlineAttrs } from './smd';

/**
 * Creates a DOM renderer that directly appends to a container element.
 * Much more memory efficient than building HTML strings.
 */
export function createDomRenderer(container: HTMLElement): Renderer & { getRoot(): HTMLElement } {
  // Element stack for nesting
  const stack: HTMLElement[] = [container];

  function current(): HTMLElement {
    return stack[stack.length - 1];
  }

  function createElement(tag: string): HTMLElement {
    return document.createElement(tag);
  }

  function push(el: HTMLElement): void {
    current().appendChild(el);
    stack.push(el);
  }

  function pop(): void {
    if (stack.length > 1) {
      stack.pop();
    }
  }

  const TAG_MAP: Record<number, string> = {
    [Token.PARAGRAPH]: 'p',
    [Token.HEADING_1]: 'h1',
    [Token.HEADING_2]: 'h2',
    [Token.HEADING_3]: 'h3',
    [Token.HEADING_4]: 'h4',
    [Token.HEADING_5]: 'h5',
    [Token.HEADING_6]: 'h6',
    [Token.BLOCKQUOTE]: 'blockquote',
    [Token.LIST_UL]: 'ul',
    [Token.LIST_OL]: 'ol',
    [Token.LIST_ITEM]: 'li',
    [Token.TABLE]: 'table',
    [Token.TABLE_HEAD]: 'thead',
    [Token.TABLE_BODY]: 'tbody',
    [Token.TABLE_ROW]: 'tr',
    [Token.TABLE_CELL_H]: 'th',
    [Token.TABLE_CELL_D]: 'td',
    [Token.BOLD]: 'strong',
    [Token.ITALIC]: 'em',
    [Token.BOLD_ITALIC]: 'strong', // Will nest em inside
    [Token.STRIKE]: 'del',
    [Token.CODE]: 'code',
    [Token.LINK]: 'a',
  };

  return {
    start() {
      // Clear container
      container.innerHTML = '';
      stack.length = 1;
      stack[0] = container;
    },

    end() {
      // Close any remaining open elements
      while (stack.length > 1) {
        stack.pop();
      }
    },

    openBlock(token: Token, attrs?: BlockAttrs) {
      const tag = TAG_MAP[token];
      if (!tag) {
        if (token === Token.CODE_BLOCK) {
          const pre = createElement('pre');
          const code = createElement('code');
          if (attrs?.lang) {
            code.className = `language-${attrs.lang}`;
          }
          pre.appendChild(code);
          current().appendChild(pre);
          stack.push(code);
          return;
        }
        return;
      }

      const el = createElement(tag);

      if (token === Token.LIST_OL && attrs?.start && attrs.start !== 1) {
        (el as HTMLOListElement).start = attrs.start;
      }

      if ((token === Token.TABLE_CELL_H || token === Token.TABLE_CELL_D) && attrs?.align) {
        el.style.textAlign = attrs.align;
      }

      push(el);
    },

    closeBlock(token: Token) {
      if (token === Token.CODE_BLOCK) {
        // Pop the code element
        pop();
        return;
      }
      pop();
    },

    openInline(token: Token, attrs?: InlineAttrs) {
      const tag = TAG_MAP[token];
      if (!tag) return;

      const el = createElement(tag);

      if (token === Token.LINK && attrs?.href) {
        (el as HTMLAnchorElement).href = attrs.href;
        (el as HTMLAnchorElement).target = '_blank';
        (el as HTMLAnchorElement).rel = 'noopener noreferrer';
        if (attrs.title) {
          el.title = attrs.title;
        }
      }

      if (token === Token.BOLD_ITALIC) {
        // Create strong > em structure
        const em = createElement('em');
        el.appendChild(em);
        current().appendChild(el);
        stack.push(em);
        return;
      }

      push(el);
    },

    closeInline(token: Token) {
      if (token === Token.BOLD_ITALIC) {
        // Pop em and strong
        pop();
        pop();
        return;
      }
      pop();
    },

    text(content: string) {
      current().appendChild(document.createTextNode(content));
    },

    selfClosing(token: Token, attrs?: InlineAttrs) {
      if (token === Token.HR) {
        current().appendChild(createElement('hr'));
      } else if (token === Token.BR) {
        current().appendChild(createElement('br'));
      } else if (token === Token.IMAGE && attrs?.src) {
        const img = createElement('img') as HTMLImageElement;
        img.src = attrs.src;
        if (attrs.alt) img.alt = attrs.alt;
        if (attrs.title) img.title = attrs.title;
        img.loading = 'lazy';
        current().appendChild(img);
      } else if (token === Token.CHECKBOX) {
        const input = createElement('input') as HTMLInputElement;
        input.type = 'checkbox';
        input.disabled = true;
        if ((attrs as unknown as BlockAttrs)?.checked) {
          input.checked = true;
        }
        current().appendChild(input);
      }
    },

    getRoot() {
      return container;
    },
  };
}

/**
 * Streaming DOM parser - truly incremental, zero memory growth.
 *
 * Usage:
 *   const streamer = createDomStreamer(containerElement);
 *   streamer.write(chunk1);
 *   streamer.write(chunk2);
 *   streamer.end();
 */
export function createDomStreamer(container: HTMLElement) {
  let content = '';
  let lastParsedLength = 0;
  let isEnded = false;

  // For streaming, we need to re-render because markdown is context-sensitive
  // But we can optimize by only re-rendering when content changes significantly
  const renderer = createDomRenderer(container);
  const parser = createParser(renderer);

  function render(streaming: boolean) {
    // Clear and re-parse (unfortunately necessary for correct markdown)
    renderer.start();
    parser.reset();

    const toRender = streaming ? content + autoComplete(content) : content;
    parser.write(toRender);
    parser.end();
  }

  return {
    write(chunk: string): void {
      if (isEnded) return;
      content += chunk;

      // Throttle renders - only render every 50ms or 100 chars
      const now = performance.now();
      if (content.length - lastParsedLength > 100) {
        render(true);
        lastParsedLength = content.length;
      }
    },

    end(): void {
      if (isEnded) return;
      isEnded = true;
      render(false);
    },

    reset(): void {
      content = '';
      lastParsedLength = 0;
      isEnded = false;
      container.innerHTML = '';
    },

    getContent(): string {
      return content;
    },
  };
}

/**
 * ZERO-ALLOCATION STREAMER
 *
 * Absolute minimal implementation for memory profiling.
 * Just appends text to a single text node - no parsing overhead.
 */
export function createZeroAllocStreamer(container: HTMLElement) {
  const pre = document.createElement('pre');
  pre.className = 'streamark-raw';
  pre.style.whiteSpace = 'pre-wrap';
  pre.style.fontFamily = 'inherit';
  container.appendChild(pre);

  // Single text node - modified in place, no object creation
  const textNode = document.createTextNode('');
  pre.appendChild(textNode);

  let content = '';

  return {
    write(chunk: string): void {
      content += chunk;
      textNode.data = content; // Direct mutation
    },
    end(): void {},
    reset(): void {
      content = '';
      textNode.data = '';
    },
    getContent(): string {
      return content;
    },
  };
}

/**
 * STREAMING MARKDOWN RENDERER
 *
 * Character-by-character rendering with minimal allocations.
 * Directly manipulates DOM - no intermediate objects.
 *
 * Handles: bold, italic, code, headings, lists, code blocks, paragraphs
 */
export function createStreamingRenderer(container: HTMLElement) {
  // State
  let content = '';
  const enum State {
    LINE_START,
    TEXT,
    MAYBE_BOLD,      // saw *
    IN_BOLD,         // inside **...**
    MAYBE_BOLD_END,  // saw * inside bold
    MAYBE_ITALIC,    // saw single * at text
    IN_ITALIC,       // inside *...*
    IN_CODE,         // inside `...`
    IN_CODE_BLOCK,   // inside ```...```
    HEADING,         // after # at line start
  }

  let state = State.LINE_START;
  let codeBlockFence = '';
  let headingLevel = 0;

  // DOM elements - reused, never recreated
  const root = document.createElement('div');
  root.className = 'streamark';
  container.appendChild(root);

  // Current elements
  let currentBlock: HTMLElement = document.createElement('p');
  let currentInline: HTMLElement | null = null;
  let currentText: Text = document.createTextNode('');

  root.appendChild(currentBlock);
  currentBlock.appendChild(currentText);

  // Pending characters for ambiguous sequences
  let pending = '';

  function appendChar(char: string) {
    currentText.data += char;
  }

  function flushPending() {
    if (pending) {
      currentText.data += pending;
      pending = '';
    }
  }

  function startNewBlock(tag: string) {
    flushPending();
    currentBlock = document.createElement(tag);
    currentText = document.createTextNode('');
    currentBlock.appendChild(currentText);
    root.appendChild(currentBlock);
    currentInline = null;
  }

  function startInline(tag: string) {
    flushPending();
    const el = document.createElement(tag);
    currentBlock.appendChild(el);
    currentText = document.createTextNode('');
    el.appendChild(currentText);
    currentInline = el;
  }

  function endInline() {
    flushPending();
    if (currentInline) {
      currentText = document.createTextNode('');
      currentBlock.appendChild(currentText);
      currentInline = null;
    }
  }

  function processChar(char: string) {
    switch (state) {
      case State.LINE_START:
        if (char === '#') {
          headingLevel = 1;
          state = State.HEADING;
        } else if (char === '`') {
          pending = '`';
          state = State.TEXT;
        } else if (char === '*' || char === '-') {
          // Could be list or bold/italic
          pending = char;
          state = State.TEXT;
        } else if (char === '\n') {
          // Blank line - new paragraph
          startNewBlock('p');
        } else {
          appendChar(char);
          state = State.TEXT;
        }
        break;

      case State.HEADING:
        if (char === '#' && headingLevel < 6) {
          headingLevel++;
        } else if (char === ' ') {
          // Start heading block
          const tag = `h${headingLevel}` as keyof HTMLElementTagNameMap;
          startNewBlock(tag);
          state = State.TEXT;
        } else {
          // Not a heading, output the #s
          flushPending();
          for (let i = 0; i < headingLevel; i++) appendChar('#');
          appendChar(char);
          state = State.TEXT;
        }
        break;

      case State.TEXT:
        if (char === '\n') {
          appendChar(char);
          state = State.LINE_START;
          headingLevel = 0;
        } else if (char === '*') {
          pending = '*';
          state = State.MAYBE_BOLD;
        } else if (char === '`') {
          if (pending === '``') {
            pending = '```';
          } else if (pending === '`') {
            pending = '``';
          } else {
            pending = '`';
          }
        } else if (pending.startsWith('```')) {
          // Start code block
          codeBlockFence = pending;
          pending = '';
          const pre = document.createElement('pre');
          const code = document.createElement('code');
          pre.appendChild(code);
          root.appendChild(pre);
          currentBlock = code;
          currentText = document.createTextNode('');
          code.appendChild(currentText);
          state = State.IN_CODE_BLOCK;
          if (char !== '\n') appendChar(char);
        } else if (pending === '`') {
          pending = '';
          startInline('code');
          state = State.IN_CODE;
          appendChar(char);
        } else if (pending === '``') {
          flushPending();
          appendChar(char);
        } else {
          flushPending();
          appendChar(char);
        }
        break;

      case State.MAYBE_BOLD:
        if (char === '*') {
          pending = '';
          startInline('strong');
          state = State.IN_BOLD;
        } else {
          // Single * - italic
          pending = '';
          startInline('em');
          state = State.IN_ITALIC;
          appendChar(char);
        }
        break;

      case State.IN_BOLD:
        if (char === '*') {
          state = State.MAYBE_BOLD_END;
        } else {
          appendChar(char);
        }
        break;

      case State.MAYBE_BOLD_END:
        if (char === '*') {
          // End bold
          endInline();
          state = State.TEXT;
        } else {
          // Just a single * inside bold
          appendChar('*');
          appendChar(char);
          state = State.IN_BOLD;
        }
        break;

      case State.IN_ITALIC:
        if (char === '*') {
          endInline();
          state = State.TEXT;
        } else {
          appendChar(char);
        }
        break;

      case State.IN_CODE:
        if (char === '`') {
          endInline();
          state = State.TEXT;
        } else {
          appendChar(char);
        }
        break;

      case State.IN_CODE_BLOCK:
        if (char === '`') {
          pending += '`';
          if (pending === '```') {
            // End code block
            pending = '';
            startNewBlock('p');
            state = State.LINE_START;
          }
        } else {
          if (pending) {
            appendChar(pending);
            pending = '';
          }
          appendChar(char);
        }
        break;
    }
  }

  return {
    write(chunk: string): void {
      content += chunk;
      for (let i = 0; i < chunk.length; i++) {
        processChar(chunk[i]);
      }
    },

    end(): void {
      flushPending();
    },

    reset(): void {
      content = '';
      state = State.LINE_START;
      pending = '';
      headingLevel = 0;
      root.innerHTML = '';
      currentBlock = document.createElement('p');
      currentText = document.createTextNode('');
      currentBlock.appendChild(currentText);
      root.appendChild(currentBlock);
      currentInline = null;
    },

    getContent(): string {
      return content;
    },
  };
}

/**
 * TRUE INCREMENTAL DOM STREAMER
 *
 * Architecture: Stable Zone + Active Zone
 * - Stable Zone: Completed blocks, parsed ONCE, never re-parsed
 * - Active Zone: Current incomplete block, re-parsed on new chunks
 *
 * Memory: O(active_block_size) not O(total_content)
 *
 * Stable points are detected at:
 * - Blank lines (paragraph boundaries) outside code blocks
 * - Code block closures (```)
 */
export function createBatchedDomStreamer(container: HTMLElement) {
  // Content storage
  let content = '';
  let stableLength = 0;      // How much content is in stable zone
  let inCodeBlock = false;   // Track if stable zone ends inside code block
  let isEnded = false;

  // Two-zone DOM structure
  const stableZone = document.createElement('div');
  const activeZone = document.createElement('div');
  stableZone.className = 'streamark-stable';
  activeZone.className = 'streamark-active';
  container.appendChild(stableZone);
  container.appendChild(activeZone);

  // Reusable parser/renderer for active zone only
  const activeRenderer = createDomRenderer(activeZone);
  const activeParser = createParser(activeRenderer);

  /**
   * Find the next stable checkpoint in content.
   * A checkpoint is where we're confident content won't change meaning.
   */
  function findNextCheckpoint(fromPos: number, trackCodeBlock: boolean): { pos: number; inCodeBlock: boolean } {
    let pos = fromPos;
    let codeBlock = trackCodeBlock;
    let lastCheckpoint = -1;
    let checkpointCodeState = codeBlock;

    while (pos < content.length) {
      // Detect code fence at line start
      const atLineStart = pos === 0 || content[pos - 1] === '\n';
      if (atLineStart && content.slice(pos, pos + 3) === '```') {
        if (codeBlock) {
          // Closing code fence - this is a checkpoint!
          // Find end of line
          let lineEnd = content.indexOf('\n', pos + 3);
          if (lineEnd === -1) lineEnd = content.length;
          else lineEnd++; // Include the newline

          if (lineEnd < content.length) {
            lastCheckpoint = lineEnd;
            checkpointCodeState = false;
          }
        }
        codeBlock = !codeBlock;
        pos += 3;
        continue;
      }

      // Blank line outside code block = checkpoint
      if (!codeBlock && content[pos] === '\n') {
        // Look for blank line (two consecutive newlines)
        let newlineCount = 0;
        let scanPos = pos;
        while (scanPos < content.length && content[scanPos] === '\n') {
          newlineCount++;
          scanPos++;
        }

        if (newlineCount >= 2 && scanPos < content.length) {
          // Found blank line with content after - this is a checkpoint
          lastCheckpoint = scanPos;
          checkpointCodeState = false;
          pos = scanPos;
          continue;
        }
      }

      pos++;
    }

    return { pos: lastCheckpoint, inCodeBlock: checkpointCodeState };
  }

  /**
   * Process new content: move stable parts to stable zone, render active part
   */
  function process() {
    // Find new checkpoints
    const checkpoint = findNextCheckpoint(stableLength, inCodeBlock);

    if (checkpoint.pos > stableLength) {
      // New stable content found! Parse and append to stable zone
      const newStableContent = content.slice(stableLength, checkpoint.pos);

      // Create temp container to parse new stable content
      const tempContainer = document.createElement('div');
      const tempRenderer = createDomRenderer(tempContainer);
      const tempParser = createParser(tempRenderer);
      tempParser.write(newStableContent);
      tempParser.end();

      // Move parsed nodes to stable zone (no re-parsing ever!)
      while (tempContainer.firstChild) {
        stableZone.appendChild(tempContainer.firstChild);
      }

      // Update stable tracking
      stableLength = checkpoint.pos;
      inCodeBlock = checkpoint.inCodeBlock;
    }

    // Render active zone (only the unstable tail)
    const activeContent = content.slice(stableLength);
    activeZone.innerHTML = '';

    if (activeContent) {
      activeRenderer.start();
      activeParser.reset();
      const completed = activeContent + autoComplete(activeContent);
      activeParser.write(completed);
      activeParser.end();
    }
  }

  // RAF batching for active zone updates only
  let rafId: number | null = null;

  function scheduleProcess() {
    if (rafId !== null || isEnded) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      if (!isEnded) {
        process();
      }
    });
  }

  return {
    write(chunk: string): void {
      if (isEnded) return;
      content += chunk;
      scheduleProcess();
    },

    end(): void {
      if (isEnded) return;
      isEnded = true;

      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }

      // Final render: move everything to stable
      const remaining = content.slice(stableLength);
      if (remaining) {
        const tempContainer = document.createElement('div');
        const tempRenderer = createDomRenderer(tempContainer);
        const tempParser = createParser(tempRenderer);
        tempParser.write(remaining);
        tempParser.end();

        while (tempContainer.firstChild) {
          stableZone.appendChild(tempContainer.firstChild);
        }
        stableLength = content.length;
      }
      activeZone.innerHTML = '';
    },

    reset(): void {
      content = '';
      stableLength = 0;
      inCodeBlock = false;
      isEnded = false;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      stableZone.innerHTML = '';
      activeZone.innerHTML = '';
    },

    getContent(): string {
      return content;
    },
  };
}
