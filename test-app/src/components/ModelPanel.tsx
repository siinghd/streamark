import { memo, useRef, useEffect, useState, useCallback } from 'react';
import { createBatchedDomStreamer, createZeroAllocStreamer, createStreamingRenderer } from '../../../src/core/dom-renderer';
import { parse, autoComplete } from '../../../src/core/smd';
import type { ModelState, RenderMode, ChunkCallback } from '../App';

interface ModelPanelProps {
  modelId: string;
  modelName: string;
  state: ModelState | undefined;
  renderMode: RenderMode;
  onRenderTime: (modelId: string, time: number) => void;
  onRegisterChunkCallback: (modelId: string, callback: ChunkCallback) => void;
  onRegisterContentGetter: (modelId: string, getter: () => string) => void;
  getContent: (modelId: string) => string;
}

export const ModelPanel = memo(({ modelId, modelName, state, renderMode, onRenderTime, onRegisterChunkCallback, onRegisterContentGetter, getContent }: ModelPanelProps) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const domContainerRef = useRef<HTMLDivElement | null>(null);
  const streamerRef = useRef<ReturnType<typeof createBatchedDomStreamer> | null>(null);
  const reactContentRef = useRef<string>(''); // For React mode content storage
  const [showRaw, setShowRaw] = useState(false);
  const [rawContent, setRawContent] = useState('');
  const [reactHtml, setReactHtml] = useState('');
  const rafIdRef = useRef<number | null>(null);

  // For React mode: register callback that updates state via RAF (for comparison - uses more memory)
  useEffect(() => {
    if (renderMode === 'react' && !showRaw) {
      // Clear content ref on init
      reactContentRef.current = '';

      // Register content getter for React mode
      onRegisterContentGetter(modelId, () => reactContentRef.current);

      onRegisterChunkCallback(modelId, (chunk: string) => {
        // Accumulate content in ref
        reactContentRef.current += chunk;

        // Batch React updates with RAF
        if (rafIdRef.current === null) {
          rafIdRef.current = requestAnimationFrame(() => {
            rafIdRef.current = null;
            const content = reactContentRef.current;
            const startTime = performance.now();
            const toRender = state?.isStreaming ? content + autoComplete(content) : content;
            const html = parse(toRender);
            setReactHtml(html);
            const elapsed = performance.now() - startTime;
            if (elapsed > 0.1) {
              onRenderTime(modelId, elapsed);
            }
          });
        }
      });

      return () => {
        if (rafIdRef.current !== null) {
          cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
      };
    }
  }, [modelId, renderMode, showRaw, onRegisterChunkCallback, onRegisterContentGetter, onRenderTime, state?.isStreaming]);

  // For DOM mode: create stable container and initialize streamer together
  useEffect(() => {
    if (renderMode === 'dom' && contentRef.current && !showRaw) {
      // Create container
      const container = document.createElement('div');
      container.className = 'streamark';
      contentRef.current.appendChild(container);
      domContainerRef.current = container;

      // Create streamer for this container
      const streamer = createBatchedDomStreamer(container);
      streamerRef.current = streamer;

      // Register content getter - streamer is the source of truth
      onRegisterContentGetter(modelId, () => streamer.getContent());

      // Register chunk callback - this bypasses React state entirely
      onRegisterChunkCallback(modelId, (chunk: string) => {
        const startTime = performance.now();
        streamer.write(chunk);
        const elapsed = performance.now() - startTime;
        if (elapsed > 0.1) {
          onRenderTime(modelId, elapsed);
        }
      });

      return () => {
        // Cleanup
        streamerRef.current = null;
        if (container.parentNode) {
          container.parentNode.removeChild(container);
        }
        domContainerRef.current = null;
      };
    }
  }, [modelId, renderMode, showRaw, onRegisterChunkCallback, onRegisterContentGetter, onRenderTime]);

  // For Stream mode: character-by-character rendering with minimal allocations
  useEffect(() => {
    if (renderMode === 'stream' && contentRef.current && !showRaw) {
      const container = document.createElement('div');
      contentRef.current.appendChild(container);
      domContainerRef.current = container;

      const streamer = createStreamingRenderer(container);
      streamerRef.current = streamer;

      onRegisterContentGetter(modelId, () => streamer.getContent());
      onRegisterChunkCallback(modelId, (chunk: string) => {
        streamer.write(chunk);
      });

      return () => {
        streamerRef.current = null;
        if (container.parentNode) {
          container.parentNode.removeChild(container);
        }
        domContainerRef.current = null;
      };
    }
  }, [modelId, renderMode, showRaw, onRegisterChunkCallback, onRegisterContentGetter]);

  // For Zero mode: absolute minimal, no parsing - just text
  useEffect(() => {
    if (renderMode === 'zero' && contentRef.current && !showRaw) {
      const container = document.createElement('div');
      contentRef.current.appendChild(container);
      domContainerRef.current = container;

      const streamer = createZeroAllocStreamer(container);
      streamerRef.current = streamer;

      onRegisterContentGetter(modelId, () => streamer.getContent());
      onRegisterChunkCallback(modelId, (chunk: string) => {
        streamer.write(chunk);
      });

      return () => {
        streamerRef.current = null;
        if (container.parentNode) {
          container.parentNode.removeChild(container);
        }
        domContainerRef.current = null;
      };
    }
  }, [modelId, renderMode, showRaw, onRegisterChunkCallback, onRegisterContentGetter]);

  // Handle streaming end - finalize the DOM (for DOM mode)
  useEffect(() => {
    if (renderMode === 'dom' && state && !state.isStreaming && state.charCount > 0 && streamerRef.current) {
      streamerRef.current.end();
    }
  }, [renderMode, state?.isStreaming, state?.charCount]);

  // Handle streaming end - final render (for React mode)
  useEffect(() => {
    if (renderMode === 'react' && state && !state.isStreaming && state.charCount > 0) {
      const content = reactContentRef.current;
      const startTime = performance.now();
      const html = parse(content);
      setReactHtml(html);
      const elapsed = performance.now() - startTime;
      onRenderTime(modelId, elapsed);
    }
  }, [modelId, renderMode, state?.isStreaming, state?.charCount, onRenderTime]);

  // Reset streamer when streaming starts (charCount resets to 0)
  useEffect(() => {
    if (state?.isStreaming && state.charCount === 0) {
      if (renderMode === 'dom' && streamerRef.current) {
        streamerRef.current.reset();
      }
      if (renderMode === 'react') {
        reactContentRef.current = '';
        setReactHtml('');
      }
    }
  }, [renderMode, state?.isStreaming, state?.charCount]);

  // Auto-scroll during streaming
  useEffect(() => {
    if (state?.isStreaming && contentRef.current) {
      const scrollInterval = setInterval(() => {
        if (contentRef.current) {
          contentRef.current.scrollTop = contentRef.current.scrollHeight;
        }
      }, 100);
      return () => clearInterval(scrollInterval);
    }
  }, [state?.isStreaming]);

  // Update raw content when switching to raw view
  useEffect(() => {
    if (showRaw) {
      setRawContent(getContent(modelId));
      // Set up interval to update raw content during streaming
      if (state?.isStreaming) {
        const interval = setInterval(() => {
          setRawContent(getContent(modelId));
        }, 200);
        return () => clearInterval(interval);
      }
    }
  }, [modelId, showRaw, state?.isStreaming, getContent]);

  const duration = state?.startTime && state?.endTime
    ? ((state.endTime - state.startTime) / 1000).toFixed(2)
    : state?.startTime
      ? 'streaming...'
      : '-';

  const charPerSec = state?.startTime && state?.endTime && state.charCount > 0
    ? Math.round(state.charCount / ((state.endTime - state.startTime) / 1000))
    : '-';

  const handleCopyRaw = useCallback(() => {
    const content = getContent(modelId);
    if (content) {
      navigator.clipboard.writeText(content);
    }
  }, [modelId, getContent]);

  return (
    <div className={`panel ${state?.isStreaming ? 'streaming' : ''} ${state?.error ? 'error' : ''}`}>
      <div className="panel-header">
        <div className="model-name">
          {state?.isStreaming && <span className="streaming-indicator" />}
          {modelName}
        </div>
        <div className="panel-stats">
          <span title="Characters">{state?.charCount || 0} chars</span>
          <span title="Duration">{duration}s</span>
          <span title="Speed">{charPerSec} c/s</span>
          {state?.renderTime ? (
            <span title="Render time" className="render-time">
              {state.renderTime.toFixed(1)}ms
            </span>
          ) : null}
        </div>
      </div>

      <div className="panel-actions">
        <button
          className={`panel-btn ${!showRaw ? 'active' : ''}`}
          onClick={() => setShowRaw(false)}
          title="Show rendered markdown"
        >
          Rendered
        </button>
        <button
          className={`panel-btn ${showRaw ? 'active' : ''}`}
          onClick={() => setShowRaw(true)}
          title="Show raw markdown"
        >
          Raw
        </button>
        {showRaw && rawContent && (
          <button
            className="panel-btn copy-btn"
            onClick={handleCopyRaw}
            title="Copy raw markdown"
          >
            Copy
          </button>
        )}
      </div>

      <div className="panel-content" ref={contentRef}>
        {state?.error ? (
          <div className="error-message">{state.error}</div>
        ) : showRaw ? (
          rawContent ? (
            <pre className="raw-markdown">{rawContent}</pre>
          ) : (
            <div className="placeholder">Waiting for response...</div>
          )
        ) : renderMode === 'react' ? (
          reactHtml ? (
            <div className="streamark" dangerouslySetInnerHTML={{ __html: reactHtml }} />
          ) : (
            <div className="placeholder">Waiting for response...</div>
          )
        ) : renderMode === 'dom' || renderMode === 'stream' || renderMode === 'zero' ? (
          // DOM container is managed imperatively via domContainerRef - don't render anything here
          // Show placeholder only when not streaming and no content
          state?.charCount === 0 && !state?.isStreaming ? (
            <div className="placeholder">Waiting for response...</div>
          ) : null
        ) : (
          <div className="placeholder">Waiting for response...</div>
        )}
      </div>
    </div>
  );
});

ModelPanel.displayName = 'ModelPanel';
