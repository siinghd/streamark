import { useState, useCallback, useRef, useEffect } from 'react';
import { ModelPanel } from './components/ModelPanel';
import { PromptInput } from './components/PromptInput';
import { Stats } from './components/Stats';
import { ModeSelector } from './components/ModeSelector';
import { MarkdownTester } from './components/MarkdownTester';
import './styles.css';
import '../../src/styles/streamark.css';

// Models to compare
const MODELS = [
  { id: 'xiaomi/mimo-v2-flash:free', name: 'Xiaomi MiMo V2' },
  { id: 'nvidia/nemotron-3-nano-30b-a3b:free', name: 'Nvidia Nemotron' },
  { id: 'allenai/molmo-2-8b:free', name: 'AllenAI Molmo' },
  { id: 'mistralai/devstral-2512:free', name: 'Mistral Devstral' },
  { id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder' },
];

const OPENROUTER_API_KEY = (import.meta.env.VITE_OPENROUTER_API_KEY as string) || '';

export type RenderMode = 'react' | 'dom' | 'stream' | 'zero' | 'worker';

export interface ModelState {
  isStreaming: boolean;
  error: string | null;
  startTime: number | null;
  endTime: number | null;
  charCount: number;
  renderTime: number;
}

// Chunk callback type - allows direct streaming to panels without state
export type ChunkCallback = (chunk: string) => void;

export default function App() {
  const [prompt, setPrompt] = useState('');
  const [modelStates, setModelStates] = useState<Record<string, ModelState>>({});
  const [isRunning, setIsRunning] = useState(false);
  const [renderMode, setRenderMode] = useState<RenderMode>('stream');
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  // Chunk callbacks for each model - allows bypassing React state
  const chunkCallbacksRef = useRef<Map<string, ChunkCallback>>(new Map());

  // Content getter callbacks - each ModelPanel registers how to get its content
  const contentGettersRef = useRef<Map<string, () => string>>(new Map());

  // Register chunk callback from ModelPanel
  const registerChunkCallback = useCallback((modelId: string, callback: ChunkCallback) => {
    chunkCallbacksRef.current.set(modelId, callback);
  }, []);

  // Register content getter from ModelPanel (streamer is source of truth)
  const registerContentGetter = useCallback((modelId: string, getter: () => string) => {
    contentGettersRef.current.set(modelId, getter);
  }, []);

  // Get content for a model (delegates to ModelPanel's streamer)
  const getModelContent = useCallback((modelId: string) => {
    const getter = contentGettersRef.current.get(modelId);
    return getter ? getter() : '';
  }, []);

  // Initialize model states
  useEffect(() => {
    const initial: Record<string, ModelState> = {};
    for (const model of MODELS) {
      initial[model.id] = {
        isStreaming: false,
        error: null,
        startTime: null,
        endTime: null,
        charCount: 0,
        renderTime: 0,
      };
    }
    setModelStates(initial);
  }, []);

  const streamFromModel = useCallback(async (modelId: string, userPrompt: string) => {
    const controller = new AbortController();
    abortControllersRef.current.set(modelId, controller);

    // Track char count locally (no content storage in App)
    let totalChars = 0;

    // Update state once at start
    setModelStates(prev => ({
      ...prev,
      [modelId]: {
        ...prev[modelId],
        isStreaming: true,
        error: null,
        startTime: performance.now(),
        endTime: null,
        charCount: 0,
        renderTime: 0,
      },
    }));

    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': window.location.origin,
          'X-Title': 'Streamark Test',
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: userPrompt }],
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      const chunkCallback = chunkCallbacksRef.current.get(modelId);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(line => line.trim() !== '');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content || '';
              if (content) {
                totalChars += content.length;

                // Send chunk directly to panel (bypasses React)
                // Panel's streamer is the only place content is stored
                if (chunkCallback) {
                  chunkCallback(content);
                }
              }
            } catch {
              // Ignore parse errors for incomplete chunks
            }
          }
        }
      }

      // Update state once at end
      setModelStates(prev => ({
        ...prev,
        [modelId]: {
          ...prev[modelId],
          isStreaming: false,
          endTime: performance.now(),
          charCount: totalChars,
        },
      }));
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setModelStates(prev => ({
          ...prev,
          [modelId]: {
            ...prev[modelId],
            isStreaming: false,
            error: err.message,
            endTime: performance.now(),
          },
        }));
      }
    } finally {
      abortControllersRef.current.delete(modelId);
    }
  }, []);

  const handleSubmit = useCallback(() => {
    if (!prompt.trim() || isRunning) return;

    setIsRunning(true);

    // Start all models concurrently
    const promises = MODELS.map(model => streamFromModel(model.id, prompt));

    Promise.all(promises).finally(() => {
      setIsRunning(false);
    });
  }, [prompt, isRunning, streamFromModel]);

  const handleStop = useCallback(() => {
    for (const controller of abortControllersRef.current.values()) {
      controller.abort();
    }
    abortControllersRef.current.clear();
    setIsRunning(false);

    setModelStates(prev => {
      const updated = { ...prev };
      for (const model of MODELS) {
        updated[model.id] = { ...updated[model.id], isStreaming: false };
      }
      return updated;
    });
  }, []);

  const handleClear = useCallback(() => {
    handleStop();
    setPrompt('');

    setModelStates(prev => {
      const updated = { ...prev };
      for (const model of MODELS) {
        updated[model.id] = {
          isStreaming: false,
          error: null,
          startTime: null,
          endTime: null,
          charCount: 0,
          renderTime: 0,
        };
      }
      return updated;
    });
  }, [handleStop]);

  const handleRenderTime = useCallback((modelId: string, time: number) => {
    setModelStates(prev => ({
      ...prev,
      [modelId]: { ...prev[modelId], renderTime: time },
    }));
  }, []);

  return (
    <div className="app">
      <header className="header">
        <h1>Streamark</h1>
        <span className="subtitle">Ultra-fast Streaming Markdown Parser</span>
        <a
          href="https://github.com/anthropics/streamark"
          target="_blank"
          rel="noopener noreferrer"
          className="github-link"
        >
          GitHub
        </a>
      </header>

      <div className="controls-row">
        <ModeSelector mode={renderMode} onModeChange={setRenderMode} />
      </div>

      <PromptInput
        value={prompt}
        onChange={setPrompt}
        onSubmit={handleSubmit}
        onStop={handleStop}
        onClear={handleClear}
        isRunning={isRunning}
      />

      <Stats modelStates={modelStates} models={MODELS} />

      <div className="panels-container">
        {MODELS.map(model => (
          <ModelPanel
            key={model.id}
            modelId={model.id}
            modelName={model.name}
            state={modelStates[model.id]}
            renderMode={renderMode}
            onRenderTime={handleRenderTime}
            onRegisterChunkCallback={registerChunkCallback}
            onRegisterContentGetter={registerContentGetter}
            getContent={getModelContent}
          />
        ))}
      </div>

      <MarkdownTester />

      <footer className="footer">
        <div className="comparison">
          <h3>vs Other Libraries</h3>
          <table className="comparison-table">
            <thead>
              <tr>
                <th>Feature</th>
                <th>react-markdown</th>
                <th>Vercel streamdown</th>
                <th>Streamark</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Parse strategy</td>
                <td className="bad">Full re-parse</td>
                <td className="ok">Memoized</td>
                <td className="good">Character-level incremental</td>
              </tr>
              <tr>
                <td>Speculative rendering</td>
                <td className="bad">No</td>
                <td className="good">Yes</td>
                <td className="good">Yes</td>
              </tr>
              <tr>
                <td>Web Worker</td>
                <td className="bad">No</td>
                <td className="bad">No</td>
                <td className="good">Yes</td>
              </tr>
              <tr>
                <td>DOM bypass</td>
                <td className="bad">No</td>
                <td className="bad">No</td>
                <td className="good">Yes</td>
              </tr>
              <tr>
                <td>Bundle size</td>
                <td className="bad">~50kB</td>
                <td className="bad">~50kB+</td>
                <td className="good">~5kB</td>
              </tr>
            </tbody>
          </table>
        </div>
      </footer>
    </div>
  );
}
