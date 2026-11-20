/**
 * systemPrompt 一句提示（任务书第 6 项；07 方案 §3.4 注 1 措辞纪律：一句文案 + 工具名，
 * 不做路由清单堆叠——清单是 model_route_query / mroute_dispatch_plan 的职责）。
 * 宿主只接受字符串 text（传函数不生效，subagent-setup 实录），故固定为字符串。
 * M4.11：改为双工具指向——完整诊断表用 model_route_query，派遣前预检清单用 mroute_dispatch_plan。
 */
import { TOOL_NAME as QUERY_TOOL_NAME } from './tool-query.js'
import { TOOL_NAME as DISPATCH_PLAN_TOOL_NAME } from './tool-dispatch-plan.js'

export const SECTION_NAME = 'tool:mroute:route-hint'
// subagent-setup 路由清单段用 116.25；本段错开至 116.5，紧随其后、避免同序抖动。
export const SECTION_ORDER = 116.5

export const SECTION_TEXT =
  `派遣子会话前先调用 ${DISPATCH_PLAN_TOOL_NAME}（派发预检，返回可直接粘贴的 assignee 清单与余额/新鲜度），` +
  `需要完整诊断表时用 ${QUERY_TOOL_NAME}；两者均按财务优先级（monthly > voucher > prepaid）排序，` +
  '按返回顺序填写派遣参数的 assignee provider/model；被宿主策略门拒绝时换列表下一项，全被拒则省略 assignee 继承父路由。'

/**
 * @returns {Function|undefined} dispose；服务缺失或注册失败时返回 undefined（不阻断工具注册）
 */
export function registerPromptSection(ctx) {
  if (typeof ctx.systemPrompt?.section !== 'function') return undefined
  try {
    return ctx.systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text: SECTION_TEXT })
  } catch {
    return undefined
  }
}
