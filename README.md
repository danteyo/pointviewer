# Hermes Dashboard

一个轻量的 Hermes 指标面板，用来展示定时任务、市场数据、黄金价格和 Home Assistant 事件的当前值与历史趋势。

## 功能

- 登录保护，密码只保存 PBKDF2 哈希。
- SQLite 保存指标定义和历史点位。
- 当前指标卡片与 24h / 7d / 30d 趋势图。
- `/api/ingest` 写入接口，适合定时任务、Shell 脚本或 Home Assistant 自动化调用。
- 页面内配置 Hermes cron 输出目录和 Markdown 数字提取规则。
- 无第三方运行依赖，Python 3 标准库即可启动。

## 本地启动

```bash
cp .env.example .env
python3 scripts/hash_password.py
```

把输出写入 `.env` 的 `HERMES_PASSWORD_HASH`，并修改 `HERMES_SECRET_KEY` 与 `HERMES_INGEST_TOKEN`。
首次登录后可以在页面右上角「密码」里修改登录密码；修改后的密码哈希会保存在本地 SQLite 数据库，优先级高于 `.env` 里的初始密码。

```bash
set -a
source .env
set +a
python3 scripts/seed_demo.py
python3 app.py
```

打开 `http://127.0.0.1:8080`。

## 写入数据

单个指标：

```bash
curl -X POST http://127.0.0.1:8080/api/ingest \
  -H "Authorization: Bearer $HERMES_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"key":"gold_spot","name":"黄金现货","unit":"USD/oz","category":"market","sort_order":1,"value":2328.6}'
```

批量指标：

```bash
curl -X POST http://127.0.0.1:8080/api/ingest \
  -H "Authorization: Bearer $HERMES_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[
    {"key":"gold_spot","name":"黄金现货","unit":"USD/oz","category":"market","sort_order":1,"value":2328.6},
    {"key":"front_door_motion","name":"门口触发次数","unit":"次","category":"home","sort_order":10,"value":12}
  ]'
```

字段说明：

- `key`: 指标唯一 ID，建议英文、数字和下划线。
- `name`: 页面显示名称。
- `unit`: 单位。
- `category`: 分类，例如 `market`、`home`。
- `sort_order`: 卡片排序。
- `value`: 数值。
- `recorded_at`: Unix 秒时间戳，可省略，默认当前时间。
- `note`: 可选备注。

`examples/ingest_market.sh` 和 `examples/home_assistant_rest.yaml` 里分别放了 Shell 定时任务与 Home Assistant `rest_command` 的接入样例。

## 跟踪 Hermes cron 输出

应用会默认预置这些任务源：

- `241db7b2b9e7`: 每日热点摘要，`17:30 每日`
- `ced3e233f5d9`: 体坛简报，`09:00 隔天`
- `e6a852568717`: 财经简报，`11:30 工作日`
- `81fb82f53914`: HA日报，`18:30 每日`

默认目录是 `~/.hermes/cron/output/<任务ID>`，文件匹配是 `*.md`。登录页面后打开「配置」，可以维护任务源和关注数据规则。

每条提取规则会从 Markdown 文本里跑一个正则表达式，并把指定捕获分组解析成数字。例如：

```text
门口触发次数[:：]\s*(\d+)
客厅温度[:：]\s*([\d.]+)
金价[:：]\s*([\d,.]+)
```

规则字段：

- `指标 key`: 历史指标唯一 ID，例如 `front_door_motion`。
- `显示名称`: 卡片和图表上的名称。
- `单位`: 例如 `次`、`°C`、`USD/oz`。
- `分类`: 例如 `home`、`market`、`sports`。
- `排序`: 卡片排序。
- `正则表达式`: 用括号捕获你要跟踪的数字。
- `捕获分组`: 默认 `1`，表示使用第一对括号。
- `倍率`: 默认 `1`，需要单位换算时可以填 `0.01`、`1000` 等。

手动扫描：

```bash
set -a
source .env
set +a
python3 scripts/scan_cron_outputs.py --limit-per-source 10
```

每 10 分钟扫描一次的 crontab 示例：

```cron
*/10 * * * * cd /opt/hermes-dashboard && set -a && . ./.env && set +a && /usr/bin/python3 scripts/scan_cron_outputs.py --limit-per-source 10 >> data/cron-scan.log 2>&1
```

也可以在「配置」页点「立即扫描」，适合调试新规则。

## Hermes 部署

建议把仓库 clone 到 Hermes，例如 `/opt/hermes-dashboard`，并把 `.env` 放在仓库目录但不要提交到 GitHub。

```bash
git clone https://github.com/<you>/hermes-dashboard.git /opt/hermes-dashboard
cd /opt/hermes-dashboard
cp .env.example .env
python3 scripts/hash_password.py
```

启动测试：

```bash
set -a
source .env
set +a
python3 app.py
```

生产环境建议放在 Caddy、Nginx 或 Home Assistant 反向代理后面，并启用 HTTPS。

## systemd 示例

把下面内容保存到 `/etc/systemd/system/hermes-dashboard.service`，按实际路径调整：

```ini
[Unit]
Description=Hermes Dashboard
After=network.target

[Service]
WorkingDirectory=/opt/hermes-dashboard
EnvironmentFile=/opt/hermes-dashboard/.env
ExecStart=/usr/bin/python3 /opt/hermes-dashboard/app.py
Restart=always
RestartSec=3
User=hermes

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-dashboard
sudo systemctl status hermes-dashboard
```

## GitHub 发布前检查

- 不要提交 `.env` 和 `data/hermes.db`。
- 首次发布前运行 `git init`、`git add .`、`git commit -m "Initial Hermes dashboard"`。
- 在 GitHub 创建仓库后，按页面提示添加 remote 并 push。
