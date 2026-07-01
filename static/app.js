const state = {
  metrics: [],
  selectedKey: "",
  rangeDays: 7,
  modalRange: "30",
  sources: [],
  selectedSourceId: "",
  selectedPreviewFile: "",
  sourcePreview: { files: [], selected: "", content: "" },
};

const $ = (id) => document.getElementById(id);
let toastTimer = 0;

function showToast(message, type = "success", timeout = 2000) {
  const toast = $("configMessage");
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast-message show ${type === "error" ? "error" : "success"}`;
  toastTimer = window.setTimeout(() => {
    toast.classList.remove("show");
  }, timeout);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatNumber(value) {
  if (value === null || value === undefined) return "--";
  const number = Number(value);
  if (Math.abs(number) >= 1000) return number.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  if (Math.abs(number) >= 100) return number.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  return number.toLocaleString("zh-CN", { maximumFractionDigits: 3 });
}

function formatTime(seconds) {
  if (!seconds) return "尚未更新";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(seconds * 1000));
}

function metricRangeKey(metricKey) {
  return `hermes.historyRange.${metricKey}`;
}

function getMetricRange(metricKey) {
  const saved = localStorage.getItem(metricRangeKey(metricKey));
  return ["30", "180", "all"].includes(saved) ? saved : "30";
}

function setMetricRange(metricKey, range) {
  if (metricKey && ["30", "180", "all"].includes(range)) {
    localStorage.setItem(metricRangeKey(metricKey), range);
  }
}

function setActiveRange(range) {
  document.querySelectorAll("[data-modal-range]").forEach((button) => {
    button.classList.toggle("active", button.dataset.modalRange === range);
  });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function show(view) {
  $("loginView").hidden = view !== "login";
  $("dashboardView").hidden = view === "login";
}

function setPanel(panel) {
  $("metricsPanel").hidden = panel !== "metrics";
  $("configPanel").hidden = panel !== "config";
  $("passwordPanel").hidden = panel !== "password";
  $("metricsTab").classList.toggle("active", panel === "metrics");
  $("configTab").classList.toggle("active", panel === "config");
  $("passwordTab").classList.toggle("active", panel === "password");
  if (panel === "config") loadConfig();
  if (panel === "password") resetPasswordForm();
}

function renderCards() {
  const pinned = state.metrics.filter((metric) => Boolean(metric.pinned)).slice(0, 4);
  $("pinnedSection").hidden = pinned.length === 0;
  renderMetricGrid($("pinnedGrid"), pinned, "pinned");

  const groups = new Map();
  for (const metric of state.metrics) {
    if (metric.pinned) continue;
    const key = metric.source_id || "other";
    if (!groups.has(key)) {
      groups.set(key, {
        title: metric.source_name || "其他指标",
        subtitle: metric.source_schedule || metric.category || "",
        metrics: [],
      });
    }
    groups.get(key).metrics.push(metric);
  }

  const container = $("metricGroups");
  container.innerHTML = "";
  for (const group of groups.values()) {
    const section = document.createElement("section");
    section.className = "metric-section";
    section.innerHTML = `
      <div class="metric-section-head">
        <div>
          <p class="kicker">Source</p>
          <h2>${escapeHtml(group.title)}</h2>
        </div>
        <span>${escapeHtml(group.subtitle)}</span>
      </div>
      <div class="metric-grid"></div>
    `;
    renderMetricGrid(section.querySelector(".metric-grid"), group.metrics, group.title);
    container.appendChild(section);
  }
}

function renderMetricGrid(grid, metrics, label) {
  grid.innerHTML = "";
  for (const metric of metrics) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `metric-card ${metric.key === state.selectedKey ? "active" : ""}`;
    card.dataset.category = metric.category;
    card.dataset.pinned = metric.pinned ? "true" : "false";
    const valueText = formatNumber(metric.value);
    const displayLength = valueText.length;
    card.dataset.valueSize = displayLength >= 10 ? "xs" : displayLength >= 8 ? "sm" : "lg";
    card.innerHTML = `
      <p class="name">${escapeHtml(metric.name)}</p>
      <p class="value">
        <span>${valueText}</span>
        <span class="unit">${escapeHtml(metric.unit || "")}</span>
      </p>
      <span class="time">${formatTime(metric.recorded_at)}</span>
    `;
    card.setAttribute("aria-label", `${label} ${metric.name} 历史趋势`);
    card.addEventListener("click", () => openHistory(metric.key));
    grid.appendChild(card);
  }
}

async function loadMetrics() {
  const data = await api("/api/metrics");
  state.metrics = data.metrics;
  if (!state.selectedKey && state.metrics.length) state.selectedKey = state.metrics[0].key;
  renderCards();
}

async function refreshMetrics() {
  const button = $("refreshMetricsButton");
  const status = $("metricsRefreshStatus");
  button.disabled = true;
  button.textContent = "刷新中...";
  status.textContent = "正在扫描已配置规则";
  status.classList.remove("error-text");
  try {
    const result = await api("/api/cron-scan", {
      method: "POST",
      body: JSON.stringify({ limit_per_source: 1 }),
    });
    await loadMetrics();
    const errorText = result.errors?.length ? `，${result.errors.length} 个错误：${result.errors[0].error}` : "";
    status.textContent = `已刷新：扫描 ${result.files} 个文件，新增 ${result.points} 个点${errorText}`;
    status.classList.toggle("error-text", Boolean(result.errors?.length));
  } catch (error) {
    status.textContent = error.message;
    status.classList.add("error-text");
  } finally {
    button.disabled = false;
    button.textContent = "刷新";
  }
}

async function openHistory(key) {
  state.selectedKey = key;
  state.modalRange = getMetricRange(key);
  setActiveRange(state.modalRange);
  renderCards();
  $("historyModal").hidden = false;
  await loadHistory();
}

function closeHistory() {
  $("historyModal").hidden = true;
}

async function loadHistory() {
  if (!state.selectedKey) {
    drawChart(null, []);
    return;
  }
  const end = Math.floor(Date.now() / 1000);
  const start = state.modalRange === "all" ? 0 : end - Number(state.modalRange) * 86400;
  const data = await api(`/api/history?key=${encodeURIComponent(state.selectedKey)}&start=${start}&end=${end}`);
  $("modalChartTitle").textContent = data.metric.name;
  drawChart(data.metric, data.points);
}

function drawChart(metric, points) {
  const canvas = $("trendCanvas");
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const pad = { top: 76, right: 34, bottom: 54, left: 86 };
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  $("emptyState").hidden = points.length > 0;
  if (!points.length) return;

  const values = points.map((point) => Number(point.value));
  const times = points.map((point) => Number(point.recorded_at));
  let minValue = Math.min(...values);
  let maxValue = Math.max(...values);
  if (minValue === maxValue) {
    minValue -= 1;
    maxValue += 1;
  }
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const timeSpan = Math.max(1, maxTime - minTime);
  const valueSpan = Math.max(1, maxValue - minValue);
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const x = (time) => pad.left + ((time - minTime) / timeSpan) * chartWidth;
  const y = (value) => pad.top + (1 - (value - minValue) / valueSpan) * chartHeight;

  ctx.strokeStyle = "#e5e5ea";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#86868b";
  ctx.font = "18px system-ui";
  ctx.textAlign = "right";
  for (let i = 0; i <= 4; i += 1) {
    const gy = pad.top + (chartHeight / 4) * i;
    const value = maxValue - (valueSpan / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, gy);
    ctx.lineTo(width - pad.right, gy);
    ctx.stroke();
    ctx.fillText(formatNumber(value), pad.left - 14, gy + 6);
  }
  ctx.textAlign = "left";

  const gradient = ctx.createLinearGradient(0, pad.top, 0, height - pad.bottom);
  gradient.addColorStop(0, "rgba(0,113,227,0.2)");
  gradient.addColorStop(1, "rgba(0,113,227,0)");
  ctx.beginPath();
  points.forEach((point, index) => {
    const px = x(Number(point.recorded_at));
    const py = y(Number(point.value));
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.lineTo(x(times[times.length - 1]), height - pad.bottom);
  ctx.lineTo(x(times[0]), height - pad.bottom);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  points.forEach((point, index) => {
    const px = x(Number(point.recorded_at));
    const py = y(Number(point.value));
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.strokeStyle = "#0071e3";
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  const last = points[points.length - 1];
  ctx.fillStyle = "#1d1d1f";
  ctx.font = "600 22px system-ui";
  ctx.fillText(`${formatNumber(last.value)} ${metric?.unit || ""}`, pad.left, 36);

  ctx.fillStyle = "#86868b";
  ctx.font = "17px system-ui";
  const startLabel = formatTime(times[0]);
  const endLabel = formatTime(times[times.length - 1]);
  ctx.fillText(startLabel, pad.left, height - 10);
  ctx.textAlign = "right";
  ctx.fillText(endLabel, width - pad.right, height - 10);
  ctx.textAlign = "left";
}

async function loadConfig() {
  const data = await api("/api/cron-config");
  state.sources = data.sources;
  if (!state.selectedSourceId && state.sources.length) state.selectedSourceId = state.sources[0].id;
  renderSources();
  renderSourceForm(currentSource() || newSource());
}

function currentSource() {
  return state.sources.find((source) => source.id === state.selectedSourceId);
}

function newSource() {
  return {
    id: "",
    name: "",
    output_dir: "~/.hermes/cron/output/",
    file_glob: "*.md",
    schedule: "",
    enabled: 1,
    rules: [],
  };
}

function renderSources() {
  const list = $("sourceList");
  list.innerHTML = "";
  for (const source of state.sources) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `source-item ${source.id === state.selectedSourceId ? "active" : ""}`;
    button.innerHTML = `
      <strong>${escapeHtml(source.name)}</strong>
      <span>${escapeHtml(source.schedule || source.id)}</span>
      <small>${source.rules.length} 条规则 · ${source.enabled ? "启用" : "停用"}</small>
    `;
    button.addEventListener("click", () => {
      state.selectedSourceId = source.id;
      renderSources();
      renderSourceForm(source);
    });
    list.appendChild(button);
  }
}

function renderSourceForm(source) {
  $("sourceId").value = source.id || "";
  $("sourceName").value = source.name || "";
  $("sourceDir").value = source.output_dir || "";
  $("sourceGlob").value = source.file_glob || "*.md";
  $("sourceSchedule").value = source.schedule || "";
  $("sourceEnabled").checked = Boolean(source.enabled);
  $("rulesList").innerHTML = "";
  for (const rule of [...(source.rules || [])].reverse()) addRuleRow(rule, { prepend: false });
  state.selectedPreviewFile = "";
  loadSourcePreview();
}

function addRuleRow(rule = {}, options = {}) {
  const row = document.createElement("div");
  row.className = "rule-row";
  row.innerHTML = `
    <label>
      <span>指标 key</span>
      <input data-field="metric_key" value="${escapeHtml(rule.metric_key || "")}" placeholder="ha_motion_count" required />
    </label>
    <label>
      <span>显示名称</span>
      <input data-field="name" value="${escapeHtml(rule.name || "")}" placeholder="门口触发次数" required />
    </label>
    <label>
      <span>单位</span>
      <input data-field="unit" value="${escapeHtml(rule.unit || "")}" placeholder="次" />
    </label>
    <label>
      <span>分类</span>
      <input data-field="category" value="${escapeHtml(rule.category || "cron")}" />
    </label>
    <label>
      <span>排序</span>
      <input data-field="sort_order" type="number" value="${escapeHtml(rule.sort_order || 100)}" />
    </label>
    <label>
      <span>捕获分组</span>
      <input data-field="group_index" type="number" min="1" value="${escapeHtml(rule.group_index || 1)}" />
    </label>
    <label>
      <span>倍率</span>
      <input data-field="value_scale" type="number" step="0.0001" value="${escapeHtml(rule.value_scale || 1)}" />
    </label>
    <label class="check-row">
      <input data-field="pinned" type="checkbox" ${rule.pinned ? "checked" : ""} />
      <span>置顶</span>
    </label>
    <label class="check-row">
      <input data-field="enabled" type="checkbox" ${rule.enabled === 0 ? "" : "checked"} />
      <span>启用</span>
    </label>
    <label class="wide">
      <span>正则表达式</span>
      <input data-field="pattern" value="${escapeHtml(rule.pattern || "")}" placeholder="门口触发次数[:：]\\s*(\\d+)" required />
    </label>
    <div class="rule-test">
      <button class="ghost test-rule" type="button">测试</button>
      <span class="rule-test-result">用当前预览文件测试</span>
    </div>
    <button class="ghost remove-rule" type="button">删除</button>
  `;
  row.querySelector(".remove-rule").addEventListener("click", () => row.remove());
  row.querySelector(".test-rule").addEventListener("click", () => testRuleRow(row));
  if (options.prepend) {
    $("rulesList").prepend(row);
  } else {
    $("rulesList").appendChild(row);
  }
}

function sourcePreviewPayload(fileName = state.selectedPreviewFile) {
  return {
    output_dir: $("sourceDir").value.trim(),
    file_glob: $("sourceGlob").value.trim() || "*.md",
    file_name: fileName || "",
  };
}

function renderSourcePreview(preview) {
  state.sourcePreview = preview;
  state.selectedPreviewFile = preview.selected || "";
  $("previewFileCount").textContent = `${preview.files.length} 个文件`;
  $("previewFileName").textContent = preview.selected || "没有文件";
  $("previewFileStatus").textContent = preview.resolved_dir ? `实际路径：${preview.resolved_dir}` : "";
  if (preview.truncated) $("previewFileStatus").textContent += " · 内容已截断";
  $("previewFileContent").textContent =
    preview.content ||
    `当前目录没有匹配的 Markdown 文件。\n\n配置路径：${preview.configured_dir || ""}\n实际路径：${preview.resolved_dir || ""}\n文件匹配：${preview.file_glob || "*.md"}\n目录存在：${preview.exists ? "是" : "否"}\n是目录：${preview.is_dir ? "是" : "否"}\n可读取：${preview.readable ? "是" : "否"}\n可进入：${preview.executable ? "是" : "否"}\n列目录错误：${preview.list_error || "无"}\n程序用户：${preview.runtime_user || ""}\n程序 HOME：${preview.runtime_home || ""}\n程序工作目录：${preview.runtime_cwd || ""}`;
  const list = $("previewFileList");
  list.innerHTML = "";
  for (const file of preview.files) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `preview-file ${file.name === preview.selected ? "active" : ""}`;
    button.innerHTML = `
      <strong>${escapeHtml(file.name)}</strong>
      <span>${formatTime(file.recorded_at)} · ${Math.ceil(Number(file.size || 0) / 1024)} KB</span>
    `;
    button.addEventListener("click", () => {
      state.selectedPreviewFile = file.name;
      loadSourcePreview(file.name);
    });
    list.appendChild(button);
  }
}

async function loadSourcePreview(fileName = "") {
  $("previewFileStatus").textContent = "加载中...";
  try {
    const preview = await api("/api/source-preview", {
      method: "POST",
      body: JSON.stringify(sourcePreviewPayload(fileName)),
    });
    renderSourcePreview(preview);
  } catch (error) {
    state.sourcePreview = { files: [], selected: "", content: "" };
    $("previewFileCount").textContent = "0 个文件";
    $("previewFileName").textContent = "预览失败";
    $("previewFileStatus").textContent = "";
    $("previewFileContent").textContent = error.message;
    $("previewFileList").innerHTML = "";
  }
}

async function testRuleRow(row) {
  const value = (field) => row.querySelector(`[data-field="${field}"]`);
  const result = row.querySelector(".rule-test-result");
  result.classList.remove("error-text", "success-text");
  result.textContent = "测试中...";
  try {
    const data = await api("/api/test-rule", {
      method: "POST",
      body: JSON.stringify({
        pattern: value("pattern").value.trim(),
        group_index: Number(value("group_index").value || 1),
        value_scale: Number(value("value_scale").value || 1),
        content: $("previewFileContent").textContent,
      }),
    });
    if (!data.matched) {
      result.textContent = "未匹配到内容";
      result.classList.add("error-text");
      return;
    }
    result.textContent = `匹配 ${data.raw}，入库值 ${formatNumber(data.value)}`;
    result.classList.add("success-text");
  } catch (error) {
    result.textContent = error.message;
    result.classList.add("error-text");
  }
}

function collectSourceForm() {
  const rules = [...document.querySelectorAll(".rule-row")].map((row) => {
    const value = (field) => row.querySelector(`[data-field="${field}"]`);
    return {
      metric_key: value("metric_key").value.trim(),
      name: value("name").value.trim(),
      unit: value("unit").value.trim(),
      category: value("category").value.trim() || "cron",
      sort_order: Number(value("sort_order").value || 100),
      group_index: Number(value("group_index").value || 1),
      value_scale: Number(value("value_scale").value || 1),
      pinned: value("pinned").checked,
      pattern: value("pattern").value.trim(),
      enabled: value("enabled").checked,
    };
  });
  return {
    id: $("sourceId").value.trim(),
    name: $("sourceName").value.trim(),
    output_dir: $("sourceDir").value.trim(),
    file_glob: $("sourceGlob").value.trim() || "*.md",
    schedule: $("sourceSchedule").value.trim(),
    enabled: $("sourceEnabled").checked,
    rules,
  };
}

async function saveSource(event) {
  event.preventDefault();
  const source = collectSourceForm();
  const result = await api("/api/cron-sources", {
    method: "POST",
    body: JSON.stringify(source),
  });
  state.selectedSourceId = result.id;
  await loadConfig();
  await loadMetrics();
  showToast("已保存，指标页已更新");
}

async function deleteCurrentSource() {
  const source = currentSource();
  if (!source) return;
  if (!window.confirm(`删除 ${source.name} 及其提取规则？历史指标数据会保留。`)) return;
  await api("/api/cron-sources/delete", {
    method: "POST",
    body: JSON.stringify({ id: source.id }),
  });
  state.selectedSourceId = "";
  await loadConfig();
}

async function scanNow() {
  const source = currentSource();
  showToast("同步中...", "success", 4000);
  try {
    const result = await api("/api/cron-scan", {
      method: "POST",
      body: JSON.stringify({ limit_per_source: 0, sync: true, source_id: source?.id || "" }),
    });
    const errorText = result.errors?.length ? `，${result.errors.length} 个错误：${result.errors[0].error}` : "";
    showToast(`同步完成：${result.files} 个文件，写入 ${result.points} 个点，清理 ${result.deleted || 0} 个旧点${errorText}`, result.errors?.length ? "error" : "success");
    await loadMetrics();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function resetPasswordForm() {
  $("passwordForm").reset();
  $("passwordMessage").textContent = "";
  $("passwordMessage").classList.remove("error-text");
}

async function savePassword(event) {
  event.preventDefault();
  const message = $("passwordMessage");
  message.textContent = "";
  message.classList.remove("error-text");
  const currentPassword = $("currentPassword").value;
  const newPassword = $("newPassword").value;
  const confirmPassword = $("confirmPassword").value;
  if (newPassword !== confirmPassword) {
    message.textContent = "两次输入的新密码不一致";
    message.classList.add("error-text");
    return;
  }
  try {
    await api("/api/change-password", {
      method: "POST",
      body: JSON.stringify({
        current_password: currentPassword,
        new_password: newPassword,
      }),
    });
    $("passwordForm").reset();
    message.textContent = "密码已更新";
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error-text");
  }
}

async function boot() {
  $("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("loginError").textContent = "";
    try {
      await api("/api/login", {
        method: "POST",
        body: JSON.stringify({ password: $("password").value }),
      });
      show("dashboard");
      setPanel("metrics");
      await loadMetrics();
    } catch (error) {
      $("loginError").textContent = error.message;
    }
  });

  $("logoutButton").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST", body: "{}" });
    show("login");
  });

  $("metricsTab").addEventListener("click", () => setPanel("metrics"));
  $("configTab").addEventListener("click", () => setPanel("config"));
  $("passwordTab").addEventListener("click", () => setPanel("password"));
  $("newSourceButton").addEventListener("click", () => {
    state.selectedSourceId = "";
    renderSources();
    renderSourceForm(newSource());
  });
  $("addRuleButton").addEventListener("click", () => addRuleRow({}, { prepend: true }));
  $("refreshPreviewButton").addEventListener("click", () => loadSourcePreview());
  $("sourceDir").addEventListener("change", () => {
    state.selectedPreviewFile = "";
    loadSourcePreview();
  });
  $("sourceGlob").addEventListener("change", () => {
    state.selectedPreviewFile = "";
    loadSourcePreview();
  });
  $("sourceForm").addEventListener("submit", saveSource);
  $("passwordForm").addEventListener("submit", savePassword);
  $("refreshMetricsButton").addEventListener("click", refreshMetrics);
  $("scanButton").addEventListener("click", scanNow);
  $("deleteSourceButton").addEventListener("click", deleteCurrentSource);

  $("closeHistoryButton").addEventListener("click", closeHistory);
  $("historyModal").addEventListener("click", (event) => {
    if (event.target === $("historyModal")) closeHistory();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeHistory();
  });
  document.querySelectorAll("[data-modal-range]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.modalRange = button.dataset.modalRange;
      setMetricRange(state.selectedKey, state.modalRange);
      setActiveRange(state.modalRange);
      await loadHistory();
    });
  });

  const session = await api("/api/session");
  if (session.authenticated) {
    show("dashboard");
    setPanel("metrics");
    await loadMetrics();
  } else {
    show("login");
  }
}

boot().catch((error) => {
  console.error(error);
  show("login");
});
