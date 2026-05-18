/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createClient } from '@supabase/supabase-js'

type Bindings = {
	SUPABASE_URL: string
	SUPABASE_SERVICE_KEY: string
	R2_PUBLIC_URL: string
	R2_BUCKET: R2Bucket
}

const app = new Hono<{ Bindings: Bindings }>()

// ✅ 允许跨域（Flutter/前端都需要）
app.use('*', cors())

// 添加这一段：处理根路径的 GET 请求
app.get('/', (c) => {
	return c.text('Hono + Supabase 连通了！')
})

// ✅ 每次请求创建 Supabase 客户端
const getDB = (env: Bindings) =>
	createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY)

// 处理测试路由
app.get('/test', (c) => {
	return c.json({ message: 'Hello from Cloudflare Worker' })
})

// ─── App 端接口（用 anon key 也能访问，RLS 保护） ───────────

// 获取已发布文章列表
// src/index.ts 里更新 GET /api/articles
app.get('/api/articles', async (c) => {
	const db = getDB(c.env)
	const page = Number(c.req.query('page') ?? 1)
	const limit = Number(c.req.query('limit') ?? 20)
	const from = (page - 1) * limit
  
	const { data, error } = await db
	  .from('articles')
	  .select('id, title, cover_url, type, published_at, created_at')
	  .eq('status', 'published')
	  .order('published_at', { ascending: false })
	  .range(from, from + limit - 1)
  
	if (error) return c.json({ error: error.message }, 500)
	return c.json(data)
  })

// 获取文章详情
app.get('/api/articles/:id', async (c) => {
	const db = getDB(c.env)
	const { data, error } = await db
		.from('articles')
		.select('*')
		.eq('id', c.req.param('id'))
		.eq('status', 'published')
		.single()

	if (error) return c.json({ error: '文章不存在' }, 404)
	return c.json(data)
})


// ─── 管理端接口（需要在请求头带 Authorization） ────────────

// 验证管理员身份的中间件
app.use('/api/admin/*', async (c, next) => {
	const token = c.req.header('Authorization')?.replace('Bearer ', '')
	if (token !== c.env.SUPABASE_SERVICE_KEY) {
		console.log("收到的Key:", token);
		console.log("预设的Key:", c.env.SUPABASE_SERVICE_KEY);
		return c.json({ error: '无权限' + token + ' ' + c.env.SUPABASE_SERVICE_KEY }, 401)
	}
	await next()
})

// 创建文章（草稿）
app.post('/api/admin/articles', async (c) => {
	const db = getDB(c.env)
	const body = await c.req.json()

	const { data, error } = await db
		.from('articles')
		.insert({
			title: body.title,
			content: body.content ?? '',
			cover_url: body.cover_url ?? null,
			type: body.type ?? 'article',
			video_url: body.video_url ?? null,
			status: 'draft',
		})
		.select()
		.single()

	if (error) return c.json({ error: error.message }, 500)
	return c.json(data, 201)
})

// 更新文章
app.put('/api/admin/articles/:id', async (c) => {
	const db = getDB(c.env)
	const body = await c.req.json()

	const { data, error } = await db
		.from('articles')
		.update({
			title: body.title,
			content: body.content,
			cover_url: body.cover_url,
			video_url: body.video_url,
		})
		.eq('id', c.req.param('id'))
		.select()
		.single()

	if (error) return c.json({ error: error.message }, 500)
	return c.json(data)
})

// 发布文章
app.post('/api/admin/articles/:id/publish', async (c) => {
	const db = getDB(c.env)

	const { data, error } = await db
		.from('articles')
		.update({ status: 'published', published_at: new Date().toISOString() })
		.eq('id', c.req.param('id'))
		.select()
		.single()

	if (error) return c.json({ error: error.message }, 500)
	return c.json(data)
})

// 删除文章
app.delete('/api/admin/articles/:id', async (c) => {
	const db = getDB(c.env)

	const { error } = await db
		.from('articles')
		.delete()
		.eq('id', c.req.param('id'))

	if (error) return c.json({ error: error.message }, 500)
	return c.json({ success: true })
})

// 上传图片到 R2
app.post('/api/admin/upload', async (c) => {
	const formData = await c.req.formData()
	const file = formData.get('file') as File

	if (!file) {
		return c.json({ error: '没有收到文件' }, 400)
	}

	// 验证文件类型
	const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
	if (!allowedTypes.includes(file.type)) {
		return c.json({ error: '只支持 jpg/png/gif/webp' }, 400)
	}

	// 生成唯一文件名：images/2024/05/时间戳-原文件名
	const date = new Date()
	const folder = `images/${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}`
	const filename = `${Date.now()}-${file.name.replace(/\s/g, '_')}`
	const key = `${folder}/${filename}`

	// 上传到 R2
	await c.env.R2_BUCKET.put(key, await file.arrayBuffer(), {
		httpMetadata: {
			contentType: file.type,
			cacheControl: 'public, max-age=31536000', // 缓存一年
		},
	})

	const url = `${c.env.R2_PUBLIC_URL}/${key}`
	return c.json({ url, key })
})


// 管理端：获取所有文章（含草稿）
app.get('/api/admin/articles', async (c) => {
	const db = getDB(c.env)
	const { data, error } = await db
		.from('articles')
		.select('*')
		.order('created_at', { ascending: false })

	if (error) return c.json({ error: error.message }, 500)
	return c.json(data)
})

// 管理端：获取单篇（含草稿）
app.get('/api/admin/articles/:id', async (c) => {
	const db = getDB(c.env)
	const { data, error } = await db
		.from('articles')
		.select('*')
		.eq('id', c.req.param('id'))
		.single()

	if (error) return c.json({ error: '文章不存在' }, 404)
	return c.json(data)
})

// ─── 阅读量 + 互动接口 ────────────────────────────────────

// 记录阅读（App 进入详情页时调用一次）
app.post('/api/articles/:id/view', async (c) => {
	const db = getDB(c.env)
	await db.rpc('increment_view_count', { article_id: c.req.param('id') })
	return c.json({ ok: true })
  })
  
  // 点赞 / 踩（传入 device_id 防重复，可切换）
  app.post('/api/articles/:id/react', async (c) => {
	const db = getDB(c.env)
	const articleId = c.req.param('id')
	const { device_id, reaction } = await c.req.json<{
	  device_id: string
	  reaction: 'like' | 'dislike'
	}>()
  
	if (!device_id || !['like', 'dislike'].includes(reaction)) {
	  return c.json({ error: '参数错误' }, 400)
	}
  
	// 查询当前投票状态
	const { data: existing } = await db
	  .from('article_reactions')
	  .select('reaction')
	  .eq('article_id', articleId)
	  .eq('device_id', device_id)
	  .single()
  
	let likeChange = 0
	let dislikeChange = 0
	let newReaction: string | null = reaction
  
	if (!existing) {
	  // 首次投票
	  await db.from('article_reactions').insert({ article_id: articleId, device_id, reaction })
	  reaction === 'like' ? likeChange++ : dislikeChange++
  
	} else if (existing.reaction === reaction) {
	  // 点同一个 → 取消
	  await db.from('article_reactions')
		.delete()
		.eq('article_id', articleId)
		.eq('device_id', device_id)
	  reaction === 'like' ? likeChange-- : dislikeChange--
	  newReaction = null
  
	} else {
	  // 从 like 改成 dislike 或反之
	  await db.from('article_reactions')
		.update({ reaction })
		.eq('article_id', articleId)
		.eq('device_id', device_id)
	  if (reaction === 'like') { likeChange++; dislikeChange-- }
	  else { likeChange--; dislikeChange++ }
	}
  
	// 更新文章计数
	if (likeChange !== 0 || dislikeChange !== 0) {
	  await db.rpc('update_reaction_counts', {
		p_article_id: articleId,
		p_like_change: likeChange,
		p_dislike_change: dislikeChange,
	  })
	}
  
	// 返回最新数据
	const { data: article } = await db
	  .from('articles')
	  .select('like_count, dislike_count, view_count')
	  .eq('id', articleId)
	  .single()
  
	return c.json({ ...article, user_reaction: newReaction })
  })
  
  // 查询当前设备的投票状态
  app.get('/api/articles/:id/reaction', async (c) => {
	const db = getDB(c.env)
	const deviceId = c.req.query('device_id')
  
	const [{ data: article }, { data: reaction }] = await Promise.all([
	  db.from('articles')
		.select('view_count, like_count, dislike_count')
		.eq('id', c.req.param('id'))
		.single(),
	  db.from('article_reactions')
		.select('reaction')
		.eq('article_id', c.req.param('id'))
		.eq('device_id', deviceId ?? '')
		.single(),
	])
  
	return c.json({
	  ...article,
	  user_reaction: reaction?.reaction ?? null,
	})
  })

export default app