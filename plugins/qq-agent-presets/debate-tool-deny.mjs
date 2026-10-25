// The analyst has no sending, file, process, network or external-tool capability.
export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.guard(() => '争论分析会话只生成待审草稿，禁止全部工具调用');
  ctx.tools.restrict({ allow: [] });
}
