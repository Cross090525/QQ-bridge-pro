/**
 * dsh-fish-tone —— 双向鱼群拓扑 · 人味插件
 *
 * 来自 BV1BNnc6nEUa 的那套方法，落到可执行的部分：
 *   1. 把话往人的方向掰一点点（不是重写）
 *   2. 双向鱼群拓扑：每条鱼只跟前后两条鱼握手
 *   3. 握完就学会了犹豫（半秒的停顿，不是一句的停顿）
 *   4. 句尾挂一点没用的东西：啊 / 啦 / 嘛 / 的（「吧」只在建议句上）
 *   5. 越没用越像人 —— 所以插件给自己算一个「无用度」
 *
 * 两个半侧：
 *   - systemPrompt 一节：让模型自己就这么说话（真正起作用的那半）
 *   - fish_tone 工具：把一段已经写好的话过一遍，确定性地掰一点
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { repair, scan, budgetFor, frameStats, FRAMES } from './grammar.js'
import { thin as thinStructures, scan as scanStructures, density as structureDensity } from './structures.js'
import { assess as judgeAssess, render as judgeRender } from './judge.js'
import { insertMarks, markDensity, MARKS } from './marks.js'

export const name = 'dsh-fish-tone'

/* ───────────────────────── 规则表 ───────────────────────── */

/** strength → 各档概率。light 是「掰一点点」，max 是「掰过头」。 */
const LEVELS = {
  off: { tail: 0, hesFirst: 0, hesOther: 0, filler: 0 },
  light: { tail: 0.15, hesFirst: 0.4, hesOther: 0.03, filler: 0 },
  normal: { tail: 0.32, hesFirst: 0.7, hesOther: 0.08, filler: 0.12 },
  max: { tail: 0.55, hesFirst: 0.9, hesOther: 0.15, filler: 0.35 },
}

/**
 * 句尾可以挂的小尾巴。视频里点名「的、吧、就」，但「就」挂在句尾基本是病句
 * （"往人的方向掰一点点就。"），删了。
 *
 * 「吧」也不能随便挂 —— 它不是纯粹的收句语气词，挂上去等于把句子改成祈使或推测：
 * 陈述句后面硬塞一个就是病句（"你干什么了吧"、"我把缓存清了一遍吧"）。
 * 所以只在句子本身已经是建议 / 祈使时才许挂（"那就先这样吧"）。
 * weight 只是相对频率，ok 才是硬闸。
 */
const PARTICLES = [
  // 权重不是拍脑袋：100 万条语料里，评论结尾的语气词占比是
  // 的 3.67% > 啊 2.55% > 吧 1.96% > 呢 0.89% > 呀 0.48% > 啦 0.25% > 嘛 0.23%
  // 「啦」「嘛」看着可爱，真人其实很少用 —— 上一版权重把它们调重了，这就是 AI 味的来源之一。
  { ch: '啊', weight: 4 },
  { ch: '啦', weight: 1 },
  { ch: '嘛', weight: 1, ok: (s) => !WH_WORD.test(s) },
  { ch: '吧', weight: 2, ok: (s) => !WH_WORD.test(s) && isSuggestion(s) },
]

/** 特指问的标志词。这类句子后面挂「吧」「嘛」直接变病句（"你干什么了吧"）。 */
const WH_WORD = /(什么|怎么|怎样|咋|哪|谁|为啥|为什么|多少|几|干嘛|何时)/

/** 建议 / 祈使的样子：句首的「那就 / 就这样 / 先 / 不如 / 要不」，或句尾的「一下 / 看看 / 试试」。 */
const SUGGEST_HEAD = /^\s*(那就|就这样|先|不如|要不|还是|干脆|直接|咱|建议|不妨|再|快)/
const SUGGEST_TAIL = /(一下|看看|试试|想想|再说|加油)$/

/**
 * 这句话本身是不是在提建议 / 让人做事。只有这种句子挂「吧」才是人话。
 * @param {string} sentence
 * @returns {boolean}
 */
export function isSuggestion(sentence) {
  const s = String(sentence ?? '').replace(TRAILING_EMOJI, '').trim()
  return SUGGEST_HEAD.test(s) || SUGGEST_TAIL.test(s)
}

/** 形容词/形容性谓语的收尾字——只有这些后面加「的」才像人话（"这事挺麻烦的"）。 */
const ADJ_TAIL = new Set([...'好对行差快慢大小多少难易累忙怪冷热香甜苦远近高低久早晚真假强弱'])

/** 程度副词：有它这句才是「评价」，挂「的」才收得住（"挺麻烦的"）。 */
const DEGREE = /(挺|很|蛮|特别|非常|太|真|有点|够|最|更)/

/** 形容词收尾的常见双字词（「麻烦」「好看」这种，末字不在 ADJ_TAIL 里）。 */
const ADJ_TAIL_WORDS = new Set([
  '麻烦', '好看', '好听', '好玩', '好吃', '好用', '舒服', '离谱', '抽象',
  '恶心', '省事', '靠谱', '闹心', '上头', '带感', '漂亮', '干净', '简单',
  '复杂', '稳定', '流畅', '粗糙', '无聊', '有意思', '没意思',
])

/**
 * 这一句能不能在尾巴上加个「的」。
 * 「的」是把谓语变成评价的，不是万能收句符：
 *   "这个功能挺麻烦" → "这个功能挺麻烦的" ✓
 *   "音质比预期好"   → "音质比预期好的" ✗（比较句里「的」得放在「好」前面）
 * 所以要求：最后一个是形容词、句里有程度副词、不是比较句、句子本身没出现过「的」。
 * @param {string} s
 * @returns {boolean}
 */
function canTakeDe(s) {
  if (!ADJ_TAIL.has(s[s.length - 1]) && !ADJ_TAIL_WORDS.has(s.slice(-2))) return false
  if (!DEGREE.test(s)) return false
  if (/比|不如/.test(s)) return false
  if (s.includes('的')) return false
  return true
}

/**
 * 这一句能挂哪些尾巴。不是所有句子都能挂所有尾巴：
 * 「的」要跟在形容词谓语后面，「吧」要句子本身是建议句，
 * 特指问（"干什么"）后面「吧」「嘛」都不挂。
 * @param {string} body 句子本体（不含标点）
 * @returns {string[]}
 */
function tailCandidates(body) {
  const s = String(body).replace(TRAILING_EMOJI, '').trim()
  const out = []
  for (const p of PARTICLES) {
    if (p.ok && !p.ok(s)) continue
    for (let i = 0; i < (p.weight ?? 1); i++) out.push(p.ch)
  }
  if (canTakeDe(s)) out.push('的', '的', '的', '的')
  return out
}

/** 犹豫的开头，都是半秒的量级，不是一句的量级。 */
const HESITATIONS = ['嗯……', '呃，', '……', '这个，']

/** 废话。只在 max 档出现，且一句最多一次。 */
const FILLERS = ['反正也差不多', '大概就这么个意思', '说不太清']

/** 已经带语气词的句尾，不再挂。 */
const ALREADY_SOFT = new Set([...'吧的啦嘛啊呀哦呢么吗呗'])

/** 结构性的一行：标题、列表、表格、引用、代码围栏。 */
const STRUCTURAL = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>|```|~~~)/

/** 看起来像命令或路径的行，一律不动。 */
const LOOKS_LIKE_CODE = /^\s*(\$|\.{0,2}\/|~\/|[A-Za-z]:\\|npm |pnpm |git |node |python|uv )/

/** 一句里出现这些东西就不碰。 */
const PROTECTED_SPAN = /(```|~~~|`[^`]+`|https?:\/\/\S+|\/[\w.-]+\/[\w./-]+|--[\w-]{2,}|@[A-Za-z0-9_-]+)/

/** 中文判断。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/

/* ───────────────────── 确定性随机（可复现） ───────────────────── */

/**
 * mulberry32：同一个 seed 永远给同一串数，插件因此可测试、可复现。
 * @param {number} seed
 * @returns {() => number}
 */
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

/* ───────────────────────── 切句 ───────────────────────── */

/**
 * 把一行切成「句子 + 它后面的分隔符」。分隔符原样保留，重组时不丢标点。
 * @param {string} line
 * @returns {Array<{ body: string, sep: string }>}
 */
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

/** 这一行整体跳过吗（代码围栏、标题、表格、命令、路径）。 */
export function isStructuralLine(line) {
  return STRUCTURAL.test(line) || LOOKS_LIKE_CODE.test(line)
}

/** 句尾的方括号表情 / 颜文字：尾巴要挂在它前面。 */
const TRAILING_EMOJI = /(\[[^\]]{1,12}\]|\([^)]{1,12}\)|（[^）]{1,12}）|[´｀ω･∇^_]{2,})$/

/** 这一句能不能挂尾巴。挂上去不能变成病句。 */
export function canTakeParticle(sentence) {
  const raw = (sentence ?? '').trim()
  const s = raw.replace(TRAILING_EMOJI, '').trim()
  if (s.length < 4) return false
  if (!CJK.test(s)) return false
  if (PROTECTED_SPAN.test(s)) return false
  const last = s[s.length - 1]
  if (ALREADY_SOFT.has(last)) return false
  if ('：:，,、；;（(【[「'.includes(last)) return false
  if (/[\dA-Za-z]/.test(last)) return false
  return true
}

/* ───────────────────────── 核心 ───────────────────────── */

/**
 * 把一段话往人的方向掰一点点。
 *
 * 拓扑按视频里说的做：正反两遍扫，一遍只跟前一条鱼握手，另一遍只跟后一条。
 * 好处是「犹豫」会像水波一样局部传开，而不是整段统一加料 —— 整段统一加料
 * 才是 AI 味，局部传开才像人。
 *
 * @param {string} text
 * @param {{ strength?: 'off'|'light'|'normal'|'max', seed?: number, protect?: boolean }} [opts]
 * @returns {{ text: string, stats: object }}
 */
export function applyTone(text, opts = {}) {
  const strength = opts.strength ?? 'light'
  const level = LEVELS[strength] ?? LEVELS.light
  const seed = Number.isFinite(opts.seed) ? opts.seed : 7
  const protect = opts.protect !== false
  const rng = mulberry32(seed)

  const src = String(text ?? '')
  if (!src.trim() || strength === 'off') {
    return { text: src, stats: emptyStats(src, strength, seed) }
  }

  const lines = src.split('\n')
  const units = []
  const perLine = []

  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const structural = protect && (inFence || isStructuralLine(line))
    const parts = structural ? [] : splitSentences(line)
    const slice = []
    for (let j = 0; j < parts.length; j++) {
      const u = { body: parts[j].body, sep: parts[j].sep, tail: null, hes: null, filler: null }
      units.push(u)
      slice.push(u)
    }
    perLine.push(structural ? null : slice)
  }

  if (units.length === 0) return { text: src, stats: emptyStats(src, strength, seed) }

  // 短句（评论、报个到这种）不需要犹豫铺垫：真人写 20 个字不会先「……」再开口。
  // 这条是拿真人短评量出来的 —— 短文本的犹豫概率砍到四成。
  const shortText = src.length < 40

  const eligible = units.map((u) => canTakeParticle(u.body))
  // 犹豫的资格比挂尾巴宽：句子只要够长、有中文、不是在引出下文，就能顿一下。
  const hesEligible = units.map((u) => {
    const body = u.body.trim()
    return body.length >= 4 && CJK.test(body) && !PROTECTED_SPAN.test(body) && !/[：:]$/.test(body)
  })

  // 正向：只跟前一条鱼握手。邻居已经挂了尾巴，我也更容易挂。
  let prevTail = false
  for (let i = 0; i < units.length; i++) {
    if (!eligible[i]) { prevTail = false; continue }
    const p = level.tail + (prevTail ? 0.25 : 0)
    if (rng() < p) {
      const cands = tailCandidates(units[i].body)
      units[i].tail = cands[Math.floor(rng() * cands.length)]
      prevTail = true
    } else {
      prevTail = false
    }
  }

  // 反向：只跟后一条鱼握手。握完就学会了犹豫。
  let nextHes = false
  for (let i = units.length - 1; i >= 0; i--) {
    const u = units[i]
    if (!hesEligible[i]) { nextHes = false; continue }
    let p = i === 0 ? level.hesFirst : level.hesOther
    if (shortText) p *= 0.4
    if (nextHes) p += 0.2
    if (level.filler > 0 && u.body.length >= 12 && rng() < level.filler) {
      u.filler = FILLERS[Math.floor(rng() * FILLERS.length)]
    }
    if (rng() < p) {
      const hes = HESITATIONS[Math.floor(rng() * HESITATIONS.length)]
      // 句子本来就以「这个」「嗯」开头时，再加一次同样的字读起来像结巴
      const bare = hes.replace(/[，,…]/g, '')
      if (!u.body.trim().startsWith(bare)) {
        u.hes = hes
        nextHes = true
      } else {
        nextHes = false
      }
    } else {
      nextHes = false
    }
  }

  // 重组：按行、按句序把尾巴/犹豫/废话塞回去，分隔符一个不动。
  const outLines = lines.slice()
  for (let i = 0; i < perLine.length; i++) {
    const slice = perLine[i]
    if (!slice || slice.length === 0) continue
    let rebuilt = ''
    for (const u of slice) {
      let body = u.body
      if (u.hes) body = u.hes + body.replace(/^\s+/, '')
      if (u.filler) {
        const trimmed = body.replace(/\s+$/, '')
        const m = TRAILING_EMOJI.exec(trimmed)
        body = m ? trimmed.slice(0, m.index).replace(/[，,]$/, '') + '，' + u.filler + m[0] : trimmed + '，' + u.filler
      }
      if (u.tail) {
        const trimmed = body.replace(/\s+$/, '')
        const m = TRAILING_EMOJI.exec(trimmed)
        body = m ? trimmed.slice(0, m.index) + u.tail + m[0] : trimmed + u.tail
      }
      rebuilt += body + u.sep
    }
    outLines[i] = rebuilt
  }

  const out = outLines.join('\n')
  return { text: out, stats: statsOf(units, eligible, src, out, strength, seed) }
}

/* ───────────────────────── 统计 ───────────────────────── */

function emptyStats(src, strength = 'off', seed = 7) {
  return {
    strength,
    seed,
    units: 0,
    eligible: 0,
    tails: 0,
    hesitations: 0,
    fillers: 0,
    particles: {},
    insertedChars: 0,
    sourceChars: String(src ?? '').length,
    uselessness: 0,
  }
}

function statsOf(units, eligible, src, out, strength, seed) {
  const tails = units.filter((u) => u.tail).length
  const hesitations = units.filter((u) => u.hes).length
  const fillers = units.filter((u) => u.filler).length
  const insertedChars = out.length - src.length
  const base = Math.max(1, src.length)
  /** 挂出去的尾巴按字分开数 —— 看得出「吧」有没有又乱挂。 */
  const particles = {}
  for (const u of units) if (u.tail) particles[u.tail] = (particles[u.tail] ?? 0) + 1
  // 「越没用越像人」：插进去的字占正文的比例，封顶 1。
  const uselessness = Math.min(1, insertedChars / base)
  return {
    strength,
    seed,
    units: units.length,
    eligible: eligible.filter(Boolean).length,
    tails,
    hesitations,
    fillers,
    particles,
    insertedChars,
    sourceChars: src.length,
    uselessness: Number(uselessness.toFixed(3)),
  }
}
