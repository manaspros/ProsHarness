import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

export interface PlanMarkdownProps {
  /** Raw markdown source for a plan document. */
  children: string;
  className?: string;
}

/**
 * PlanMarkdown -- renders a plan markdown document (headings, lists,
 * tables, blockquotes, code, links, strikethrough via GFM) using the
 * `.prose-plan` typography scale defined in app/globals.css (comfortable
 * ~72ch measure, 1.75 line-height, styled heading hierarchy).
 *
 * Replaces dumping raw markdown into a `<pre className="plan-markdown">`
 * tag -- use this anywhere a plan/review document body is rendered.
 *
 * Usage:
 *   <PlanMarkdown>{planMarkdownSource}</PlanMarkdown>
 */
export function PlanMarkdown({ children, className }: PlanMarkdownProps) {
  return (
    <div className={cn("prose-plan", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
