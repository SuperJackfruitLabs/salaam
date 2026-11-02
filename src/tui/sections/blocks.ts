import type { ViewModel } from '../view-model.js';

/** The building blocks a document section renders with (DocumentView provides them). */
export interface DocumentBlocks {
  readonly view: ViewModel;
  /** A heading line. */
  title(label: string, width: number, role?: 'jade' | 'amber' | 'muted'): string[];
  /** Plain text, wrapped. */
  text(text: string, width: number): string[];
  /** Markdown, rendered once per id and text and kept until the theme or text changes. */
  prose(id: string, text: string, width: number): string[];
}
