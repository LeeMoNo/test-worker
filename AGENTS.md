# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

| Command | Purpose |
|---------|---------|
| `npx wrangler dev` | Local development |
| `npx wrangler deploy` | Deploy to Cloudflare |
| `npx wrangler types` | Generate TypeScript types |

Run `wrangler types` after changing bindings in wrangler.jsonc.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`

## Best Practices (conditional)

If the application uses Durable Objects or Workflows, refer to the relevant best practices:

- Durable Objects: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Workflows: https://developers.cloudflare.com/workflows/build/rules-of-workflows/

项目名称=test-worker
API地址：https://test-worker.wasai-test.workers.dev

服务测试运行：wrangler dev
服务器部署：npx wrangler deploy

---

## 接口调用说明（test-worker）

面向 App / 前端 / 管理后台的 HTTP API，基于 Hono + Supabase + R2。

### 基础信息

| 项 | 说明 |
|----|------|
| 生产 Base URL | `https://test-worker.wasai-test.workers.dev` |
| 本地开发 | `http://localhost:8787`（`npx wrangler dev`） |
| 跨域 | 已开启 CORS，浏览器 / Flutter 可直接请求 |
| 请求体格式 | JSON 接口使用 `Content-Type: application/json` |
| 响应格式 | 成功一般为 JSON；根路径 `/` 返回纯文本 |

### 鉴权说明

| 接口前缀 | 是否需要鉴权 |
|----------|----------------|
| `/api/articles` | 否（仅返回 `status = published` 的内容） |
| `/api/admin/*` | 是，请求头：`Authorization: Bearer <SUPABASE_SERVICE_KEY>` |

管理端 Key 由运维配置在 Worker 环境变量 `SUPABASE_SERVICE_KEY`，**不要写进客户端代码**。仅管理后台 / 内部脚本使用。

---

### 一、公开接口（App / 用户端）

#### 1. 健康检查

```http
GET /
```

响应：`Hono + Supabase 连通了！`（纯文本）

```http
GET /test
```

响应示例：

```json
{ "message": "Hello from Cloudflare Worker" }
```

---

#### 2. 已发布文章列表

```http
GET /api/articles?page=1&limit=20
```

| 查询参数 | 类型 | 默认 | 说明 |
|----------|------|------|------|
| `page` | number | `1` | 页码，从 1 开始 |
| `limit` | number | `20` | 每页条数 |

响应：文章数组（仅 `published`），字段示例：

```json
[
  {
    "id": "uuid",
    "title": "标题",
    "cover_url": "https://...",
    "type": "article",
    "published_at": "2024-05-01T00:00:00.000Z",
    "created_at": "2024-05-01T00:00:00.000Z"
  }
]
```

```bash
curl "https://test-worker.wasai-test.workers.dev/api/articles?page=1&limit=10"
```

---

#### 3. 文章详情

```http
GET /api/articles/:id
```

- 仅 `status = published` 的文章可访问
- 404：`{ "error": "文章不存在" }`

```bash
curl "https://test-worker.wasai-test.workers.dev/api/articles/<文章ID>"
```

---

#### 4. 记录阅读量

进入详情页时调用一次即可。

```http
POST /api/articles/:id/view
```

响应：

```json
{ "ok": true }
```

```bash
curl -X POST "https://test-worker.wasai-test.workers.dev/api/articles/<文章ID>/view"
```

---

#### 5. 点赞 / 踩

同一 `device_id` 在同一篇文章上只能有一种态度；再次点击相同类型会**取消**；切换类型会更新计数。

```http
POST /api/articles/:id/react
```

请求体：

```json
{
  "device_id": "设备唯一标识（UUID 等，客户端本地持久化）",
  "reaction": "like"
}
```

`reaction` 取值：`like` | `dislike`

响应示例：

```json
{
  "view_count": 100,
  "like_count": 10,
  "dislike_count": 2,
  "user_reaction": "like"
}
```

取消后 `user_reaction` 为 `null`。参数错误返回 400：`{ "error": "参数错误" }`

```bash
curl -X POST "https://test-worker.wasai-test.workers.dev/api/articles/<文章ID>/react" \
  -H "Content-Type: application/json" \
  -d '{"device_id":"my-device-uuid","reaction":"like"}'
```

---

#### 6. 查询当前设备的投票状态

```http
GET /api/articles/:id/reaction?device_id=<设备ID>
```

响应示例：

```json
{
  "view_count": 100,
  "like_count": 10,
  "dislike_count": 2,
  "user_reaction": "like"
}
```

未投票时 `user_reaction` 为 `null`。

```bash
curl "https://test-worker.wasai-test.workers.dev/api/articles/<文章ID>/reaction?device_id=my-device-uuid"
```

---

### 二、管理端接口（需 Authorization）

所有路径前缀：`/api/admin`，请求头：

```http
Authorization: Bearer <SUPABASE_SERVICE_KEY>
```

无权限返回 401：`{ "error": "无权限..." }`

---

#### 1. 文章列表（含草稿）

```http
GET /api/admin/articles
```

返回全部文章，按 `created_at` 降序。

---

#### 2. 单篇文章（含草稿）

```http
GET /api/admin/articles/:id
```

404：`{ "error": "文章不存在" }`

---

#### 3. 创建文章（草稿）

```http
POST /api/admin/articles
```

请求体：

```json
{
  "title": "标题（必填）",
  "content": "正文，可选，默认 \"\"",
  "cover_url": "封面 URL，可选",
  "type": "article，可选，默认 article",
  "video_url": "视频 URL，可选"
}
```

成功 201，返回完整文章对象（`status` 为 `draft`）。

```bash
curl -X POST "https://test-worker.wasai-test.workers.dev/api/admin/articles" \
  -H "Authorization: Bearer <KEY>" \
  -H "Content-Type: application/json" \
  -d '{"title":"新文章","content":"正文"}'
```

---

#### 4. 更新文章

```http
PUT /api/admin/articles/:id
```

请求体（字段按需传）：

```json
{
  "title": "新标题",
  "content": "新正文",
  "cover_url": "https://...",
  "video_url": "https://..."
}
```

---

#### 5. 发布文章

```http
POST /api/admin/articles/:id/publish
```

将 `status` 设为 `published`，并写入 `published_at`。

---

#### 6. 删除文章

```http
DELETE /api/admin/articles/:id
```

响应：

```json
{ "success": true }
```

---

#### 7. 上传图片到 R2

```http
POST /api/admin/upload
Content-Type: multipart/form-data
```

表单字段：`file`（图片文件）

支持类型：`image/jpeg`、`image/png`、`image/gif`、`image/webp`

成功响应：

```json
{
  "url": "https://<R2_PUBLIC_URL>/images/2024/05/1730000000-photo.jpg",
  "key": "images/2024/05/1730000000-photo.jpg"
}
```

可将 `url` 填入文章的 `cover_url` 或正文图片。

```bash
curl -X POST "https://test-worker.wasai-test.workers.dev/api/admin/upload" \
  -H "Authorization: Bearer <KEY>" \
  -F "file=@/path/to/image.jpg"
```

错误：`400` 无文件或类型不支持。

---

### 三、数据模型参考

**文章 `articles`（管理端可见全字段，App 列表为子集）**

| 字段 | 说明 |
|------|------|
| `id` | UUID |
| `title` | 标题 |
| `content` | 正文 |
| `cover_url` | 封面 |
| `type` | 类型，如 `article` |
| `video_url` | 视频链接 |
| `status` | `draft` \| `published` |
| `published_at` | 发布时间 |
| `created_at` | 创建时间 |
| `view_count` | 阅读数 |
| `like_count` | 点赞数 |
| `dislike_count` | 踩数 |

**App 端 `device_id` 建议**

- 首次启动生成 UUID，写入本地存储，全生命周期复用
- 用于 `/react` 与 `/reaction`，实现「一设备一票」

---

### 四、常见错误码

| HTTP | 场景 |
|------|------|
| 400 | 参数缺失或非法（如 react、upload） |
| 401 | 管理端未带或 Key 错误 |
| 404 | 文章不存在（公开详情仅已发布） |
| 500 | 数据库 / 服务端错误，`{ "error": "..." }` |

---

### 五、典型接入流程

**App 阅读**

1. `GET /api/articles` 列表
2. `GET /api/articles/:id` 详情
3. `POST /api/articles/:id/view` 记一次阅读
4. `GET /api/articles/:id/reaction?device_id=...` 展示当前点赞状态
5. `POST /api/articles/:id/react` 用户点赞/踩

**管理后台发文**

1. `POST /api/admin/upload` 上传封面（可选）
2. `POST /api/admin/articles` 创建草稿
3. `PUT /api/admin/articles/:id` 编辑
4. `POST /api/admin/articles/:id/publish` 发布
5. App 端即可在 `GET /api/articles` 中看到
