/**
 * dsh-fish-tone-flavor —— 人味插件的**附属包**
 *
 * 主插件（dsh-fish-tone）只管「把话往人的方向掰一点点」，它自己是中性的。
 * 可爱、抽象、热梗这些**性格**都放在这里，而且默认是关的：
 *   关着 → 只多两个工具（fish_meme / fish_flavor），不往 prompt 里塞任何东西
 *   开着 → 挂一节性格层 prompt + 让 fish_flavor 真的会挂软尾巴 / 梗尾巴
 *
 * 为什么拆开：性格是偏好，不是语言能力。换个心情可能就不想可爱了，
 * 也可能只想看热梗库、不想让模型说话带梗 —— 一个开关比一次改代码便宜。
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-fish-tone-flavor'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/* ───────────────────────── 热梗库 ───────────────────────── */

/** @type {{note:string, builtAt:string, count:number, memes:Array<any>}} */
let LIB = { note: '', builtAt: '', count: 0, memes: [] }
/** 句式梗：一套模板，往格式里填东西（！？X？！ / X了 / 单字判词） */
let CONS = []

function loadLib() {
  try {
    const raw = JSON.parse(readFileSync(join(ROOT, 'data', 'memes.json'), 'utf8'))
    if (Array.isArray(raw?.memes)) LIB = raw
  } catch { /* 没数据也能跑，只是查不到梗 */ }
  try {
    const raw = JSON.parse(readFileSync(join(ROOT, 'data', 'constructions.json'), 'utf8'))
    if (Array.isArray(raw)) CONS = raw
  } catch { /* 句式库可缺 */ }
}
loadLib()

/** 把句式梗和词汇梗拍成同一个形状，查询和输出都不用分叉。 */
function constructionAsMeme(c) {
  return {
    id: c.id,
    kind: 'construction',
    term: c.name,
    template: c.template,
    gloss: c.effect,
    usage: c.example,
    vibes: c.vibes || [],
    year: '2024–2026',
    source: 'B站评论区句式（语料称重）',
    corpus: { comment: c.corpus?.comment ?? 0, danmaku: c.corpus?.danmaku ?? 0 },
  }
}

/** 全部梗（词汇 + 句式），统一形状。 */
export function allMemes() {
  const words = LIB.memes.map((m) => ({ ...m, kind: m.kind || 'word' }))
  return [...words, ...CONS.map(constructionAsMeme)]
}

const VIBES = ['cute', 'abstract', 'ironic', 'broken', 'work', 'heal', 'hype', 'retro', 'slacker', 'fun']

/**
 * 查梗。
 * @param {{query?:string, vibe?:string, limit?:number}} [opts]
 * @returns {Array<any>}
 */
function filteredMemes(opts = {}) {
  const q = String(opts.query ?? '').trim().toLowerCase()
  const vibe = String(opts.vibe ?? '').trim()
  let list = allMemes()
  if (opts.kind === 'word' || opts.kind === 'construction') list = list.filter((m) => m.kind === opts.kind)
  if (vibe) list = list.filter((m) => (m.vibes || []).includes(vibe))
  if (q) {
    list = list.filter((m) =>
      m.term.toLowerCase().includes(q)
      || (m.aliases || []).some((a) => a.toLowerCase().includes(q))
      || String(m.gloss ?? '').includes(q)
      || String(m.usage ?? '').includes(q)
      || String(m.template ?? '').includes(q))
  }
  return list
}

export function searchMemes(opts = {}) {
  return filteredMemes(opts).slice(0, Math.max(1, Math.min(30, Number(opts.limit) || 8)))
}

/** 随一个梗。同一个 seed 给同一个，方便测试。 */
export function randomMeme(seed = 7, opts = {}) {
  const pool = filteredMemes(opts)
  if (pool.length === 0) return null
  return pool[Math.floor(mulberry32(seed)() * pool.length)]
}

/* ───────────────────────── 性格档 ───────────────────────── */

/** 挂尾巴的概率（按句子算）。low 是默认：一段话里大概挂一处。 */
export const RATES = { low: 0.07, normal: 0.16, high: 0.3 }

/** 可爱档的软尾巴。都只加在句尾、标点前面，一句最多一个。 */
const CUTE_TAILS = ['呀', '嘛', '啦', '哟', '哦', '呢']

/** 特指问（干什么/为什么/多少）：这种句子后面挂「嘛」是病句（"你干什么了嘛"）。 */
const WH_WORD = /(什么|怎么|怎样|咋|哪|谁|为啥|为什么|多少|几|干嘛|何时)/

/** 抽象档的梗尾巴：能直接「，X」收句的那几个。宁缺毋滥，凑数的读起来像营销号。 */
const TAIL_PHRASES = new Set(['典', '绝了', '离谱', '逆天', '这很难评', '我不理解', '就这', '好家伙', '绷不住了', '笑死', '已阅', '那咋了', '不讲不讲', '抽象'])
export function abstractTails() {
  const inLib = new Set(LIB.memes.map((m) => m.term))
  return [...TAIL_PHRASES].filter((t) => inLib.has(t))
}

const ALREADY_SOFT = new Set([...'吧啦嘛啊呀哦呢么吗呗诶欸捏'])
/** 判断句的线索词：梗挂在这类句尾才像评价，不像硬塞。 */
const JUDGE = /(有点|有一点|挺|太|真的|感觉|觉得|难|不错|拖|尬|怪|离谱|一般|不行|还行)/
const STRUCTURAL = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>|```|~~~)/
const LOOKS_LIKE_CODE = /^\s*(\$|\.{0,2}\/|~\/|[A-Za-z]:\\|npm |pnpm |git |node |python|uv )/
const PROTECTED_SPAN = /(```|~~~|`[^`]+`|https?:\/\/\S+|\/[\w.-]+\/[\w./-]+|--[\w-]{2,})/

/** 这一行整行跳过。 */
export function isStructuralLine(line) {
  return STRUCTURAL.test(line) || LOOKS_LIKE_CODE.test(line) || PROTECTED_SPAN.test(line)
}

/** 切句：句子本体 + 它后面的标点。 */
export function splitSentences(line) {
  const out = []
  const re = /([^。！？!?…；;]+)([。！？!?…；;]*)/g
  let m
  while ((m = re.exec(line)) !== null) {
    if (m[0] === '') break
    out.push({ body: m[1], sep: m[2] })
  }
  return out
}

/**
 * 把话往「性格」方向掰一点。只加尾巴，不改句子。
 * @param {string} text
 * @param {{mode?:'cute'|'abstract', rate?:'low'|'normal'|'high', seed?:number, protect?:boolean}} [opts]
 * @returns {{text:string, hits:Array<{mode:string, tail:string, body:string}>, considered:number}}
 */
export function flavorize(text, opts = {}) {
  const src = String(text ?? '')
  if (opts.mode === 'shock') return wrapShock(src, opts)
  const mode = opts.mode === 'abstract' ? 'abstract' : 'cute'
  const rate = RATES[opts.rate] ?? RATES.low
  const seed = Number.isFinite(opts.seed) ? opts.seed : 7
  const protect = opts.protect !== false
  const rng = mulberry32(seed ^ 0x9e3779b9)
  const tails = mode === 'cute' ? CUTE_TAILS : abstractTails()
  if (tails.length === 0) return { text: src, hits: [], considered: 0 }

  const lines = src.split('\n')
  let inFence = false
  const hits = []
  let considered = 0
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    if (protect && /^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (protect && (inFence || isStructuralLine(line))) continue
    const parts = splitSentences(line)
    if (parts.length === 0) continue

    // 先挑出这一行里能挂的位置（太短、已经带语气词的不要）
    const eligible = []
    for (let i = 0; i < parts.length; i++) {
      const body = parts[i].body
      const trimmed = body.trimEnd()
      const last = trimmed[trimmed.length - 1] ?? ''
      considered += 1
      const ok = trimmed.length >= 5
        && /[\u4e00-\u9fff]/.test(last)
        && !ALREADY_SOFT.has(last)
        && !ALREADY_SOFT.has(trimmed[trimmed.length - 2] ?? '')
      if (ok) eligible.push(i)
    }
    const targets = new Map()  // 句子下标 → 尾巴下标
    // 抽象的梗挂在**最后一个**判断句上才顺（「后面那段有点拖，这很难评」），
    // 挂在陈述句中间像硬塞 —— 所以从后往前找第一个掷中的。可爱档不挑位置。
    // 判断句优先（有「有点/挺/太/真/感觉…」这类评价词的那几句）
    const judged = mode === 'abstract' ? eligible.filter((i) => JUDGE.test(parts[i].body)) : []
    const order = mode === 'abstract' ? [...(judged.length ? judged : eligible)].reverse() : eligible
    // 抽象档一段只挂一处，所以命中率按「段」算，不然会稀得看不见
    const p = mode === 'abstract' ? Math.min(0.85, rate * 2.5) : rate
    for (const i of order) {
      const draw = rng()
      const pick = Math.floor(rng() * tails.length)
      // 硬闸：特指问后面不挂「嘛」（"你干什么了嘛"），别的站不住脚的搭配也一样处理
      if (tails[pick] === '嘛' && WH_WORD.test(parts[i].body)) continue
      if (draw < p && hits.length + targets.size < 3) {
        targets.set(i, pick)
        if (mode === 'abstract') break
      }
    }

    let rebuilt = ''
    for (let i = 0; i < parts.length; i++) {
      const body = parts[i].body
      const tail = tails[targets.get(i) ?? 0]
      if (!targets.has(i)) { rebuilt += body + parts[i].sep; continue }
      const trimmed = body.trimEnd()
      const joined = mode === 'cute' ? `${trimmed}${tail}` : `${trimmed}，${tail}`
      hits.push({ mode, tail, body: trimmed.slice(-14) })
      rebuilt += joined + body.slice(trimmed.length) + parts[i].sep
    }
    lines[li] = rebuilt
  }
  // 一段话里最多挂三处：再多就不是性格，是口音（循环里已经卡住，这里只是兜底）
  return { text: lines.join('\n'), hits, considered }
}

/**
 * 震惊档：最后一句的句号换成「？！」。
 *
 * 这是基础款 —— 「14.69？！」。网上更常见的是「！？X？！」那种把东西整个夹住的写法，
 * 但那是加码版：中间得是两个叠字（强强 / 电电）或者抽象名词，用在抽象视频底下。
 * 不分场合乱加就成了模仿梗，所以这里只做基础款，加码的交给 prompt 里的人判断。
 * @param {string} text
 * @param {{seed?:number, protect?:boolean}} [opts]
 */
export function wrapShock(text, opts = {}) {
  const src = String(text ?? '')
  const seed = Number.isFinite(opts.seed) ? opts.seed : 7
  const protect = opts.protect !== false
  const rng = mulberry32(seed ^ 0x85ebca6b)
  const lines = src.split('\n')
  let inFence = false
  const fenced = lines.map(line => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return true }
    return inFence
  })
  for (let li = lines.length - 1; li >= 0; li--) {
    const line = lines[li]
    if (!line.trim()) continue
    if (protect && (fenced[li] || isStructuralLine(line))) continue
    const parts = splitSentences(line).filter((p) => p.body.trim().length >= 4)
    if (parts.length === 0) continue
    const target = parts[Math.min(parts.length - 1, Math.floor(rng() * parts.length))]
    const body = target.body.trim()
    const idx = line.indexOf(target.body)
    if (idx < 0) continue
    const replaced = `${body}？！`
    lines[li] = line.slice(0, idx) + replaced + line.slice(idx + target.body.length + target.sep.length)
    return { text: lines.join('\n'), hits: [{ mode: 'shock', tail: '？！', body: body.slice(-14) }], considered: parts.length }
  }
  return { text: src, hits: [], considered: 0 }
}

/**
 * 只挂前 N 处的版本（flavorize 本身不截断文本，这里给它兜底）。
 * @param {string} text
 * @param {object} opts
 */
export function flavor(text, opts = {}) {
  const out = flavorize(text, opts)
  if (out.hits.length <= 3) return out
  return { ...out, hits: out.hits.slice(0, 3) }
}

/* ───────────────────── 确定性随机 ───────────────────── */

export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
