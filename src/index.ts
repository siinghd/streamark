/**
 * Streamark - Ultra-fast Streaming Markdown Parser
 *
 * Optimized for LLM response streaming with:
 * - Character-level state machine parsing
 * - Auto-completion for incomplete markdown
 * - GFM support (tables, strikethrough, task lists)
 * - RAF-batched updates (no render storms)
 * - Built-in XSS protection
 * - Zero dependencies
 */

// Main SMD parser exports
export {
  createParser,
  createHtmlRenderer,
  parse,
  autoComplete,
  StreamingParser,
  Token,
} from './core/smd';

export type {
  Renderer,
  BlockAttrs,
  InlineAttrs,
  Align,
} from './core/smd';

// DOM renderer exports (for direct DOM manipulation - most memory efficient)
export {
  createDomRenderer,
  createDomStreamer,
  createBatchedDomStreamer,
  createZeroAllocStreamer,
  createStreamingRenderer,
} from './core/dom-renderer';

// Utility exports
export {
  hashString,
  escapeHtml,
  sanitizeHtml,
  RingBuffer,
  rafBatch,
  debounce,
} from './core/utils';
