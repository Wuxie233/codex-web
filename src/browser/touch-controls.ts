// Input capability is independent of the sidebar's narrow-screen layout.
const touchControlsStyle = document.createElement("style");
touchControlsStyle.textContent = `
@media (hover: none) and (pointer: coarse) {
  [data-codex-composer-root] [class*="_ComposerLayoutFooter_"] button {
    min-width: 44px; min-height: 44px;
  }
  [data-codex-composer-root] [class*="_ComposerLayoutFooter_"] button.size-token-button-composer,
  [data-codex-composer-root] [data-composer-navigation-target="add-context"] {
    width: 44px !important; height: 44px !important; flex-shrink: 0;
  }
}
`;
document.head.appendChild(touchControlsStyle);
