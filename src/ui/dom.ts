/** Tiny DOM helpers for the HUD (no framework – CLAUDE.md stack). */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  parent?: HTMLElement,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

/** CSS colour string from a 0xRRGGBB number. */
export const hexCss = (c: number): string => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;

/** Mix a 0xRRGGBB colour towards white (t > 0) or black (t < 0). */
export function shade(c: number, t: number): number {
  const target = t > 0 ? 255 : 0;
  const k = Math.abs(t);
  const ch = (s: number) => Math.round(((c >> s) & 255) + (target - ((c >> s) & 255)) * k);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/**
 * Cached text setter: only touches the DOM when the value changed. Use one instance per text node.
 */
export class TextSlot {
  private value: string | null = null;
  constructor(readonly node: HTMLElement) {}
  set(v: string): void {
    if (v === this.value) return;
    this.value = v;
    this.node.textContent = v;
  }
}

/** Cached class toggle. */
export class ClassSlot {
  private on: boolean | null = null;
  constructor(
    readonly node: Element,
    readonly name: string,
  ) {}
  set(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.node.classList.toggle(this.name, on);
  }
}

/** Cached inline style property (e.g. transform). */
export class StyleSlot {
  private value: string | null = null;
  constructor(
    readonly node: HTMLElement,
    readonly prop: string,
  ) {}
  set(v: string): void {
    if (v === this.value) return;
    this.value = v;
    this.node.style.setProperty(this.prop, v);
  }
}
