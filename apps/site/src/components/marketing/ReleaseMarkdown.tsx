import React from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Render remote release text as Markdown, never executable MDX or raw HTML. */
export function ReleaseMarkdown({ body }: { body: string }) {
  return (
    <div className="release-prose">
      <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
        a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
        table: ({ children }) => <div className="overflow-x-auto"><table>{children}</table></div>,
      }}>{body}</Markdown>
    </div>
  );
}
