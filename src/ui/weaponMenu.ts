/**
 * Weapon menu (Q): dark rounded panel with tabs and a 3-column icon grid.
 * Only the "Våben" tab is active in the MVP. Selecting emits onSelect(id) – no sim effect here; the
 * caller turns it into a Command once weapons exist.
 */
import { el } from './dom';
import { weaponIcon } from './icons';
import type { WeaponMenuItem } from './weapons';

const TABS = ['Våben', 'Udstyr', 'Skins', 'Emotes'] as const;

export class WeaponMenu {
  readonly root: HTMLDivElement;
  private readonly grid: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private selected: string | null = null;
  private open = false;

  constructor(
    parent: HTMLElement,
    items: readonly WeaponMenuItem[],
    private readonly onSelect: (id: string) => void,
  ) {
    this.root = el('div', 'hud-panel hud-weapon-menu', parent);
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Våbenmenu');
    this.root.hidden = true;
    const tabs = el('div', 'wm-tabs', this.root);
    tabs.setAttribute('role', 'tablist');
    TABS.forEach((t, i) => {
      const b = el('button', 'wm-tab', tabs, t);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(i === 0));
      if (i === 0) b.classList.add('is-active');
      else {
        b.disabled = true;
        b.title = 'Kommer senere';
      }
    });
    this.grid = el('div', 'wm-grid', this.root);
    for (const it of items) {
      const b = el('button', 'wm-item', this.grid);
      b.type = 'button';
      b.dataset.weapon = it.id;
      b.title = it.available ? it.name : `${it.name} (kommer senere)`;
      b.setAttribute('aria-label', it.name);
      b.innerHTML = weaponIcon(it.id);
      if (!it.available) {
        b.disabled = true;
        b.classList.add('is-locked');
      }
      b.addEventListener('click', () => {
        if (!it.available) return;
        this.onSelect(it.id);
        this.setOpen(false);
      });
      b.addEventListener('mouseenter', () => this.showTitle(it.name));
      b.addEventListener('focus', () => this.showTitle(it.name));
      this.buttons.set(it.id, b);
    }
    this.title = el('div', 'wm-title', this.root);
    // Keep clicks/drags on the panel from reaching the canvas (camera look / pointer lock).
    for (const type of ['pointerdown', 'mousedown', 'wheel', 'contextmenu'] as const)
      this.root.addEventListener(type, (e) => e.stopPropagation());
  }

  private showTitle(name: string): void {
    this.title.textContent = name;
  }

  get isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    this.root.hidden = !open;
    if (open) {
      if (document.pointerLockElement) document.exitPointerLock();
      const cur = this.selected ? this.buttons.get(this.selected) : null;
      this.showTitle(cur?.getAttribute('aria-label') ?? '');
    } else if (document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement)) {
      // Don't leave focus on a button: Space would "click" it instead of jumping.
      document.activeElement.blur();
    }
  }

  setSelected(id: string | null): void {
    if (id === this.selected) return;
    if (this.selected) this.buttons.get(this.selected)?.classList.remove('is-selected');
    this.selected = id;
    if (id) this.buttons.get(id)?.classList.add('is-selected');
  }

  dispose(): void {
    this.root.remove();
  }
}
