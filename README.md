# Hermes Dashboard

一个轻量的 Hermes 指标面板，用来展示定时任务、市场数据、黄金价格和 Home Assistant 事件的当前值与历史趋势。

## 功能

- 登录保护，密码只保存 PBKDF2 哈希。
- SQLite 保存指标定义和历史点位。
- 当前指标按任务源分组展示，支持最多 4 个置顶指标。
- 点击指标卡片后，在浮窗里查看 30天 / 半年 / 所有 趋势图；每个指标会记住最近选择的时间窗口。
- 实时指标页可一键刷新，扫描已配置规则并更新数据库。
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
python3 app.py
```

打开 `http://127.0.0.1:8080`。

如果只是想本地预览样例卡片，可以额外运行 `python3 scripts/seed_demo.py`；预览完可用 `python3 scripts/clear_demo_data.py` 删除这些样例指标。

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

选择某个任务源后，配置页会直接展示该目录下匹配到的文件列表，并打开最新一个 Markdown 文件。点击文件名可以切换预览内容；添加或编辑规则时，可以点规则里的「测试」按钮，用当前预览文件立即验证正则是否命中以及最终入库值。

每条提取规则会从 Markdown 文本里跑一个正则表达式，并把指定捕获分组解析成数字。例如：

```text
门口触发次数[:：]\s*(\d+)
客厅温度[:：]\s*([\d.]+)
金价[:：]\s*([\d,.]+)
现货黄金（人民币）：¥\s*([\d,.]+)
```

配置页推荐使用带括号的捕获组，例如上面的 `([\d,.]+)`，并把「捕获分组」设为 `1`。`(?<=...)` 这类零宽断言虽然 Python 正则支持，但没有显式捕获组，不如捕获组写法直观稳定。

规则字段：

- `指标 key`: 历史指标唯一 ID，例如 `front_door_motion`。
- `显示名称`: 卡片和图表上的名称。
- `单位`: 例如 `次`、`°C`、`USD/oz`。
- `分类`: 例如 `home`、`market`、`sports`。
- `排序`: 卡片排序。
- `正则表达式`: 用括号捕获你要跟踪的数字。
- `捕获分组`: 默认 `1`，表示使用第一对括号。
- `倍率`: 默认 `1`，需要单位换算时可以填 `0.01`、`1000` 等。
- `置顶`: 最多 4 个，保存后显示在指标页最上方。

扫描会把匹配值按文件时间写入历史点。文件名里带有 `2026-06-29_1130`、`2026-06-29_11-30` 这类日期时间时会优先使用文件名时间；否则会尝试读取 Markdown 文件头里的 `2026年06月30日` / `2026年06月30日 11:30`，再不行才使用文件修改时间。文件名和文件头时间默认按 `Asia/Shanghai` 解析，可通过 `.env` 设置 `HERMES_TIMEZONE` 覆盖。首页展示最新一条，点开指标后按所选时间窗口展示对应历史点。

两个页面入口语义不同：

- 指标页「刷新」：只读取每个已配置来源的最新文件，适合把刚生成的数据增量写入数据库。
- 配置页「立即扫描」：同步当前选中的定时任务来源，先清理该来源之前写入的历史点，再按当前文件夹下所有匹配文件重建历史，保证数据库与当前文件夹一致。

手动扫描：

```bash
set -a
source .env
set +a
python3 scripts/scan_cron_outputs.py
```

手动同步某个来源：

```bash
python3 scripts/scan_cron_outputs.py --sync --source-id e6a852568717
```

每 10 分钟扫描一次的 crontab 示例：

```cron
*/10 * * * * cd /opt/hermes-dashboard && set -a && . ./.env && set +a && /usr/bin/python3 scripts/scan_cron_outputs.py >> data/cron-scan.log 2>&1
```

如果某个目录文件特别多，可以临时加 `--limit-per-source 100` 只扫描每个来源最新 100 个文件。

也可以在「配置」页点「立即扫描」，适合调试新规则。
保存规则后，指标页会先出现对应卡片；只有扫描到匹配文本后，卡片才会显示实际数值。

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
