/**
 * Streamark Utilities
 * High-performance helper functions
 */

/**
 * Fast string hashing using FNV-1a algorithm
 * Produces stable 32-bit integers for content-addressed IDs
 */
export function hashString(str: string): number {
  let hash = 2166136261; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619); // FNV prime
  }
  return hash >>> 0; // Convert to unsigned
}

/**
 * Escape HTML entities for safe rendering
 */
const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, char => HTML_ESCAPE_MAP[char]);
}

/**
 * Sanitize HTML content - removes dangerous elements and attributes
 * These constants are exported for advanced usage
 */
export const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'div', 'dl', 'dt',
  'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd',
  'li', 'ol', 'p', 'pre', 'q', 's', 'span', 'strong', 'sub', 'sup', 'table',
  'tbody', 'td', 'th', 'thead', 'tr', 'ul', 'mark',
]);

export const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title', 'rel', 'target']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  td: new Set(['colspan', 'rowspan', 'align']),
  th: new Set(['colspan', 'rowspan', 'align']),
  code: new Set(['class']),
  pre: new Set(['class']),
  span: new Set(['class']),
  div: new Set(['class']),
};

export const DANGEROUS_PROTOCOLS = /^(javascript|vbscript|data):/i;

export function sanitizeHtml(html: string): string {
  // Simple but effective HTML sanitization
  // For production, consider using DOMPurify
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/on\w+\s*=/gi, 'data-removed=')
    .replace(/javascript:/gi, '')
    .replace(/vbscript:/gi, '')
    .replace(/<iframe\b[^>]*>/gi, '')
    .replace(/<\/iframe>/gi, '');
}

/**
 * Debounce function for batching updates
 */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number
): T & { cancel: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const debounced = ((...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delay);
  }) as T & { cancel: () => void };

  debounced.cancel = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  return debounced;
}

/**
 * RAF-based batching for smooth rendering
 */
export function rafBatch<T>(callback: (items: T[]) => void): (item: T) => void {
  const pending: T[] = [];
  let rafId: number | null = null;

  return (item: T) => {
    pending.push(item);

    if (rafId === null) {
      rafId = requestAnimationFrame(() => {
        const items = pending.splice(0);
        callback(items);
        rafId = null;
      });
    }
  };
}

/**
 * Ring buffer for efficient streaming input
 * Avoids O(n) string concatenation
 */
export class RingBuffer {
  private buffer: string[];
  private head = 0;
  private tail = 0;
  private size = 0;
  private capacity: number;

  constructor(capacity = 1024) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  write(chunk: string): void {
    // If chunk is larger than remaining space, grow buffer
    if (this.size + chunk.length > this.capacity) {
      this.grow(Math.max(this.capacity * 2, this.size + chunk.length));
    }

    for (const char of chunk) {
      this.buffer[this.tail] = char;
      this.tail = (this.tail + 1) % this.capacity;
      this.size++;
    }
  }

  read(count: number): string {
    const result: string[] = [];
    const toRead = Math.min(count, this.size);

    for (let i = 0; i < toRead; i++) {
      result.push(this.buffer[this.head]);
      this.head = (this.head + 1) % this.capacity;
      this.size--;
    }

    return result.join('');
  }

  peek(count: number): string {
    const result: string[] = [];
    const toPeek = Math.min(count, this.size);
    let pos = this.head;

    for (let i = 0; i < toPeek; i++) {
      result.push(this.buffer[pos]);
      pos = (pos + 1) % this.capacity;
    }

    return result.join('');
  }

  get length(): number {
    return this.size;
  }

  clear(): void {
    this.head = 0;
    this.tail = 0;
    this.size = 0;
  }

  private grow(newCapacity: number): void {
    const newBuffer = new Array(newCapacity);
    let pos = this.head;

    for (let i = 0; i < this.size; i++) {
      newBuffer[i] = this.buffer[pos];
      pos = (pos + 1) % this.capacity;
    }

    this.buffer = newBuffer;
    this.head = 0;
    this.tail = this.size;
    this.capacity = newCapacity;
  }

  toString(): string {
    return this.peek(this.size);
  }
}
