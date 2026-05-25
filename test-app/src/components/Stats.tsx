import { memo, useMemo } from 'react';
import type { ModelState } from '../App';

interface StatsProps {
  modelStates: Record<string, ModelState>;
  models: { id: string; name: string }[];
}

export const Stats = memo(({ modelStates, models }: StatsProps) => {
  const stats = useMemo(() => {
    const activeCount = Object.values(modelStates).filter(s => s?.isStreaming).length;
    const completedCount = Object.values(modelStates).filter(
      s => s?.endTime && !s.error
    ).length;
    const errorCount = Object.values(modelStates).filter(s => s?.error).length;

    const totalChars = Object.values(modelStates).reduce(
      (sum, s) => sum + (s?.charCount || 0),
      0
    );

    // Find fastest model
    let fastest: { name: string; speed: number } | null = null;
    for (const model of models) {
      const state = modelStates[model.id];
      if (state?.startTime && state.endTime && state.charCount > 0) {
        const speed = state.charCount / ((state.endTime - state.startTime) / 1000);
        if (!fastest || speed > fastest.speed) {
          fastest = { name: model.name, speed };
        }
      }
    }

    return { activeCount, completedCount, errorCount, totalChars, fastest };
  }, [modelStates, models]);

  return (
    <div className="stats-bar">
      <div className="stat">
        <span className="stat-label">Active</span>
        <span className={`stat-value ${stats.activeCount > 0 ? 'active' : ''}`}>
          {stats.activeCount}
        </span>
      </div>
      <div className="stat">
        <span className="stat-label">Completed</span>
        <span className="stat-value success">{stats.completedCount}</span>
      </div>
      <div className="stat">
        <span className="stat-label">Errors</span>
        <span className={`stat-value ${stats.errorCount > 0 ? 'error' : ''}`}>
          {stats.errorCount}
        </span>
      </div>
      <div className="stat">
        <span className="stat-label">Total Chars</span>
        <span className="stat-value">{stats.totalChars.toLocaleString()}</span>
      </div>
      {stats.fastest && (
        <div className="stat fastest">
          <span className="stat-label">Fastest</span>
          <span className="stat-value">
            {stats.fastest.name} ({Math.round(stats.fastest.speed)} c/s)
          </span>
        </div>
      )}
    </div>
  );
});

Stats.displayName = 'Stats';
