chrome.devtools.panels.create("Live Captions", "", "panel.html", panel => {
  let panelWindow;
  panel.onShown.addListener(window => { panelWindow = window; });
  panel.onHidden.addListener(() => {
    panelWindow?.dispatchEvent(new panelWindow.Event("live-support-panel-hidden"));
  });
});
