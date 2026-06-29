const state = {
  metrics: [],
  selectedKey: "",
  rangeDays: 7,
};

const $ = (id) => document.getElementById(id);

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
  $("dashboardView").hidden = view !== "dashboard";
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
      <p class="name">${metric.name}</p>
      <p class="value">
        <span>${formatNumber(metric.value)}</span>
        <span class="unit">${metric.unit || ""}</span>
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
      await loadMetrics();
    } catch (error) {
      $("loginError").textContent = error.message;
    }
  });

  $("logoutButton").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST", body: "{}" });
    show("login");
  });

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
    await loadMetrics();
  } else {
    show("login");
  }
}

boot().catch((error) => {
  console.error(error);
  show("login");
});
