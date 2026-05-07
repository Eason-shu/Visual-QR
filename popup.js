const statusEl = document.getElementById('status');
function show(msg){ statusEl.textContent = msg; }

document.getElementById('openPanel').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return show('未找到当前标签页');

    // panel.js 已通过 content_scripts 在普通网页刷新后自动注入。
    // 这里再执行一次是为了兼容：刚加载插件后，当前页面尚未刷新。
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['panel.js'] });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.__QRFILL_ASCII_PANEL__ && window.__QRFILL_ASCII_PANEL__.show()
    });

    show('已打开模板面板。刷新页面后，扫码监听会自动恢复。');
  } catch (e) {
    show('打开失败：' + e.message + '。请确认不是 chrome:// 页面；本地文件需开启允许访问文件网址。');
  }
});
