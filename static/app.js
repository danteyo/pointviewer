const state = {
  metrics: [],
  selectedKey: "",
  rangeDays: 7,
  sources: [],
  selectedSourceId: "",
};

const $ = (id) => document.getElementById(id);

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
  const grid = $("metricGrid");
  grid.innerHTML = "";
  for (const metric of state.metrics) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `metric-card ${metric.key === state.selectedKey ? "active" : ""}`;
    card.dataset.category = metric.category;
    card.innerHTML = `
      <p class="name">${escapeHtml(metric.name)}</p>
      <p class="value">
        <span>${formatNumber(metric.value)}</span>
        <span class="unit">${escapeHtml(metric.unit || "")}</span>
      </p>
      <span class="time">${formatTime(metric.recorded_at)}</span>
    `;
    card.addEventListener("click", () => selectMetric(metric.key));
    grid.appendChild(card);
  }
}

function renderSelect() {
  const select = $("metricSelect");
  select.innerHTML = "";
  for (const metric of state.metrics) {
    const option = document.createElement("option");
    option.value = metric.key;
    option.textContent = metric.name;
    select.appendChild(option);
  }
  select.value = state.selectedKey;
}

async function loadMetrics() {
  const data = await api("/api/metrics");
  state.metrics = data.metrics;
  if (!state.selectedKey && state.metrics.length) state.selectedKey = state.metrics[0].key;
  renderCards();
  renderSelect();
  await loadHistory();
}

async function selectMetric(key) {
  state.selectedKey = key;
  renderCards();
  renderSelect();
  await loadHistory();
}

async function loadHistory() {
  if (!state.selectedKey) {
    drawChart(null, []);
    return;
  }
  const end = Math.floor(Date.now() / 1000);
  const start = end - state.rangeDays * 86400;
  const data = await api(`/api/history?key=${encodeURIComponent(state.selectedKey)}&start=${start}&end=${end}`);
  $("chartTitle").textContent = data.metric.name;
  drawChart(data.metric, data.points);
}

function drawChart(metric, points) {
  const canvas = $("trendCanvas");
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const pad = { top: 28, right: 28, bottom: 46, left: 72 };
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

  ctx.strokeStyle = "#d8e0e4";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#63717b";
  ctx.font = "24px system-ui";
  for (let i = 0; i <= 4; i += 1) {
    const gy = pad.top + (chartHeight / 4) * i;
    const value = maxValue - (valueSpan / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, gy);
    ctx.lineTo(width - pad.right, gy);
    ctx.stroke();
    ctx.fillText(formatNumber(value), 8, gy + 8);
  }

  const gradient = ctx.createLinearGradient(0, pad.top, 0, height - pad.bottom);
  gradient.addColorStop(0, "rgba(15,139,141,0.22)");
  gradient.addColorStop(1, "rgba(15,139,141,0)");
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
  ctx.strokeStyle = "#0f8b8d";
  ctx.lineWidth = 4;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  const last = points[points.length - 1];
  ctx.fillStyle = "#172026";
  ctx.font = "26px system-ui";
  ctx.fillText(`${formatNumber(last.value)} ${metric?.unit || ""}`, pad.left, 26);

  ctx.fillStyle = "#63717b";
  ctx.font = "22px system-ui";
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
  for (const rule of source.rules || []) addRuleRow(rule);
  $("configMessage").textContent = "";
}

function addRuleRow(rule = {}) {
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
      <input data-field="enabled" type="checkbox" ${rule.enabled === 0 ? "" : "checked"} />
      <span>启用</span>
    </label>
    <label class="wide">
      <span>正则表达式</span>
      <input data-field="pattern" value="${escapeHtml(rule.pattern || "")}" placeholder="门口触发次数[:：]\\s*(\\d+)" required />
    </label>
    <button class="ghost remove-rule" type="button">删除</button>
  `;
  row.querySelector(".remove-rule").addEventListener("click", () => row.remove());
  $("rulesList").appendChild(row);
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
  $("configMessage").textContent = "";
  $("configMessage").classList.remove("error-text");
  const source = collectSourceForm();
  const result = await api("/api/cron-sources", {
    method: "POST",
    body: JSON.stringify(source),
  });
  state.selectedSourceId = result.id;
  await loadConfig();
  await loadMetrics();
  $("configMessage").textContent = "已保存，指标页已更新";
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
  $("configMessage").textContent = "扫描中...";
  $("configMessage").classList.remove("error-text");
  const result = await api("/api/cron-scan", {
    method: "POST",
    body: JSON.stringify({ limit_per_source: 10 }),
  });
  const errorText = result.errors?.length ? `，${result.errors.length} 个错误：${result.errors[0].error}` : "";
  $("configMessage").textContent = `扫描完成：${result.files} 个文件，新增 ${result.points} 个点${errorText}`;
  $("configMessage").classList.toggle("error-text", Boolean(result.errors?.length));
  await loadMetrics();
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
  $("addRuleButton").addEventListener("click", () => addRuleRow());
  $("sourceForm").addEventListener("submit", saveSource);
  $("passwordForm").addEventListener("submit", savePassword);
  $("scanButton").addEventListener("click", scanNow);
  $("deleteSourceButton").addEventListener("click", deleteCurrentSource);

  $("metricSelect").addEventListener("change", (event) => selectMetric(event.target.value));
  document.querySelectorAll("[data-range]").forEach((button) => {
    button.addEventListener("click", async () => {
      document.querySelectorAll("[data-range]").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.rangeDays = Number(button.dataset.range);
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
