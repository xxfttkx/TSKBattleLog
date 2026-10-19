/**
 * API 响应总线（模块级，非 mod）。
 *
 * NetworkCaptureMod 收到 resp 明文时发布（publishApi），
 * 其他 mod 按接口名订阅（subscribeApi）消费——例如 user-data-dump
 * 订阅 unit/list + warehouse/list 导出账号持有数据。
 *
 * 设计要点：
 * - 按需 parse：没有任何订阅者时零 JSON 解析成本（unit/list 明文 2.3MB）
 * - 双 resp 去重：实测同一份响应明文会被游戏解密两次（预解析+消费），
 *   相邻同 (api, plain) 只发布一次，消费者不会被调两遍
 * - 消费者异常逐个 try/catch，不影响抓包主流程与其他订阅者
 */

type ApiHandler = (body: any) => void;

const subscribers = new Map<string, ApiHandler[]>();
/** 上次发布的 (api, plain)，双 resp 去重用 */
let lastPublished: { api: string; plain: string } | null = null;

/** 订阅某接口的响应体（JSON.parse 后的对象）。返回取消订阅函数。 */
export function subscribeApi(api: string, handler: ApiHandler): () => void {
  const list = subscribers.get(api) ?? [];
  list.push(handler);
  subscribers.set(api, list);
  return () => {
    const cur = subscribers.get(api) ?? [];
    const i = cur.indexOf(handler);
    if (i >= 0) cur.splice(i, 1);
  };
}

/** 是否有订阅者（NetworkCaptureMod 用来决定要不要 parse） */
export function hasApiSubscribers(api: string): boolean {
  return (subscribers.get(api)?.length ?? 0) > 0;
}

/**
 * 发布接口响应明文。无订阅者直接丢弃（不 parse）；
 * 与上次相邻同 (api, plain) 视为双 resp 重复，跳过。
 */
export function publishApi(api: string, plain: string): void {
  if (!api || !plain) return;
  if (
    lastPublished &&
    lastPublished.api === api &&
    lastPublished.plain === plain
  ) {
    return;
  }
  lastPublished = { api, plain };
  const list = subscribers.get(api);
  if (!list || list.length === 0) return;
  let body: any;
  try {
    body = JSON.parse(plain);
  } catch {
    return;
  }
  for (const h of list) {
    try {
      h(body);
    } catch (e) {
      // 消费者异常不传染：逐个 try/catch
      console.log(`[apiBus] subscriber error for ${api}: ${e}`);
    }
  }
}
