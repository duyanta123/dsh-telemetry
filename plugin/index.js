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

export const name = "dsh-local-telemetry";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(rootDir, "skills");
const requireOptional = createRequire(import.meta.url);

let sharedRecorder = null;

/** 供宿主集成代码获取共享记录器（惰性创建；配置 enabled=false 时仍可创建，由 record() 自行短路）。 */
export function getTelemetry(config) {
  if (!sharedRecorder) {
    sharedRecorder = createRecorder(config ?? {});
  }
  return sharedRecorder;
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
    void recorder.start?.();
  } catch {
    recorder = null; // fail-open：遥测初始化失败不影响 Harness
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
          if (recorder && typeof recorder.close === "function") await recorder.close();
        } catch {
          /* 关闭 flush 失败不阻塞退出（§6.3） */
        }
      };
    },
    "dsh-local-telemetry skill provider + telemetry flush"
  );

  return { name, skillsRegistered };
}
