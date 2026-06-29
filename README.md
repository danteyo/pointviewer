# Hermes Dashboard

一个轻量的 Hermes 指标面板，用来展示定时任务、市场数据、黄金价格和 Home Assistant 事件的当前值与历史趋势。

## 功能

- 登录保护，密码只保存 PBKDF2 哈希。
- SQLite 保存指标定义和历史点位。
- 当前指标卡片与 24h / 7d / 30d 趋势图。
- `/api/ingest` 写入接口，适合定时任务、Shell 脚本或 Home Assistant 自动化调用。
- 无第三方运行依赖，Python 3 标准库即可启动。

## 本地启动

```bash
cp .env.example .env
python3 scripts/hash_password.py
```

把输出写入 `.env` 的 `HERMES_PASSWORD_HASH`，并修改 `HERMES_SECRET_KEY` 与 `HERMES_INGEST_TOKEN`。

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
