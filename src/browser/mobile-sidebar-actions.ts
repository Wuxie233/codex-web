// Hover-only desktop actions must be visible and deliberate on touch screens.
const archiveSelector = 'button:is([aria-label="归档聊天"], [aria-label="Archive chat"])';
const mobile = matchMedia('(hover: none) and (pointer: coarse)');
const style = document.createElement('style');
style.textContent = `
[data-codex-web-touch-thread-title] { display: none; }
@layer theme {
@media (hover: none) and (pointer: coarse) {
  .app-shell-left-panel .touch-none { touch-action: pan-y pinch-zoom !important; }
  .app-shell-left-panel [class~="group/folder-row"] :is(.w-0, .opacity-0):has(button) { width: auto !important; overflow: visible !important; opacity: 1 !important; }
  /* Desktop overlays project status and actions in one grid cell. Touch needs both. */
  .app-shell-left-panel [class~="group/folder-row"] .grid:has(.col-start-1 button) { display: flex !important; width: auto !important; gap: 6px; }
  .app-shell-left-panel [class~="group/folder-row"] .grid:has(.col-start-1 button) > div.col-start-1 { visibility: visible !important; }
  .app-shell-left-panel [class~="group/nav-section-title"] .pointer-events-none:has(button),
  .app-shell-left-panel .pointer-events-none:has([data-app-action-sidebar-project-create]) { opacity: 1 !important; pointer-events: auto !important; }
  /* Keep the original title, badges and buttons in one row, sized by their content. */
  .app-shell-left-panel .sidebar-item:has([data-thread-title]) { display: flex !important; align-items: center; height: auto !important; min-height: var(--height-token-row); padding-block: 4px !important; }
  .app-shell-left-panel .sidebar-item > .flex.w-full:has([data-thread-title]) { order: 0; flex: 1 1 0; min-width: 0; width: auto !important; height: auto !important; }
  .app-shell-left-panel .sidebar-item > .flex.w-full > .flex:has([data-thread-title]) + .flex { min-width: 0 !important; flex-shrink: 0; }
  .app-shell-left-panel .sidebar-item:has([data-thread-title]) > .contents > .absolute:has(button),
  .app-shell-left-panel .sidebar-item:has([data-thread-title]) > .absolute[data-hover-card-open-immediately] { position: static !important; order: 2; flex: none; width: auto !important; min-width: 0 !important; height: auto !important; margin: 0 !important; margin-inline-start: 6px !important; padding: 0 !important; visibility: visible !important; opacity: 1 !important; display: flex !important; pointer-events: auto !important; }
  .app-shell-left-panel .sidebar-item:has([data-thread-title]) > .absolute[data-hover-card-open-immediately] { order: 1; }
  /* The desktop spacer reserved room for the badge overlay, now a flex item. */
  .app-shell-left-panel .sidebar-item:has(> .absolute[data-hover-card-open-immediately]) > .flex.w-full > .shrink-0[style]:empty { display: none !important; }
  .app-shell-left-panel .sidebar-item:has([data-thread-title]) span[data-hover-card-open-immediately] { position: static !important; margin-inline: 0 !important; visibility: visible !important; opacity: 1 !important; display: flex !important; }
  .app-shell-left-panel .sidebar-item > .contents > .absolute button { opacity: 1 !important; pointer-events: auto !important; }
  /* Marquee has its own nowrap/max-content track: reset every layer, then clamp. */
  .app-shell-left-panel [data-thread-title] { white-space: normal !important; overflow-wrap: anywhere; }
  .app-shell-left-panel [data-thread-title] > span,
  .app-shell-left-panel [data-thread-title] > span > span { display: block !important; width: 100% !important; min-width: 0 !important; margin: 0 !important; padding: 0 !important; mask-image: none !important; animation: none !important; transform: none !important; }
  .app-shell-left-panel [data-thread-title] [data-marquee-content] { display: -webkit-box !important; min-width: 0 !important; width: 100%; white-space: normal !important; overflow: hidden !important; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .app-shell-left-panel [data-thread-title] [data-marquee-copy] { display: none !important; }
  /* This is a label inside the existing context menu, not another menu action. */
  /* Radix measures collision space in viewport pixels; the menu itself uses app zoom. */
  [role="menu"]:has(> [data-codex-web-touch-thread-title]) { min-width: 0 !important; max-width: min(calc(var(--radix-context-menu-content-available-width, 100vw) / var(--codex-window-zoom, 1)), calc((100vw - 16px) / var(--codex-window-zoom, 1))); max-height: min(calc(var(--radix-context-menu-content-available-height, 100dvh) / var(--codex-window-zoom, 1)), calc((100dvh - 16px) / var(--codex-window-zoom, 1))); overflow-y: auto; }
  [data-codex-web-touch-thread-title] { display: block !important; flex-shrink: 0; box-sizing: border-box; width: min(320px, calc((100vw - 32px) / var(--codex-window-zoom, 1))); max-width: 100%; max-height: min(calc(30dvh / var(--codex-window-zoom, 1)), 12rem); overflow-y: auto; padding: 8px; margin-bottom: 4px; white-space: normal; overflow-wrap: anywhere; line-height: 1.4; }
}
}
.codex-web-archive-confirm { margin: auto; width: min(320px, calc(100vw - 40px)); box-sizing: border-box; padding: 20px; border: 1px solid #888; border-radius: 16px; background: #fff; color: #181818; }
html.electron-dark .codex-web-archive-confirm { background: #242424; color: #fff; }
.codex-web-archive-confirm::backdrop { background: #0008; }
.codex-web-archive-confirm h2 { margin: 0 0 12px; font-size: 18px; }
.codex-web-archive-confirm p { margin-bottom: 20px; }
.codex-web-archive-confirm footer { display: flex; justify-content: end; gap: 12px; }
.codex-web-archive-confirm button { padding: 10px 16px; min-height: 44px; border: 1px solid #888; border-radius: 8px; }
`;
document.head.appendChild(style);
const approved = new WeakSet<HTMLButtonElement>();
document.addEventListener('click', event => {
  if (!mobile.matches || !(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLButtonElement>(`.app-shell-left-panel ${archiveSelector}`);
  if (!button || button.disabled) return;
  if (approved.delete(button)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (document.querySelector('.codex-web-archive-confirm')) return;
  const zh = button.getAttribute('aria-label') === '归档聊天';
  const dialog = document.createElement('dialog');
  dialog.className = 'codex-web-archive-confirm';
  dialog.setAttribute('aria-label', zh ? '确认归档' : 'Confirm archive');
  const heading = document.createElement('h2');
  heading.textContent = zh ? '归档这条会话？' : 'Archive this chat?';
  const description = document.createElement('p');
  description.textContent = zh ? '会话将从当前列表移入归档。' : 'This chat will move out of the current list into the archive.';
  const footer = document.createElement('footer');
  const cancel = document.createElement('button');
  cancel.textContent = zh ? '取消' : 'Cancel';
  const confirm = document.createElement('button');
  confirm.textContent = zh ? '确认归档' : 'Archive';
  cancel.onclick = () => dialog.close();
  confirm.onclick = () => {
    dialog.close();
    if (button.isConnected) {
      approved.add(button);
      try { button.click(); } finally { approved.delete(button); }
    }
  };
  dialog.addEventListener('close', () => { dialog.remove(); if (button.isConnected) button.focus(); }, {once:true});
  footer.append(cancel, confirm);
  dialog.append(heading, description, footer);
  document.body.append(dialog);
  dialog.showModal();
  cancel.focus();
}, true);
