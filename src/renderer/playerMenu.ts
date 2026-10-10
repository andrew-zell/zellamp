import type { PlayerMenuItem } from '../shared/types'
import './playerMenu.css'

/** A menu item; page-only items run `run` instead of sending an action to main. */
export type MenuNode = Omit<PlayerMenuItem, 'submenu'> & { run?: () => void; submenu?: MenuNode[] }

/**
 * The player's right-click menu, drawn in the page in Webamp's menu style so
 * every skin (classic or freeform) gets the same one. Items come from main
 * (window.widget.getMenu); `slots` fills in page-specific items.
 */
export class PlayerMenu {
  readonly el: HTMLDivElement
  private token = 0

  constructor(private slots: (slot: string) => MenuNode[]) {
    this.el = document.createElement('div')
    this.el.id = 'za-menu'
    document.body.append(this.el)
    // Any press outside the menu closes it.
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (this.isOpen && !this.el.contains(e.target as Node)) this.close()
      },
      true,
    )
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close()
    })
    window.addEventListener('blur', () => this.close())
  }

  get isOpen() {
    return this.el.childElementCount > 0
  }

  async open(x: number, y: number) {
    const token = ++this.token
    const items = await window.widget.getMenu()
    // A newer open (or a close) won the race.
    if (token !== this.token) return
    this.el.replaceChildren(this.render(this.expand(items), true))
    Object.assign(this.el.style, { left: `${Math.round(x)}px`, top: `${Math.round(y)}px` })
  }

  close() {
    this.token++
    this.el.replaceChildren()
  }

  /** Insert slot items; drop separators left doubled or dangling. */
  private expand(items: MenuNode[]): MenuNode[] {
    const out: MenuNode[] = []
    for (const item of items) {
      if (item.slot) out.push(...this.slots(item.slot))
      else out.push(item.submenu ? { ...item, submenu: this.expand(item.submenu) } : item)
    }
    const cleaned: MenuNode[] = []
    for (const item of out) {
      if (item.separator && (!cleaned.length || cleaned[cleaned.length - 1].separator)) continue
      cleaned.push(item)
    }
    while (cleaned[cleaned.length - 1]?.separator) cleaned.pop()
    return cleaned
  }

  private render(items: MenuNode[], root = false) {
    const ul = document.createElement('ul')
    if (root) ul.className = 'za-menu-root'
    else ul.style.display = 'none'
    for (const item of items) {
      const li = document.createElement('li')
      if (item.separator) {
        li.className = 'hr'
        li.append(document.createElement('hr'))
      } else {
        li.textContent = item.label ?? ''
        if (item.checked) li.classList.add('checked')
        if (item.submenu) {
          li.classList.add('parent')
          li.append(this.render(item.submenu))
        }
        li.addEventListener('click', (e) => {
          e.stopPropagation()
          if (item.submenu) return
          this.close()
          if (item.run) item.run()
          else if (item.action != null) window.widget.menuAction(item.action)
        })
      }
      // Open this item's submenu, close its siblings'. Inline display (not
      // :hover) so the layout and hit-region watchers see the change.
      li.addEventListener('mouseenter', () => {
        for (const sib of ul.children) {
          const sub = sib.querySelector(':scope > ul') as HTMLElement | null
          if (sub) sub.style.display = sib === li ? 'block' : 'none'
          sib.classList.toggle('open', sib === li && !!sub)
        }
      })
      ul.append(li)
    }
    return ul
  }
}
