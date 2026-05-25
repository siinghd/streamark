/**
 * Streamark React Components
 * Optimized for minimal re-renders
 */

import { memo, useMemo } from 'react';
import type { ReactNode, ComponentType } from 'react';
import { Token, TokenType } from '../core/types';

export interface MarkdownProps {
  tokens: Token[];
  className?: string;
  components?: Partial<ComponentMap>;
}

export interface TokenProps {
  token: Token;
  components?: Partial<ComponentMap>;
}

type ComponentMap = {
  [K in keyof typeof TokenType]: ComponentType<TokenProps>;
};

// Default components - all memoized
const Text = memo(({ token }: TokenProps) => <>{token.raw}</>);

const Bold = memo(({ token, components }: TokenProps) => (
  <strong>{renderChildren(token, components)}</strong>
));

const Italic = memo(({ token, components }: TokenProps) => (
  <em>{renderChildren(token, components)}</em>
));

const Strikethrough = memo(({ token, components }: TokenProps) => (
  <del>{renderChildren(token, components)}</del>
));

const Code = memo(({ token, components }: TokenProps) => (
  <code>{renderChildren(token, components)}</code>
));

const Link = memo(({ token, components }: TokenProps) => (
  <a
    href={token.href}
    title={token.title}
    target="_blank"
    rel="noopener noreferrer"
  >
    {renderChildren(token, components)}
  </a>
));

const Image = memo(({ token }: TokenProps) => (
  <img src={token.href} alt={token.alt} title={token.title} loading="lazy" />
));

const Paragraph = memo(({ token, components }: TokenProps) => (
  <p>{renderChildren(token, components)}</p>
));

const Heading = memo(({ token, components }: TokenProps) => {
  const Tag = `h${token.depth || 1}` as keyof JSX.IntrinsicElements;
  return <Tag>{renderChildren(token, components)}</Tag>;
});

const CodeBlock = memo(({ token }: TokenProps) => {
  const className = token.lang ? `language-${token.lang}` : undefined;
  return (
    <pre>
      <code className={className}>{token.raw}</code>
    </pre>
  );
});

const Blockquote = memo(({ token, components }: TokenProps) => (
  <blockquote>{renderChildren(token, components)}</blockquote>
));

const ListItem = memo(({ token, components }: TokenProps) => {
  if (token.checked !== undefined) {
    return (
      <li>
        <input type="checkbox" checked={token.checked} disabled readOnly />
        {' '}{renderChildren(token, components)}
      </li>
    );
  }
  return <li>{renderChildren(token, components)}</li>;
});

const HorizontalRule = memo(() => <hr />);

const LineBreak = memo(() => <br />);

// Default component map
const DEFAULT_COMPONENTS: Record<TokenType, ComponentType<TokenProps>> = {
  [TokenType.Text]: Text,
  [TokenType.Bold]: Bold,
  [TokenType.Italic]: Italic,
  [TokenType.Strikethrough]: Strikethrough,
  [TokenType.Code]: Code,
  [TokenType.Link]: Link,
  [TokenType.Image]: Image,
  [TokenType.Paragraph]: Paragraph,
  [TokenType.Heading]: Heading,
  [TokenType.CodeBlock]: CodeBlock,
  [TokenType.Blockquote]: Blockquote,
  [TokenType.List]: Paragraph, // Will be handled specially
  [TokenType.ListItem]: ListItem,
  [TokenType.HorizontalRule]: HorizontalRule,
  [TokenType.LineBreak]: LineBreak,
  [TokenType.Table]: Paragraph,
  [TokenType.TableRow]: Paragraph,
  [TokenType.TableCell]: Paragraph,
  [TokenType.Html]: Text,
  [TokenType.Pending]: Text,
};

// Render children helper
function renderChildren(
  token: Token,
  components?: Partial<ComponentMap>
): ReactNode {
  if (!token.children || token.children.length === 0) {
    return null;
  }

  return token.children.map((child) => (
    <TokenRenderer key={child.id} token={child} components={components} />
  ));
}

// Individual token renderer - memoized
const TokenRenderer = memo(({ token, components }: TokenProps) => {
  const Component = components?.[token.type as unknown as keyof ComponentMap]
    || DEFAULT_COMPONENTS[token.type];

  if (!Component) {
    return <>{token.raw}</>;
  }

  return <Component token={token} components={components} />;
});

TokenRenderer.displayName = 'TokenRenderer';

/**
 * Main Markdown component
 * Renders tokens to React elements with optimal reconciliation
 */
export const Markdown = memo(({ tokens, className, components }: MarkdownProps) => {
  const mergedComponents = useMemo(
    () => ({ ...DEFAULT_COMPONENTS, ...components }),
    [components]
  );

  return (
    <div className={className}>
      {tokens.map((token) => (
        <TokenRenderer key={token.id} token={token} components={mergedComponents} />
      ))}
    </div>
  );
});

Markdown.displayName = 'Markdown';

/**
 * Streaming Markdown component with built-in hook
 */
export interface StreamingMarkdownProps {
  className?: string;
  components?: Partial<ComponentMap>;
  onTokens?: (tokens: Token[]) => void;
}

// Re-export for convenience
export { TokenRenderer, DEFAULT_COMPONENTS };
