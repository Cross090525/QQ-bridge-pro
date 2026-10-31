// Read-only marker counts from dsh-fish-tone; no insertion or rewriting functions.
export const MARKS = [
  { ch: '也', kind: 'relate', human: 3.4, ai: 2.87, why: '把对方拉进来：你也是' },
  { ch: '还', kind: 'relate', human: 3.37, ai: 3.22, why: '在已有的基础上再添一层' },
  { ch: '反正', kind: 'relate', human: 0.06, ai: 0.02, why: '不打算解释了，收口' },
  { ch: '好像', kind: 'hedge', human: 0.25, ai: 0.09, why: '不确定就说不确定' },
  { ch: '应该', kind: 'hedge', human: 0.41, ai: 0.08, why: '推断，不是断言' },
  { ch: '感觉', kind: 'hedge', human: 0.7, ai: 0.24, why: '标出这是感受不是结论' },
  { ch: '可能', kind: 'hedge', human: 0.53, ai: 0.17, why: '留个口子' },
  { ch: '估计', kind: 'hedge', human: 0.07, ai: 0.03, why: '猜，并且承认是猜' },
  // 加强组：人夸张，AI 校准。这几个真人用得比 AI 多一个量级。
  { ch: '根本', kind: 'intensify', human: 0.15, ai: 0.03, why: '「根本不识字」—— 把描述改成吐槽' },
  { ch: '全都', kind: 'intensify', human: 0.04, ai: 0.0, why: '范围说满' },
  { ch: '简直', kind: 'intensify', human: 0.07, ai: 0.01, why: '夸张一步' },
  { ch: '特别', kind: 'intensify', human: 0.17, ai: 0.02, why: '程度往上抬一格' },
  { ch: '贼', kind: 'intensify', human: 0.07, ai: 0.0, why: '口语的极端程度' },
  { ch: '巨', kind: 'intensify', human: 0.09, ai: 0.0, why: '同上，更年轻' },
  { ch: '竟然', kind: 'intensify', human: 0.07, ai: 0.01, why: '反预期' },
  { ch: '到底', kind: 'intensify', human: 0.14, ai: 0.02, why: '问句里的追问' },
  { ch: '明明', kind: 'intensify', human: 0.08, ai: 0.02, why: '先摆事实再反驳' },
]

const MB = new Map(MARKS.map((m) => [m.ch, m]))

/** 补「好像」时，句子里已经有留白标记就不再补。 */
const OCCUPIED = /好像|估计|感觉|可能|大概|应该/
/** 紧跟在人称后面的这几个字 —— 有了就别再插，插了会变成「我也还试过」。 */

export function scanMarks(text) {
  const src = String(text ?? '')
  const out = []
  for (const m of MARKS) {
    const n = [...src.matchAll(new RegExp(m.ch, 'g'))].length
    if (n) out.push({ ch: m.ch, kind: m.kind, count: n })
  }
  return out
}

/** 每千字的微标记密度，关系类和留白类分开算。 */
export function markDensity(text) {
  const src = String(text ?? '')
  const chars = Math.max(1, src.length)
  let relate = 0
  let hedge = 0
  let intensify = 0
  for (const row of scanMarks(src)) {
    if (row.kind === 'relate') relate += row.count
    else if (row.kind === 'intensify') intensify += row.count
    else hedge += row.count
  }
  return {
    chars,
    relate: +((relate / chars) * 1000).toFixed(2),
    hedge: +((hedge / chars) * 1000).toFixed(2),
    intensify: +((intensify / chars) * 1000).toFixed(2),
    // 真人：关系约 5/千字，留白约 2/千字，加强约 0.9/千字
    relateLine: 6.8,
    hedgeline: 2.0,
    intensifyLine: 0.9,
  }
}
