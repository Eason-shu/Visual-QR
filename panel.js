(() => {
  if (window.__QRFILL_ASCII_PANEL__) {
    // 已经注入过：不要重复绑定监听；由 popup 显式调用 show()。
    return;
  }

  const STATE_KEY = "__qrfill_ascii_templates_v1__";
  const PANEL_POS_KEY = "__qrfill_ascii_panel_position_v1__";
  const SETTINGS_KEY = "__qrfill_settings_v1__";
  const HISTORY_KEY = "__qrfill_fill_history_v1__";
  const panelId = "qrfill-ascii-panel";
  const APP_VERSION = "1.0";
  const MAX_HISTORY_COUNT = 50;
  let selectedElement = null;
  let templates = loadTemplates();
  let history = loadHistory();
  let currentTemplateId =
    (templates[0] ? templates[0].id : null) || createTemplate("默认模板").id;
  let scanTimer = null;
  let scanBuffer = "";
  let scanLastAt = 0;
  const SCAN_RESET_GAP = 120;
  const SCAN_AUTO_COMMIT_DELAY = 420;
  let lastScanCompletedAt = 0;

  // 后台服务模式相关
  let currentMode = "scanner"; // 'scanner' | 'service'
  let serviceUrl = "";
  let pollInterval = 2000;
  let pollTimer = null;
  let isPolling = false;
  let lastProcessedId = "";
  let dataPath = "data"; // 自定义数据路径，支持点号分隔如 "result.data"

  function refocusScannerAfterFill(reason) {
    // 复杂 Vue / Element 下拉框填充后，浏览器经常把焦点留在表单真实输入框。
    // 扫码枪第二次扫描时就会把二维码原文打进表单。这里用多次延迟聚焦把焦点拉回隐藏捕获框。
    const delays = [0, 80, 250, 600];
    delays.forEach((delay) => {
      setTimeout(() => {
        try {
          if (!window.__qrfillHiddenScanner) return;
          const active = document.activeElement;
          if (active && active.closest && active.closest("#" + panelId)) return;
          if (active && active.blur) active.blur();
          window.__qrfillHiddenScanner.focus({ preventScroll: true });
          if (window.__qrfillHiddenScanner.select)
            window.__qrfillHiddenScanner.select();
          log("扫码焦点", (reason || "填充后") + "：已回到隐藏捕获框");
        } catch (e) {
          log("扫码焦点", "恢复失败：" + e.message);
        }
      }, delay);
    });
  }

  function pageKey() {
    return location.origin + location.pathname;
  }
  function uid() {
    return (
      "tpl_" +
      Date.now().toString(36) +
      "_" +
      Math.random().toString(36).slice(2, 8)
    );
  }
  function loadTemplates() {
    try {
      return JSON.parse(localStorage.getItem(STATE_KEY) || "[]");
    } catch {
      return [];
    }
  }
  function saveTemplates() {
    localStorage.setItem(STATE_KEY, JSON.stringify(templates));
  }
  function loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    } catch {
      return [];
    }
  }
  function saveHistory(history) {
    const trimmed = history.slice(-MAX_HISTORY_COUNT);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
  }
  function clearHistory() {
    localStorage.removeItem(HISTORY_KEY);
    history = [];
    renderHistory();
  }
  function formatTime(timestamp) {
    const d = new Date(timestamp);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }
  function renderHistory() {
    const historyList = document.getElementById("historyList");
    if (!historyList) return;

    if (history.length === 0) {
      historyList.innerHTML = `<div style="padding:20px;text-align:center;color:#94a3b8;font-size:13px">暂无填充历史记录</div>`;
      return;
    }

    historyList.innerHTML = history
      .map(
        (item) => `
      <div class="history-item" data-id="${item.id}">
        <div class="history-header">
          <div class="history-time">${formatTime(item.timestamp)}</div>
          <div class="history-status ${item.success ? "success" : "failed"}">${item.success ? "✓ 成功" : "✗ 失败"}</div>
        </div>
        <div class="history-summary">${item.message}</div>
        <div class="history-meta">
          <span class="history-duration">耗时: ${formatDuration(item.duration)}</span>
          ${item.template ? `<span class="history-template">模板: ${item.template.name}</span>` : ""}
        </div>
        <div class="history-fields">
          ${item.fields
            .map(
              (field) => `
            <div class="history-field">
              <span class="field-key">${field.key}</span>
              <span class="field-status ${field.status === "成功" ? "success" : field.status === "失败" ? "failed" : "skipped"}">${field.status}</span>
              <span class="field-value">${field.msg}</span>
              ${field.duration !== undefined ? `<span class="field-duration">${formatDuration(field.duration)}</span>` : ""}
            </div>
          `,
            )
            .join("")}
        </div>
        <div class="history-actions">
          <button class="history-action-btn" onclick="copyHistoryPayload('${item.id}')">📋 复制原始数据</button>
        </div>
      </div>
    `,
      )
      .join("");
  }
  function copyHistoryPayload(id) {
    const item = history.find((h) => h.id === id);
    if (item) {
      navigator.clipboard
        .writeText(JSON.stringify(item.payload, null, 2))
        .then(() => {
          toast("已复制", "原始 payload 已复制到剪贴板");
        })
        .catch(() => {
          toast("复制失败", "无法复制到剪贴板");
        });
    }
  }
  function createTemplate(name) {
    const tpl = {
      id: uid(),
      name: name || "未命名模板",
      pageKey: pageKey(),
      fields: [],
    };
    templates.push(tpl);
    saveTemplates();
    return tpl;
  }
  function loadSettings() {
    try {
      const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      currentMode = settings.mode || "scanner";
      serviceUrl = settings.serviceUrl || "";
      pollInterval = settings.pollInterval || 2000;
      lastProcessedId = settings.lastProcessedId || "";
      dataPath = settings.dataPath || "data";
    } catch {
      currentMode = "scanner";
      serviceUrl = "";
      pollInterval = 2000;
      lastProcessedId = "";
      dataPath = "data";
    }
  }
  function saveSettings() {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          mode: currentMode,
          serviceUrl,
          pollInterval,
          lastProcessedId,
          dataPath,
        }),
      );
    } catch {}
  }
  function getNestedValue(obj, path) {
    if (!obj || !path) return obj;
    const keys = path.split(".").filter((k) => k.trim());
    return keys.reduce((current, key) => {
      if (current && typeof current === "object" && key in current) {
        return current[key];
      }
      return undefined;
    }, obj);
  }
  function currentTemplate() {
    return templates.find((t) => t.id === currentTemplateId) || templates[0];
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.body) {
      let part = el.tagName.toLowerCase();
      if (el.name) {
        part += `[name="${CSS.escape(el.name)}"]`;
        parts.unshift(part);
        break;
      }
      const parent = el.parentElement;
      if (!parent) break;
      const same = Array.from(parent.children).filter(
        (x) => x.tagName === el.tagName,
      );
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
      parts.unshift(part);
      el = parent;
    }
    return parts.join(" > ");
  }

  function xpathOf(el) {
    if (!el || el.nodeType !== 1) return "";
    const segs = [];
    while (el && el.nodeType === 1) {
      let i = 1,
        sib = el.previousElementSibling;
      while (sib) {
        if (sib.tagName === el.tagName) i++;
        sib = sib.previousElementSibling;
      }
      segs.unshift(`${el.tagName.toLowerCase()}[${i}]`);
      el = el.parentElement;
    }
    return "/" + segs.join("/");
  }

  function byXPath(xpath) {
    try {
      return document.evaluate(
        xpath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      ).singleNodeValue;
    } catch {
      return null;
    }
  }

  function uniqElements(list) {
    return Array.from(new Set(list.filter(Boolean)));
  }

  function isActuallyVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el === document.body || el === document.documentElement) return true;

    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      if (node.hasAttribute("hidden")) return false;
      if (node.getAttribute("aria-hidden") === "true") return false;

      const cls = typeof node.className === "string" ? node.className : "";
      if (
        /\b(is-hidden|hidden|el-tab-pane--hidden|ant-tabs-tabpane-hidden)\b/.test(
          cls,
        )
      )
        return false;

      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden")
        return false;

      node = node.parentElement;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0 && !el.isContentEditable)
      return false;

    return true;
  }

  function isInViewport(el) {
    const rect = el.getBoundingClientRect();
    return (
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth
    );
  }

  function findFieldScope(el) {
    if (!el) return null;
    const scope = el.closest(
      'form,.el-form,.ant-form,.n-form,.el-dialog,.el-drawer,.el-tab-pane,.ant-tabs-tabpane,.n-tabs-pane,.van-tab__pane,[role="tabpanel"],.router-view,.page,.content,.main,.el-main,[data-qr-scope]',
    );
    if (scope && scope !== document.body && scope !== document.documentElement)
      return scope;
    return null;
  }

  function queryFillableAll(selector, root = document) {
    try {
      return Array.from(root.querySelectorAll(selector))
        .map(realFillable)
        .filter(Boolean)
        .filter(isActuallyVisible);
    } catch {
      return [];
    }
  }

  function scopeRoots(field) {
    const roots = [];

    if (field.scopeSelector) {
      try {
        roots.push(
          ...Array.from(document.querySelectorAll(field.scopeSelector)).filter(
            isActuallyVisible,
          ),
        );
      } catch {}
    }

    if (field.scopeXPath) {
      const scope = byXPath(field.scopeXPath);
      if (scope && isActuallyVisible(scope)) roots.push(scope);
    }

    roots.push(document);
    return uniqElements(roots);
  }

  function bestVisible(candidates) {
    const visible = uniqElements(candidates)
      .map(realFillable)
      .filter(Boolean)
      .filter(isActuallyVisible);

    if (!visible.length) return null;

    return visible
      .map((el) => ({
        el,
        score:
          (isInViewport(el) ? 100 : 0) +
          (el === document.activeElement ? 10 : 0),
      }))
      .sort((a, b) => b.score - a.score)[0].el;
  }

  function getLabelText(el) {
    if (!el) return "";
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent.trim();
    }
    const item = el.closest(
      ".el-form-item,.ant-form-item,.n-form-item,.form-item,.form-group,label",
    );
    if (item) {
      const label = item.querySelector(
        "label,.el-form-item__label,.ant-form-item-label,.n-form-item-label",
      );
      if (label)
        return label.textContent
          .trim()
          .replace(/[:：*]/g, "")
          .trim();
    }
    return "";
  }

  function realFillable(target) {
    if (!target) return null;
    if (isFillable(target)) return target;
    return target.querySelector
      ? target.querySelector('input,textarea,select,[contenteditable="true"]')
      : null;
  }
  function isFillable(el) {
    const tag = el && el.tagName && el.tagName.toLowerCase();
    return (
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      (el && el.isContentEditable)
    );
  }

  function locate(field) {
    const selectors = [];

    if (field.name) selectors.push(`[name="${CSS.escape(field.name)}"]`);
    if (field.placeholder) {
      selectors.push(
        `input[placeholder*="${CSS.escape(field.placeholder)}"],textarea[placeholder*="${CSS.escape(field.placeholder)}"]`,
      );
    }
    // id 在复杂系统里可能重复或动态生成，所以不用 getElementById，改成 querySelectorAll + 可见过滤。
    if (field.id) selectors.push(`[id="${CSS.escape(field.id)}"]`);
    if (field.selector) selectors.push(field.selector);

    for (const root of scopeRoots(field)) {
      for (const selector of selectors) {
        const found = bestVisible(queryFillableAll(selector, root));
        if (found) return found;
      }

      if (field.xpath) {
        const el = byXPath(field.xpath);
        const fillable = realFillable(el);
        if (
          fillable &&
          isActuallyVisible(fillable) &&
          (root === document || root.contains(fillable))
        ) {
          return fillable;
        }
      }
    }

    return null;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  function nativeSet(el, value) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, String(value));
    else el.value = String(value);
    ["input", "change", "blur", "keyup"].forEach((n) =>
      el.dispatchEvent(new Event(n, { bubbles: true })),
    );
  }

  const Adapters = (() => {
    const adapters = [];

    class Adapter {
      constructor(name, priority = 10) {
        this.name = name;
        this.priority = priority;
      }
      match(el) {
        return false;
      }
      async fill(el, value) {
        return false;
      }
    }

    class NativeSelectAdapter extends Adapter {
      constructor() {
        super("native-select", 50);
      }
      match(el) {
        return el && el.tagName && el.tagName.toLowerCase() === "select";
      }
      async fill(el, value) {
        const text = String(value);
        const option = Array.from(el.options).find(
          (o) => o.textContent.trim() === text || o.value === text,
        );
        if (option) {
          el.value = option.value;
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
        el.value = text;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }

    class NativeCheckboxAdapter extends Adapter {
      constructor() {
        super("native-checkbox", 50);
      }
      match(el) {
        return el && el.type && el.type.toLowerCase() === "checkbox";
      }
      async fill(el, value) {
        el.checked = Boolean(value);
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }

    class NativeRadioAdapter extends Adapter {
      constructor() {
        super("native-radio", 50);
      }
      match(el) {
        return el && el.type && el.type.toLowerCase() === "radio";
      }
      async fill(el, value) {
        const text = String(value);
        const radio = document.querySelector(
          `input[type="radio"][name="${CSS.escape(el.name)}"][value="${CSS.escape(text)}"]`,
        );
        if (radio) {
          radio.checked = true;
          radio.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
        return false;
      }
    }

    class NativeContentEditableAdapter extends Adapter {
      constructor() {
        super("native-contenteditable", 50);
      }
      match(el) {
        return el && el.isContentEditable;
      }
      async fill(el, value) {
        el.textContent = String(value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      }
    }

    class NativeInputAdapter extends Adapter {
      constructor() {
        super("native-input", 40);
      }
      match(el) {
        const tag = el && el.tagName && el.tagName.toLowerCase();
        return (
          tag === "input" &&
          !["checkbox", "radio"].includes(el.type?.toLowerCase())
        );
      }
      async fill(el, value) {
        nativeSet(el, value);
        return true;
      }
    }

    class NativeTextareaAdapter extends Adapter {
      constructor() {
        super("native-textarea", 40);
      }
      match(el) {
        const tag = el && el.tagName && el.tagName.toLowerCase();
        return tag === "textarea";
      }
      async fill(el, value) {
        nativeSet(el, value);
        return true;
      }
    }

    class ElementSelectAdapter extends Adapter {
      constructor() {
        super("element-select", 30);
      }
      match(el) {
        return el && el.closest(".el-select");
      }
      async fill(el, value) {
        const text = String(value);
        const root = el.closest(".el-select");
        const clickable =
          root.querySelector(".el-input,.el-select__wrapper") || root;
        clickable.click();
        if (el.focus) el.focus();
        await sleep(250);
        const options = Array.from(
          document.querySelectorAll(
            ".el-select-dropdown__item, .el-popper .el-select-dropdown__item",
          ),
        ).filter(
          (o) =>
            o.offsetParent !== null || getComputedStyle(o).display !== "none",
        );
        const matched =
          options.find((o) => o.textContent.trim() === text) ||
          options.find((o) => o.textContent.trim().includes(text));
        if (!matched) return false;
        matched.click();
        await sleep(120);
        ["change", "blur"].forEach((n) =>
          el.dispatchEvent(new Event(n, { bubbles: true })),
        );
        return true;
      }
    }

    class AntSelectAdapter extends Adapter {
      constructor() {
        super("ant-select", 30);
      }
      match(el) {
        return el && el.closest(".ant-select");
      }
      async fill(el, value) {
        const text = String(value);
        const root = el.closest(".ant-select");
        const clickable = root.querySelector(".ant-select-selector") || root;
        clickable.click();
        if (el.focus) el.focus();
        await sleep(250);
        const options = Array.from(
          document.querySelectorAll(
            ".ant-select-item-option, .ant-select-dropdown .ant-select-item-option",
          ),
        ).filter(
          (o) =>
            o.offsetParent !== null || getComputedStyle(o).display !== "none",
        );
        const matched =
          options.find((o) => o.textContent.trim() === text) ||
          options.find((o) => o.textContent.trim().includes(text));
        if (!matched) return false;
        matched.click();
        await sleep(120);
        ["change", "blur"].forEach((n) =>
          el.dispatchEvent(new Event(n, { bubbles: true })),
        );
        return true;
      }
    }

    class NaiveSelectAdapter extends Adapter {
      constructor() {
        super("naive-select", 30);
      }
      match(el) {
        return el && el.closest(".n-select");
      }
      async fill(el, value) {
        const text = String(value);
        const root = el.closest(".n-select");
        const clickable = root.querySelector(".n-base-selection") || root;
        clickable.click();
        if (el.focus) el.focus();
        await sleep(250);
        const options = Array.from(
          document.querySelectorAll(
            ".n-base-select-option, .n-select-menu .n-base-select-option",
          ),
        ).filter(
          (o) =>
            o.offsetParent !== null || getComputedStyle(o).display !== "none",
        );
        const matched =
          options.find((o) => o.textContent.trim() === text) ||
          options.find((o) => o.textContent.trim().includes(text));
        if (!matched) return false;
        matched.click();
        await sleep(120);
        ["change", "blur"].forEach((n) =>
          el.dispatchEvent(new Event(n, { bubbles: true })),
        );
        return true;
      }
    }

    class ElementDateAdapter extends Adapter {
      constructor() {
        super("element-date", 30);
      }
      match(el) {
        return el && el.closest(".el-date-editor, .el-date-picker");
      }
      async fill(el, value) {
        const text = String(value);
        const root = el.closest(".el-date-editor, .el-date-picker");
        const inputEl = root.querySelector("input") || el;
        nativeSet(inputEl, text);
        await sleep(100);
        inputEl.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }

    class AntDateAdapter extends Adapter {
      constructor() {
        super("ant-date", 30);
      }
      match(el) {
        return el && el.closest(".ant-picker-date");
      }
      async fill(el, value) {
        const text = String(value);
        const root = el.closest(".ant-picker-date");
        const inputEl = root.querySelector("input") || el;
        nativeSet(inputEl, text);
        await sleep(100);
        inputEl.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }

    class NaiveDateAdapter extends Adapter {
      constructor() {
        super("naive-date", 30);
      }
      match(el) {
        return el && el.closest(".n-date-picker");
      }
      async fill(el, value) {
        const text = String(value);
        const root = el.closest(".n-date-picker");
        const inputEl = root.querySelector("input") || el;
        nativeSet(inputEl, text);
        await sleep(100);
        inputEl.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }

    class ElementSwitchAdapter extends Adapter {
      constructor() {
        super("element-switch", 30);
      }
      match(el) {
        return el && el.closest(".el-switch");
      }
      async fill(el, value) {
        const root = el.closest(".el-switch");
        const isChecked = Boolean(value);
        const currentChecked = root.classList.contains("is-checked");
        if (isChecked !== currentChecked) {
          root.click();
          await sleep(100);
        }
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }

    class AntSwitchAdapter extends Adapter {
      constructor() {
        super("ant-switch", 30);
      }
      match(el) {
        return el && el.closest(".ant-switch");
      }
      async fill(el, value) {
        const root = el.closest(".ant-switch");
        const isChecked = Boolean(value);
        const currentChecked = root.classList.contains("ant-switch-checked");
        if (isChecked !== currentChecked) {
          root.click();
          await sleep(100);
        }
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }

    class NaiveSwitchAdapter extends Adapter {
      constructor() {
        super("naive-switch", 30);
      }
      match(el) {
        return el && el.closest(".n-switch");
      }
      async fill(el, value) {
        const root = el.closest(".n-switch");
        const isChecked = Boolean(value);
        const currentChecked = root.classList.contains("n-switch--checked");
        if (isChecked !== currentChecked) {
          root.click();
          await sleep(100);
        }
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }

    class ElementCascaderAdapter extends Adapter {
      constructor() {
        super("element-cascader", 30);
      }
      match(el) {
        return el && el.closest(".el-cascader");
      }
      async fill(el, value) {
        const text = String(value);
        const root = el.closest(".el-cascader");
        const clickable = root.querySelector(".el-input") || root;
        clickable.click();
        await sleep(250);
        const options = Array.from(
          document.querySelectorAll(".el-cascader-menu__item"),
        ).filter((o) => o.offsetParent !== null);
        const matched =
          options.find((o) => o.textContent.trim() === text) ||
          options.find((o) => o.textContent.trim().includes(text));
        if (!matched) return false;
        matched.click();
        await sleep(150);
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }

    class AntCascaderAdapter extends Adapter {
      constructor() {
        super("ant-cascader", 30);
      }
      match(el) {
        return el && el.closest(".ant-cascader");
      }
      async fill(el, value) {
        const text = String(value);
        const root = el.closest(".ant-cascader");
        const clickable = root.querySelector(".ant-cascader-picker") || root;
        clickable.click();
        await sleep(250);
        const options = Array.from(
          document.querySelectorAll(".ant-cascader-menu-item"),
        ).filter((o) => o.offsetParent !== null);
        const matched =
          options.find((o) => o.textContent.trim() === text) ||
          options.find((o) => o.textContent.trim().includes(text));
        if (!matched) return false;
        matched.click();
        await sleep(150);
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }

    function register(adapter) {
      if (adapter instanceof Adapter) {
        adapters.push(adapter);
        adapters.sort((a, b) => b.priority - a.priority);
      }
    }

    function find(el) {
      return adapters.find((adapter) => adapter.match(el));
    }

    async function fill(el, value) {
      const adapter = find(el);
      if (adapter) {
        try {
          return await adapter.fill(el, value);
        } catch (e) {
          log("Adapter Error", `${adapter.name}: ${e.message}`);
          return false;
        }
      }
      return false;
    }

    function init() {
      register(new NativeSelectAdapter());
      register(new NativeCheckboxAdapter());
      register(new NativeRadioAdapter());
      register(new NativeContentEditableAdapter());
      register(new NativeInputAdapter());
      register(new NativeTextareaAdapter());
      register(new ElementSelectAdapter());
      register(new AntSelectAdapter());
      register(new NaiveSelectAdapter());
      register(new ElementDateAdapter());
      register(new AntDateAdapter());
      register(new NaiveDateAdapter());
      register(new ElementSwitchAdapter());
      register(new AntSwitchAdapter());
      register(new NaiveSwitchAdapter());
      register(new ElementCascaderAdapter());
      register(new AntCascaderAdapter());
    }

    return {
      register,
      find,
      fill,
      init,
      Adapter,
      adapters: () => [...adapters],
    };
  })();

  Adapters.init();

  async function smartFill(el, value) {
    if (!el) return false;
    const adapter = Adapters.find(el);
    if (adapter) {
      const ok = await Adapters.fill(el, value);
      if (ok) return true;
      log(
        "Adapter Failed",
        `Adapter ${adapter.name} failed, falling back to native`,
      );
    }
    const tag = el.tagName && el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      nativeSet(el, value);
      return true;
    }
    if (tag === "select") {
      el.value = String(value);
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    if (el.isContentEditable) {
      el.textContent = String(value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    return false;
  }

  function utf8ToBase64Url(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }
  function base64UrlToUtf8(b64url) {
    let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
    b64 += "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  }
  function normalize(text) {
    return String(text || "")
      .trim()
      .replace(/^\uFEFF/, "")
      .replace(/[\r\n\t]+$/g, "")
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/：/g, ":")
      .replace(/，/g, ",");
  }
  function parsePayload(raw) {
    const cleaned = normalize(raw);
    log("扫码原始内容", raw);
    log("扫码清洗后内容", cleaned);
    if (cleaned.startsWith("QRFILL1:")) {
      const encoded = cleaned.slice("QRFILL1:".length).trim();
      const json = base64UrlToUtf8(encoded);
      log("QRFILL1 解码 JSON", json);
      return JSON.parse(json);
    }
    if (cleaned.startsWith("FORMQR64:")) {
      const encoded = cleaned
        .slice("FORMQR64:".length)
        .trim()
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
      const json = base64UrlToUtf8(encoded);
      log("FORMQR64 解码 JSON", json);
      return JSON.parse(json);
    }
    if (cleaned.startsWith("FORMQR:")) {
      const json = cleaned.slice("FORMQR:".length).trim();
      log("FORMQR JSON", json);
      return JSON.parse(json);
    }
    throw new Error("缺少 QRFILL1: / FORMQR64: / FORMQR: 前缀");
  }

  async function fillByPayload(payload) {
    const startTime = Date.now();
    let tpl = currentTemplate();
    let data = payload;
    let rawPayload = payload;
    if (payload && typeof payload === "object" && payload.data) {
      data = payload.data;
      if (payload.templateId)
        tpl = templates.find((t) => t.id === payload.templateId) || tpl;
      if (payload.template)
        tpl = templates.find((t) => t.name === payload.template) || tpl;
    }
    if (!tpl) {
      const historyItem = {
        id: uid(),
        timestamp: Date.now(),
        duration: Date.now() - startTime,
        success: false,
        message: "未找到模板",
        payload: rawPayload,
        template: null,
        fields: [],
      };
      history.unshift(historyItem);
      saveHistory(history);
      toast("未找到模板", "请先创建并保存模板");
      return;
    }
    const results = [];
    let successCount = 0;
    let failCount = 0;
    let skipCount = 0;

    for (const field of tpl.fields) {
      const fieldStartTime = Date.now();
      if (!Object.prototype.hasOwnProperty.call(data, field.key)) {
        results.push({
          key: field.key,
          status: "跳过",
          msg: "二维码无此字段",
          duration: Date.now() - fieldStartTime,
        });
        skipCount++;
        continue;
      }
      const el = locate(field);
      log("字段定位", `${field.key} => ${el ? "找到" : "未找到"}`);
      if (!el) {
        results.push({
          key: field.key,
          status: "失败",
          msg: "未找到元素",
          duration: Date.now() - fieldStartTime,
        });
        failCount++;
        continue;
      }
      const ok = await smartFill(el, data[field.key]);
      const fieldDuration = Date.now() - fieldStartTime;
      if (ok) {
        successCount++;
      } else {
        failCount++;
      }
      results.push({
        key: field.key,
        status: ok ? "成功" : "失败",
        msg: String(data[field.key]),
        duration: fieldDuration,
      });
    }

    const duration = Date.now() - startTime;
    const historyItem = {
      id: uid(),
      timestamp: Date.now(),
      duration: duration,
      success: failCount === 0,
      message: `成功 ${successCount} 个，失败 ${failCount} 个${skipCount > 0 ? `，跳过 ${skipCount} 个` : ""}`,
      payload: rawPayload,
      template: { id: tpl.id, name: tpl.name },
      fields: results,
    };
    history.unshift(historyItem);
    saveHistory(history);

    renderFields();
    renderHistory();
    toast("填充完成", historyItem.message);
  }

  async function handleScan(raw) {
    try {
      await fillByPayload(parsePayload(raw));
      lastScanCompletedAt = Date.now();
    } catch (e) {
      log("解析失败", e.message);
      toast("解析失败", e.message);
    } finally {
      refocusScannerAfterFill("扫码处理完成");
    }
  }

  // 后台服务模式相关
  async function fetchFromService() {
    if (!serviceUrl) {
      log("服务模式", "未配置服务地址");
      return;
    }
    try {
      log("服务模式", `正在请求: ${serviceUrl}`);
      const response = await fetch(serviceUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      log("服务模式", `收到数据: ${JSON.stringify(data).substring(0, 200)}`);

      // 检查是否有新数据（通过 id 或时间戳判断）
      const dataId = data.id || data.timestamp || JSON.stringify(data);
      if (dataId === lastProcessedId) {
        log("服务模式", "数据未变化，跳过");
        return;
      }

      lastProcessedId = dataId;
      saveSettings();

      // 从响应中提取数据（支持自定义路径）
      const fillData = getNestedValue(data, dataPath) || data;
      log(
        "服务模式",
        `数据路径 "${dataPath}" 提取结果: ${JSON.stringify(fillData).substring(0, 200)}`,
      );

      // 解析数据并填充
      await fillByPayload(fillData);
    } catch (e) {
      log("服务模式", `请求失败: ${e.message}`);
    }
  }

  function startPolling() {
    if (isPolling) return;
    if (!serviceUrl) {
      toast("服务模式", "请先配置服务地址");
      return;
    }
    isPolling = true;
    log("服务模式", `开始轮询，间隔 ${pollInterval}ms`);
    fetchFromService();
    pollTimer = setInterval(fetchFromService, pollInterval);
    updateModeUI();
  }

  function stopPolling() {
    if (!isPolling) return;
    isPolling = false;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    log("服务模式", "已停止轮询");
    updateModeUI();
  }

  function switchMode(mode) {
    if (mode === currentMode) return;

    // 停止当前模式
    if (currentMode === "service") {
      stopPolling();
    }

    currentMode = mode;
    saveSettings();

    // 启动新模式
    if (mode === "service") {
      startPolling();
    } else {
      setTimeout(focusHiddenScanner, 300);
    }

    updateModeUI();
    const modeNames = {
      scanner: "扫码枪模式",
      service: "后台服务模式",
      history: "填充历史",
    };
    toast("模式切换", `已切换到${modeNames[mode] || mode}`);
  }

  function updateModeUI() {
    const modeTabs = document.querySelectorAll(".mode-tab");
    modeTabs.forEach((tab) => {
      const tabMode = tab.dataset.mode;
      if (tabMode === currentMode) {
        tab.classList.add("active");
      } else {
        tab.classList.remove("active");
      }
    });

    const serviceSection = document.getElementById("serviceSection");
    if (serviceSection) {
      serviceSection.style.display =
        currentMode === "service" ? "grid" : "none";
    }

    const scannerSection = document.getElementById("scannerSection");
    if (scannerSection) {
      scannerSection.style.display =
        currentMode === "scanner" ? "grid" : "none";
    }

    const historySection = document.getElementById("historySection");
    if (historySection) {
      historySection.style.display =
        currentMode === "history" ? "block" : "none";
    }

    const pollBtn = document.getElementById("pollBtn");
    if (pollBtn) {
      pollBtn.textContent = isPolling ? "⏸ 停止轮询" : "▶ 开始轮询";
      pollBtn.style.background = isPolling
        ? "linear-gradient(135deg,#ff4d5e,#ef233c)"
        : "linear-gradient(135deg,#22c55e,#16a34a)";
    }

    const statusBadge = document.getElementById("modeStatus");
    if (statusBadge) {
      if (currentMode === "scanner") {
        statusBadge.textContent = "扫码枪就绪";
        statusBadge.style.background = "#eff6ff";
        statusBadge.style.color = "#2563eb";
        statusBadge.style.borderColor = "#bfdbfe";
      } else {
        statusBadge.textContent = isPolling ? "服务轮询中..." : "服务就绪";
        statusBadge.style.background = isPolling ? "#f0fdf4" : "#fffbeb";
        statusBadge.style.color = isPolling ? "#16a34a" : "#d97706";
        statusBadge.style.borderColor = isPolling ? "#86efac" : "#fcd34d";
      }
    }
  }

  function charFromKeyboardEvent(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return "";
    const code = e.code || "";
    if (/^Key[A-Z]$/.test(code)) {
      const ch = code.slice(3).toLowerCase();
      return e.shiftKey ? ch.toUpperCase() : ch;
    }
    if (/^Digit[0-9]$/.test(code)) {
      const n = code.slice(5);
      const shifted = {
        0: ")",
        1: "!",
        2: "@",
        3: "#",
        4: "$",
        5: "%",
        6: "^",
        7: "&",
        8: "*",
        9: "(",
      };
      return e.shiftKey ? shifted[n] : n;
    }
    const map = {
      Space: " ",
      Minus: e.shiftKey ? "_" : "-",
      Equal: e.shiftKey ? "+" : "=",
      BracketLeft: e.shiftKey ? "{" : "[",
      BracketRight: e.shiftKey ? "}" : "]",
      Backslash: e.shiftKey ? "|" : "\\",
      Semicolon: e.shiftKey ? ":" : ";",
      Quote: e.shiftKey ? '"' : "'",
      Comma: e.shiftKey ? "<" : ",",
      Period: e.shiftKey ? ">" : ".",
      Slash: e.shiftKey ? "?" : "/",
      Backquote: e.shiftKey ? "~" : "`",
    };
    return map[code] || "";
  }

  function commitScanBuffer(reason) {
    const raw = scanBuffer;
    scanBuffer = "";
    clearTimeout(scanTimer);
    if (!raw.trim()) return;
    log("扫码键盘捕获", `${reason}：${raw}`);
    if (
      raw.includes("QRFILL1:") ||
      raw.includes("FORMQR") ||
      raw.includes("FORMQR64:")
    )
      handleScan(raw);
  }

  function pushScanChar(ch) {
    const now = Date.now();
    if (now - scanLastAt > SCAN_RESET_GAP) scanBuffer = "";
    scanLastAt = now;
    scanBuffer += ch;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(
      () => commitScanBuffer("延迟提交"),
      SCAN_AUTO_COMMIT_DELAY,
    );
  }

  function onKeydown(e) {
    if (isPanelTarget(e.target)) return;
    if (e.isComposing || e.key === "Process" || e.key === "Dead") return;
    if (e.key === "Enter" || e.key === "Tab") {
      if (scanBuffer.trim()) {
        e.preventDefault();
        commitScanBuffer("结束符 " + e.key);
      }
      return;
    }
    const ch =
      charFromKeyboardEvent(e) || (e.key && e.key.length === 1 ? e.key : "");
    if (ch) pushScanChar(ch);
  }
  function isPanelTarget(el) {
    return !!(el && el.closest && el.closest("#" + panelId));
  }
  // 只监听扫描枪键盘事件；不监听剪贴板/复制粘贴事件，避免 QRFILL1 内容区复制文本时触发填充。
  document.addEventListener("keydown", onKeydown, true);

  function selectElement(e) {
    if (isPanelTarget(e.target)) return;
    const fillable =
      realFillable(e.target) ||
      realFillable(
        e.target.closest
          ? e.target.closest(
              ".el-select,.ant-select,.n-select,.el-input,.ant-input-affix-wrapper,.n-input",
            )
          : null,
      );
    if (!fillable) return;
    if (selectedElement)
      selectedElement.classList.remove("__qrfill_selected__");
    selectedElement = fillable;
    selectedElement.classList.add("__qrfill_selected__");
    updateSelectedInfo();
  }
  document.addEventListener("click", selectElement, true);

  const style = document.createElement("style");
  style.textContent = `
    .__qrfill_selected__{outline:none!important;outline-offset:0!important;box-shadow:none!important;background:transparent!important;background-image:none!important;border-color:inherit!important;}
    #${panelId}{position:fixed;z-index:2147483647;left:50%;top:50%;transform:translate(-50%,-50%);width:min(680px,calc(100vw - 40px));max-height:88vh;overflow:hidden;background:linear-gradient(180deg,rgba(255,255,255,.98),rgba(250,253,255,.96));border-radius:18px;box-shadow:0 22px 70px rgba(15,23,42,.22);font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#0f172a;border:1px solid rgba(203,213,225,.9);user-select:none;backdrop-filter:blur(10px)}
    #${panelId}.dragging{opacity:.97;box-shadow:0 26px 76px rgba(15,23,42,.26)}
    #${panelId} *{box-sizing:border-box}
    #${panelId} .hd{padding:20px 22px 16px;display:flex;justify-content:space-between;align-items:flex-start;background:linear-gradient(135deg,rgba(255,255,255,.95),rgba(248,250,252,.9));cursor:move;touch-action:none;position:sticky;top:0;z-index:2;border-bottom:1px solid rgba(226,232,240,.6);backdrop-filter:blur(20px);box-shadow:0 2px 20px rgba(15,23,42,.06)}
    #${panelId} .brand{display:flex;align-items:center;gap:14px;min-width:0}
    #${panelId} .logo{width:38px;height:38px;border-radius:14px;background:linear-gradient(135deg,#2378ff,#0f63ee);box-shadow:0 12px 28px rgba(35,120,255,.35);display:grid;place-items:center;color:white;flex:0 0 auto;transition:transform .2s ease,box-shadow .2s ease}
    #${panelId} .logo:hover{transform:scale(1.05);box-shadow:0 14px 32px rgba(35,120,255,.45)}
    #${panelId} .logo svg{width:22px;height:22px;transition:transform .3s ease}
    #${panelId} .logo:hover svg{transform:scale(1.1)}
    #${panelId} .titleBox{display:grid;gap:3px;min-width:0}
    #${panelId} .title{font-weight:900;font-size:20px;letter-spacing:-0.02em;color:#0f172a;line-height:1.05;background:linear-gradient(135deg,#0f172a,#334155);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
    #${panelId} .dragHint{font-size:11px;color:#64748b;font-weight:600;display:flex;align-items:center;gap:4px;opacity:.8;transition:opacity .2s ease}
    #${panelId} .dragHint:hover{opacity:1}
    #${panelId} .dragHint::before{content:'⋮⋮';font-size:8px;color:#94a3b8;letter-spacing:-2px}
    #${panelId} #qrClose{cursor:pointer;width:auto;min-width:110px;background:#f8fafc;color:#1e293b;border:1px solid #cbd5e1;border-radius:13px;padding:10px 14px;font-size:13px;box-shadow:0 6px 18px rgba(15,23,42,.06)}
    #${panelId} #qrClose:hover{background:#eef6ff;border-color:#93c5fd;color:#0f172a}
    #${panelId} .bd{padding:16px 20px 18px;display:grid;gap:12px;max-height:calc(92vh - 98px);overflow:auto;background:rgba(248,250,252,.55)}
    #${panelId} .section{display:grid;gap:12px}
    #${panelId} .sectionTitle{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:800;color:#101828;margin:2px 0 0}
    #${panelId} .sectionTitle svg{width:20px;height:20px;color:#1e293b;flex:0 0 auto}
    #${panelId} label{font-size:14px;font-weight:800;color:#101828;display:grid;gap:10px;line-height:1.25}
    #${panelId} label .hint{font-size:11px;color:#94a3b8;font-weight:600}
    #${panelId} input,#${panelId} textarea,#${panelId} select{width:100%;border:1px solid #cbd5e1;border-radius:13px;padding:11px 14px;font-size:14px;background:#fff;color:#0f172a;outline:none;box-shadow:0 5px 18px rgba(15,23,42,.035) inset,0 1px 2px rgba(15,23,42,.03);transition:border-color .14s ease, box-shadow .14s ease, background .14s ease;min-height:44px;box-sizing:border-box}
    #${panelId} select{line-height:1.5;cursor:pointer}
    #${panelId} input::placeholder,#${panelId} textarea::placeholder{color:#94a3b8}
    #${panelId} input:focus,#${panelId} textarea:focus,#${panelId} select:focus{border-color:#bfdbfe;box-shadow:0 0 0 1px rgba(59,130,246,.08);background:transparent}
    #${panelId} #scannerInput{ime-mode:disabled;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:transparent;border-color:#dbe4f0}
    #${panelId} textarea{min-height:74px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.55;resize:vertical}
    #${panelId} button{border:1px solid transparent;border-radius:12px;background:linear-gradient(135deg,#2378ff,#0f63ee);color:#fff;padding:11px 14px;font-weight:850;cursor:pointer;font-size:14px;box-shadow:0 12px 25px rgba(37,99,235,.22);display:inline-flex;align-items:center;justify-content:center;gap:9px;min-height:42px}
    #${panelId} button:hover{filter:brightness(.98);transform:translateY(-1px)}
    #${panelId} button.secondary{background:#f8fafc;color:#1e293b;border-color:#cbd5e1;box-shadow:0 7px 18px rgba(15,23,42,.05);display:flex;align-items:center;justify-content:center;gap:8px}
    #${panelId} button.secondary svg{width:18px;height:18px;flex-shrink:0}
    #${panelId} button.secondary:hover{background:#eef6ff;border-color:#93c5fd;filter:none}
    #${panelId} button.danger{background:linear-gradient(135deg,#ff4d5e,#ef233c);color:#fff;border-color:transparent;box-shadow:0 12px 24px rgba(239,35,60,.22)}
    #${panelId} .row{display:grid;grid-template-columns:1fr 1fr;gap:10px;align-items:end}
    #${panelId} .row3{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;align-items:end}
    #${panelId} .row2tight{display:grid;grid-template-columns:1.05fr .95fr;gap:12px;align-items:end}
    #${panelId} .infoBox{font-size:14px;color:#334155;line-height:1.65;word-break:break-all;background:#eff8ff;border:1px solid #93c5fd;border-radius:12px;padding:10px 14px;display:flex;align-items:flex-start;gap:10px;box-shadow:0 8px 22px rgba(14,165,233,.07)}
    #${panelId} .infoIcon{width:24px;height:24px;border:2px solid #0b72d9;border-radius:999px;display:grid;place-items:center;color:#0b72d9;font-weight:900;line-height:1;flex:0 0 auto;margin-top:1px}
    #${panelId} .listSectionHead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:2px}
    #${panelId} .list{display:grid;gap:10px;max-height:200px;overflow:auto;border:0;border-radius:0;padding:0;background:transparent}
    #${panelId} .item{font-size:13px;line-height:1.55;background:#fff;border:1px solid rgba(226,232,240,.95);border-radius:16px;padding:12px 14px;word-break:break-all;box-shadow:0 10px 24px rgba(15,23,42,.06);display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:10px;align-items:center}
    #${panelId} .delete-field-btn{width:28px;height:28px;border-radius:8px;border:1px solid #fee2e2;background:#fef2f2;color:#dc2626;font-size:16px;font-weight:800;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s;line-height:1;min-height:auto;padding:0}
    #${panelId} .delete-field-btn:hover{background:#fee2e2;border-color:#fca5a5;transform:scale(1.1)}
    #${panelId} .item .num{width:34px;height:34px;border-radius:10px;background:#eef4ff;display:grid;place-items:center;color:#1769e9;font-size:14px;font-weight:850}
    #${panelId} .itemMain{min-width:0}
    #${panelId} .keyRow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px}
    #${panelId} .item .key{font-size:14px;color:#0f172a;font-weight:850;display:inline-flex;align-items:center;gap:6px}
    #${panelId} .keyBadge{display:inline-flex;align-items:center;padding:3px 8px;border-radius:999px;background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe;font-size:11px;font-weight:800}
    #${panelId} .item .meta{color:#475569;font-size:12px;line-height:1.5}
    #${panelId} .itemActions{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
    #${panelId} .copyBtn{display:none;border-radius:10px;background:#fff;color:#2563eb;border:1px solid #bfdbfe;box-shadow:none;padding:0 12px;font-size:13px;font-weight:800}
    #${panelId} .copyBtn:hover{background:#eff6ff;border-color:#93c5fd;transform:none}
    #${panelId} .small{font-size:13px;color:#64748b;line-height:1.6;word-break:break-all;background:#fff;border:1px dashed #cbd5e1;border-radius:10px;padding:12px 14px;text-align:center}
    #${panelId} .log{max-height:140px;overflow:auto;background:#0f172a;color:#dbeafe;border-radius:10px;padding:10px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.55;white-space:pre-wrap;border:1px solid rgba(15,23,42,.12);box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}
    #${panelId} .versionFooter{border-top:1px solid rgba(226,232,240,.9);padding-top:12px;display:grid;gap:8px;color:#64748b;font-size:12px;line-height:1.55}
    #${panelId} .versionLine{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
    #${panelId} .versionBadge{display:inline-flex;align-items:center;padding:3px 9px;border-radius:999px;background:#eef6ff;color:#2563eb;border:1px solid #bfdbfe;font-weight:850;font-size:11px}
    #${panelId} details.changelog{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:9px 11px;text-align:left}
    #${panelId} details.changelog summary{cursor:pointer;font-weight:850;color:#334155;list-style:none;display:flex;align-items:center;justify-content:space-between;gap:8px}
    #${panelId} details.changelog summary::-webkit-details-marker{display:none}
    #${panelId} details.changelog summary:after{content:'展开';font-size:11px;color:#2563eb;font-weight:850}
    #${panelId} details.changelog[open] summary:after{content:'收起'}
    #${panelId} .changelogList{margin:8px 0 0;padding-left:16px;color:#64748b;font-size:12px;line-height:1.65}
    #${panelId} .mode-tabs{display:flex;background:#f1f5f9;border-radius:12px;padding:4px;gap:4px;margin-bottom:8px}
    #${panelId} .mode-tab{flex:1;padding:10px 14px;border-radius:10px;text-align:center;font-weight:800;font-size:14px;cursor:pointer;transition:all .2s;color:#64748b;background:transparent;border:0;display:flex;align-items:center;justify-content:center;gap:8px}
    #${panelId} .mode-tab svg{width:18px;height:18px;flex-shrink:0}
    #${panelId} .mode-tab:hover{color:#475569}
    #${panelId} .mode-tab.active{background:#fff;color:#0f63ee;box-shadow:0 2px 8px rgba(15,99,238,.12)}
    #${panelId} .mode-status{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}
    #${panelId} .mode-status-badge{padding:6px 12px;border-radius:999px;font-size:12px;font-weight:800;border:1px solid}
    #${panelId} .copyright{text-align:center;font-size:11px;color:#94a3b8;line-height:1.6}
    #${panelId} .history-list{max-height:400px;overflow-y:auto;padding-right:8px}
    #${panelId} .history-list::-webkit-scrollbar{width:6px;border-radius:3px}
    #${panelId} .history-list::-webkit-scrollbar-track{background:#f1f5f9;border-radius:3px}
    #${panelId} .history-list::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:3px}
    #${panelId} .history-list::-webkit-scrollbar-thumb:hover{background:#94a3b8}
    #${panelId} .history-item{background:#fff;border-radius:12px;padding:14px;margin-bottom:10px;box-shadow:0 1px 3px rgba(0,0,0,.05);border:1px solid #e2e8f0}
    #${panelId} .history-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
    #${panelId} .history-time{font-size:12px;color:#94a3b8;font-family:monospace}
    #${panelId} .history-status{font-size:12px;font-weight:800;padding:3px 10px;border-radius:999px}
    #${panelId} .history-status.success{background:#dcfce7;color:#166534;border:1px solid #bbf7d0}
    #${panelId} .history-status.failed{background:#fee2e2;color:#991b1b;border:1px solid #fecaca}
    #${panelId} .history-summary{font-size:13px;color:#334155;font-weight:700;margin-bottom:6px}
    #${panelId} .history-meta{display:flex;gap:12px;margin-bottom:10px}
    #${panelId} .history-duration,#${panelId} .history-template{font-size:11px;color:#64748b}
    #${panelId} .history-fields{background:#f8fafc;border-radius:8px;padding:10px}
    #${panelId} .history-field{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:6px;margin-bottom:4px}
    #${panelId} .history-field:last-child{margin-bottom:0}
    #${panelId} .history-field:hover{background:#f1f5f9}
    #${panelId} .field-key{font-size:12px;font-weight:800;color:#1e293b;min-width:60px}
    #${panelId} .field-status{font-size:11px;font-weight:800;padding:2px 8px;border-radius:999px}
    #${panelId} .field-status.success{background:#dcfce7;color:#166534}
    #${panelId} .field-status.failed{background:#fee2e2;color:#991b1b}
    #${panelId} .field-status.skipped{background:#f3f4f6;color:#6b7280}
    #${panelId} .field-value{font-size:12px;color:#475569;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #${panelId} .field-duration{font-size:11px;color:#94a3b8;font-family:monospace}
    #${panelId} .history-actions{margin-top:10px;padding-top:10px;border-top:1px solid #e2e8f0}
    #${panelId} .history-action-btn{font-size:12px;padding:5px 12px;border-radius:6px;border:1px solid #e2e8f0;background:#fff;color:#64748b;cursor:pointer;transition:all .2s}
    #${panelId} .history-action-btn:hover{background:#f1f5f9;color:#334155;border-color:#cbd5e1}
    /* 隐藏滚动条但保留滚动功能 */
    #${panelId} .bd::-webkit-scrollbar{display:none}
    #${panelId} .bd{-ms-overflow-style:none;scrollbar-width:none}
    #${panelId} .list::-webkit-scrollbar{display:none}
    #${panelId} .list{-ms-overflow-style:none;scrollbar-width:none}
    #${panelId} .log::-webkit-scrollbar{display:none}
    #${panelId} .log{-ms-overflow-style:none;scrollbar-width:none}

    #qrfill-hidden-scanner{position:fixed!important;left:-10000px!important;top:-10000px!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important;z-index:-1!important}
    .qrfill-toast{position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#0f172a;color:#fff;border-radius:10px;padding:10px 12px;max-width:420px;box-shadow:0 16px 40px rgba(0,0,0,.26);font:14px/1.6 system-ui;white-space:pre-wrap;border:1px solid rgba(255,255,255,.08)}
    #qrfill-fab{position:fixed;width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#2378ff,#0f63ee);color:#fff;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 24px rgba(37,99,235,.4);z-index:2147483646;transition:transform .2s,box-shadow .2s;bottom:20px;right:20px}
    #qrfill-fab:hover{transform:scale(1.08);box-shadow:0 12px 32px rgba(37,99,235,.5)}
    #qrfill-fab svg{width:26px;height:26px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
    .__qrfill_hover__{outline:2px dashed #22c55e!important;outline-offset:2px!important;box-shadow:0 0 0 4px rgba(34,197,94,.15)!important;cursor:crosshair!important;transition:outline .1s ease,box-shadow .1s ease}
    .__qrfill_record_tip__{position:fixed;z-index:2147483646;pointer-events:none;background:#0f172a;color:#fff;border-radius:8px;padding:6px 12px;font:13px/1.5 system-ui;white-space:nowrap;box-shadow:0 8px 24px rgba(0,0,0,.3);transform:translate(-50%,-100%);margin-top:-8px;max-width:320px;overflow:hidden;text-overflow:ellipsis}
    .__qrfill_record_tip__ em{color:#86efac;font-style:normal;font-weight:800}
    #${panelId} .record-bar{display:flex;align-items:center;gap:10px;background:#fff;border:1px solid #e2e8f0;border-radius:13px;padding:10px 14px;box-shadow:0 4px 12px rgba(15,23,42,.04)}
    #${panelId} .record-bar .record-dot{width:10px;height:10px;border-radius:50%;flex:0 0 auto}
    #${panelId} .record-bar .record-dot.off{background:#cbd5e1}
    #${panelId} .record-bar .record-dot.on{background:#22c55e;box-shadow:0 0 0 4px rgba(34,197,94,.2);animation:qrfill-pulse 1.5s infinite}
    @keyframes qrfill-pulse{0%,100%{box-shadow:0 0 0 4px rgba(34,197,94,.2)}50%{box-shadow:0 0 0 8px rgba(34,197,94,.1)}}
    #${panelId} .record-bar .record-text{flex:1;font-size:13px;color:#475569;font-weight:600}
    #${panelId} .record-bar .record-text b{color:#0f172a}
    #${panelId} .record-bar button{border-radius:8px;padding:4px 10px;font-size:12px;font-weight:700;min-height:auto;box-shadow:none}
    #${panelId} .record-bar button.secondary{background:#eff6ff;color:#2563eb;border-color:#bfdbfe}
    #${panelId} .record-bar button.record-on{background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;border-color:transparent;box-shadow:0 4px 12px rgba(34,197,94,.2)}
    #${panelId} .record-bar button.record-off{background:linear-gradient(135deg,#ff4d5e,#ef233c);color:#fff;border-color:transparent;box-shadow:0 4px 12px rgba(239,35,60,.2)}
    #${panelId} .suggest-box{display:grid;gap:8px;background:#f0fdf4;border:1px solid #86efac;border-radius:12px;padding:12px 14px;box-shadow:0 8px 22px rgba(34,197,94,.08)}
    #${panelId} .suggest-box .suggest-head{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:800;color:#166534}
    #${panelId} .suggest-box .suggest-head svg{width:16px;height:16px;color:#16a34a;flex:0 0 auto}
    #${panelId} .suggest-box .suggest-info{font-size:12px;color:#475569;line-height:1.5;word-break:break-all}
    #${panelId} .suggest-box .suggest-keys{display:flex;flex-wrap:wrap;gap:6px}
    #${panelId} .suggest-box .suggest-key{display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border-radius:8px;font-size:12px;font-weight:800;cursor:pointer;border:1px solid #bbf7d0;background:#fff;color:#166534;transition:all .15s}
    #${panelId} .suggest-box .suggest-key:hover{background:#dcfce7;border-color:#86efac}
    #${panelId} .suggest-box .suggest-key.active{background:#22c55e;color:#fff;border-color:#22c55e}
    @media (max-width:780px){#${panelId}{width:calc(100vw - 24px);border-radius:18px}#${panelId} .hd{padding:18px}#${panelId} .bd{padding:18px;gap:14px}#${panelId} .title{font-size:22px}#${panelId} .row,#${panelId} .row2tight,#${panelId} .row3{grid-template-columns:1fr;gap:12px}#${panelId} label{font-size:15px}#${panelId} input,#${panelId} textarea,#${panelId} select,#${panelId} button{font-size:14px}#${panelId} .item{grid-template-columns:44px 1fr}.itemActions{display:none!important}#qrfill-fab{bottom:14px;right:14px;width:48px;height:48px}#qrfill-fab svg{width:22px;height:22px}}
  `;
  document.documentElement.appendChild(style);

  const panel = document.createElement("div");
  panel.id = panelId;
  panel.innerHTML = `
    <div class="hd" id="dragHandle">
      <div class="brand">
<div class="title">表单填充助手</div>
      </div>
      <button class="secondary" id="qrClose">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        隐藏面板
      </button>
    </div>
    <div class="bd">
      <div class="mode-tabs">
        <button class="mode-tab active" data-mode="scanner">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"/><path d="M15 15h2v2h-2zM19 15h1v5h-5v-1M14 19v1"/></svg>
          扫码枪模式
        </button>
        <button class="mode-tab" data-mode="service">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21a9 9 0 1 0-9-9"/><path d="M3 12a9 9 0 0 1 9 9"/><path d="M12 3v3l2.5 2.5M21 12h-3l-2.5-2.5M12 21v-3l-2.5-2.5M3 12h3l2.5 2.5"/></svg>
          后台服务模式
        </button>
        <button class="mode-tab" data-mode="history">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
          填充历史
        </button>
      </div>
      <div class="mode-status">
        <span style="font-size:13px;color:#64748b;font-weight:600">当前状态</span>
        <span class="mode-status-badge" id="modeStatus">扫码枪就绪</span>
      </div>
      <div class="row">
        <label>模板<select id="tplSelect"></select></label>
        <label>模板名<input id="tplName" placeholder="例如：检测表单"></label>
      </div>
      <div class="row3"><button id="newTpl">＋ 新建模板</button><button id="saveTpl">▣ 保存模板</button><button class="danger" id="delTpl">删除模板</button><button id="exportTpl">↓ 导出</button><button id="importTpl">↑ 导入</button></div>
      <div class="record-bar" id="recordBar">
        <div class="record-dot off" id="recordDot"></div>
        <div class="record-text" id="recordText">点击右侧按钮开启<b>录制模式</b>，自动抓取页面元素并推荐 key</div>
        <button class="record-on" id="recordToggle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><circle cx="12" cy="12" r="7" fill="#ef4444"/><circle cx="12" cy="12" r="4"/></svg> 开启录制</button>
      </div>
      <div class="suggest-box" id="suggestBox" style="display:none">
        <div class="suggest-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg><span id="suggestTitle">推荐 key</span></div>
        <div class="suggest-info" id="suggestInfo"></div>
        <div class="suggest-keys" id="suggestKeys"></div>
      </div>
      <div class="infoBox"><span class="infoIcon">i</span><span id="selectedInfo">点击页面上的输入框/下拉框后，在下面绑定二维码字段 key。</span></div>
      <div class="section"><div class="sectionTitle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41 11 3.83a2 2 0 0 0-1.41-.59H4a2 2 0 0 0-2 2v5.59a2 2 0 0 0 .59 1.41l9.59 9.59a2 2 0 0 0 2.83 0l5.58-5.58a2 2 0 0 0 0-2.84Z"/><path d="M7 7h.01"/></svg>二维码字段 key</div><input id="fieldKey" placeholder="例如：111 / name / phone"></div>
      <div class="row2tight"><button id="bindField">🔗 添加 / 更新字段绑定</button><button class="secondary" id="focusScanner">聚焦扫码捕获框</button></div>
      
      <!-- 历史记录区域 -->
      <div class="section" id="historySection" style="display:none">
        <div class="sectionTitle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>填充历史记录
          <button id="clearHistoryBtn" class="secondary" style="margin-left:auto;border-radius:8px;padding:4px 10px;font-size:12px;font-weight:700;box-shadow:none;min-height:auto;cursor:pointer">🗑️ 清空历史</button>
        </div>
        <div class="history-list" id="historyList"></div>
      </div>
      
      <!-- 扫码枪模式区域 -->
      <div class="section" id="scannerSection">
        <div class="sectionTitle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M8 12h8"/></svg>扫码捕获框（防中文输入法干扰）</div>
        <input id="scannerInput" placeholder="点击这里后扫码；建议扫 QRFILL1..." inputmode="latin" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" lang="en">
      </div>
      
      <!-- 后台服务模式区域 -->
      <div class="section" id="serviceSection" style="display:none">
        <div class="sectionTitle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21a9 9 0 1 0-9-9"/><path d="M3 12a9 9 0 0 1 9 9"/><path d="M12 3v3l2.5 2.5M21 12h-3l-2.5-2.5M12 21v-3l-2.5-2.5M3 12h3l2.5 2.5"/></svg>后台服务配置</div>
        <label>服务地址<span class="hint">返回 JSON 数据的 API 地址</span><input id="serviceUrl" placeholder="例如：http://localhost:3000/api/data"></label>
        <label>轮询间隔（毫秒）<span class="hint">建议 1000-5000ms</span><input id="pollInterval" type="number" placeholder="2000" value="2000"></label>
        <label>数据路径<span class="hint">从响应中提取数据的路径，支持点号分隔。如 "data"、"result.data"、留空使用根对象</span><input id="dataPath" placeholder="data"></label>
        <div class="row">
          <button id="pollBtn" style="background:linear-gradient(135deg,#22c55e,#16a34a)">▶ 开始轮询</button>
          <button class="secondary" id="fetchOnceBtn">↻ 获取一次</button>
        </div>
      </div>
      
      <div class="section"><div class="sectionTitle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>测试 JSON<button id="autoGenMock" style="margin-left:auto;border-radius:8px;padding:4px 10px;font-size:12px;font-weight:700;background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe;box-shadow:none;min-height:auto;cursor:pointer">🎲 自动生成</button></div><textarea id="testJson">{"111":"检测中"}</textarea></div>
      <div class="row2tight"><button id="testFill">▷ 测试填充</button><button id="genAscii" style="background:linear-gradient(135deg,#16a8e8,#0ca7a7);box-shadow:0 12px 25px rgba(13,148,136,.22)">▦ 生成 QRFILL1</button></div>
      <div class="section"><div class="sectionTitle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>QRFILL1 内容</div><textarea id="asciiOut" placeholder="生成的 QRFILL1 将显示在这里" readonly></textarea></div>
      <div class="section"><div class="listSectionHead"><div class="sectionTitle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12h6"/><path d="M12 9v6"/><path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>已绑定字段</div></div><div class="list" id="fieldList"></div></div>
      <div class="section"><div class="sectionTitle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>操作日志</div></div><div class="log" id="logBox"></div>
      <div class="versionFooter">
        <div class="versionLine"><span>当前版本</span><span class="versionBadge">v${APP_VERSION}</span></div>
        <details class="changelog" open>
          <summary>版本更新日志</summary>
          <ul class="changelogList">
            <li><strong>v1.0</strong>：新增后台服务模式，支持通过 API 获取数据自动填充，增加美观的模式切换界面，品牌升级为"表单填充助手"。</li>
          </ul>
        </details>
        <div class="copyright">© 2026 表单填充助手. All rights reserved.<br>仅在本地浏览器保存模板，请勿在不可信页面使用敏感数据。</div>
      </div>
    </div>`;
  document.body.appendChild(panel);

  function clampPanelPosition(left, top) {
    const rect = panel.getBoundingClientRect();
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(
      margin,
      window.innerHeight -
        Math.min(rect.height, window.innerHeight - margin * 2) -
        margin,
    );
    return {
      left: Math.min(Math.max(left, margin), maxLeft),
      top: Math.min(Math.max(top, margin), maxTop),
    };
  }

  function savePanelPosition(left, top) {
    try {
      localStorage.setItem(PANEL_POS_KEY, JSON.stringify({ left, top }));
    } catch {}
  }

  function loadPanelPosition() {
    try {
      return JSON.parse(localStorage.getItem(PANEL_POS_KEY) || "null");
    } catch {
      return null;
    }
  }

  function applyPanelPosition(pos) {
    if (!pos || typeof pos.left !== "number" || typeof pos.top !== "number")
      return;
    const next = clampPanelPosition(pos.left, pos.top);
    panel.style.left = next.left + "px";
    panel.style.top = next.top + "px";
    panel.style.transform = "none";
  }

  function enablePanelDrag() {
    const handle = panel.querySelector("#dragHandle");
    if (!handle) return;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    handle.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button,input,textarea,select")) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      startX = event.clientX;
      startY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      panel.style.left = rect.left + "px";
      panel.style.top = rect.top + "px";
      panel.style.transform = "none";
      panel.classList.add("dragging");
      if (handle.setPointerCapture) handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    handle.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const next = clampPanelPosition(
        startLeft + event.clientX - startX,
        startTop + event.clientY - startY,
      );
      panel.style.left = next.left + "px";
      panel.style.top = next.top + "px";
      event.preventDefault();
    });

    function stopDrag(event) {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove("dragging");
      const rect = panel.getBoundingClientRect();
      const next = clampPanelPosition(rect.left, rect.top);
      panel.style.left = next.left + "px";
      panel.style.top = next.top + "px";
      savePanelPosition(next.left, next.top);
      try {
        if (handle.releasePointerCapture)
          handle.releasePointerCapture(event.pointerId);
      } catch {}
    }

    handle.addEventListener("pointerup", stopDrag);
    handle.addEventListener("pointercancel", stopDrag);
    window.addEventListener("resize", () =>
      applyPanelPosition(loadPanelPosition()),
    );
  }

  applyPanelPosition(loadPanelPosition());
  enablePanelDrag();
  // 默认隐藏：刷新页面后只恢复扫码监听，不打扰页面；点击插件图标再显示面板。
  panel.style.display = "none";

  const hiddenScanner = document.createElement("input");
  hiddenScanner.id = "qrfill-hidden-scanner";
  hiddenScanner.setAttribute("autocomplete", "off");
  hiddenScanner.setAttribute("autocorrect", "off");
  hiddenScanner.setAttribute("autocapitalize", "off");
  hiddenScanner.setAttribute("spellcheck", "false");
  hiddenScanner.setAttribute("inputmode", "latin");
  hiddenScanner.setAttribute("lang", "en");
  hiddenScanner.setAttribute("aria-hidden", "true");
  document.body.appendChild(hiddenScanner);
  window.__qrfillHiddenScanner = hiddenScanner;

  function focusHiddenScanner() {
    try {
      hiddenScanner.value = "";
      hiddenScanner.focus({ preventScroll: true });
      hiddenScanner.select();
      log("扫码监听", "隐藏捕获框已聚焦，面板关闭后仍可扫码");
    } catch (e) {
      log("扫码监听", "隐藏捕获框聚焦失败：" + e.message);
    }
  }

  function processScannerInput(input) {
    const raw = input.value;
    input.value = "";
    if (raw && raw.trim()) handleScan(raw);
  }

  function resetInputScanner(input) {
    input.__qrfillCodeBuffer = "";
    input.value = "";
    clearTimeout(input.__qrfillTimer);
  }

  function commitInputScanner(input, name, reason) {
    const codeRaw = input.__qrfillCodeBuffer || "";
    const valueRaw = input.value || "";
    const raw =
      codeRaw.includes("QRFILL1:") || codeRaw.includes("FORMQR")
        ? codeRaw
        : valueRaw;
    resetInputScanner(input);
    if (!raw.trim()) return;
    log("扫码捕获", `${name} ${reason}：${raw}`);
    handleScan(raw);
  }

  function bindScannerInput(input, name) {
    input.__qrfillCodeBuffer = "";
    input.addEventListener(
      "compositionstart",
      (e) => {
        input.__qrfillComposing = true;
        input.value = "";
        log(
          "输入法防护",
          name + " 检测到 compositionstart，忽略输入法组合内容",
        );
      },
      true,
    );
    input.addEventListener(
      "compositionupdate",
      (e) => {
        if (e.preventDefault) e.preventDefault();
        input.value = "";
      },
      true,
    );
    input.addEventListener(
      "compositionend",
      (e) => {
        input.__qrfillComposing = false;
        input.value = "";
        log("输入法防护", name + " compositionend 已清空组合内容");
      },
      true,
    );
    input.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          commitInputScanner(input, name, "收到结束符 " + e.key);
          return;
        }
        const ch = charFromKeyboardEvent(e);
        if (ch) {
          // 扫码捕获框用 KeyboardEvent.code 重建 ASCII，绕过中文输入法把 key 改成中文/智能标点的问题。
          e.preventDefault();
          input.__qrfillCodeBuffer += ch;
          clearTimeout(input.__qrfillTimer);
          input.__qrfillTimer = setTimeout(() => {
            const raw = input.__qrfillCodeBuffer || input.value || "";
            if (raw.includes("QRFILL1:") || raw.includes("FORMQR"))
              commitInputScanner(input, name, "ASCII code 延迟收包");
          }, SCAN_AUTO_COMMIT_DELAY);
        }
      },
      true,
    );
    // 只通过 keydown 重建扫描枪输入；不监听 input/paste，防止复制/粘贴 QRFILL1 内容被当成扫码。
  }

  bindScannerInput(hiddenScanner, "隐藏捕获框");

  document.addEventListener(
    "focusin",
    (e) => {
      // 刚完成扫码填充后的一小段时间内，若组件把焦点抢回表单，立刻拉回扫码捕获框。
      if (!lastScanCompletedAt || Date.now() - lastScanCompletedAt > 5000)
        return;
      if (e.target === hiddenScanner || isPanelTarget(e.target)) return;
      setTimeout(() => refocusScannerAfterFill("阻止焦点落入表单"), 30);
    },
    true,
  );

  function log(title, msg) {
    const box = document.getElementById("logBox");
    if (!box) return;
    const line = `[${new Date().toLocaleTimeString()}] ${title}: ${msg}`;
    box.textContent = line + "\n" + box.textContent;
  }
  function toast(title, msg) {
    const old = document.querySelector(".qrfill-toast");
    if (old) old.remove();
    const div = document.createElement("div");
    div.className = "qrfill-toast";
    div.textContent = `${title}\n${msg || ""}`;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 7000);
  }
  function renderTemplates() {
    const sel = document.getElementById("tplSelect");
    sel.innerHTML = templates
      .map(
        (t) =>
          `<option value="${t.id}">${escapeHtml(t.name)}｜${escapeHtml(t.pageKey)}</option>`,
      )
      .join("");
    sel.value = currentTemplateId;
    var tplObj = currentTemplate();
    document.getElementById("tplName").value =
      (tplObj ? tplObj.name : "") || "";
    renderFields();
  }
  function deleteField(index) {
    const tpl = currentTemplate();
    if (!tpl) return;
    const fieldKey = (tpl.fields[index] ? tpl.fields[index].key : "") || "";
    if (!confirm(`确定删除字段 "${fieldKey}"？`)) return;
    tpl.fields.splice(index, 1);
    saveTemplates();
    renderFields();
    toast("已删除字段", fieldKey);
  }

  function renderFields() {
    const tpl = currentTemplate();
    const box = document.getElementById("fieldList");
    if (!tpl || !tpl.fields.length) {
      box.innerHTML =
        '<div class="small">暂无字段绑定，先点击页面上的表单框，再输入二维码字段 key 进行绑定。</div>';
      return;
    }
    box.innerHTML = tpl.fields
      .map(
        (f, i) => `
      <div class="item">
        <div class="num">${i + 1}</div>
        <div class="itemMain">
          <div class="keyRow">
            <div class="key">${escapeHtml(f.key)}</div>
            <span class="keyBadge">二维码 key</span>
          </div>
          <div class="meta">标签：${escapeHtml(f.label || "")}<br>选择器：${escapeHtml(f.selector || "")}<br>作用域：${escapeHtml(f.scopeSelector || "")}<br>xpath：${escapeHtml(f.xpath || "")}</div>
        </div>
        <button class="delete-field-btn" data-index="${i}" title="删除字段">✕</button>
      </div>
    `,
      )
      .join("");

    // 绑定删除按钮事件
    box.querySelectorAll(".delete-field-btn").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        deleteField(parseInt(btn.dataset.index));
      };
    });
  }
  function updateSelectedInfo() {
    const el = selectedElement;
    const info = el
      ? `已选中表单框：${el.tagName.toLowerCase()} ｜ name=${el.name || "-"} ｜ id=${el.id || "-"} ｜ placeholder=${el.placeholder || "-"} ｜ label=${getLabelText(el) || "-"}`
      : "未选中字段，请直接点击页面上的输入框、下拉框或文本域。";
    document.getElementById("selectedInfo").textContent = info;
  }
  function escapeHtml(s) {
    return String(s || "").replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );
  }

  function extractSelectOptions(el) {
    if (!el) return [];
    const tag = el.tagName && el.tagName.toLowerCase();
    if (tag === "select") {
      return Array.from(el.options || [])
        .map((o) => ({ value: o.value, text: o.textContent.trim() }))
        .filter((o) => o.value);
    }
    const wrapper = el.closest(".el-select,.ant-select,.n-select");
    if (!wrapper) return [];
    const selectEl = wrapper.querySelector("select");
    if (selectEl) {
      return Array.from(selectEl.options || [])
        .map((o) => ({ value: o.value, text: o.textContent.trim() }))
        .filter((o) => o.value);
    }
    return [];
  }

  let recordingMode = false;
  let recordHoverEl = null;
  let recordTooltip = null;

  function suggestKeys(el) {
    const label = getLabelText(el);
    const name = el.name || "";
    const id = el.id || "";
    const placeholder = el.placeholder || "";
    const autocomplete = el.autocomplete || "";
    const type = (el.type || "").toLowerCase();

    const candidates = [];
    const seen = new Set();
    function add(val, src) {
      if (!val || seen.has(val)) return;
      seen.add(val);
      candidates.push({ key: val, source: src });
    }

    if (label) {
      const cleaned = label.replace(/[:：*·\s]+/g, " ").trim();
      add(cleaned, "label");
      const short = cleaned.replace(/\s+/g, "");
      if (short !== cleaned) add(short, "label");
      if (/^\d{3,}$/.test(cleaned)) add(cleaned, "label");
      const pinyinMap = {
        姓名: "xm",
        名字: "mz",
        名称: "mc",
        手机: "sj",
        电话: "dh",
        手机号: "sjh",
        邮箱: "yx",
        邮件: "yj",
        地址: "dz",
        住址: "zz",
        编号: "bh",
        工号: "gh",
        序号: "xh",
        日期: "rq",
        时间: "sj",
        数量: "sl",
        金额: "je",
        价格: "jg",
        状态: "zt",
        结果: "jg",
        类型: "lx",
        备注: "bz",
        说明: "sm",
        描述: "ms",
        密码: "mm",
        用户名: "yhm",
        公司: "gs",
        部门: "bm",
        职位: "zw",
        年龄: "nl",
        性别: "xb",
        身份证: "sfz",
        检测: "jc",
        批次: "pc",
        规格: "gg",
        重量: "zl",
        温度: "wd",
        湿度: "sd",
        标题: "bt",
        内容: "nr",
        文本: "wb",
        编码: "bm",
        代号: "dh",
        邮编: "yb",
        链接: "lj",
        网址: "wz",
        图片: "tp",
        文件: "wj",
        版本: "bb",
      };
      const pinyinVal = pinyinMap[cleaned] || pinyinMap[short];
      if (pinyinVal) add(pinyinVal, "label→key");
    }

    if (name) add(name, "name");
    if (id && !/^el-|n-|ant-|__/.test(id)) add(id, "id");

    const autoMap = {
      name: "xm",
      "given-name": "x",
      "family-name": "m",
      email: "yx",
      tel: "dh",
      phone: "sj",
      "street-address": "dz",
      "postal-code": "yb",
      organization: "gs",
      country: "gj",
      username: "yhm",
      password: "mm",
      "new-password": "xmm",
      bday: "sr",
      sex: "xb",
      gender: "xb",
      "cc-name": "ckr",
      "cc-number": "kh",
      "cc-exp": "yxq",
    };
    const autoVal = autoMap[autocomplete.toLowerCase()];
    if (autoVal) add(autoVal, "autocomplete");

    const typeMap = {
      email: "yx",
      tel: "dh",
      url: "wz",
      date: "rq",
      time: "sj",
      number: "sl",
      color: "ys",
      password: "mm",
    };
    const typeVal = typeMap[type];
    if (typeVal) add(typeVal, "type");

    if (placeholder) {
      const phCleaned = placeholder
        .replace(/请输入|请填写|选择|填写|：|:/g, "")
        .trim();
      if (phCleaned && phCleaned !== label) {
        add(phCleaned, "placeholder");
        const phPinyinMap = {
          姓名: "xm",
          手机号: "sjh",
          邮箱: "yx",
          地址: "dz",
          身份证号: "sfzh",
          编号: "bh",
          备注: "bz",
          描述: "ms",
          密码: "mm",
          用户名: "yhm",
          验证码: "yzm",
          公司名称: "gsmc",
          部门: "bm",
        };
        const phPinyin = phPinyinMap[phCleaned];
        if (phPinyin) add(phPinyin, "placeholder→key");
      }
    }

    const tpl = currentTemplate();
    if (tpl) {
      for (const f of tpl.fields) {
        seen.delete(f.key);
      }
    }

    if (candidates.length === 0) {
      const tplName = tpl ? `f${tpl.fields.length + 1}` : "field1";
      add(tplName, "auto");
    }

    return candidates.slice(0, 6);
  }

  function buildFieldInfo(el) {
    const label = getLabelText(el);
    const tag = el.tagName && el.tagName.toLowerCase();
    const type = el.type || "";
    const parts = [];
    if (tag) parts.push(`&lt;${tag}&gt;`);
    if (type) parts.push(`type=${type}`);
    if (el.name) parts.push(`name=${el.name}`);
    if (el.id) parts.push(`id=${el.id}`);
    if (label) parts.push(`label="${label}"`);
    if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
    return parts.join(" · ");
  }

  function showSuggestBox(el) {
    const box = document.getElementById("suggestBox");
    const info = document.getElementById("suggestInfo");
    const keys = document.getElementById("suggestKeys");
    const title = document.getElementById("suggestTitle");
    if (!box || !info || !keys) return;

    const label = getLabelText(el);
    const name = el.name || "";
    title.textContent = label ? `推荐 key（检测到标签：${label}）` : "推荐 key";
    info.innerHTML = buildFieldInfo(el);

    const suggestions = suggestKeys(el);
    keys.innerHTML = "";
    for (const s of suggestions) {
      const btn = document.createElement("span");
      btn.className = "suggest-key";
      btn.textContent = s.key;
      btn.title = `来源：${s.source}`;
      btn.onclick = () => {
        keys
          .querySelectorAll(".suggest-key")
          .forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById("fieldKey").value = s.key;
        log("录制推荐", `已选择推荐 key: ${s.key}（来源：${s.source}）`);
      };
      keys.appendChild(btn);
    }

    if (suggestions.length > 0) {
      document.getElementById("fieldKey").value = suggestions[0].key;
      var firstKey = keys.querySelector(".suggest-key");
      if (firstKey) firstKey.classList.add("active");
    }

    box.style.display = "grid";
    var bd = panel.querySelector(".bd");
    if (bd) bd.scrollTo({ top: box.offsetTop - 80, behavior: "smooth" });
  }

  function hideSuggestBox() {
    const box = document.getElementById("suggestBox");
    if (box) box.style.display = "none";
  }

  function showRecordTooltip(el, x, y) {
    if (!recordTooltip) {
      recordTooltip = document.createElement("div");
      recordTooltip.className = "__qrfill_record_tip__";
      document.body.appendChild(recordTooltip);
    }
    const label = getLabelText(el);
    const name = el.name || "";
    const tag = (el.tagName && el.tagName.toLowerCase()) || "";
    let tip = `<em>${tag}</em>`;
    if (label) tip += ` ${label}`;
    else if (name) tip += ` name="${name}"`;
    else if (el.placeholder) tip += ` ${el.placeholder}`;
    recordTooltip.innerHTML = tip;
    recordTooltip.style.left = x + "px";
    recordTooltip.style.top = y + "px";
    recordTooltip.style.display = "block";
  }

  function hideRecordTooltip() {
    if (recordTooltip) recordTooltip.style.display = "none";
  }

  function findRecordableTarget(target) {
    if (!target || target.nodeType !== 1) return null;
    if (isPanelTarget(target)) return null;
    const fillable =
      realFillable(target) ||
      realFillable(
        target.closest
          ? target.closest(
              ".el-select,.ant-select,.n-select,.el-input,.ant-input-affix-wrapper,.n-input",
            )
          : null,
      );
    return fillable;
  }

  function onRecordMousemove(e) {
    if (!recordingMode) return;
    const target = findRecordableTarget(e.target);
    if (recordHoverEl && recordHoverEl !== target) {
      recordHoverEl.classList.remove("__qrfill_hover__");
    }
    if (target && isActuallyVisible(target)) {
      recordHoverEl = target;
      target.classList.add("__qrfill_hover__");
      showRecordTooltip(target, e.clientX, e.clientY - 4);
    } else {
      recordHoverEl = null;
      hideRecordTooltip();
    }
  }

  function onRecordClick(e) {
    if (!recordingMode) return;
    const target = findRecordableTarget(e.target);
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    selectedElement && selectedElement.classList.remove("__qrfill_selected__");
    selectedElement = target;
    target.classList.remove("__qrfill_hover__");
    updateSelectedInfo();
    showSuggestBox(target);

    const label = getLabelText(target);
    const name = target.name || "";
    log(
      "录制抓取",
      `元素=${target.tagName} label="${label}" name="${name}" id="${target.id}"`,
    );
    toast("已抓取元素", label || name || target.id || "元素");

    setTimeout(() => {
      const fieldKeyInput = document.getElementById("fieldKey");
      if (fieldKeyInput) fieldKeyInput.focus();
    }, 100);
  }

  function startRecording() {
    recordingMode = true;
    document.addEventListener("mousemove", onRecordMousemove, true);
    document.addEventListener("click", onRecordClick, true);
    document.addEventListener("keydown", onRecordKeydown, true);
    const dot = document.getElementById("recordDot");
    const text = document.getElementById("recordText");
    const btn = document.getElementById("recordToggle");
    if (dot) {
      dot.classList.remove("off");
      dot.classList.add("on");
    }
    if (text)
      text.innerHTML = "<b>录制中</b> — 点击页面上的表单框自动抓取并推荐 key";
    if (btn) {
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px"><rect x="7" y="7" width="10" height="10" rx="1"/></svg> 停止录制';
      btn.className = "record-off";
    }
    log("录制模式", "已开启，点击页面元素自动抓取");
    toast("录制模式已开启", "点击页面上的表单框自动抓取并推荐 key");
  }

  function stopRecording() {
    recordingMode = false;
    document.removeEventListener("mousemove", onRecordMousemove, true);
    document.removeEventListener("click", onRecordClick, true);
    document.removeEventListener("keydown", onRecordKeydown, true);
    if (recordHoverEl) {
      recordHoverEl.classList.remove("__qrfill_hover__");
      recordHoverEl = null;
    }
    hideRecordTooltip();
    hideSuggestBox();
    const dot = document.getElementById("recordDot");
    const text = document.getElementById("recordText");
    const btn = document.getElementById("recordToggle");
    if (dot) {
      dot.classList.remove("on");
      dot.classList.add("off");
    }
    if (text)
      text.innerHTML =
        "点击右侧按钮开启<b>录制模式</b>，自动抓取页面元素并推荐 key";
    if (btn) {
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><circle cx="12" cy="12" r="7" fill="#ef4444"/><circle cx="12" cy="12" r="4"/></svg> 开启录制';
      btn.className = "record-on";
    }
    log("录制模式", "已停止");
    toast("录制模式已停止", "");
  }

  function onRecordKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      stopRecording();
    }
  }

  function generateValueByType(field) {
    const type = (field.type || "").toLowerCase();
    const inputMode = (field.inputMode || "").toLowerCase();
    const autocomplete = (field.autocomplete || "").toLowerCase();
    const min = field.min ? parseFloat(field.min) : null;
    const max = field.max ? parseFloat(field.max) : null;
    const step = field.step ? parseFloat(field.step) : null;
    const maxLength = field.maxLength || 0;

    if (field.options && field.options.length > 0) {
      const idx = Math.floor(Math.random() * field.options.length);
      return field.options[idx].value;
    }

    if (type === "email" || autocomplete === "email") {
      return "test@example.com";
    }
    if (type === "tel" || autocomplete === "tel" || inputMode === "tel") {
      return "13812345678";
    }
    if (type === "url" || autocomplete === "url") {
      return "https://example.com";
    }
    if (type === "date") {
      return "2024-01-15";
    }
    if (type === "datetime-local") {
      return "2024-01-15T09:30";
    }
    if (type === "time") {
      return "09:30";
    }
    if (type === "month") {
      return "2024-01";
    }
    if (type === "week") {
      return "2024-W03";
    }
    if (
      type === "number" ||
      inputMode === "numeric" ||
      inputMode === "decimal"
    ) {
      const minVal = min !== null ? min : 1;
      const maxVal = max !== null ? max : 100;
      const stepVal = step || 1;
      let val = minVal + Math.floor((maxVal - minVal) / stepVal / 2) * stepVal;
      if (step % 1 !== 0) {
        val = parseFloat(val.toFixed(2));
      }
      return String(val);
    }
    if (type === "range") {
      const minVal = min !== null ? min : 0;
      const maxVal = max !== null ? max : 100;
      return String(minVal + Math.floor((maxVal - minVal) / 2));
    }
    if (type === "color") {
      return "#3b82f6";
    }
    if (type === "checkbox") {
      return true;
    }
    if (type === "radio") {
      return field.value || "on";
    }

    if (inputMode === "numeric" || inputMode === "decimal") {
      return "100";
    }
    if (inputMode === "search") {
      return "搜索关键词";
    }

    return null;
  }

  function generateValueByPattern(pattern, maxLength) {
    if (!pattern) return null;

    const charSets = {
      "\\d": () => "0123456789"[Math.floor(Math.random() * 10)],
      "\\w": () =>
        "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)],
      "\\s": () => " ",
      "[0-9]": () => "0123456789"[Math.floor(Math.random() * 10)],
      "[a-zA-Z]": () =>
        "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)],
      "[a-z]": () =>
        "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)],
      "[A-Z]": () =>
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[Math.floor(Math.random() * 26)],
      "[a-zA-Z0-9]": () =>
        "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)],
    };

    let result = "";
    let i = 0;
    const patternStr = pattern;
    const targetLen = maxLength > 0 ? Math.min(maxLength, 20) : 10;

    while (result.length < targetLen && i < patternStr.length) {
      const remaining = patternStr.substring(i);

      for (const [key, gen] of Object.entries(charSets)) {
        if (remaining.startsWith(key)) {
          result += gen();
          i += key.length;
          break;
        }
      }

      if (result.length < targetLen && i < patternStr.length) {
        const ch = patternStr[i];
        if (
          ch === "^" ||
          ch === "$" ||
          ch === "(" ||
          ch === ")" ||
          ch === "|" ||
          ch === "?" ||
          ch === "*" ||
          ch === "+" ||
          ch === "{"
        ) {
          i++;
        } else if (ch === "\\") {
          i += 2;
        } else if (ch === "[") {
          const end = patternStr.indexOf("]", i);
          if (end > i) {
            const range = patternStr.substring(i + 1, end);
            if (range.includes("-")) {
              const [start, endChar] = range.split("-");
              result += String.fromCharCode(
                Math.floor(
                  Math.random() *
                    (endChar.charCodeAt(0) - start.charCodeAt(0) + 1),
                ) + start.charCodeAt(0),
              );
            } else {
              result += range[Math.floor(Math.random() * range.length)];
            }
            i = end + 1;
          } else {
            result += ch;
            i++;
          }
        } else {
          result += ch;
          i++;
        }
      }
    }

    return result || null;
  }

  function generateValueByKeyword(field) {
    const key = (field.key || "").toLowerCase();
    const label = (field.label || "").toLowerCase();
    const placeholder = (field.placeholder || "").toLowerCase();
    const combined = key + " " + label + " " + placeholder;

    const keywordMap = [
      { p: /姓名|名字|名称|name/i, v: "张三" },
      { p: /手机|电话|phone|tel|mobile/i, v: "13812345678" },
      { p: /邮箱|email/i, v: "test@example.com" },
      { p: /地址|address/i, v: "北京市朝阳区建国路100号" },
      { p: /邮编|邮证|postal|zip/i, v: "100000" },
      { p: /工号|员工|staff/i, v: "1001" },
      { p: /编号|id|no\b/i, v: "1001" },
      { p: /身份证|idcard|identity/i, v: "110101199001011234" },
      { p: /日期|date/i, v: "2024-01-15" },
      { p: /时间|time/i, v: "09:30:00" },
      { p: /数量|数目|count|qty|quantity/i, v: "5" },
      { p: /金额|价格|单价|price|amount|cost/i, v: "99.50" },
      { p: /状态|status/i, v: "正常" },
      { p: /结果|result/i, v: "合格" },
      { p: /备注|说明|remark|note|memo/i, v: "测试数据" },
      { p: /编码|代号|code/i, v: "CODE001" },
      { p: /类型|分类|type|kind|category/i, v: "类型A" },
      { p: /序号|number|seq/i, v: "1" },
      { p: /年龄|age/i, v: "28" },
      { p: /性别|gender|sex/i, v: "男" },
      { p: /公司|单位|company|corp/i, v: "测试公司" },
      { p: /部门|department|dept/i, v: "技术部" },
      { p: /职位|职务|title|position/i, v: "工程师" },
      { p: /文本|内容|text|content/i, v: "测试文本内容" },
      { p: /检测|检验|inspect/i, v: "检测中" },
      { p: /批次|批次号|batch/i, v: "B20240115001" },
      { p: /规格|spec/i, v: "100ml" },
      { p: /重量|weight/i, v: "500g" },
      { p: /温度|temp/i, v: "25℃" },
      { p: /湿度|humidity/i, v: "60%" },
      { p: /长度|length/i, v: "150cm" },
      { p: /宽度|width/i, v: "80cm" },
      { p: /高度|height/i, v: "50cm" },
      { p: /面积|area/i, v: "120㎡" },
      { p: /体积|volume/i, v: "2.5m³" },
      { p: /密码|password|pwd/i, v: "Test@123456" },
      { p: /用户|username|login/i, v: "testuser" },
      { p: /标题|title/i, v: "测试标题" },
      { p: /描述|description|desc/i, v: "这是一段测试描述" },
      { p: /链接|link|url/i, v: "https://example.com" },
      { p: /图片|image|photo/i, v: "test.jpg" },
      { p: /文件|file/i, v: "document.pdf" },
      { p: /版本|version/i, v: "1.0.0" },
      { p: /日期|date/i, v: "2024-01-15" },
      { p: /创建|create/i, v: "2024-01-15 09:00:00" },
      { p: /更新|update|modify/i, v: "2024-01-15 10:30:00" },
    ];

    for (const m of keywordMap) {
      if (m.p.test(combined)) return m.v;
    }

    if (/^\d+$/.test(field.key)) return "测试" + field.key;
    if (field.label) return field.label + "测试";
    return "测试数据";
  }

  function generateMockData() {
    const tpl = currentTemplate();
    if (!tpl || !tpl.fields.length) {
      toast("自动生成", "当前模板无字段，请先绑定字段");
      return;
    }

    const obj = {};
    const stats = { byType: 0, byPattern: 0, byKeyword: 0, fallback: 0 };

    for (const f of tpl.fields) {
      let val = null;

      val = generateValueByType(f);
      if (val !== null) {
        stats.byType++;
        obj[f.key] = val;
        continue;
      }

      if (f.pattern) {
        val = generateValueByPattern(f.pattern, f.maxLength);
        if (val !== null) {
          stats.byPattern++;
          obj[f.key] = val;
          continue;
        }
      }

      val = generateValueByKeyword(f);
      if (val !== null) {
        stats.byKeyword++;
        obj[f.key] = val;
        continue;
      }

      stats.fallback++;
      obj[f.key] = "测试数据";
    }

    document.getElementById("testJson").value = JSON.stringify(obj, null, 2);

    const parts = [];
    if (stats.byType) parts.push(`类型识别 ${stats.byType} 个`);
    if (stats.byPattern) parts.push(`正则匹配 ${stats.byPattern} 个`);
    if (stats.byKeyword) parts.push(`关键词匹配 ${stats.byKeyword} 个`);
    const summary = `共 ${tpl.fields.length} 个字段：${parts.join("，")}`;

    log("智能生成", summary);
    toast("已生成测试数据", summary);
  }

  panel.querySelector("#qrClose").onclick = () => {
    if (recordingMode) stopRecording();
    panel.style.display = "none";
    focusHiddenScanner();
    toast("面板已隐藏", "扫码监听仍在当前页面生效；刷新页面后也会自动恢复监听");
  };
  panel.querySelector("#tplSelect").onchange = (e) => {
    currentTemplateId = e.target.value;
    renderTemplates();
  };
  panel.querySelector("#newTpl").onclick = () => {
    const name = prompt("模板名称", "新模板");
    if (!name) return;
    currentTemplateId = createTemplate(name).id;
    renderTemplates();
  };
  panel.querySelector("#saveTpl").onclick = () => {
    const tpl = currentTemplate();
    tpl.name = document.getElementById("tplName").value || tpl.name;
    tpl.pageKey = pageKey();
    saveTemplates();
    renderTemplates();
    toast("已保存模板", tpl.name);
  };
  panel.querySelector("#delTpl").onclick = () => {
    if (!confirm("确定删除当前模板？")) return;
    templates = templates.filter((t) => t.id !== currentTemplateId);
    if (!templates.length) createTemplate("默认模板");
    currentTemplateId = templates[0].id;
    saveTemplates();
    renderTemplates();
  };
  panel.querySelector("#exportTpl").onclick = () => {
    const tpl = currentTemplate();
    if (!tpl) return;
    const blob = new Blob([JSON.stringify(tpl, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (tpl.name || "template") + ".json";
    a.click();
    URL.revokeObjectURL(url);
    toast("已导出模板", tpl.name);
  };
  panel.querySelector("#importTpl").onclick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const tpl = JSON.parse(ev.target.result);
          if (!tpl.name || !Array.isArray(tpl.fields))
            throw new Error("无效模板格式");
          tpl.id = Date.now().toString();
          templates.push(tpl);
          currentTemplateId = tpl.id;
          saveTemplates();
          renderTemplates();
          toast("已导入模板", tpl.name);
        } catch (err) {
          toast("导入失败", err.message);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  };
  panel.querySelector("#bindField").onclick = () => {
    const el = selectedElement;
    const key = document.getElementById("fieldKey").value.trim();
    const tpl = currentTemplate();
    if (!el || !key || !tpl)
      return toast("无法绑定", "请先点击页面字段，并输入 key");
    const scope = findFieldScope(el);
    const field = {
      key,
      label: getLabelText(el),
      selector: cssPath(el),
      xpath: xpathOf(el),
      scopeSelector: scope ? cssPath(scope) : "",
      scopeXPath: scope ? xpathOf(scope) : "",
      id: el.id || "",
      name: el.name || "",
      placeholder: el.placeholder || "",
      tag: el.tagName,
      type: el.type || "",
      pattern: el.pattern || "",
      min: el.min || "",
      max: el.max || "",
      step: el.step || "",
      maxLength: el.maxLength > 0 ? el.maxLength : 0,
      required: el.required || false,
      readOnly: el.readOnly || false,
      disabled: el.disabled || false,
      autocomplete: el.autocomplete || "",
      inputMode: el.inputMode || "",
      options: extractSelectOptions(el),
      component: el.closest(".el-select")
        ? "element-select"
        : el.closest(".ant-select")
          ? "ant-select"
          : el.closest(".n-select")
            ? "naive-select"
            : "",
      visibleOnly: true,
    };
    const idx = tpl.fields.findIndex((f) => f.key === key);
    if (idx >= 0) tpl.fields[idx] = field;
    else tpl.fields.push(field);
    saveTemplates();
    renderFields();
    toast("已绑定字段", key);
  };
  panel.querySelector("#testFill").onclick = () => {
    try {
      fillByPayload(JSON.parse(document.getElementById("testJson").value));
    } catch (e) {
      toast("测试 JSON 错误", e.message);
    }
  };
  panel.querySelector("#genAscii").onclick = () => {
    try {
      const obj = JSON.parse(document.getElementById("testJson").value);
      const out = "QRFILL1:" + utf8ToBase64Url(JSON.stringify(obj));
      document.getElementById("asciiOut").value = out;
      log("生成 QRFILL1", out);
    } catch (e) {
      toast("生成失败", e.message);
    }
  };
  panel.querySelector("#autoGenMock").onclick = () => {
    generateMockData();
  };
  const visibleScanner = panel.querySelector("#scannerInput");
  ["autocomplete", "autocorrect", "autocapitalize", "spellcheck"].forEach(
    (attr) =>
      visibleScanner.setAttribute(
        attr,
        attr === "spellcheck" ? "false" : "off",
      ),
  );
  visibleScanner.setAttribute("inputmode", "latin");
  visibleScanner.setAttribute("lang", "en");
  bindScannerInput(visibleScanner, "面板捕获框");
  panel.querySelector("#focusScanner").onclick = () => {
    visibleScanner.focus();
    visibleScanner.select();
    toast("已聚焦扫码捕获框", "现在可以扫码");
  };
  panel.querySelector("#recordToggle").onclick = () => {
    if (recordingMode) stopRecording();
    else startRecording();
  };

  // 模式切换
  panel.querySelectorAll(".mode-tab").forEach((tab) => {
    tab.onclick = () => switchMode(tab.dataset.mode);
  });

  // 服务地址输入
  const serviceUrlInput = panel.querySelector("#serviceUrl");
  serviceUrlInput.onchange = () => {
    serviceUrl = serviceUrlInput.value.trim();
    saveSettings();
    log("设置", "服务地址已保存: " + serviceUrl);
  };

  // 轮询间隔输入
  const pollIntervalInput = panel.querySelector("#pollInterval");
  pollIntervalInput.onchange = () => {
    pollInterval = Math.max(500, parseInt(pollIntervalInput.value) || 2000);
    pollIntervalInput.value = pollInterval;
    saveSettings();
    log("设置", "轮询间隔已保存: " + pollInterval + "ms");
    // 如果正在轮询，重启轮询
    if (isPolling) {
      stopPolling();
      startPolling();
    }
  };

  // 数据路径输入
  const dataPathInput = panel.querySelector("#dataPath");
  dataPathInput.onchange = () => {
    dataPath = dataPathInput.value.trim() || "data";
    saveSettings();
    log("设置", "数据路径已保存: " + dataPath);
  };

  // 轮询按钮
  panel.querySelector("#pollBtn").onclick = () => {
    if (isPolling) {
      stopPolling();
    } else {
      startPolling();
    }
  };

  // 获取一次按钮
  panel.querySelector("#fetchOnceBtn").onclick = () => {
    if (!serviceUrl) {
      toast("错误", "请先配置服务地址");
      return;
    }
    fetchFromService();
  };

  // 清空历史按钮
  panel.querySelector("#clearHistoryBtn").onclick = () => {
    if (history.length === 0) {
      toast("提示", "暂无历史记录可清空");
      return;
    }
    if (confirm("确定要清空所有填充历史记录吗？此操作不可恢复。")) {
      clearHistory();
      toast("已清空", "填充历史记录已清空");
    }
  };

  renderHistory();

  window.__QRFILL_ASCII_PANEL__ = {
    show() {
      panel.style.display = "block";
      renderTemplates();
      applyPanelPosition(loadPanelPosition());
      // 加载设置并更新UI
      loadSettings();
      panel.querySelector("#serviceUrl").value = serviceUrl;
      panel.querySelector("#pollInterval").value = pollInterval;
      panel.querySelector("#dataPath").value = dataPath;
      updateModeUI();
      log("面板", "已显示；扫码监听常驻当前页面；面板支持拖动并会记住位置");
    },
    hide() {
      panel.style.display = "none";
      focusHiddenScanner();
    },
    toggle() {
      const willShow = panel.style.display === "none";
      panel.style.display = willShow ? "block" : "none";
      if (willShow) {
        renderTemplates();
        loadSettings();
        panel.querySelector("#serviceUrl").value = serviceUrl;
        panel.querySelector("#pollInterval").value = pollInterval;
        panel.querySelector("#dataPath").value = dataPath;
        updateModeUI();
      } else {
        focusHiddenScanner();
      }
    },
    focusScanner: focusHiddenScanner,
  };
  const fab = document.createElement("button");
  fab.id = "qrfill-fab";
  fab.innerHTML =
    '<svg viewBox="0 0 24 24"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"/><path d="M15 15h2v2h-2zM19 15h1v5h-5v-1M14 19v1"/></svg>';
  fab.title = "展开/收起面板";
  let fabDragging = false,
    fabDragOffsetX = 0,
    fabDragOffsetY = 0;
  fab.addEventListener("mousedown", (e) => {
    fabDragging = true;
    fabDragOffsetX = e.clientX - fab.getBoundingClientRect().left;
    fabDragOffsetY = e.clientY - fab.getBoundingClientRect().top;
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!fabDragging) return;
    fab.style.right = "auto";
    fab.style.bottom = "auto";
    fab.style.left = e.clientX - fabDragOffsetX + "px";
    fab.style.top = e.clientY - fabDragOffsetY + "px";
  });
  document.addEventListener("mouseup", () => {
    fabDragging = false;
  });
  fab.addEventListener("click", () => {
    window.__QRFILL_ASCII_PANEL__.toggle();
  });
  document.body.appendChild(fab);
  // 初始化
  loadSettings();
  renderTemplates();
  updateModeUI();
  log(
    "启动",
    `v${APP_VERSION} 页面加载后已自动恢复扫码枪键盘监听；支持后台服务模式`,
  );
  setTimeout(focusHiddenScanner, 300);
})();
