/**
 * Streamark React Hooks
 *
 * Optimized for streaming with:
 * - RAF-batched updates (no render storms)
 * - Stable token keys (minimal reconciliation)
 * - Memoized components
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createTokenizer } from '../core/tokenizer';
import { Token, StreamarkOptions, StreamarkInstance } from '../core/types';
import { renderToHtml, IncrementalRenderer, RenderOptions } from '../core/renderer';

export interface UseStreamingMarkdownOptions extends StreamarkOptions, RenderOptions {
  // Batching
  batchMs?: number;
}

export interface UseStreamingMarkdownResult {
  tokens: Token[];
  html: string;
  isStreaming: boolean;
  write: (chunk: string) => void;
  end: () => void;
  reset: () => void;
}

/**
 * Hook for streaming markdown parsing with batched updates
 */
export function useStreamingMarkdown(
  options: UseStreamingMarkdownOptions = {}
): UseStreamingMarkdownResult {
  const { batchMs = 16, ...parserOptions } = options;

  const [tokens, setTokens] = useState<Token[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);

  const tokenizerRef = useRef<StreamarkInstance | null>(null);
  const rendererRef = useRef<IncrementalRenderer | null>(null);
  const pendingTokensRef = useRef<Token[]>([]);
  const rafIdRef = useRef<number | null>(null);
  const lastUpdateRef = useRef<number>(0);

  // Initialize tokenizer and renderer
  useEffect(() => {
    tokenizerRef.current = createTokenizer(parserOptions);
    rendererRef.current = new IncrementalRenderer(parserOptions);

    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  // Flush pending tokens with RAF batching
  const flushPending = useCallback(() => {
    if (pendingTokensRef.current.length === 0) return;

    const allTokens = tokenizerRef.current?.getTokens() || [];
    setTokens([...allTokens]);
    pendingTokensRef.current = [];
    lastUpdateRef.current = performance.now();
  }, []);

  // Schedule batched update
  const scheduleUpdate = useCallback(() => {
    if (rafIdRef.current !== null) return;

    const timeSinceLastUpdate = performance.now() - lastUpdateRef.current;

    if (timeSinceLastUpdate >= batchMs) {
      // Enough time passed, update immediately
      flushPending();
    } else {
      // Schedule for next frame
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        flushPending();
      });
    }
  }, [batchMs, flushPending]);

  const write = useCallback((chunk: string) => {
    if (!tokenizerRef.current) return;

    setIsStreaming(true);
    const newTokens = tokenizerRef.current.write(chunk);
    pendingTokensRef.current.push(...newTokens);
    scheduleUpdate();
  }, [scheduleUpdate]);

  const end = useCallback(() => {
    if (!tokenizerRef.current) return;

    const finalTokens = tokenizerRef.current.end();
    pendingTokensRef.current.push(...finalTokens);
    flushPending();
    setIsStreaming(false);
  }, [flushPending]);

  const reset = useCallback(() => {
    tokenizerRef.current?.reset();
    rendererRef.current?.clear();
    pendingTokensRef.current = [];
    setTokens([]);
    setIsStreaming(false);

    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, []);

  // Memoize HTML rendering
  const html = useMemo(() => {
    if (!rendererRef.current) return '';
    return rendererRef.current.render(tokens);
  }, [tokens]);

  return {
    tokens,
    html,
    isStreaming,
    write,
    end,
    reset,
  };
}

/**
 * Hook for parsing complete markdown (non-streaming)
 */
export function useMarkdown(
  content: string,
  options: UseStreamingMarkdownOptions = {}
): { tokens: Token[]; html: string } {
  const tokenizer = useMemo(() => createTokenizer(options), []);
  const renderer = useMemo(() => new IncrementalRenderer(options), []);

  const result = useMemo(() => {
    tokenizer.reset();
    tokenizer.write(content);
    const tokens = tokenizer.end();
    const allTokens = tokenizer.getTokens();
    const html = renderer.render(allTokens);
    return { tokens: allTokens, html };
  }, [content, tokenizer, renderer]);

  return result;
}

/**
 * Hook for SSE/EventSource streaming with auto-parsing
 */
export function useSSEMarkdown(
  url: string | null,
  options: UseStreamingMarkdownOptions & {
    headers?: Record<string, string>;
    onError?: (error: Error) => void;
    onComplete?: () => void;
  } = {}
): UseStreamingMarkdownResult & { error: Error | null } {
  const { headers, onError, onComplete, ...markdownOptions } = options;
  const streaming = useStreamingMarkdown(markdownOptions);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!url) return;

    streaming.reset();
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    const fetchStream = async () => {
      try {
        const response = await fetch(url, {
          headers,
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('No response body');
        }

        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            streaming.end();
            onComplete?.();
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          streaming.write(chunk);
        }
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') {
          setError(err);
          onError?.(err);
        }
      }
    };

    fetchStream();

    return () => {
      controller.abort();
    };
  }, [url]);

  return { ...streaming, error };
}
