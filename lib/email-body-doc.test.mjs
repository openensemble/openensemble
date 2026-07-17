import { describe, expect, it } from 'vitest';
import { markdownToHtml } from './email-body-doc.mjs';

describe('email body document Markdown rendering', () => {
  it('renders report structure and makes bare source URLs clickable', () => {
    const html = markdownToHtml([
      '# Research report',
      '',
      '- Source: https://example.com/report?id=7&view=full.',
      '- Parenthesized: https://en.wikipedia.org/wiki/Conflict_(history).',
    ].join('\n'));

    expect(html).toContain('<h1>Research report</h1>');
    expect(html).toContain('<a href="https://example.com/report?id=7&amp;view=full">https://example.com/report?id=7&amp;view=full</a>.');
    expect(html).toContain('<a href="https://en.wikipedia.org/wiki/Conflict_(history)">https://en.wikipedia.org/wiki/Conflict_(history)</a>.');
    expect((html.match(/<a href=/g) || [])).toHaveLength(2);
  });

  it('does not double-link explicit Markdown links or link URLs in code', () => {
    const html = markdownToHtml('[Primary source](https://example.com/a) and `https://example.com/literal`.');
    expect(html).toContain('<a href="https://example.com/a">Primary source</a>');
    expect(html).toContain('<code>https://example.com/literal</code>');
    expect((html.match(/<a href=/g) || [])).toHaveLength(1);
  });

  it('escapes document HTML and quote characters before creating links', () => {
    const html = markdownToHtml('<script>alert("x")</script> https://example.com/"bad');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).not.toContain('href="https://example.com/"bad');
  });
});
