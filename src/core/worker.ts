/**
 * Streamark Web Worker
 * Offloads markdown parsing to a separate thread
 */

import { createStreamingParser, createTokenCollector, StreamingToken } from './streaming-tokenizer';

export interface WorkerMessage {
  type: 'write' | 'end' | 'reset';
  chunk?: string;
  id: number;
}

export interface WorkerResponse {
  type: 'tokens' | 'html' | 'done';
  tokens?: StreamingToken[];
  html?: string;
  id: number;
}

// Worker code as a string for inline worker creation
export const WORKER_CODE = `
const CHAR = {
  NEWLINE: 10, SPACE: 32, HASH: 35, ASTERISK: 42, PLUS: 43, MINUS: 45,
  DOT: 46, SLASH: 47, ZERO: 48, NINE: 57, COLON: 58, LT: 60, GT: 62,
  QUESTION: 63, BACKSLASH: 92, UNDERSCORE: 95, BACKTICK: 96,
  OPEN_BRACKET: 91, CLOSE_BRACKET: 93, OPEN_PAREN: 40, CLOSE_PAREN: 41,
  BANG: 33, TILDE: 126,
};

const TokenType = {
  Root: 0, Paragraph: 1, Text: 2, Bold: 3, Italic: 4, BoldItalic: 5,
  Code: 6, CodeBlock: 7, Heading1: 8, Heading2: 9, Heading3: 10,
  Heading4: 11, Heading5: 12, Heading6: 13, Blockquote: 14, Link: 15,
  Image: 16, ListItem: 17, HorizontalRule: 18, LineBreak: 19, Strikethrough: 20,
};

const MAX_DEPTH = 32;
const tokenStack = new Uint8Array(MAX_DEPTH);
let stackDepth = 0;
let pos = 0;
let lineStart = true;
let pending = '';
let escaped = false;
let inCodeBlock = false;
let codeBlockFence = '';
let html = '';

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const TAG_MAP = {
  0: ['', ''], 1: ['<p>', '</p>'], 2: ['', ''], 3: ['<strong>', '</strong>'],
  4: ['<em>', '</em>'], 5: ['<strong><em>', '</em></strong>'],
  6: ['<code>', '</code>'], 7: ['<pre><code>', '</code></pre>'],
  8: ['<h1>', '</h1>'], 9: ['<h2>', '</h2>'], 10: ['<h3>', '</h3>'],
  11: ['<h4>', '</h4>'], 12: ['<h5>', '</h5>'], 13: ['<h6>', '</h6>'],
  14: ['<blockquote>', '</blockquote>'], 15: ['<a>', '</a>'],
  16: ['<img', '>'], 17: ['<li>', '</li>'], 18: ['<hr>', ''],
  19: ['<br>', ''], 20: ['<del>', '</del>'],
};

function pushToken(type, attrs) {
  if (stackDepth < MAX_DEPTH) {
    tokenStack[stackDepth++] = type;
    let tag = TAG_MAP[type]?.[0] || '';
    if (type === 15 && attrs?.href) tag = '<a href="' + escapeHtml(attrs.href) + '" target="_blank" rel="noopener noreferrer">';
    if (type === 7 && attrs?.lang) tag = '<pre><code class="language-' + escapeHtml(attrs.lang) + '">';
    html += tag;
  }
}

function popToken() {
  if (stackDepth > 0) {
    const type = tokenStack[--stackDepth];
    html += TAG_MAP[type]?.[1] || '';
    return type;
  }
  return null;
}

function currentToken() {
  return stackDepth > 0 ? tokenStack[stackDepth - 1] : 0;
}

function hasToken(type) {
  for (let i = 0; i < stackDepth; i++) if (tokenStack[i] === type) return true;
  return false;
}

function closeTokensTo(type) {
  while (stackDepth > 0 && tokenStack[stackDepth - 1] !== type) popToken();
  if (stackDepth > 0) popToken();
}

function emitText(text) {
  if (text.length > 0) html += escapeHtml(text);
}

function processChar(char, code) {
  if (escaped) { emitText(char); escaped = false; return; }
  if (code === CHAR.BACKSLASH) { escaped = true; return; }

  if (inCodeBlock) {
    if (lineStart && char === codeBlockFence[0]) {
      pending += char;
      if (pending.length >= codeBlockFence.length && pending.startsWith(codeBlockFence)) {
        inCodeBlock = false; closeTokensTo(7); pending = ''; lineStart = false; return;
      }
    } else {
      if (pending) { emitText(pending); pending = ''; }
      emitText(char);
      lineStart = code === CHAR.NEWLINE;
    }
    return;
  }

  if (code === CHAR.NEWLINE) {
    if (pending) { emitText(pending); pending = ''; }
    while (stackDepth > 0 && tokenStack[stackDepth - 1] === 1) popToken();
    emitText('\\n');
    lineStart = true;
    return;
  }

  if (lineStart) {
    lineStart = false;
    if (code === CHAR.HASH) { pending += char; return; }
    if (pending.length > 0 && pending[0] === '#') {
      if (code === CHAR.SPACE && pending.length <= 6) {
        pushToken(8 + pending.length - 1, { level: pending.length });
        pending = ''; return;
      } else if (code !== CHAR.HASH) { emitText(pending); pending = ''; }
    }
    if (code === CHAR.BACKTICK || code === CHAR.TILDE) { pending += char; return; }
    if (pending.length >= 3 && (pending[0] === '\`' || pending[0] === '~')) {
      codeBlockFence = pending; pending = ''; inCodeBlock = true;
      pushToken(7); return;
    }
    if (code === CHAR.GT) { pushToken(14); return; }
    if (code === CHAR.MINUS || code === CHAR.ASTERISK || code === CHAR.PLUS) { pending += char; return; }
    if (pending.length === 1 && (pending[0] === '-' || pending[0] === '*' || pending[0] === '+')) {
      if (code === CHAR.SPACE) { pushToken(17); pending = ''; return; }
      else { emitText(pending); pending = ''; }
    }
  }

  if (pending && !/^[\`~#\\-*+_>]/.test(pending)) { emitText(pending); pending = ''; }

  if (code === CHAR.ASTERISK) { pending += char; return; }
  if (pending.startsWith('*')) {
    if (pending === '**') {
      if (hasToken(3)) closeTokensTo(3); else pushToken(3);
      pending = ''; return;
    } else if (pending === '*' && code !== CHAR.ASTERISK) {
      if (hasToken(4)) closeTokensTo(4); else pushToken(4);
      pending = '';
    }
  }

  if (code === CHAR.TILDE) { pending += char; return; }
  if (pending === '~~') {
    if (hasToken(20)) closeTokensTo(20); else pushToken(20);
    pending = ''; return;
  }

  if (code === CHAR.BACKTICK) {
    if (hasToken(6)) closeTokensTo(6); else pushToken(6);
    return;
  }

  if (pending) { emitText(pending); pending = ''; }
  if (currentToken() === 0) pushToken(1);
  emitText(char);
}

function write(chunk) {
  for (let i = 0; i < chunk.length; i++) {
    processChar(chunk[i], chunk.charCodeAt(i));
    pos++;
  }
}

function end() {
  if (pending) { emitText(pending); pending = ''; }
  while (stackDepth > 0) popToken();
}

function reset() {
  stackDepth = 0; pos = 0; lineStart = true; pending = '';
  escaped = false; inCodeBlock = false; codeBlockFence = ''; html = '';
}

self.onmessage = function(e) {
  const { type, chunk, id } = e.data;
  switch (type) {
    case 'write':
      write(chunk);
      self.postMessage({ type: 'html', html, id });
      break;
    case 'end':
      end();
      self.postMessage({ type: 'html', html, id });
      self.postMessage({ type: 'done', id });
      break;
    case 'reset':
      reset();
      self.postMessage({ type: 'done', id });
      break;
  }
};
`;

/**
 * Create a Web Worker for markdown parsing
 */
export function createWorkerParser(): {
  write: (chunk: string) => Promise<string>;
  end: () => Promise<string>;
  reset: () => Promise<void>;
  terminate: () => void;
} {
  const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);

  let messageId = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const { id, type, html } = e.data;
    const handler = pending.get(id);
    if (handler) {
      if (type === 'html' || type === 'done') {
        handler.resolve(html || '');
        pending.delete(id);
      }
    }
  };

  worker.onerror = (e) => {
    for (const handler of pending.values()) {
      handler.reject(new Error(e.message));
    }
    pending.clear();
  };

  function send<T>(message: Omit<WorkerMessage, 'id'>): Promise<T> {
    const id = messageId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ ...message, id });
    });
  }

  return {
    write: (chunk: string) => send<string>({ type: 'write', chunk }),
    end: () => send<string>({ type: 'end' }),
    reset: () => send<void>({ type: 'reset' }),
    terminate: () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    },
  };
}
