/**
 * Streamark React Hooks v2
 *
 * New features:
 * - Character-level streaming
 * - Speculative rendering
 * - Web Worker offload option
 * - Direct DOM bypass mode
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  createStreamingParser,
  createTokenCollector,
  createDOMRenderer,
  StreamingToken,
  Renderer,
} from '../core/streaming-tokenizer';
import { createWorkerParser } from '../core/worker';

export interface UseStreamingMarkdownV2Options {
  // Performance modes
  mode?: 'react' | 'dom' | 'worker';

  // Batching
  batchMs?: number;

  // Container for DOM mode
  containerRef?: React.RefObject<HTMLElement>;
}

export interface UseStreamingMarkdownV2Result {
  html: string;
  tokens: StreamingToken[];
  isStreaming: boolean;
  write: (chunk: string) => void;
  end: () => void;
  reset: () => void;
  stats: {
    charCount: number;
    tokenCount: number;
    renderTime: number;
  };
}

/**
 * High-performance streaming markdown hook
 */
export function useStreamingMarkdownV2(
  options: UseStreamingMarkdownV2Options = {}
): UseStreamingMarkdownV2Result {
  const { mode = 'react', batchMs = 16, containerRef } = options;

  const [html, setHtml] = useState('');
  const [tokens, setTokens] = useState<StreamingToken[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [stats, setStats] = useState({ charCount: 0, tokenCount: 0, renderTime: 0 });

  const parserRef = useRef<ReturnType<typeof createStreamingParser> | null>(null);
  const rendererRef = useRef<Renderer & { getHTML?: () => string } | null>(null);
  const workerRef = useRef<ReturnType<typeof createWorkerParser> | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const pendingChunksRef = useRef<string[]>([]);
  const lastUpdateRef = useRef<number>(0);
  const charCountRef = useRef(0);

  // Initialize parser based on mode
  useEffect(() => {
    if (mode === 'worker') {
      workerRef.current = createWorkerParser();
    } else if (mode === 'dom' && containerRef?.current) {
      rendererRef.current = createDOMRenderer(containerRef.current);
      parserRef.current = createStreamingParser(rendererRef.current);
    } else {
      // React mode - use token collector
      const collector = createTokenCollector();
      rendererRef.current = collector;
      parserRef.current = createStreamingParser(collector);
    }

    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
      if (workerRef.current) {
        workerRef.current.terminate();
      }
    };
  }, [mode, containerRef]);

  // Flush pending chunks with RAF batching
  const flushPending = useCallback(() => {
    const chunks = pendingChunksRef.current;
    if (chunks.length === 0) return;

    const startTime = performance.now();
    const combined = chunks.join('');
    pendingChunksRef.current = [];
    charCountRef.current += combined.length;

    if (mode === 'worker' && workerRef.current) {
      workerRef.current.write(combined).then(newHtml => {
        setHtml(newHtml);
        setStats(prev => ({
          ...prev,
          charCount: charCountRef.current,
          renderTime: performance.now() - startTime,
        }));
      });
    } else if (parserRef.current) {
      parserRef.current.write(combined);

      if (mode === 'react' && rendererRef.current && 'getHTML' in rendererRef.current) {
        setHtml(rendererRef.current.getHTML!());
        setTokens([...parserRef.current.getTokens()]);
      }

      setStats(prev => ({
        ...prev,
        charCount: charCountRef.current,
        tokenCount: parserRef.current?.getTokens().length || 0,
        renderTime: performance.now() - startTime,
      }));
    }

    lastUpdateRef.current = performance.now();
  }, [mode]);

  // Schedule batched update
  const scheduleUpdate = useCallback(() => {
    if (rafIdRef.current !== null) return;

    const timeSinceLastUpdate = performance.now() - lastUpdateRef.current;

    if (timeSinceLastUpdate >= batchMs) {
      flushPending();
    } else {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        flushPending();
      });
    }
  }, [batchMs, flushPending]);

  const write = useCallback((chunk: string) => {
    setIsStreaming(true);
    pendingChunksRef.current.push(chunk);
    scheduleUpdate();
  }, [scheduleUpdate]);

  const end = useCallback(async () => {
    // Flush any remaining content
    flushPending();

    if (mode === 'worker' && workerRef.current) {
      const finalHtml = await workerRef.current.end();
      setHtml(finalHtml);
    } else if (parserRef.current) {
      parserRef.current.end();
      if (mode === 'react' && rendererRef.current && 'getHTML' in rendererRef.current) {
        setHtml(rendererRef.current.getHTML!());
        setTokens([...parserRef.current.getTokens()]);
      }
    }

    setIsStreaming(false);
  }, [mode, flushPending]);

  const reset = useCallback(async () => {
    pendingChunksRef.current = [];
    charCountRef.current = 0;

    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }

    if (mode === 'worker' && workerRef.current) {
      await workerRef.current.reset();
    } else if (parserRef.current) {
      parserRef.current.reset();
    }

    // Re-initialize collector for react mode
    if (mode === 'react') {
      const collector = createTokenCollector();
      rendererRef.current = collector;
      parserRef.current = createStreamingParser(collector);
    }

    if (mode === 'dom' && containerRef?.current) {
      containerRef.current.innerHTML = '';
      rendererRef.current = createDOMRenderer(containerRef.current);
      parserRef.current = createStreamingParser(rendererRef.current);
    }

    setHtml('');
    setTokens([]);
    setIsStreaming(false);
    setStats({ charCount: 0, tokenCount: 0, renderTime: 0 });
  }, [mode, containerRef]);

  return {
    html,
    tokens,
    isStreaming,
    write,
    end,
    reset,
    stats,
  };
}

/**
 * Hook for OpenRouter streaming with automatic parsing
 */
export function useOpenRouterStream(
  apiKey: string,
  model: string,
  options: UseStreamingMarkdownV2Options = {}
) {
  const markdown = useStreamingMarkdownV2(options);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(async (prompt: string) => {
    if (abortRef.current) {
      abortRef.current.abort();
    }

    markdown.reset();
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': window.location.origin,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const data = JSON.parse(line.slice(6));
              const content = data.choices?.[0]?.delta?.content;
              if (content) {
                markdown.write(content);
              }
            } catch {
              // Ignore parse errors
            }
          }
        }
      }

      await markdown.end();
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setError(err);
      }
    }
  }, [apiKey, model, markdown]);

  const stop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  return {
    ...markdown,
    error,
    send,
    stop,
  };
}
