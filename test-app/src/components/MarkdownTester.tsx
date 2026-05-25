import { useState, useMemo } from 'react';
import { parse } from '../../../src/core/smd';

const EXAMPLE_MARKDOWN = `# Heading 1
## Heading 2

This is a paragraph with **bold**, *italic*, and ~~strikethrough~~.

- List item 1
- List item 2
  - Nested item
- [x] Task done
- [ ] Task todo

\`\`\`javascript
const hello = "world";
console.log(hello);
\`\`\`

| Column 1 | Column 2 |
|----------|----------|
| Cell 1   | Cell 2   |

> Blockquote text

Visit https://example.com for more info.

---

![Image](https://via.placeholder.com/100)
`;

export function MarkdownTester() {
  const [markdown, setMarkdown] = useState(EXAMPLE_MARKDOWN);
  const [showHtml, setShowHtml] = useState(false);

  const html = useMemo(() => {
    try {
      return parse(markdown, false);
    } catch (err) {
      return `<p style="color:red">Error: ${err}</p>`;
    }
  }, [markdown]);

  return (
    <div className="tester-container">
      <div className="tester-header">
        <h3>Markdown Tester</h3>
        <div className="tester-actions">
          <button
            className={`btn btn-secondary ${showHtml ? 'active' : ''}`}
            onClick={() => setShowHtml(!showHtml)}
          >
            {showHtml ? 'Hide HTML' : 'Show HTML'}
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => setMarkdown('')}
          >
            Clear
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => setMarkdown(EXAMPLE_MARKDOWN)}
          >
            Reset
          </button>
        </div>
      </div>

      <div className="tester-panels">
        <div className="tester-input">
          <label>Input Markdown:</label>
          <textarea
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            placeholder="Type or paste markdown here..."
            spellCheck={false}
          />
        </div>

        <div className="tester-output">
          <label>Rendered Output:</label>
          <div className="tester-preview streamark" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </div>

      {showHtml && (
        <div className="tester-html">
          <label>Raw HTML:</label>
          <pre><code>{html}</code></pre>
        </div>
      )}
    </div>
  );
}
