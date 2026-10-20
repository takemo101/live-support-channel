chrome.devtools.panels.create("Live Support", "", "panel.html", panel => {
  let panelWindow;
  panel.onShown.addListener(window => { panelWindow = window; });
  panel.onHidden.addListener(() => {
    panelWindow?.dispatchEvent(new panelWindow.Event("live-support-panel-hidden"));
  });
});
