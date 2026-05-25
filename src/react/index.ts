/**
 * Streamark React Bindings
 */

// v1 hooks (line-based)
export { useStreamingMarkdown, useMarkdown, useSSEMarkdown } from './hooks';
export type { UseStreamingMarkdownOptions, UseStreamingMarkdownResult } from './hooks';

// v2 hooks (character-level streaming)
export { useStreamingMarkdownV2, useOpenRouterStream } from './hooks-v2';
export type { UseStreamingMarkdownV2Options, UseStreamingMarkdownV2Result } from './hooks-v2';

// Components
export { Markdown, TokenRenderer, DEFAULT_COMPONENTS } from './components';
export type { MarkdownProps, TokenProps, StreamingMarkdownProps } from './components';
