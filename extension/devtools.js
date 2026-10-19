chrome.devtools.panels.create("Tactiq Live", "", "panel.html", panel => {
  let panelWindow;
  panel.onShown.addListener(window => { panelWindow = window; });
  panel.onHidden.addListener(() => {
    panelWindow?.dispatchEvent(new panelWindow.Event("tactiq-panel-hidden"));
  });
});
