import type { Component, Editor } from '@earendil-works/pi-tui';
import type { ProviderRoute } from '../../core/index.js';
import type { OperatorClient } from '../client.js';
import type { ViewModel, ViewTab } from '../view.js';

export interface ChoiceItem {
  value: string;
  label: string;
  description?: string;
}

/** What a panel needs from the app: the client, the view, and the app's modal flow. The app
 * satisfies it itself, so a panel always reaches the app's current methods. */
export interface PanelContext {
  readonly client: OperatorClient;
  readonly view: ViewModel;
  readonly editor: Component & Pick<Editor, 'getExpandedText' | 'setText'>;
  readonly tui: { requestRender(force?: boolean): void; setFocus(component: Component): void };
  readonly terminal: { readonly rows: number };
  /** Run work one at a time, reporting its error; work asked for while busy waits its turn. */
  execute(work: () => Promise<unknown>): Promise<void>;
  choice(title: string, items: ChoiceItem[], choose: (value: string) => void): void;
  confirm(
    title: string,
    description: string,
    label: string,
    confirm: () => Promise<unknown>,
    confirmByDefault?: boolean,
  ): void;
  /** A one-field form; `submit` gets the value after the form closes. */
  taskInput(
    title: string,
    initial: string,
    field: string,
    hint: string,
    submit: (value: string) => void,
  ): void;
  showText(title: string, text: string): void;
  showModal(component: Component, width?: number): void;
  closeModal(): void;
}

/** A panel that moves between tabs and redraws the document. */
export interface TabContext extends PanelContext {
  readonly document: { invalidate(): void };
  setTab(tab: ViewTab): void;
}

/** A panel that chooses the provider route for this or a new session. */
export interface RouteContext extends PanelContext {
  selectedRoute?: ProviderRoute;
  newSession(localCoding?: boolean): Promise<void>;
}

/** A panel that opens, creates or switches sessions. */
export interface SessionContext extends TabContext, RouteContext {
  /** How the TUI was started (TuiOptions). */
  readonly options: {
    readonly state: string;
    readonly cwd?: string;
    readonly observe?: boolean;
    readonly takeover?: boolean;
    readonly codingRoot?: string;
    readonly codingSocket?: string;
  };
  /** Start the service when it is not running. */
  startService(): Promise<void>;
  sessions(): Promise<void>;
  modelPicker(): void;
  runSlashCommand(command: string, args?: string): Promise<void>;
}
