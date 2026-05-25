import { memo, useCallback } from 'react';
import type { KeyboardEvent } from 'react';

interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  onClear: () => void;
  isRunning: boolean;
}

export const PromptInput = memo(({
  value,
  onChange,
  onSubmit,
  onStop,
  onClear,
  isRunning,
}: PromptInputProps) => {
  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmit();
    }
  }, [onSubmit]);

  return (
    <div className="prompt-container">
      <textarea
        className="prompt-input"
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Enter your prompt... (Ctrl/Cmd + Enter to submit)"
        rows={3}
        disabled={isRunning}
      />
      <div className="prompt-actions">
        {isRunning ? (
          <button className="btn btn-stop" onClick={onStop}>
            Stop All
          </button>
        ) : (
          <button
            className="btn btn-primary"
            onClick={onSubmit}
            disabled={!value.trim()}
          >
            Send to All Models
          </button>
        )}
        <button className="btn btn-secondary" onClick={onClear}>
          Clear
        </button>
      </div>
    </div>
  );
});

PromptInput.displayName = 'PromptInput';
