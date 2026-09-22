// Hover-only desktop actions must be visible and deliberate on touch screens.
const archiveSelector = 'button:is([aria-label="归档聊天"], [aria-label="Archive chat"])';
const mobile = matchMedia('(hover: none) and (pointer: coarse)');
const style = document.createElement('style');
style.textContent = `
@layer theme {
@media (hover: none) and (pointer: coarse) {
  .app-shell-left-panel .touch-none { touch-action: pan-y pinch-zoom !important; }
  .app-shell-left-panel [class~="group/folder-row"] :is(.w-0, .opacity-0):has(button) { width: auto !important; overflow: visible !important; opacity: 1 !important; }
  .app-shell-left-panel [class~="group/folder-row"] .grid:has(.col-start-1 button) > div.col-start-1 { visibility: hidden; }
  .app-shell-left-panel [class~="group/nav-section-title"] .pointer-events-none:has(button),
  .app-shell-left-panel .pointer-events-none:has([data-app-action-sidebar-project-create]) { opacity: 1 !important; pointer-events: auto !important; }
  /* Reveal the original action rail and reserve space without restyling its buttons. */
  .app-shell-left-panel .sidebar-item:has(.absolute button) { padding-inline-end: 116px !important; }
  .app-shell-left-panel .sidebar-item .absolute:has(button) { z-index: 20 !important; opacity: 1 !important; width: auto !important; pointer-events: auto !important; }
  /* Status badges share the trailing edge upstream; keep them beside the revealed actions. */
  .app-shell-left-panel .sidebar-item:has(.absolute button) .absolute[data-hover-card-open-immediately] { visibility: visible !important; display: flex !important; inset-inline-end: 60px !important; pointer-events: none !important; }
  .app-shell-left-panel .sidebar-item .absolute button { opacity: 1 !important; pointer-events: auto !important; }
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
