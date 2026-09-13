/**
 * dsh-local-telemetry — DSH (DeepSeek Harness) 插件入口（GitHub 仓库 dsh-telemetry；npm 名 dsh-telemetry 已被第三方占用）。
 *
 * 职责（计划 §10）：读取配置、注册技能根、惰性创建 sink/记录器、
 * 注册关闭时 flush 的资源清理逻辑、暴露查询 CLI 与本地服务。
 *
 * 遥测是旁路能力（fail-open）：
 * - 初始化失败不阻止 Harness 启动（只留一次性 stderr 提示）；
 * - 不注册任何改变请求语义的人设、工具或参数；
 * - 宿主生命周期 Hook 尚未确认（计划 §2），事件经显式适配器接入：
 *   宿主集成代码 `import { createRecorder } from "dsh-local-telemetry/telemetry"`。
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { createRecorder } from "../src/recorder.mjs";
import { createDshAdapter } from "../src/adapter-dsh.mjs";

export const name = "dsh-local-telemetry";
export const inject = ["skills"];

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(rootDir, "skills");
const requireOptional = createRequire(import.meta.url);

let sharedRecorder = null;
let sharedStart = null;

/** 供宿主集成代码获取共享记录器（惰性创建；配置 enabled=false 时仍可创建，由 record() 自行短路）。 */
export function getTelemetry(config) {
  if (!sharedRecorder) {
    // 注意：createRecorder 的形参是 { config, sink, now }，把配置对象直接传进去会被当成 opts，
    // 导致宿主配置（store/path/sample_rate/…）被静默忽略——这里必须包一层 config。
    sharedRecorder = createRecorder({ config: config ?? undefined });
    sharedStart = Promise.resolve(sharedRecorder.start?.()).catch(() => {});
  }
  return sharedRecorder;
}

/**
 * 记录器就绪 promise（sink 已建好、可以落盘）。
 * sink 就绪之前的 record() 会如实返回 { ok:false, reason:"not_started" }，不会静默丢数据。
 */
export function telemetryReady() {
  return sharedStart ?? Promise.resolve();
}

export function apply(ctx, config = {}) {
  let provider;
  let skillsRegistered = false;

  // 技能注册：复用官方 FileSystemSkillProvider；不可用时静默降级（遥测核心不依赖技能）
  try {
    const { FileSystemSkillProvider } = requireOptional("@deepseek-ai/dsh-skill-filesystem");
    ctx.skills.registerProvider((control) => {
      provider = new FileSystemSkillProvider(ctx, control, {
        providerName: "dsh-local-telemetry",
        includeDefaultRoots: false,
        customSkillDirs: [skillsDir],
      });
      skillsRegistered = true;
      return provider;
    });
  } catch {
    console.warn?.("[dsh-local-telemetry] skill provider unavailable; CLI and library interfaces remain usable");
  }

  // 记录器预热（惰性 sink：首个事件落盘前不创建文件）
  let recorder = null;
  try {
    recorder = getTelemetry(config?.telemetry);
    void telemetryReady();
  } catch {
    recorder = null; // fail-open：遥测初始化失败不影响 Harness
  }

  // 宿主接入：订阅 dsh-session 公开的 session 事件总线，把真实会话流量喂给记录器。
  // 宿主不提供该总线（旧版本/非 DSH 宿主）时降级为「显式 emit 模式」，只提示一次。
  let adapter = null;
  if (recorder) {
    try {
      adapter = createDshAdapter(recorder, {
        profile: config?.profile ?? null,
        environment: config?.environment ?? "local",
      });
      adapter.attach(ctx);
    } catch (error) {
      adapter = null;
      console.warn?.(
        "[dsh-local-telemetry] host session bus unavailable (" +
          (error?.message ?? String(error)) +
          "); explicit emit API remains usable"
      );
    }
  }

  ctx.effect(
    function* () {
      yield async () => {
        try {
          if (provider && typeof provider.dispose === "function") await provider.dispose();
        } catch {
          /* ignore */
        }
        try {
          if (adapter) adapter.detach();
        } catch {
          /* ignore */
        }
        try {
          if (recorder && typeof recorder.close === "function") await recorder.close();
        } catch {
          /* 关闭 flush 失败不阻塞退出（§6.3） */
        }
      };
    },
    "dsh-local-telemetry skill provider + telemetry flush"
  );

  return { name, skillsRegistered, hostAdapter: adapter ? adapter.snapshot() : null };
}
