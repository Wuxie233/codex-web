// Hover-only desktop actions must be visible and deliberate on touch screens.
const archiveSelector = 'button:is([aria-label="归档聊天"], [aria-label="Archive chat"])';
const mobile = matchMedia('(hover: none) and (pointer: coarse)');
const style = document.createElement('style');
style.textContent = `
@layer theme {
.codex-web-sidebar-more { display: none; }
@media (hover: none) and (pointer: coarse) {
  /* Touch input needs native panning on a wide tablet. */
  .app-shell-left-panel .touch-none { touch-action: pan-y pinch-zoom !important; }
  .app-shell-left-panel [class~="group/folder-row"] :is(.w-0, .opacity-0):has(button) { width: auto !important; overflow: visible !important; opacity: 1 !important; }
  .app-shell-left-panel [class~="group/folder-row"] { min-height: 44px; }
  .app-shell-left-panel [class~="group/folder-row"] button { width: 44px !important; height: 44px !important; }
  .app-shell-left-panel [class~="group/folder-row"] .grid:has(.col-start-1 button) { min-width: 44px !important; height: 44px !important; }
  .app-shell-left-panel [class~="group/folder-row"] .grid:has(.col-start-1 button) > div.col-start-1 { visibility: hidden; }
  .app-shell-left-panel [class~="group/nav-section-title"] { min-height: 44px; height: auto !important; }
  .app-shell-left-panel [class~="group/nav-section-title"] .pointer-events-none:has(button) { opacity: 1 !important; pointer-events: auto !important; }
  .app-shell-left-panel [class~="group/nav-section-title"] button { min-width: 44px !important; min-height: 44px !important; }
  .app-shell-left-panel .codex-web-sidebar-more { display: inline-flex; flex-shrink: 0; width: 44px; height: 44px; align-items: center; justify-content: center; border-radius: 8px; font-size: 24px; pointer-events: auto; }
  .app-shell-left-panel .pointer-events-none:has([data-app-action-sidebar-project-create]) { opacity: 1 !important; pointer-events: auto !important; }
  .app-shell-left-panel [data-app-action-sidebar-project-create] { width: 44px !important; height: 44px !important; }
  .app-shell-left-panel .sidebar-item:has(${archiveSelector}) { min-height: 64px; padding-inline-end: 112px !important; }
  .app-shell-left-panel .sidebar-item .absolute:has(${archiveSelector}) { z-index: 20 !important; opacity: 1 !important; width: 104px !important; align-items: center !important; padding-top: 0 !important; }
  /* Local/cloud rows can supply renderActions instead of the archive rail. */
  .app-shell-left-panel .sidebar-item:has(.absolute button[aria-haspopup="menu"]) { min-height: 64px; padding-inline-end: 112px !important; }
  .app-shell-left-panel .sidebar-item .absolute:has(button[aria-haspopup="menu"]) { z-index: 20 !important; opacity: 1 !important; width: 104px !important; align-items: center !important; padding-top: 0 !important; }
  .app-shell-left-panel .sidebar-item .absolute:has(button[aria-haspopup="menu"]) button { width: 44px !important; height: 44px !important; flex-shrink: 0; pointer-events: auto; }
  .app-shell-left-panel [data-app-action-sidebar-thread-row]:has(.codex-web-sidebar-more) { padding-inline-end: 156px !important; }
  .app-shell-left-panel [data-app-action-sidebar-thread-row] .absolute:has(.codex-web-sidebar-more) { width: 148px !important; gap: 4px; }
  .app-shell-left-panel ${archiveSelector} { opacity: 1 !important; pointer-events: auto; width: 44px !important; height: 44px !important; color: inherit !important; border: 1px solid #888 !important; border-radius: 8px !important; background: var(--color-surface, #242424) !important; }
  .app-shell-left-panel ${archiveSelector} svg { display: none !important; }
  .app-shell-left-panel ${archiveSelector}::after { content: attr(aria-label); font-size: 13px; white-space: normal; line-height: 16px; }
  .app-shell-left-panel button[aria-label="归档聊天"]::after { content: "归档"; }
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
