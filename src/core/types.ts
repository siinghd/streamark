/**
 * Streamark - Streaming Markdown Parser Types
 * Optimized for LLM response streaming
 */

export const enum TokenType {
  // Block-level
  Paragraph = 1,
  Heading = 2,
  CodeBlock = 3,
  Blockquote = 4,
  List = 5,
  ListItem = 6,
  HorizontalRule = 7,
  Table = 8,
  TableRow = 9,
  TableCell = 10,

  // Inline
  Text = 20,
  Bold = 21,
  Italic = 22,
  Strikethrough = 23,
  Code = 24,
  Link = 25,
  Image = 26,
  LineBreak = 27,

  // Special
  Html = 30,
  Pending = 31, // Incomplete token awaiting more data
}

export interface Token {
  type: TokenType;
  id: number;           // Stable content-addressed ID
  start: number;        // Position in source
  end: number;          // Position in source
  raw: string;          // Raw source text
  children?: Token[];   // Nested tokens for containers

  // Type-specific data
  depth?: number;       // Heading level (1-6)
  lang?: string;        // Code block language
  ordered?: boolean;    // List ordered/unordered
  listStart?: number;   // Starting number for ordered lists
  href?: string;        // Link/image URL
  title?: string;       // Link/image title
  alt?: string;         // Image alt text
  checked?: boolean;    // Checkbox state
  align?: ('left' | 'center' | 'right' | null)[]; // Table alignment
  header?: boolean;     // Table header row
}

export interface ParseState {
  // Current parsing context
  inCodeBlock: boolean;
  codeBlockLang: string;
  codeBlockFence: string;
  inBlockquote: boolean;
  blockquoteDepth: number;
  inList: boolean;
  listDepth: number;
  listOrdered: boolean;

  // Pending incomplete structures
  pendingText: string;
  pendingTokenType: TokenType | null;

  // Position tracking
  position: number;
  line: number;
  column: number;

  // Token ID counter for stability
  nextId: number;
}

export interface StreamarkOptions {
  // Security
  sanitize?: boolean;
  allowedTags?: string[];
  allowedAttributes?: Record<string, string[]>;
  allowedSchemes?: string[];

  // Performance
  batchUpdates?: boolean;
  batchDelayMs?: number;
  maxTokensPerBatch?: number;

  // Features
  gfm?: boolean;           // GitHub Flavored Markdown
  breaks?: boolean;        // Convert \n to <br>
  smartypants?: boolean;   // Smart quotes

  // Callbacks
  onToken?: (token: Token) => void;
  onComplete?: (tokens: Token[]) => void;
  onError?: (error: Error, position: number) => void;
}

export interface StreamarkInstance {
  write(chunk: string): Token[];
  end(): Token[];
  getTokens(): Token[];
  reset(): void;
  getState(): ParseState;
}
