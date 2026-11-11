import { projectKey } from "./config.ts";
import { selectDevice, type DeviceMenuContext } from "./device-menu.ts";
import type { Device, DeviceStore } from "./devices.ts";
import { values, type Context } from "./wizard.ts";

/** Per project/environment profile key holding the bound deployment device. */
export const DEVICE_BINDING = "@releaseDeviceId";

const PRODUCTION_ENVIRONMENTS = new Set(["production", "prod"]);
const isProduction = (env: string) => PRODUCTION_ENVIRONMENTS.has(env);
const describe = (device: Device) =>
  `${device.label} (${device.user}@${device.host}:${device.port})`;

/** Other environments of the same project that are bound to the device. */
export function environmentsSharingDevice(
  ctx: Context,
  deviceId: string,
): string[] {
  return ctx.config.environments.filter(
    (env) =>
      env !== ctx.env &&
      ctx.data.profiles[projectKey(ctx.config.project, env)]?.[
        DEVICE_BINDING
      ] === deviceId,
  );
}

export function boundEnvironmentDevice(
  ctx: Context,
  store: DeviceStore,
): Device | undefined {
  const id = values(ctx)[DEVICE_BINDING];
  return id ? store.read(id) : undefined;
}

/** Warning when production and another environment of the project share a host. */
export function sharedHostWarning(
  ctx: Context,
  device: Device,
): string | undefined {
  const shared = environmentsSharingDevice(ctx, device.id);
  if (!shared.length || !(isProduction(ctx.env) || shared.some(isProduction)))
    return undefined;
  return `注意：${describe(device)} 同时用于 ${shared.map((env) => `${ctx.config.project}/${env}`).join("、")}；production 与其他环境共用主机会共享内存、磁盘和出口 IP，建议使用独立设备。`;
}

function bindingWarnings(
  ctx: Context,
  device: Device,
  previous: string | undefined,
  store: DeviceStore,
): string[] {
  const target = `${ctx.config.project}/${ctx.env}`;
  const lines: string[] = [];
  if (previous) {
    const old = store.read(previous);
    lines.push(
      `将 ${target} 的部署设备从 ${old ? describe(old) : previous} 更换为 ${describe(device)}。`,
      "旧设备上已运行的版本不会被停止或迁移。若新旧设备使用同一 Tunnel 连接 Token，Cloudflare 会把请求分流到两台主机。",
      "新设备发布并核验通过后，请在“运行状态”中选择旧设备停止该环境；此前的发布与运行核验不适用于新设备。",
    );
  }
  const warning = sharedHostWarning(ctx, device);
  const shared = environmentsSharingDevice(ctx, device.id);
  if (warning) lines.push(warning);
  else if (shared.length)
    lines.push(
      `注意：${describe(device)} 已用于 ${shared.map((env) => `${ctx.config.project}/${env}`).join("、")}。`,
    );
  return lines;
}

/**
 * Binds the device to the current environment. A change of an existing
 * binding, or production sharing a host, needs explicit confirmation.
 */
export async function bindEnvironmentDevice(
  ctx: Context,
  device: Device,
  store: DeviceStore,
): Promise<boolean> {
  const previous = values(ctx)[DEVICE_BINDING];
  if (previous === device.id) return true;
  const productionShare = sharedHostWarning(ctx, device) !== undefined;
  const lines = bindingWarnings(ctx, device, previous, store);
  if (previous || productionShare) {
    if (!(await ctx.ui.confirm(`${lines.join("\n")}\n确认使用此设备？`))) {
      ctx.ui.log("已取消；保留原部署设备绑定。");
      return false;
    }
  } else if (lines.length) ctx.ui.log(lines.join("\n"));
  values(ctx)[DEVICE_BINDING] = device.id;
  try {
    await ctx.save();
  } catch (error) {
    // Keep memory consistent with the persisted binding.
    if (previous === undefined) delete values(ctx)[DEVICE_BINDING];
    else values(ctx)[DEVICE_BINDING] = previous;
    throw error;
  }
  ctx.ui.log(`${ctx.config.project}/${ctx.env} 部署设备：${describe(device)}`);
  return true;
}

/** Shows the current binding and lets the user choose a different device. */
export async function switchEnvironmentDevice(
  ctx: Context,
  options: {
    store: DeviceStore;
    select?: (context: DeviceMenuContext) => Promise<Device | undefined>;
  },
): Promise<Device | undefined> {
  const saved = values(ctx)[DEVICE_BINDING];
  const current = boundEnvironmentDevice(ctx, options.store);
  ctx.ui.log(
    `${ctx.config.project}/${ctx.env} 当前部署设备：${
      current
        ? describe(current)
        : saved
          ? `${saved}（档案缺失，请重新选择）`
          : "未绑定"
    }`,
  );
  const device = await (options.select ?? selectDevice)({
    ui: ctx.ui,
    store: options.store,
    runner: ctx.runner,
  });
  if (!device) return undefined;
  if (device.id === saved) {
    ctx.ui.log("部署设备未更改。");
    return device;
  }
  return (await bindEnvironmentDevice(ctx, device, options.store))
    ? device
    : undefined;
}
