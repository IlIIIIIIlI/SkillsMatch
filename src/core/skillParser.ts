import { compactWhitespace } from './utils';

export interface ParsedSkillMarkdown {
  title?: string;
  description?: string;
}

export function parseSkillMarkdown(markdown: string): ParsedSkillMarkdown {
  const content = stripFrontmatter(markdown).replace(/<!--[\s\S]*?-->/g, '').trim();
  const lines = content.split(/\r?\n/);

  let title: string | undefined;
  const paragraphs: string[] = [];
  let inCodeBlock = false;
  let currentParagraph: string[] = [];

  function flushParagraph(): void {
    if (currentParagraph.length === 0) {
      return;
    }

    const paragraph = compactWhitespace(currentParagraph.join(' '));
    if (paragraph) {
      paragraphs.push(paragraph);
    }
    currentParagraph = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      continue;
    }

    if (!title && line.startsWith('# ')) {
      title = compactWhitespace(line.replace(/^#\s+/, ''));
      continue;
    }

    if (!line) {
      flushParagraph();
      continue;
    }

    if (/^#{1,6}\s/.test(line)) {
      flushParagraph();
      continue;
    }

    if (/^[-*]\s/.test(line) || /^\d+\.\s/.test(line)) {
      flushParagraph();
      continue;
    }

    currentParagraph.push(line);
  }

  flushParagraph();

  return {
    title,
    description: paragraphs[0]
  };
}

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---\n')) {
    return markdown;
  }

  const endIndex = markdown.indexOf('\n---\n', 4);
  if (endIndex === -1) {
    return markdown;
  }

  return markdown.slice(endIndex + 5);
}
