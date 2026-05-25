import { memo } from 'react';
import type { RenderMode } from '../App';

interface ModeSelectorProps {
  mode: RenderMode;
  onModeChange: (mode: RenderMode) => void;
}

const MODES: { id: RenderMode; label: string; description: string }[] = [
  {
    id: 'stream',
    label: 'Stream',
    description: 'Character-by-character rendering, minimal allocations (RECOMMENDED)',
  },
  {
    id: 'dom',
    label: 'DOM Bypass',
    description: 'Incremental parsing with stable/active zones',
  },
  {
    id: 'react',
    label: 'React',
    description: 'Standard React rendering (high memory usage)',
  },
  {
    id: 'zero',
    label: 'Zero Alloc',
    description: 'No parsing, just text (for memory profiling)',
  },
  {
    id: 'worker',
    label: 'Web Worker',
    description: 'Parsing offloaded to Web Worker thread',
  },
];

export const ModeSelector = memo(({ mode, onModeChange }: ModeSelectorProps) => {
  return (
    <div className="mode-selector">
      <span className="mode-label">Render Mode:</span>
      <div className="mode-buttons">
        {MODES.map(m => (
          <button
            key={m.id}
            className={`mode-btn ${mode === m.id ? 'active' : ''}`}
            onClick={() => onModeChange(m.id)}
            title={m.description}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
});

ModeSelector.displayName = 'ModeSelector';
